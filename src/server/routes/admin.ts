import express from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { env } from "../env.js";
import { decryptSecret, encryptSecret } from "../utils/crypto.js";
import { billingMonth } from "../utils/shop.js";
import { getPlanUsage, planLimit, PLAN_LIMITS } from "../services/plans.js";
import { fetchRecentUpdatedOrders, syncManagedPricing } from "../services/shopify.js";
import { testShipStationConnection } from "../services/shipstation.js";
import { sendNotification } from "../services/notifications.js";
import { releaseQueue } from "../queue/releaseQueue.js";
import { evaluateOrderEligibility, evaluateRuleFoundation, orderGateway } from "../services/eligibility.js";
import { logReleaseEvent } from "../services/releaseEvents.js";
import { hasActiveReleaseJob, queueReleaseFromOrder } from "../services/releaseOrchestration.js";

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
  releaseOnlyFullyPaid: z.boolean().default(false),
  delayMinutes: z.number().int().min(0).max(1440).default(0),
  ignoreHighRiskOrders: z.boolean().default(true),
  requireManualReviewAboveAmount: z.boolean().default(false),
  manualReviewAmount: z.number().min(0).max(999999).default(0),
  notificationEmail: z.string().email().or(z.literal("")).nullable().optional(),
  notifyAutomationPaused: z.boolean().default(true),
  notifyReconciliationFixes: z.boolean().default(true),
  notifyRepeatedFailures: z.boolean().default(true),
  notifyWebhookFailures: z.boolean().default(true),
  repeatedFailureThreshold: z.number().int().min(1).max(20).default(3),
  notificationDebounceMinutes: z.number().int().min(5).max(1440).default(60)
});

