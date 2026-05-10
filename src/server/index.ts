import path from "node:path";
import { legalRouter } from "./routes/legal.js";
import { fileURLToPath } from "node:url";
import express from "express";
import compression from "compression";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { env } from "./env.js";
import { beginOAuth, finishOAuth, requireShopSession } from "./services/shopify.js";
import { adminRouter } from "./routes/admin.js";
import { webhookRouter } from "./routes/webhooks.js";

const app = express();
const dirname = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(dirname, "../../src/web/dist");

app.use(helmet({ contentSecurityPolicy: false, frameguard: false }));
app.use(compression());
app.use(cookieParser());

app.get("/health", (_req, res) => res.json({ ok: true, app: "ShipRelease" }));
app.get("/auth", beginOAuth);
app.get("/auth/callback", finishOAuth);
app.use("/", legalRouter);
app.use("/webhooks", webhookRouter);

app.use("/api", express.json({ limit: "1mb" }), requireShopSession, adminRouter);

app.use(express.static(webDist));
app.get(["/", "/app", "/app/*"], (_req, res) => {
  res.sendFile(path.join(webDist, "index.html"));
});

app.listen(env.PORT, () => {
  console.log(`ShipRelease app listening on ${env.PORT}`);
});
