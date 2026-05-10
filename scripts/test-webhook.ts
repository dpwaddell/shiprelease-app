import crypto from "node:crypto";
import { env } from "../src/server/env.js";

const body = JSON.stringify({
  id: 1234567890,
  name: "#1001",
  order_number: 1001,
  financial_status: "pending",
  gateway: "Bank Deposit",
  tags: ""
});

const hmac = crypto.createHmac("sha256", env.SHOPIFY_API_SECRET).update(body).digest("base64");
const url = `${env.SHOPIFY_APP_URL.replace(/\/$/, "")}/webhooks/orders`;

const response = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Shopify-Hmac-Sha256": hmac,
    "X-Shopify-Topic": "orders/create",
    "X-Shopify-Shop-Domain": process.argv[2] || "example.myshopify.com"
  },
  body
});

console.log(response.status, await response.text());
