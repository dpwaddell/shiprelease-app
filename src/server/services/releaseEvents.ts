import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

export const RELEASE_EVENT_TYPES = [
  "hold_detected",
  "queued_for_release",
  "payment_detected",
  "release_started",
  "release_deferred",
  "shipstation_import_pending",
  "shipstation_import_timeout",
  "release_success",
  "release_failed",
  "manual_release",
  "manual_retry",
  "retry_scheduled",
  "rule_evaluated",
  "ignored"
] as const;

export const RELEASE_EVENT_STATUSES = ["success", "pending", "failed", "info"] as const;

export type ReleaseEventType = typeof RELEASE_EVENT_TYPES[number];
export type ReleaseEventStatus = typeof RELEASE_EVENT_STATUSES[number];

const SENSITIVE_KEYS = /secret|token|authorization|auth|api[_-]?key|api[_-]?secret|password|credential|cookie/i;

function sanitizeMetadata(value: unknown): Prisma.InputJsonValue | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) return value.map((item) => sanitizeMetadata(item) ?? null) as Prisma.InputJsonArray;
  if (typeof value === "object") {
    const clean: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.test(key)) continue;
      const sanitized = sanitizeMetadata(nested);
      if (sanitized !== undefined) clean[key] = sanitized;
    }
    return clean as Prisma.InputJsonObject;
  }
  if (["string", "number", "boolean"].includes(typeof value)) return value as Prisma.InputJsonValue;
  return String(value);
}

export async function logReleaseEvent(input: {
  shopId: string;
  orderId: string;
  orderName?: string | null;
  eventType: ReleaseEventType;
  status: ReleaseEventStatus;
  message: string;
  metadata?: Record<string, unknown>;
}) {
  return prisma.releaseEvent.create({
    data: {
      shopId: input.shopId,
      orderId: input.orderId,
      orderName: input.orderName || null,
      eventType: input.eventType,
      status: input.status,
      message: input.message,
      metadata: sanitizeMetadata(input.metadata)
    }
  });
}
