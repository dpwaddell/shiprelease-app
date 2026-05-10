import type { AutomationSetting } from "@prisma/client";
import { prisma } from "../db.js";
import { enqueueRelease } from "../queue/releaseQueue.js";
import { evaluateOrderEligibility, evaluateRuleFoundation, orderGateway } from "./eligibility.js";
import { logReleaseEvent } from "./releaseEvents.js";

type ShopifyOrder = {
  id: string | number;
  name?: string;
  financial_status?: string;
  gateway?: string;
  payment_gateway_names?: string[];
  tags?: string;
  total_price?: string | number;
  risk_level?: string;
};

const ACTIVE_JOB_STATUSES = ["queued", "retrying"] as const;

export async function hasActiveReleaseJob(shopId: string, orderId: string) {
  return prisma.releaseJob.findFirst({
    where: {
      shopId,
      shopifyOrderId: orderId,
      status: { in: [...ACTIVE_JOB_STATUSES] }
    },
    orderBy: { createdAt: "desc" }
  });
}

export function releaseDelay(settings: AutomationSetting) {
  return settings.delayMinutes || settings.releaseDelayMinutes || 0;
}

export async function queueReleaseFromOrder(input: {
  shopId: string;
  order: ShopifyOrder;
  settings: AutomationSetting;
  source: "webhook" | "reconciliation" | "manual_retry";
  retryOfJobId?: string;
}) {
  const orderId = String(input.order.id);
  const orderName = input.order.name || orderId;
  const gateway = orderGateway(input.order);
  const eligibility = evaluateOrderEligibility(input.order, input.settings);
  const foundation = evaluateRuleFoundation(input.order, input.settings);
  const allowedByRules = eligibility.eligible && foundation.passed;
  const decisionReason = input.settings.automationPaused
    ? "Automation paused"
    : !eligibility.eligible
      ? eligibility.reason
      : !foundation.passed
        ? "Blocked by rule foundation"
        : "Eligible for release";
  const ruleEvaluation = {
    eligibility,
    foundation,
    automationPaused: input.settings.automationPaused
  };

  if (input.settings.automationPaused) {
    await logReleaseEvent({
      shopId: input.shopId,
      orderId,
      orderName,
      eventType: "ignored",
      status: "info",
      message: "Automation paused. No release job was queued.",
      metadata: { source: input.source, ruleEvaluation }
    });
    return { queued: false, ignored: true, reason: "Automation paused" };
  }

  const active = await hasActiveReleaseJob(input.shopId, orderId);
  if (active) {
    await logReleaseEvent({
      shopId: input.shopId,
      orderId,
      orderName,
      eventType: "ignored",
      status: "info",
      message: "Order already has an active release job.",
      metadata: { releaseJobId: active.id, status: active.status, source: input.source }
    });
    return { queued: false, ignored: true, reason: "Active release job already exists", releaseJob: active };
  }

  const retryCount = input.retryOfJobId
    ? await prisma.releaseJob.count({ where: { shopId: input.shopId, shopifyOrderId: orderId, retryOfJobId: { not: null } } })
    : 0;
  const retryKeyPrefix = input.source === "manual_retry" ? "manual-retry" : `${input.source}-repair`;
  const idempotencyKey = input.retryOfJobId
    ? `${input.shopId}:${orderId}:${retryKeyPrefix}:${input.retryOfJobId}:${retryCount + 1}`
    : `${input.shopId}:${orderId}:release-to-awaiting-shipment`;

  const releaseJob = await prisma.releaseJob.upsert({
    where: { idempotencyKey },
    update: allowedByRules ? {
      status: "queued",
      skipReason: null,
      failureReason: null,
      queuedAt: new Date(),
      ruleEvaluation,
      decisionReason,
      source: input.source
    } : {
      status: "skipped",
      skipReason: decisionReason,
      failureReason: null,
      ruleEvaluation,
      decisionReason,
      source: input.source
    },
    create: {
      shopId: input.shopId,
      shopifyOrderId: orderId,
      shopifyOrderName: orderName,
      shopifyFinancialStatus: input.order.financial_status,
      shopifyGateway: gateway,
      idempotencyKey,
      status: allowedByRules ? "queued" : "skipped",
      skipReason: allowedByRules ? null : decisionReason,
      source: input.source,
      retryOfJobId: input.retryOfJobId,
      manualRetryCount: input.retryOfJobId ? retryCount + 1 : 0,
      ruleEvaluation,
      decisionReason
    }
  });

  await logReleaseEvent({
    shopId: input.shopId,
    orderId,
    orderName,
    eventType: allowedByRules ? "queued_for_release" : "ignored",
    status: allowedByRules ? "pending" : "info",
    message: allowedByRules ? "Order queued for ShipStation release." : decisionReason || "Order ignored by automation rules.",
    metadata: { releaseJobId: releaseJob.id, delayMinutes: releaseDelay(input.settings), source: input.source, ruleEvaluation }
  });

  if (allowedByRules) await enqueueRelease({ releaseJobId: releaseJob.id, shopId: input.shopId }, releaseDelay(input.settings));
  return { queued: allowedByRules, ignored: !allowedByRules, reason: decisionReason, releaseJob };
}
