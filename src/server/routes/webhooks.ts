import express from "express";
import { prisma } from "../db.js";
import { verifyShopifyWebhook } from "../utils/hmac.js";
import { normalizeShopDomain } from "../utils/shop.js";
import { orderGateway } from "../services/eligibility.js";
import { logReleaseEvent } from "../services/releaseEvents.js";
import { queueReleaseFromOrder } from "../services/releaseOrchestration.js";
import { sendNotification } from "../services/notifications.js";

export const webhookRouter = express.Router();

webhookRouter.use(express.raw({ type: "application/json" }));

function verifyWebhookRequest(req: express.Request, res: express.Response) {
  const hmac = req.get("x-shopify-hmac-sha256");
  if (!Buffer.isBuffer(req.body) || !verifyShopifyWebhook(req.body, hmac || undefined)) {
    res.status(401).send("Invalid HMAC");
    return false;
  }
  return true;
}

async function handleOrderWebhook(req: express.Request, res: express.Response) {
  if (!verifyWebhookRequest(req, res)) return;
  res.status(200).send("OK");

  try {
    const shopDomain = normalizeShopDomain(req.get("x-shopify-shop-domain") || "");
    const order = JSON.parse(req.body.toString("utf8"));
    const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
    if (!shop || shop.uninstalledAt) return;
    const settings = await prisma.automationSetting.upsert({
      where: { shopId: shop.id },
      update: { lastWebhookReceivedAt: new Date() },
      create: { shopId: shop.id, lastWebhookReceivedAt: new Date() }
    });
    await logReleaseEvent({
      shopId: shop.id,
      orderId: String(order.id),
      orderName: order.name,
      eventType: "hold_detected",
      status: "info",
      message: `Webhook detected ${order.name || order.id}.`,
      metadata: { financialStatus: order.financial_status, gateway: orderGateway(order) }
    });
    if (String(order.financial_status || "").toLowerCase() === "paid") {
      await logReleaseEvent({
        shopId: shop.id,
        orderId: String(order.id),
        orderName: order.name,
        eventType: "payment_detected",
        status: "info",
        message: `Payment detected for ${order.name || order.id}.`,
        metadata: { financialStatus: order.financial_status }
      });
    }
    await queueReleaseFromOrder({ shopId: shop.id, order, settings, source: "webhook" });
  } catch (error) {
    const shopDomain = req.get("x-shopify-shop-domain");
    const shop = shopDomain ? await prisma.shop.findUnique({ where: { domain: normalizeShopDomain(shopDomain) }, include: { automationSettings: true } }).catch(() => null) : null;
    await prisma.appEvent.create({
      data: {
        shopId: shop?.id,
        eventType: "webhook_processing_failed",
        message: error instanceof Error ? error.message : "Webhook processing failed",
        metadata: { topic: req.get("x-shopify-topic"), shop: req.get("x-shopify-shop-domain") }
      }
    });
    if (shop?.automationSettings?.notifyWebhookFailures) {
      await sendNotification({
        shopId: shop.id,
        to: shop.automationSettings.notificationEmail,
        eventType: "webhook_processing_failed_alert",
        subject: "ShipRelease webhook processing failed",
        text: `ShipRelease could not process a Shopify webhook for ${shop.domain}. Reconciliation can be run from the dashboard.`,
        debounceMinutes: shop.automationSettings.notificationDebounceMinutes
      });
    }
  }
}

async function handleAppUninstalledWebhook(req: express.Request, res: express.Response) {
  if (!verifyWebhookRequest(req, res)) return;
  res.status(200).send("OK");
  const shopDomain = req.get("x-shopify-shop-domain");
  if (!shopDomain) return;
  await prisma.shop.updateMany({
    where: { domain: normalizeShopDomain(shopDomain) },
    data: { uninstalledAt: new Date(), accessToken: "uninstalled", planStatus: "inactive" }
  });
}

async function handleComplianceWebhook(req: express.Request, res: express.Response) {
  if (!verifyWebhookRequest(req, res)) return;
  res.status(200).send("OK");
  await prisma.appEvent.create({
    data: {
      eventType: "compliance_webhook_received",
      message: `Compliance webhook received: ${req.get("x-shopify-topic") || "unknown"}`,
      metadata: { shop: req.get("x-shopify-shop-domain") || null }
    }
  });
}

webhookRouter.post("/orders", handleOrderWebhook);
webhookRouter.post("/app/uninstalled", handleAppUninstalledWebhook);
webhookRouter.post("/customers/data_request", handleComplianceWebhook);
webhookRouter.post("/customers/redact", handleComplianceWebhook);
webhookRouter.post("/shop/redact", handleComplianceWebhook);

// Compatibility aliases for existing deployed webhook registrations.
webhookRouter.post("/app-uninstalled", handleAppUninstalledWebhook);
webhookRouter.post("/compliance", handleComplianceWebhook);
