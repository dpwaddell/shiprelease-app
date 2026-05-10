import type { AutomationSetting } from "@prisma/client";
import { prisma } from "../db.js";
import { enqueueRelease } from "../queue/releaseQueue.js";
import { evaluateOrderEligibility, evaluateRuleFoundation, orderGateway } from "./eligibility.js";
import { logReleaseEvent } from "./releaseEvents.js";
import { demoConfig, isDemoReleaseCandidate, logDemoDecision } from "./demoMode.js";

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

const ACTIVE_JOB_STATUSES = ["queued", "retrying", "waiting_for_shipstation_import"] as const;
const DEMO_SUCCESS_MESSAGE = "Demo release completed — no live ShipStation action was performed.";
type ReleaseSource = "webhook" | "reconciliation" | "manual_retry" | "demo_sync";

function requiredOrderId(value: string | number | null | undefined) {
  return String(value || "").trim();
}

async function ensureDemoReleaseEvents(input: {
  shopId: string;
  orderId: string;
  orderName?: string | null;
  releaseJobId: string;
  source: ReleaseSource;
  demoTag: string;
}) {
  const existingSuccess = await prisma.releaseEvent.findFirst({
    where: {
      shopId: input.shopId,
      orderId: input.orderId,
      eventType: "release_success",
      status: "success",
      message: DEMO_SUCCESS_MESSAGE
    },
    select: { id: true }
  });
  if (existingSuccess) return false;

  await logReleaseEvent({
    shopId: input.shopId,
    orderId: input.orderId,
    orderName: input.orderName,
    eventType: "demo_release_candidate",
    status: "info",
    message: `Demo mode tag ${input.demoTag} matched. ShipStation will not be called.`,
    metadata: { releaseJobId: input.releaseJobId, source: input.source, demoMode: true, demoTag: input.demoTag }
  });
  await logReleaseEvent({
    shopId: input.shopId,
    orderId: input.orderId,
    orderName: input.orderName,
    eventType: "release_success",
    status: "success",
    message: DEMO_SUCCESS_MESSAGE,
    metadata: { releaseJobId: input.releaseJobId, source: input.source, demoMode: true, demoTag: input.demoTag, simulated: true }
  });
  return true;
}

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
  source: ReleaseSource;
  retryOfJobId?: string;
}) {
  const orderId = requiredOrderId(input.order.id);
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
  const demoCandidate = isDemoReleaseCandidate(input.order);
  const demo = demoConfig();

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

  if (demoCandidate) {
    if (!orderId) {
      await prisma.appEvent.create({
        data: {
          shopId: input.shopId,
          eventType: "demo_release_missing_order_id",
          message: "Demo release skipped because Shopify order ID was missing",
          metadata: { source: input.source, demoMode: true, demoTag: demo.tag, orderName }
        }
      });
      return { queued: false, ignored: true, simulated: false, processed: false, reason: "Demo release skipped because order ID was missing" };
    }
    const idempotencyKey = `${input.shopId}:${orderId}:demo-release:${demo.tag.toLowerCase()}`;
    const existingDemoRelease = await prisma.releaseJob.findUnique({ where: { idempotencyKey } });
    if (existingDemoRelease?.status === "demo_completed") {
      const eventsCreated = await ensureDemoReleaseEvents({
        shopId: input.shopId,
        orderId: existingDemoRelease.shopifyOrderId || orderId,
        orderName: existingDemoRelease.shopifyOrderName || orderName,
        releaseJobId: existingDemoRelease.id,
        source: input.source,
        demoTag: demo.tag
      });
      return {
        queued: false,
        ignored: false,
        simulated: true,
        processed: eventsCreated,
        reason: eventsCreated ? "Demo release audit events restored" : "Demo release already completed",
        releaseJob: existingDemoRelease
      };
    }
    logDemoDecision("DEMO_RELEASE_CANDIDATE", { shopId: input.shopId, orderId, orderName, source: input.source, demoTag: demo.tag });
    logDemoDecision("DEMO_SHIPSTATION_BYPASS", { shopId: input.shopId, orderId, orderName, source: input.source });
    const releaseJob = await prisma.releaseJob.upsert({
      where: { idempotencyKey },
      update: {
        status: "demo_completed",
        skipReason: null,
        failureReason: null,
        queuedAt: new Date(),
        releasedAt: new Date(),
        ruleEvaluation: { ...ruleEvaluation, demoMode: true, demoTag: demo.tag },
        decisionReason: "Demo mode tag matched; simulated release completed without ShipStation.",
        source: input.source,
        lookupCandidates: []
      },
      create: {
        shopId: input.shopId,
        shopifyOrderId: orderId,
        shopifyOrderName: orderName,
        shopifyFinancialStatus: input.order.financial_status,
        shopifyGateway: gateway,
        idempotencyKey,
        status: "demo_completed",
        skipReason: null,
        failureReason: null,
        source: input.source,
        retryOfJobId: input.retryOfJobId,
        ruleEvaluation: { ...ruleEvaluation, demoMode: true, demoTag: demo.tag },
        decisionReason: "Demo mode tag matched; simulated release completed without ShipStation.",
        lookupCandidates: [],
        releasedAt: new Date()
      }
    });
    await ensureDemoReleaseEvents({
      shopId: input.shopId,
      orderId,
      orderName,
      releaseJobId: releaseJob.id,
      source: input.source,
      demoTag: demo.tag
    });
    logDemoDecision("DEMO_RELEASE_COMPLETED", { shopId: input.shopId, orderId, orderName, releaseJobId: releaseJob.id, source: input.source });
    return { queued: false, ignored: false, simulated: true, processed: true, reason: "Demo release completed", releaseJob };
  }

  const retryCount = input.retryOfJobId
    ? await prisma.releaseJob.count({ where: { shopId: input.shopId, shopifyOrderId: orderId, retryOfJobId: { not: null } } })
    : 0;
  const idempotencyKey = input.retryOfJobId
    ? `${input.shopId}:${orderId}:retry:${input.retryOfJobId}:${retryCount + 1}`
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
