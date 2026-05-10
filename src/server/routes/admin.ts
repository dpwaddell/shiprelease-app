import express from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { decryptSecret, encryptSecret } from "../utils/crypto.js";
import { billingMonth } from "../utils/shop.js";
import { getPlanUsage, planLimit, PLAN_LIMITS } from "../services/plans.js";
import { syncManagedPricing } from "../services/shopify.js";
import { testShipStationConnection } from "../services/shipstation.js";
import { sendNotification } from "../services/notifications.js";

export const adminRouter = express.Router();

type ShipStationCredentialSummary = {
  configured: boolean;
  connectionStatus: string;
  lastCheckedAt?: Date | null;
  lastSuccessAt?: Date | null;
  lastFailureReason?: string | null;
  apiKeyPreview?: string | null;
};

const automationSchema = z.object({
  enabled: z.boolean(),
  financialStatuses: z.array(z.string()).default(["pending", "unpaid"]),
  paymentMethods: z.array(z.string()).default([]),
  includeTags: z.array(z.string()).default([]),
  excludeTags: z.array(z.string()).default(["sampleguard:hold", "fraud", "review"]),
  releaseDelayMinutes: z.union([z.literal(0), z.literal(5), z.literal(15), z.literal(60)]),
  notificationEmail: z.string().email().or(z.literal("")).nullable().optional()
});

function maskApiKey(apiKey: string) {
  const suffix = apiKey.slice(-4);
  return suffix ? `****${suffix}` : "saved";
}

function shipStationCredentialSummary(credentials: {
  encryptedApiKey: string;
  connectionStatus: string;
  lastCheckedAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureReason: string | null;
} | null): ShipStationCredentialSummary {
  return {
    configured: Boolean(credentials),
    connectionStatus: credentials?.connectionStatus || "missing",
    lastCheckedAt: credentials?.lastCheckedAt,
    lastSuccessAt: credentials?.lastSuccessAt,
    lastFailureReason: credentials?.lastFailureReason,
    apiKeyPreview: credentials ? maskApiKey(decryptSecret(credentials.encryptedApiKey)) : null
  };
}

async function planStatus(shopId: string) {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  const usage = await getPlanUsage(shop.id, shop.planName);
  return {
    currentPlan: shop.planName,
    planStatus: shop.planStatus,
    allowance: planLimit(shop.planName),
    usage: { month: usage.month, count: usage.count, limit: usage.limit },
    plans: PLAN_LIMITS,
    manageUrl: `https://${shop.domain}/admin/charges/${env.SHOPIFY_API_KEY}/pricing_plans`
  };
}

adminRouter.get("/dashboard", async (req, res) => {
  const shop = req.shop!;
  const [usage, released, failed, recent] = await Promise.all([
    getPlanUsage(shop.id, shop.planName),
    prisma.releaseEvent.count({ where: { shopId: shop.id, status: "released", createdAt: { gte: new Date(`${billingMonth()}-01T00:00:00.000Z`) } } }),
    prisma.releaseEvent.count({ where: { shopId: shop.id, status: "failed" } }),
    prisma.releaseEvent.findMany({ where: { shopId: shop.id }, orderBy: { createdAt: "desc" }, take: 20 })
  ]);
  const totalFinished = await prisma.releaseEvent.count({ where: { shopId: shop.id, status: { in: ["released", "failed"] } } });
  const totalReleased = await prisma.releaseEvent.count({ where: { shopId: shop.id, status: "released" } });
  res.json({
    releasesThisMonth: released,
    usage: { count: usage.count, limit: usage.limit, month: usage.month },
    estimatedSecondsSaved: released * 30,
    successRate: totalFinished ? Math.round((totalReleased / totalFinished) * 1000) / 10 : 100,
    failedReleases: failed,
    recent
  });
});

adminRouter.get("/automation", async (req, res) => {
  const settings = await prisma.automationSetting.upsert({
    where: { shopId: req.shop!.id },
    update: {},
    create: { shopId: req.shop!.id }
  });
  res.json(settings);
});