const simulatorSchema = z.object({
  orderId: z.string().trim().min(1).max(80),
  orderName: z.string().trim().max(80).optional(),
  financialStatus: z.string().trim().max(40).default("pending"),
  gateway: z.string().trim().max(120).default("Manual Payment"),
  tags: z.string().trim().max(500).default(""),
  totalPrice: z.number().min(0).max(999999).default(0),
  riskLevel: z.string().trim().max(40).default("low")
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

function serializeAutomation(settings: {
  enabled: boolean;
  financialStatuses: unknown;
  paymentMethods: unknown;
  includeTags: unknown;
  excludeTags: unknown;
  releaseDelayMinutes: number;
  releaseOnlyFullyPaid: boolean;
  delayMinutes: number;
  ignoreHighRiskOrders: boolean;
  requireManualReviewAboveAmount: boolean;
  manualReviewAmount: unknown;
  notificationEmail: string | null;
  automationPaused: boolean;
  automationPausedAt: Date | null;
  lastWebhookReceivedAt: Date | null;
  notifyAutomationPaused: boolean;
  notifyReconciliationFixes: boolean;
  notifyRepeatedFailures: boolean;
  notifyWebhookFailures: boolean;
  repeatedFailureThreshold: number;
  notificationDebounceMinutes: number;
}) {
  return {
    ...settings,
    manualReviewAmount: Number(settings.manualReviewAmount || 0)
  };
}

adminRouter.get("/dashboard", async (req, res) => {
  const shop = req.shop!;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(`${billingMonth()}-01T00:00:00.000Z`);
  const [usage, releasesToday, releasesThisMonth, failedReleases, retryCountToday, failedNeedsAttention, pendingQueueJobs, recentActivity, settings, credentials, firstRelease, lastSuccessfulRelease] = await Promise.all([
    getPlanUsage(shop.id, shop.planName),
    prisma.releaseEvent.count({ where: { shopId: shop.id, eventType: "release_success", status: "success", createdAt: { gte: startOfToday } } }),
    prisma.releaseEvent.count({ where: { shopId: shop.id, eventType: "release_success", status: "success", createdAt: { gte: startOfMonth } } }),
    prisma.releaseEvent.count({ where: { shopId: shop.id, status: "failed" } }),
    prisma.releaseEvent.count({ where: { shopId: shop.id, eventType: "manual_retry", createdAt: { gte: startOfToday } } }),
    prisma.releaseJob.count({ where: { shopId: shop.id, status: "failed" } }),
    prisma.releaseJob.count({ where: { shopId: shop.id, status: { in: ["queued", "retrying"] } } }),
    prisma.releaseEvent.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "desc" },
      take: 25,
      select: { id: true, orderId: true, orderName: true, eventType: true, status: true, message: true, metadata: true, createdAt: true }
    }),
    prisma.automationSetting.findUnique({ where: { shopId: shop.id } }),
    prisma.shipStationCredential.findUnique({ where: { shopId: shop.id } }),
    prisma.releaseEvent.findFirst({ where: { shopId: shop.id, eventType: "release_success", status: "success" }, select: { id: true } }),
    prisma.releaseEvent.findFirst({
      where: { shopId: shop.id, eventType: "release_success", status: "success" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true }
    })
  ]);
  const queueCounts = releaseQueue ? await releaseQueue.getJobCounts("waiting", "delayed", "active", "failed").catch(() => null) : null;
  const failedJobs = await prisma.releaseJob.findMany({
    where: { shopId: shop.id, status: "failed" },
    orderBy: { updatedAt: "desc" },
    take: 10,
    select: { id: true, shopifyOrderId: true, shopifyOrderName: true, failureReason: true, attempts: true, updatedAt: true, manualRetryCount: true }
  });
  const recentWithActions = await Promise.all(recentActivity.map(async (event) => {
    const metadata = event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
      ? event.metadata as Record<string, unknown>
      : {};
    let releaseJobId = typeof metadata.releaseJobId === "string" ? metadata.releaseJobId : null;
    if (!releaseJobId && event.status === "failed") {
      const job = await prisma.releaseJob.findFirst({
        where: { shopId: shop.id, shopifyOrderId: event.orderId, status: "failed" },
        orderBy: { updatedAt: "desc" },
        select: { id: true }
      });
      releaseJobId = job?.id || null;
    }
    return {
      ...event,
      releaseJobId,
      canRetry: event.status === "failed" && Boolean(releaseJobId)
    };
  }));
  const checklist = [
    { label: "App installed", complete: !shop.uninstalledAt },
    { label: "ShipStation connected", complete: credentials?.connectionStatus === "connected" },
    { label: "Pricing plan selected", complete: shop.planName !== "unknown" && shop.planStatus === "active" },
    { label: "Automation enabled", complete: Boolean(settings?.enabled) },
    { label: "First release completed", complete: Boolean(firstRelease) }
  ];
  const completed = checklist.filter((item) => item.complete).length;
  res.json({
    metrics: {
      releasesToday,
      releasesThisMonth,
      failedReleases,
      pendingQueueJobs: queueCounts ? queueCounts.waiting + queueCounts.delayed + queueCounts.active : pendingQueueJobs,
      queueHealth: queueCounts ? { ...queueCounts, databasePending: pendingQueueJobs } : { databasePending: pendingQueueJobs },
      lastWebhookReceivedAt: settings?.lastWebhookReceivedAt || null,
      lastSuccessfulReleaseAt: lastSuccessfulRelease?.createdAt || null,
      retryCountToday,
      failedNeedsAttention,
      automationPaused: Boolean(settings?.automationPaused)
    },
    automation: {
      active: Boolean(settings?.enabled && !settings?.automationPaused),
      enabled: Boolean(settings?.enabled),
      paused: Boolean(settings?.automationPaused),
      pausedAt: settings?.automationPausedAt || null
    },
    usage: { count: usage.count, limit: usage.limit, month: usage.month },
    onboarding: { percent: Math.round((completed / checklist.length) * 100), checklist },
    failedJobs,
    recentActivity: recentWithActions
  });
});

adminRouter.get("/automation", async (req, res) => {
  const settings = await prisma.automationSetting.upsert({
    where: { shopId: req.shop!.id },
    update: {},
    create: { shopId: req.shop!.id }
  });
  res.json(serializeAutomation(settings));
});

adminRouter.put("/automation", async (req, res) => {
  const input = automationSchema.parse(req.body);
  const delayMinutes = input.delayMinutes || input.releaseDelayMinutes;
  const settings = await prisma.automationSetting.upsert({
    where: { shopId: req.shop!.id },
    update: { ...input, delayMinutes, notificationEmail: input.notificationEmail || null },
    create: { shopId: req.shop!.id, ...input, delayMinutes, notificationEmail: input.notificationEmail || null }
  });
  await prisma.appEvent.create({ data: { shopId: req.shop!.id, eventType: "automation_saved", message: "Automation settings saved" } });
  res.json(serializeAutomation(settings));
});

