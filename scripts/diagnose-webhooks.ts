import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

type WebhookCase = {
  path: string;
  topic: string;
  body: string;
};

const appUrl = process.env.SHOPIFY_APP_URL?.trim().replace(/\/$/, "");
const secret = process.env.SHOPIFY_API_SECRET;
const diagnosticShop = "diagnostic-webhook-check.myshopify.com";

if (!appUrl) {
  console.log("SHOPIFY_APP_URL not set; production webhook diagnostic skipped.");
  process.exit(0);
}

if (!appUrl.startsWith("https://")) {
  throw new Error("SHOPIFY_APP_URL must be an HTTPS URL for production webhook diagnostics.");
}

if (!secret) {
  throw new Error("SHOPIFY_API_SECRET is required for webhook diagnostics.");
}

const orderBody = JSON.stringify({
  id: 9876543210,
  name: "#DIAG",
  order_number: 9876543210,
  financial_status: "pending",
  gateway: "Diagnostic",
  tags: ""
});

const complianceBody = JSON.stringify({
  shop_id: 9876543210,
  shop_domain: diagnosticShop,
  orders_requested: []
});

const cases: WebhookCase[] = [
  { path: "/webhooks/orders", topic: "orders/create", body: orderBody },
  { path: "/webhooks/app/uninstalled", topic: "app/uninstalled", body: complianceBody },
  { path: "/webhooks/compliance", topic: "customers/data_request", body: complianceBody },
  { path: "/webhooks/compliance", topic: "customers/redact", body: complianceBody },
  { path: "/webhooks/compliance", topic: "shop/redact", body: complianceBody },
  { path: "/webhooks/customers/data_request", topic: "customers/data_request", body: complianceBody },
  { path: "/webhooks/customers/redact", topic: "customers/redact", body: complianceBody },
  { path: "/webhooks/shop/redact", topic: "shop/redact", body: complianceBody }
];

function hmacFor(body: string) {
  return crypto.createHmac("sha256", secret).update(body).digest("base64");
}

async function postWebhook(testCase: WebhookCase, hmac: string) {
  return fetch(`${appUrl}${testCase.path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": hmac,
      "X-Shopify-Topic": testCase.topic,
      "X-Shopify-Shop-Domain": diagnosticShop
    },
    body: testCase.body
  });
}

let failures = 0;
for (const testCase of cases) {
  const valid = await postWebhook(testCase, hmacFor(testCase.body));
  const invalid = await postWebhook(testCase, "invalid");
  await valid.text().catch(() => undefined);
  await invalid.text().catch(() => undefined);

  console.log(`${testCase.path} ${testCase.topic}: valid=${valid.status} invalid=${invalid.status}`);

  if (valid.status !== 200 || invalid.status !== 401) {
    failures += 1;
  }
}

if (failures > 0) {
  throw new Error(`Production webhook diagnostic failed for ${failures} case${failures === 1 ? "" : "s"}.`);
}
