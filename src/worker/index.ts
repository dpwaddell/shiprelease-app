import { Worker } from "bullmq";
import { prisma } from "../server/db.js";
import { decryptSecret } from "../server/utils/crypto.js";
import { billingMonth } from "../server/utils/shop.js";
import { RELEASE_QUEUE_NAME, redisConnection, type ReleaseJob } from "../server/queue/releaseQueue.js";
import { locateShipStationOrder, orderCandidates, releaseShipStationOrder } from "../server/services/shipstation.js";
import { getPlanUsage } from "../server/services/plans.js";
import { sendNotification } from "../server/services/notifications.js";

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
  const event = await prisma.releaseEvent.findUnique({
    where: { id: job.data.releaseEventId },
    include: { shop: { include: { shipstationCredentials: true, automationSettings: true } } }
  });
  if (!event) return;
  if (event.status === "released") return;
  if (event.shop.uninstalledAt) {
    await prisma.releaseEvent.update({
      where: { id: event.id },
      data: { status: "skipped", skipReason: "Shop is uninstalled", attempts: job.attemptsMade }
    });
    return;
  }

  await prisma.releaseEvent.update({
    where: { id: event.id },
    data: { status: job.attemptsMade > 0 ? "retrying" : "queued", attempts: job.attemptsMade + 1 }
  });

  const credentials = event.shop.shipstationCredentials;
  if (!credentials) throw new Error("ShipStation credentials are missing");
  if (!event.shop.automationSettings?.enabled) throw new Error("Automation is disabled");

  const auth = {
    apiKey: decryptSecret(credentials.encryptedApiKey),
    apiSecret: decryptSecret(credentials.encryptedApiSecret)
  };
  const candidates = orderCandidates({
    id: event.shopifyOrderId,
    name: event.shopifyOrderName
  });
  const shipstationOrder = await locateShipStationOrder(auth, candidates);
  if (!shipstationOrder) throw new Error(`No matching ShipStation order found for ${candidates.join(", ")}`);

  await releaseShipStationOrder(auth, shipstationOrder.orderId);
  const month = billingMonth();
  await prisma.$transaction([
    prisma.releaseEvent.update({
      where: { id: event.id },
      data: {
        status: "released",
        shipstationOrderId: String(shipstationOrder.orderId),
        releasedAt: new Date(),
        failureReason: null
      }
    }),
    prisma.usageCounter.upsert({
      where: { shopId_billingMonth: { shopId: event.shopId, billingMonth: month } },
      update: { releaseCount: { increment: 1 } },
      create: { shopId: event.shopId, billingMonth: month, releaseCount: 1 }
    }),
    prisma.appEvent.create({
      data: {
        shopId: event.shopId,
        eventType: "order_released",
        message: `Released ${event.shopifyOrderName || event.shopifyOrderId} into ShipStation workflow`,
        metadata: { shipstationOrderId: shipstationOrder.orderId }
      }
    })
  ]);
  await maybeSendUsageWarnings(event.shopId);
}

const worker = new Worker<ReleaseJob>(
  RELEASE_QUEUE_NAME,
  async (job) => processRelease(job),
  { connection: redisConnection, concurrency: 5 }
);

worker.on("failed", async (job, error) => {
  if (!job) return;
  const willRetry = job.attemptsMade < (job.opts.attempts || 1);
  await prisma.releaseEvent.updateMany({
    where: { id: job.data.releaseEventId, status: { not: "released" } },
    data: {
      status: willRetry ? "retrying" : "failed",
      failureReason: error.message,
      attempts: job.attemptsMade
    }
  });
  const event = await prisma.releaseEvent.findUnique({
    where: { id: job.data.releaseEventId },
    include: { shop: { include: { automationSettings: true } } }
  });
  if (event && !willRetry) {
    await sendNotification({
      shopId: event.shopId,
      to: event.shop.automationSettings?.notificationEmail,
      eventType: "release_failed",
      subject: "ShipRelease order release failed",
      text: `ShipRelease could not release ${event.shopifyOrderName || event.shopifyOrderId} for ${event.shop.domain}.\n\n${error.message}`
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