adminRouter.post("/automation/pause", async (req, res) => {
  const settings = await prisma.automationSetting.upsert({
    where: { shopId: req.shop!.id },
    update: { automationPaused: true, automationPausedAt: new Date() },
    create: { shopId: req.shop!.id, automationPaused: true, automationPausedAt: new Date() }
  });
  await prisma.appEvent.create({
    data: { shopId: req.shop!.id, eventType: "automation_paused", message: "Automation paused by merchant" }
  });
  if (settings.notifyAutomationPaused) {
    await sendNotification({
      shopId: req.shop!.id,
      to: settings.notificationEmail,
      eventType: "automation_paused_alert",
      subject: "ShipRelease automation paused",
      text: `Automation was paused for ${req.shop!.domain}. No release jobs will be queued until automation is resumed.`,
      debounceMinutes: settings.notificationDebounceMinutes
    });
  }
  res.json(serializeAutomation(settings));
});

adminRouter.post("/automation/resume", async (req, res) => {
  const settings = await prisma.automationSetting.upsert({
    where: { shopId: req.shop!.id },
    update: { automationPaused: false, automationPausedAt: null },
    create: { shopId: req.shop!.id, automationPaused: false, automationPausedAt: null }
  });
  await prisma.appEvent.create({
    data: { shopId: req.shop!.id, eventType: "automation_resumed", message: "Automation resumed by merchant" }
  });
  res.json(serializeAutomation(settings));
});

adminRouter.post("/simulator", async (req, res) => {
  const input = simulatorSchema.parse(req.body);
  const settings = await prisma.automationSetting.upsert({
    where: { shopId: req.shop!.id },
    update: {},
    create: { shopId: req.shop!.id }
  });
  const order = {
    id: input.orderId,
    name: input.orderName || input.orderId,
    financial_status: input.financialStatus,
    gateway: input.gateway,
    tags: input.tags,
    total_price: input.totalPrice,
    risk_level: input.riskLevel
  };
  const eligibility = evaluateOrderEligibility(order, settings);
  const foundation = evaluateRuleFoundation(order, settings);
  const wouldRelease = eligibility.eligible && foundation.passed;
  await logReleaseEvent({
    shopId: req.shop!.id,
    orderId: input.orderId,
    orderName: order.name,
    eventType: "manual_release",
    status: "info",
    message: `Dry run simulated for ${order.name}.`,
    metadata: { dryRun: true, wouldRelease }
  });
  res.json({
    dryRun: true,
    webhookDetected: true,
    queueJobCreated: wouldRelease,
    ruleEvaluation: {
      eligible: eligibility.eligible,
      reason: eligibility.reason,
      foundation
    },
    decision: wouldRelease ? "would_release" : "would_block",
    shipStationPayloadPreview: wouldRelease ? {
      action: "restorefromhold",
      lookupCandidates: [order.name, String(order.id)].filter(Boolean),
      orderNumber: order.name,
      gateway: orderGateway(order)
    } : null
  });
});

adminRouter.get("/releases/:id", async (req, res) => {
  const release = await prisma.releaseJob.findFirst({
    where: { id: req.params.id, shopId: req.shop!.id }
  });
  if (!release) return res.status(404).json({ error: "Release job not found" });
  const [timeline, retryAttempts, childRetries] = await Promise.all([
    prisma.releaseEvent.findMany({
      where: { shopId: req.shop!.id, orderId: release.shopifyOrderId },
      orderBy: { createdAt: "asc" },
      select: { id: true, eventType: true, status: true, message: true, metadata: true, createdAt: true }
    }),
    prisma.releaseJob.count({ where: { shopId: req.shop!.id, shopifyOrderId: release.shopifyOrderId, retryOfJobId: { not: null } } }),
    prisma.releaseJob.findMany({
      where: { shopId: req.shop!.id, retryOfJobId: release.id },
      orderBy: { createdAt: "asc" },
      select: { id: true, status: true, failureReason: true, attempts: true, createdAt: true, updatedAt: true }
    })
  ]);
  res.json({
    release: {
      id: release.id,
      orderId: release.shopifyOrderId,
      orderName: release.shopifyOrderName,
      status: release.status,
      source: release.source,
      attempts: release.attempts,
      retryAttempts,
      retryOfJobId: release.retryOfJobId,
      childRetries,
      queuedAt: release.queuedAt,
      releasedAt: release.releasedAt,
      failureReason: release.failureReason,
      decisionReason: release.decisionReason,
      ruleEvaluation: release.ruleEvaluation,
      shipstationOrderId: release.shipstationOrderId,
      lookupCandidates: release.lookupCandidates,
      metadata: {
        financialStatus: release.shopifyFinancialStatus,
        gateway: release.shopifyGateway,
        skipReason: release.skipReason
      }
    },
    timeline
  });
});

