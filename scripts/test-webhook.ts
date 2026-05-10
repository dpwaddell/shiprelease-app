import crypto from "node:crypto";
import { env } from "../src/server/env.js";

type WebhookCase = {
  path: string;
  topic: string;
  body: string;
};

const orderBody = JSON.stringify({
  id: 1234567890,
  name: "#1001",
  order_number: 1001,
  financial_status: "pending",
  gateway: "Bank Deposit",
  tags: ""
});

const complianceBody = JSON.stringify({
  shop_id: 123456,
  shop_domain: process.argv[2] || "example.myshopify.com",
  orders_requested: []
});

const baseUrl = (process.env.WEBHOOK_TEST_BASE_URL || "http://127.0.0.1:3300").replace(/\/$/, "");
const shopDomain = process.argv[2] || "example.myshopify.com";
const cases: WebhookCase[] = [
  { path: "/webhooks/orders", topic: "orders/create", body: orderBody },
  { path: "/webhooks/app/uninstalled", topic: "app/uninstalled", body: complianceBody },
  { path: "/webhooks/customers/data_request", topic: "customers/data_request", body: complianceBody },
  { path: "/webhooks/customers/redact", topic: "customers/redact", body: complianceBody },
  { path: "/webhooks/shop/redact", topic: "shop/redact", body: complianceBody }
];

function hmacFor(body: string) {
  return crypto.createHmac("sha256", env.SHOPIFY_API_SECRET).update(body).digest("base64");
}

async function postWebhook(testCase: WebhookCase, hmac: string) {
  return fetch(`${baseUrl}${testCase.path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": hmac,
      "X-Shopify-Topic": testCase.topic,
      "X-Shopify-Shop-Domain": shopDomain
    },
    body: testCase.body
  });
}

let failures = 0;
for (const testCase of cases) {
  const valid = await postWebhook(testCase, hmacFor(testCase.body));
  const invalid = await postWebhook(testCase, "invalid");
  const validOk = valid.status === 200;
  const invalidOk = invalid.status === 401;
  console.log(`${testCase.topic}: valid=${valid.status} invalid=${invalid.status}`);
  if (!validOk || !invalidOk) failures += 1;
  await valid.text().catch(() => undefined);
  await invalid.text().catch(() => undefined);
}

if (failures > 0) {
  throw new Error(`Webhook verification failed for ${failures} case${failures === 1 ? "" : "s"}`);
}
