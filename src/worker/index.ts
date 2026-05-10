import { DelayedError, Worker, type Job } from "bullmq";
import { prisma } from "../server/db.js";
import { decryptSecret } from "../server/utils/crypto.js";
import { billingMonth } from "../server/utils/shop.js";
import { RELEASE_QUEUE_NAME, redisConnection, type ReleaseJob } from "../server/queue/releaseQueue.js";
import { locateShipStationOrder, orderCandidates, releaseShipStationOrder } from "../server/services/shipstation.js";
import { getPlanUsage } from "../server/services/plans.js";
import { sendNotification } from "../server/services/notifications.js";
import { logReleaseEvent } from "../server/services/releaseEvents.js";
import { logDemoDecision } from "../server/services/demoMode.js";

if (!redisConnection) throw new Error("REDIS_URL is required to start the ShipRelease worker");

async function maybeSendUsageWarnings(shopId: string) {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  const settings = await prisma.automationSetting.findUnique({ where: { shopId } });
  const { usage, limit } = await getPlanUsage(shopId, shop.planName);
  if (!limit) return;

  const usageRatio = usage.releaseCount / limit;
  if (usageRatio >= 1 && !usage.warning100SentAt) {
    await prisma.usageCounter.update({
      where: { shopId_billingMonth: { shopId, billingMonth: usage.billingMonth } },
      data: { warning100SentAt: new Date() }
    });
    await sendNotification({
      shopId,
      to: settings?.notificationEmail,
      eventType: "usage_warning_100",
      subject: "ShipRelease monthly release allowance reached",
      text: `${shop.domain} has reached ${usage.releaseCount}/${limit} releases for ${usage.billingMonth}. Releases will continue for the MVP, and over-limit usage is logged for review.`
    });
  } else if (usageRatio >= 0.8 && !usage.warning80SentAt) {
    await prisma.usageCounter.update({
      where: { shopId_billingMonth: { shopId, billingMonth: usage.billingMonth } },
      data: { warning80SentAt: new Date() }
    });
    await sendNotification({
      shopId,
      to: settings?.notificationEmail,
      eventType: "usage_warning_80",
      subject: "ShipRelease usage is approaching the monthly allowance",
      text: `${shop.domain} has used ${usage.releaseCount}/${limit} releases for ${usage.billingMonth}. Consider moving to a higher managed pricing plan if this pace continues.`
    });
  }
}

const PAUSED_RELEASE_DEFER_MINUTES = 15;
const IMPORT_WAIT_FAST_RETRY_MINUTES = 2;
const IMPORT_WAIT_SLOW_RETRY_MINUTES = 10;
const IMPORT_WAIT_FAST_WINDOW_MS = 60 * 60 * 1000;
const IMPORT_WAIT_TIMEOUT_MS = 5 * 60 * 60 * 1000;

async function deferPausedRelease(job: Job<ReleaseJob>, releaseJob: NonNullable<Awaited<ReturnType<typeof prisma.releaseJob.findUnique>>>) {
  const runAt = new Date(Date.now() + PAUSED_RELEASE_DEFER_MINUTES * 60_000);
  await prisma.releaseJob.update({
    where: { id: releaseJob.id },
    data: { status: "queued", failureReason: null }
  });
  await logReleaseEvent({
    shopId: releaseJob.shopId,
    orderId: releaseJob.shopifyOrderId,
    orderName: releaseJob.shopifyOrderName,
    eventType: "release_deferred",
    status: "info",
    message: "Automation is paused. Release job deferred without consuming retry attempts.",
    metadata: { releaseJobId: releaseJob.id, deferredUntil: runAt.toISOString(), delayMinutes: PAUSED_RELEASE_DEFER_MINUTES }
  });
  await job.moveToDelayed(runAt.getTime(), job.token);
  throw new DelayedError();
}

function importWaitDeadline(releaseJob: { queuedAt: Date; createdAt: Date }) {
  return new Date((releaseJob.queuedAt || releaseJob.createdAt).getTime() + IMPORT_WAIT_TIMEOUT_MS);
}