adminRouter.post("/releases/:id/retry", async (req, res) => {
  const original = await prisma.releaseJob.findFirst({
    where: { id: req.params.id, shopId: req.shop!.id }
  });
  if (!original) return res.status(404).json({ error: "Release job not found" });
  if (original.status !== "failed") return res.status(409).json({ error: "Only failed releases can be retried manually" });

  const active = await hasActiveReleaseJob(req.shop!.id, original.shopifyOrderId);
  if (active) return res.status(409).json({ error: "This order already has an active release job", releaseJobId: active.id });

  const settings = await prisma.automationSetting.upsert({
    where: { shopId: req.shop!.id },
    update: {},
    create: { shopId: req.shop!.id }
  });
  await logReleaseEvent({
    shopId: req.shop!.id,
    orderId: original.shopifyOrderId,
    orderName: original.shopifyOrderName,
    eventType: "manual_retry",
    status: "info",
    message: "Manual retry requested.",
    metadata: { originalReleaseJobId: original.id }
  });
  const result = await queueReleaseFromOrder({
    shopId: req.shop!.id,
    order: {
      id: original.shopifyOrderId,
      name: original.shopifyOrderName || original.shopifyOrderId,
      financial_status: original.shopifyFinancialStatus || undefined,
      gateway: original.shopifyGateway || undefined,
      payment_gateway_names: original.shopifyGateway ? [original.shopifyGateway] : []
    },
    settings,
    source: "manual_retry",
    retryOfJobId: original.id
  });
  res.status(result.queued ? 201 : 202).json(result);
});

adminRouter.post("/reconcile/recent-orders", async (req, res) => {
  const shop = req.shop!;
  const settings = await prisma.automationSetting.upsert({
    where: { shopId: shop.id },
    update: {},
    create: { shopId: shop.id }
  });
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const orders = await fetchRecentUpdatedOrders(shop.id, since);
  let queuedFixes = 0;
  let ignoredOrders = 0;
  const fixes: Array<{ orderId: string; orderName: string; releaseJobId?: string }> = [];

  for (const order of orders) {
    const existing = await prisma.releaseJob.findFirst({
      where: { shopId: shop.id, shopifyOrderId: String(order.id), status: { in: ["queued", "retrying", "released"] } },
      orderBy: { createdAt: "desc" }
    });
    if (existing) {
      ignoredOrders += 1;
      continue;
    }
    const failedJob = await prisma.releaseJob.findFirst({
      where: { shopId: shop.id, shopifyOrderId: String(order.id), status: "failed" },
      orderBy: { updatedAt: "desc" }
    });
    const result = await queueReleaseFromOrder({
      shopId: shop.id,
      order,
      settings,
      source: "reconciliation",
      retryOfJobId: failedJob?.id
    });
    if (result.queued) {
      queuedFixes += 1;
      fixes.push({ orderId: String(order.id), orderName: order.name, releaseJobId: result.releaseJob?.id });
    } else {
      ignoredOrders += 1;
    }
  }

  await prisma.appEvent.create({
    data: {
      shopId: shop.id,
      eventType: "reconciliation_completed",
      message: `Reconciliation scanned ${orders.length} recent orders`,
      metadata: { scannedOrders: orders.length, queuedFixes, ignoredOrders }
    }
  });

  if (queuedFixes > 0 && settings.notifyReconciliationFixes) {
    await sendNotification({
      shopId: shop.id,
      to: settings.notificationEmail,
      eventType: "reconciliation_queued_fixes_alert",
      subject: "ShipRelease reconciliation queued release fixes",
      text: `Reconciliation found and queued ${queuedFixes} missing release ${queuedFixes === 1 ? "job" : "jobs"} for ${shop.domain}.`,
      debounceMinutes: settings.notificationDebounceMinutes
    });
  }

  res.json({ scannedOrders: orders.length, queuedFixes, ignoredOrders, fixes });
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
