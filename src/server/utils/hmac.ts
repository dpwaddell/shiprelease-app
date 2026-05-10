import crypto from "node:crypto";
import type { Request } from "express";
import { env } from "../env.js";

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function verifyShopifyWebhook(rawBody: Buffer, hmacHeader?: string): boolean {
  if (!hmacHeader) return false;
  const digest = crypto.createHmac("sha256", env.SHOPIFY_API_SECRET).update(rawBody).digest("base64");
  return safeEqual(digest, hmacHeader);
}

export function verifyOAuthQuery(query: Request["query"]): boolean {
  const hmac = String(query.hmac || "");
  if (!hmac) return false;
  const pairs = Object.entries(query)
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .flatMap(([key, value]) => Array.isArray(value) ? value.map((v) => [key, String(v)]) : [[key, String(value)]])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const digest = crypto.createHmac("sha256", env.SHOPIFY_API_SECRET).update(pairs).digest("hex");
  return safeEqual(digest, hmac);
}