adminRouter.put("/automation", async (req, res) => {
  const input = automationSchema.parse(req.body);
  const settings = await prisma.automationSetting.upsert({
    where: { shopId: req.shop!.id },
    update: { ...input, notificationEmail: input.notificationEmail || null },
    create: { shopId: req.shop!.id, ...input, notificationEmail: input.notificationEmail || null }
  });
  await prisma.appEvent.create({ data: { shopId: req.shop!.id, eventType: "automation_saved", message: "Automation settings saved" } });
  res.json(settings);
});

adminRouter.get("/shipstation", async (req, res) => {
  const credentials = await prisma.shipStationCredential.findUnique({ where: { shopId: req.shop!.id } });
  res.json(shipStationCredentialSummary(credentials));
});

adminRouter.put("/shipstation", async (req, res) => {
  const input = z.object({ apiKey: z.string().min(1), apiSecret: z.string().min(1) }).parse(req.body);
  const credentials = await prisma.shipStationCredential.upsert({
    where: { shopId: req.shop!.id },
    update: {
      encryptedApiKey: encryptSecret(input.apiKey),
      encryptedApiSecret: encryptSecret(input.apiSecret),
      connectionStatus: "untested",
      lastFailureReason: null
    },
    create: {
      shopId: req.shop!.id,
      encryptedApiKey: encryptSecret(input.apiKey),
      encryptedApiSecret: encryptSecret(input.apiSecret)
    }
  });
  await prisma.appEvent.create({ data: { shopId: req.shop!.id, eventType: "shipstation_credentials_saved", message: "ShipStation credentials saved" } });
  res.json(shipStationCredentialSummary(credentials));
});

adminRouter.post("/shipstation/test", async (req, res) => {
  const credentials = await prisma.shipStationCredential.findUnique({ where: { shopId: req.shop!.id } });
  if (!credentials) return res.status(400).json({ error: "ShipStation credentials have not been saved" });
  try {
    await testShipStationConnection({
      apiKey: decryptSecret(credentials.encryptedApiKey),
      apiSecret: decryptSecret(credentials.encryptedApiSecret)
    });
    const updated = await prisma.shipStationCredential.update({
      where: { shopId: req.shop!.id },
      data: { connectionStatus: "connected", lastCheckedAt: new Date(), lastSuccessAt: new Date(), lastFailureReason: null }
    });
    res.json(shipStationCredentialSummary(updated));
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown ShipStation connection failure";
    const updated = await prisma.shipStationCredential.update({
      where: { shopId: req.shop!.id },
      data: { connectionStatus: "failed", lastCheckedAt: new Date(), lastFailureReason: reason }
    });
    const settings = await prisma.automationSetting.findUnique({ where: { shopId: req.shop!.id } });
    await sendNotification({
      shopId: req.shop!.id,
      to: settings?.notificationEmail,
      eventType: "shipstation_auth_failed",
      subject: "ShipRelease ShipStation connection failed",
      text: `ShipRelease could not authenticate with ShipStation for ${req.shop!.domain}.\n\n${reason}`
    });
    res.status(400).json(shipStationCredentialSummary(updated));
  }
});

adminRouter.get("/plans", async (req, res) => {
  let shop = req.shop!;
  try {
    await syncManagedPricing(shop.id);
    shop = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
  } catch {
    // Surface cached plan data when Shopify managed pricing cannot be refreshed.
  }
  res.json(await planStatus(shop.id));
});

adminRouter.post("/plans/refresh", async (req, res) => {
  await syncManagedPricing(req.shop!.id);
  res.json(await planStatus(req.shop!.id));
});

adminRouter.get("/support", async (req, res) => {
  const [settings, credentials, failures] = await Promise.all([
    prisma.automationSetting.findUnique({ where: { shopId: req.shop!.id } }),
    prisma.shipStationCredential.findUnique({ where: { shopId: req.shop!.id } }),
    prisma.releaseEvent.count({ where: { shopId: req.shop!.id, status: "failed", createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } } })
  ]);
  res.json({
    supportEmail: env.SUPPORT_EMAIL || "support@sample-guard.com",
    diagnostics: {
      shopDomain: req.shop!.domain,
      plan: req.shop!.planName,
      shipStationConnectionStatus: credentials?.connectionStatus || "missing",
      automationEnabled: Boolean(settings?.enabled),
      recentFailureCount: failures
    }
  });
});
