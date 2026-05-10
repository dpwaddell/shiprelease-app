process.env.SHOPIFY_API_KEY ||= "demo-key";
process.env.SHOPIFY_API_SECRET ||= "demo-secret";
process.env.SHOPIFY_APP_URL ||= "https://shiprelease.example.com";
process.env.DATABASE_URL ||= "postgresql://shiprelease:shiprelease@example.com:5432/shiprelease";
process.env.SHIPRELEASE_SECRET_ENCRYPTION_KEY ||= "00000000000000000000000000000000";
process.env.SHIPRELEASE_DEMO_MODE = "true";
process.env.SHIPRELEASE_DEMO_TAG = "shiprelease-demo";

const { demoConfig, isDemoReleaseCandidate } = await import("../src/server/services/demoMode.js");

const config = demoConfig();
if (!config.enabled) throw new Error("Expected demo mode to be enabled");
if (config.tag !== "shiprelease-demo") throw new Error(`Unexpected demo tag: ${config.tag}`);
if (!isDemoReleaseCandidate({ tags: "vip, shiprelease-demo" })) throw new Error("Expected comma-separated demo tag to match");
if (!isDemoReleaseCandidate({ tags: ["ShipRelease-Demo"] })) throw new Error("Expected array demo tag to match case-insensitively");
if (isDemoReleaseCandidate({ tags: "vip, release" })) throw new Error("Unexpected non-demo order match");

console.log("Demo mode verification passed");
