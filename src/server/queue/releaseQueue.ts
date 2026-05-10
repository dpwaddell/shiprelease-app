import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../env.js";

export type ReleaseJob = {
  releaseEventId: string;
  shopId: string;
};

export const RELEASE_QUEUE_NAME = "shiprelease-release-orders";

export const redisConnection = env.REDIS_URL
  ? new Redis(env.REDIS_URL, { maxRetriesPerRequest: null })
  : undefined;

export const releaseQueue = redisConnection
  ? new Queue<ReleaseJob>(RELEASE_QUEUE_NAME, { connection: redisConnection })
  : null;

export async function enqueueRelease(job: ReleaseJob, delayMinutes: number) {
  if (!releaseQueue) throw new Error("REDIS_URL is required for release queueing");
  await releaseQueue.add("release-order", job, {
    jobId: job.releaseEventId,
    delay: delayMinutes * 60_000,
    attempts: 5,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { age: 60 * 60 * 24 * 14 },
    removeOnFail: { age: 60 * 60 * 24 * 30 }
  });
}