function nextImportLookupAt(releaseJob: { queuedAt: Date; createdAt: Date }, now: Date, deadline: Date) {
  const waitedMs = now.getTime() - (releaseJob.queuedAt || releaseJob.createdAt).getTime();
  const delayMinutes = waitedMs < IMPORT_WAIT_FAST_WINDOW_MS ? IMPORT_WAIT_FAST_RETRY_MINUTES : IMPORT_WAIT_SLOW_RETRY_MINUTES;
  const next = new Date(now.getTime() + delayMinutes * 60_000);
  return next > deadline ? deadline : next;
}

async function deferShipStationImportLookup(
  job: Job<ReleaseJob>,
  releaseJob: NonNullable<Awaited<ReturnType<typeof prisma.releaseJob.findUnique>>>,
  candidates: string[],
  lookupAttempt: number
) {
  const now = new Date();
  const deadline = importWaitDeadline(releaseJob);

  if (now >= deadline) {
    const reason = "ShipStation order was not imported within 5 hours.";
    await prisma.releaseJob.update({
      where: { id: releaseJob.id },
      data: {
        status: "failed",
        failureReason: reason,
        decisionReason: reason,
        lastShipstationLookupAt: now,
        nextShipstationLookupAt: null,
        shipstationImportWaitUntil: deadline
      }
    });
    await logReleaseEvent({
      shopId: releaseJob.shopId,
      orderId: releaseJob.shopifyOrderId,
      orderName: releaseJob.shopifyOrderName,
      eventType: "shipstation_import_timeout",
      status: "failed",
      message: reason,
      metadata: { releaseJobId: releaseJob.id, lookupAttempts: lookupAttempt, importWaitUntil: deadline.toISOString(), lookupCandidates: candidates }
    });
    await logReleaseEvent({
      shopId: releaseJob.shopId,
      orderId: releaseJob.shopifyOrderId,
      orderName: releaseJob.shopifyOrderName,
      eventType: "release_failed",
      status: "failed",
      message: reason,
      metadata: { releaseJobId: releaseJob.id, lookupAttempts: lookupAttempt }
    });
    const shop = await prisma.shop.findUnique({
      where: { id: releaseJob.shopId },
      include: { automationSettings: true }
    });
    await sendNotification({
      shopId: releaseJob.shopId,
      to: shop?.automationSettings?.notificationEmail,
      eventType: "release_failed",
      subject: "ShipRelease order release failed",
      text: `ShipRelease could not find ${releaseJob.shopifyOrderName || releaseJob.shopifyOrderId} in ShipStation after waiting 5 hours for import.`,
      debounceMinutes: shop?.automationSettings?.notificationDebounceMinutes
    });
    return;
  }

  const nextLookupAt = nextImportLookupAt(releaseJob, now, deadline);
  await prisma.releaseJob.update({
    where: { id: releaseJob.id },
    data: {
      status: "waiting_for_shipstation_import",
      failureReason: null,
      decisionReason: "Waiting for ShipStation import",
      lastShipstationLookupAt: now,
      nextShipstationLookupAt: nextLookupAt,
      shipstationImportWaitUntil: deadline
    }
  });
  await logReleaseEvent({
    shopId: releaseJob.shopId,
    orderId: releaseJob.shopifyOrderId,
    orderName: releaseJob.shopifyOrderName,
    eventType: "shipstation_import_pending",
    status: "info",
    message: "ShipStation has not imported the order yet. Lookup deferred.",
    metadata: {
      releaseJobId: releaseJob.id,
      lookupAttempts: lookupAttempt,
      nextLookupAt: nextLookupAt.toISOString(),
      importWaitUntil: deadline.toISOString(),
      lookupCandidates: candidates
    }
  });
  await job.moveToDelayed(nextLookupAt.getTime(), job.token);
  throw new DelayedError();
}

