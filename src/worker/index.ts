import { Worker } from "bullmq";
import { prisma } from "../server/db.js";
import { decryptSecret } from "../server/utils/crypto.js";
import { billingMonth } from "../server/utils/shop.js";
import { RELEASE_QUEUE_NAME, redisConnection, type ReleaseJob } from "../server/queue/releaseQueue.js";
import { locateShipStationOrder, orderCandidates, releaseShipStationOrder } from "../server/services/shipstation.js";
import { getPlanUsage } from "../server/services/plans.js";
import { sendNotification } from "../server/services/notifications.js";
import { logReleaseEvent } from "../server/services/releaseEvents.js";

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

async function processRelease(job: { data: ReleaseJob; attemptsMade: number }) {
  const releaseJob = await prisma.releaseJob.findUnique({
    where: { id: job.data.releaseJobId },
    include: { shop: { include: { shipstationCredentials: true, automationSettings: true } } }
  });
  if (!releaseJob) return;
  if (releaseJob.status === "released") return;
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
    metadata: { attempt: job.attemptsMade + 1 }
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
  const shipstationOrder = await locateShipStationOrder(auth, candidates);
  if (!shipstationOrder) throw new Error(`No matching ShipStation order found for ${candidates.join(", ")}`);

  await releaseShipStationOrder(auth, shipstationOrder.orderId);
  const month = billingMonth();
  await prisma.$transaction([
    prisma.releaseJob.update({
      where: { id: releaseJob.id },
      data: {
        status: "released",
        shipstationOrderId: String(shipstationOrder.orderId),
        releasedAt: new Date(),
        failureReason: null
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
    metadata: { shipstationOrderId: shipstationOrder.orderId }
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
      metadata: { attemptsMade: job.attemptsMade }
    });
  }
  if (releaseJob && !willRetry) {
    await sendNotification({
      shopId: releaseJob.shopId,
      to: releaseJob.shop.automationSettings?.notificationEmail,
      eventType: "release_failed",
      subject: "ShipRelease order release failed",
      text: `ShipRelease could not release ${releaseJob.shopifyOrderName || releaseJob.shopifyOrderId} for ${releaseJob.shop.domain}.\n\n${error.message}`
    });
  }
});

worker.on("ready", () => console.log("ShipRelease worker ready"));
worker.on("error", (error) => console.error("ShipRelease worker error", error));

async function shutdown() {
  await worker.close();
  await redisConnection?.quit();
  await prisma.$disconnect();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
