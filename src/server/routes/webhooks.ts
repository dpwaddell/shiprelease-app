import express from "express";
import { prisma } from "../db.js";
import { verifyShopifyWebhook } from "../utils/hmac.js";
import { normalizeShopDomain } from "../utils/shop.js";
import { evaluateOrderEligibility, orderGateway } from "../services/eligibility.js";
import { enqueueRelease } from "../queue/releaseQueue.js";

export const webhookRouter = express.Router();

webhookRouter.use(express.raw({ type: "application/json" }));

webhookRouter.post("/orders", async (req, res) => {
  const hmac = req.get("x-shopify-hmac-sha256");
  if (!verifyShopifyWebhook(req.body, hmac || undefined)) return res.status(401).send("Invalid HMAC");
  res.status(200).send("OK");

  try {
    const shopDomain = normalizeShopDomain(req.get("x-shopify-shop-domain") || "");
    const order = JSON.parse(req.body.toString("utf8"));
    const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
    if (!shop || shop.uninstalledAt) return;
    const settings = await prisma.automationSetting.upsert({
      where: { shopId: shop.id },
      update: {},
      create: { shopId: shop.id }
    });
    const idempotencyKey = `${shop.id}:${order.id}:release-to-awaiting-shipment`;
    const result = evaluateOrderEligibility(order, settings);
    const existing = await prisma.releaseEvent.findUnique({ where: { idempotencyKey } });
    if (existing && existing.status !== "skipped") return;

    const event = await prisma.releaseEvent.upsert({
      where: { idempotencyKey },
      update: result.eligible ? {
        status: "queued",
        skipReason: null,
        failureReason: null,
        queuedAt: new Date()
      } : {
        status: "skipped",
        skipReason: result.reason,
        failureReason: null
      },
      create: {
        shopId: shop.id,
        shopifyOrderId: String(order.id),
        shopifyOrderName: order.name,
        shopifyFinancialStatus: order.financial_status,
        shopifyGateway: orderGateway(order),
        idempotencyKey,
        status: result.eligible ? "queued" : "skipped",
        skipReason: result.reason
      }
    });

    if (result.eligible) await enqueueRelease({ releaseEventId: event.id, shopId: shop.id }, settings.releaseDelayMinutes);
  } catch (error) {
    await prisma.appEvent.create({
      data: {
        eventType: "webhook_processing_failed",
        message: error instanceof Error ? error.message : "Webhook processing failed",
        metadata: { topic: req.get("x-shopify-topic"), shop: req.get("x-shopify-shop-domain") }
      }
    });
  }
});

webhookRouter.post("/app-uninstalled", async (req, res) => {
  const hmac = req.get("x-shopify-hmac-sha256");
  if (!verifyShopifyWebhook(req.body, hmac || undefined)) return res.status(401).send("Invalid HMAC");
  res.status(200).send("OK");
  const shopDomain = req.get("x-shopify-shop-domain");
  if (!shopDomain) return;
  await prisma.shop.updateMany({
    where: { domain: normalizeShopDomain(shopDomain) },
    data: { uninstalledAt: new Date(), accessToken: "uninstalled", planStatus: "inactive" }
  });
});

webhookRouter.post("/compliance", async (req, res) => {
  const hmac = req.get("x-shopify-hmac-sha256");
  if (!verifyShopifyWebhook(req.body, hmac || undefined)) return res.status(401).send("Invalid HMAC");
  res.status(200).send("OK");
  await prisma.appEvent.create({
    data: {
      eventType: "compliance_webhook_received",
      message: `Compliance webhook received: ${req.get("x-shopify-topic") || "unknown"}`,
      metadata: { shop: req.get("x-shopify-shop-domain") || null }
    }
  });
});