async function processRelease(job: Job<ReleaseJob>) {
  const releaseJob = await prisma.releaseJob.findUnique({
    where: { id: job.data.releaseJobId },
    include: { shop: { include: { shipstationCredentials: true, automationSettings: true } } }
  });
  if (!releaseJob) return;
  if (releaseJob.status === "released") return;
  if (releaseJob.status === "demo_completed") {
    logDemoDecision("DEMO_SHIPSTATION_BYPASS", {
      shopId: releaseJob.shopId,
      orderId: releaseJob.shopifyOrderId,
      orderName: releaseJob.shopifyOrderName,
      releaseJobId: releaseJob.id
    });
    return;
  }
  if (releaseJob.shop.uninstalledAt) {
    await prisma.releaseJob.update({
      where: { id: releaseJob.id },
      data: { status: "skipped", skipReason: "Shop is uninstalled", attempts: job.attemptsMade }
    });
    await logReleaseEvent({
      shopId: releaseJob.shopId,
      orderId: releaseJob.shopifyOrderId,
      orderName: releaseJob.shopifyOrderName,
      eventType: "ignored",
      status: "info",
      message: "Shop is uninstalled."
    });
    return;
  }

  if (releaseJob.shop.automationSettings?.automationPaused) {
    await deferPausedRelease(job, releaseJob);
  }

  await prisma.releaseJob.update({
    where: { id: releaseJob.id },
    data: { status: job.attemptsMade > 0 ? "retrying" : "queued", attempts: job.attemptsMade + 1 }
  });
  await logReleaseEvent({
    shopId: releaseJob.shopId,
    orderId: releaseJob.shopifyOrderId,
    orderName: releaseJob.shopifyOrderName,
    eventType: "release_started",
    status: "pending",
    message: "Release worker started ShipStation release.",
    metadata: { releaseJobId: releaseJob.id, attempt: job.attemptsMade + 1 }
  });

  const credentials = releaseJob.shop.shipstationCredentials;
  if (!credentials) throw new Error("ShipStation credentials are missing");
  if (!releaseJob.shop.automationSettings?.enabled) throw new Error("Automation is disabled");

  const auth = {
    apiKey: decryptSecret(credentials.encryptedApiKey),
    apiSecret: decryptSecret(credentials.encryptedApiSecret)
  };
  const candidates = orderCandidates({
    id: releaseJob.shopifyOrderId,
    name: releaseJob.shopifyOrderName
  });
  const now = new Date();
  const lookupAttempt = releaseJob.shipstationLookupAttempts + 1;
  await prisma.releaseJob.update({
    where: { id: releaseJob.id },
    data: {
      lookupCandidates: candidates,
      shipstationLookupAttempts: { increment: 1 },
      firstShipstationLookupAt: releaseJob.firstShipstationLookupAt || now,
      lastShipstationLookupAt: now,
      shipstationImportWaitUntil: importWaitDeadline(releaseJob)
    }
  });
  const shipstationOrder = await locateShipStationOrder(auth, candidates);
  if (!shipstationOrder) {
    await deferShipStationImportLookup(job, releaseJob, candidates, lookupAttempt);
    return;
  }

  await releaseShipStationOrder(auth, shipstationOrder.orderId);
  const month = billingMonth();
  await prisma.$transaction([
    prisma.releaseJob.update({
      where: { id: releaseJob.id },
      data: {
        status: "released",
        shipstationOrderId: String(shipstationOrder.orderId),
        releasedAt: new Date(),
        failureReason: null,
        decisionReason: "ShipStation order found and released",
        nextShipstationLookupAt: null
      }
    }),
    prisma.usageCounter.upsert({
      where: { shopId_billingMonth: { shopId: releaseJob.shopId, billingMonth: month } },
      update: { releaseCount: { increment: 1 } },
      create: { shopId: releaseJob.shopId, billingMonth: month, releaseCount: 1 }
    }),
    prisma.appEvent.create({
      data: {
        shopId: releaseJob.shopId,
        eventType: "order_released",
        message: `Released ${releaseJob.shopifyOrderName || releaseJob.shopifyOrderId} into ShipStation workflow`,
        metadata: { shipstationOrderId: shipstationOrder.orderId }
      }
    })
  ]);
  await logReleaseEvent({
    shopId: releaseJob.shopId,
    orderId: releaseJob.shopifyOrderId,
    orderName: releaseJob.shopifyOrderName,
    eventType: "release_success",
    status: "success",
    message: `Released ${releaseJob.shopifyOrderName || releaseJob.shopifyOrderId} into ShipStation workflow.`,
    metadata: { releaseJobId: releaseJob.id, shipstationOrderId: shipstationOrder.orderId }
  });
  await maybeSendUsageWarnings(releaseJob.shopId);
}

const worker = new Worker<ReleaseJob>(
  RELEASE_QUEUE_NAME,
  async (job) => processRelease(job),
  { connection: redisConnection, concurrency: 5 }
);

worker.on("failed", async (job, error) => {
  if (!job) return;
  const willRetry = job.attemptsMade < (job.opts.attempts || 1);
  await prisma.releaseJob.updateMany({
    where: { id: job.data.releaseJobId, status: { not: "released" } },
    data: {
      status: willRetry ? "retrying" : "failed",
      failureReason: error.message,
      attempts: job.attemptsMade
    }
  });
  const releaseJob = await prisma.releaseJob.findUnique({
    where: { id: job.data.releaseJobId },
    include: { shop: { include: { automationSettings: true } } }
  });
  if (releaseJob) {
    await logReleaseEvent({
      shopId: releaseJob.shopId,
      orderId: releaseJob.shopifyOrderId,
      orderName: releaseJob.shopifyOrderName,
      eventType: willRetry ? "retry_scheduled" : "release_failed",
      status: willRetry ? "pending" : "failed",
      message: willRetry ? "Release failed and will retry." : error.message,
      metadata: { releaseJobId: releaseJob.id, attemptsMade: job.attemptsMade }
    });
  }
  if (releaseJob && !willRetry) {
    const failuresToday = await prisma.releaseJob.count({
      where: {
        shopId: releaseJob.shopId,
        status: "failed",
        updatedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      }
    });
    await sendNotification({
      shopId: releaseJob.shopId,
      to: releaseJob.shop.automationSettings?.notificationEmail,
      eventType: "release_failed",
      subject: "ShipRelease order release failed",
      text: `ShipRelease could not release ${releaseJob.shopifyOrderName || releaseJob.shopifyOrderId} for ${releaseJob.shop.domain}.\n\n${error.message}`,
      debounceMinutes: releaseJob.shop.automationSettings?.notificationDebounceMinutes
    });
    if (
      releaseJob.shop.automationSettings?.notifyRepeatedFailures &&
      failuresToday >= releaseJob.shop.automationSettings.repeatedFailureThreshold
    ) {
      await sendNotification({
        shopId: releaseJob.shopId,
        to: releaseJob.shop.automationSettings.notificationEmail,
        eventType: "repeated_release_failures",
        subject: "ShipRelease repeated release failures detected",
        text: `${releaseJob.shop.domain} has ${failuresToday} failed release jobs in the last 24 hours.`,
        debounceMinutes: releaseJob.shop.automationSettings.notificationDebounceMinutes
      });
    }
  }
});

worker.on("ready", () => console.log("ShipRelease worker ready"));
worker.on("error", (error) => console.error("ShipRelease worker error", error));

async function cleanupOldAuditEvents() {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const [releaseEvents, appEvents] = await prisma.$transaction([
    prisma.releaseEvent.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.appEvent.deleteMany({ where: { createdAt: { lt: cutoff } } })
  ]);
  await prisma.appEvent.create({
    data: {
      eventType: "audit_retention_cleanup",
      message: `Deleted ${releaseEvents.count + appEvents.count} audit events older than 90 days`,
      metadata: { cutoff: cutoff.toISOString(), releaseEventsDeleted: releaseEvents.count, appEventsDeleted: appEvents.count }
    }
  });
}

cleanupOldAuditEvents().catch((error) => console.error("Audit retention cleanup failed", error));
const cleanupTimer = setInterval(() => {
  cleanupOldAuditEvents().catch((error) => console.error("Audit retention cleanup failed", error));
}, 24 * 60 * 60 * 1000);

async function shutdown() {
  clearInterval(cleanupTimer);
  await worker.close();
  await redisConnection?.quit();
  await prisma.$disconnect();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
