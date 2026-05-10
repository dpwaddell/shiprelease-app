import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { env, isProduction } from "../env.js";
import { prisma } from "../db.js";
import { normalizeShopDomain } from "../utils/shop.js";
import { verifyOAuthQuery } from "../utils/hmac.js";
import { normalizePlanName } from "./plans.js";

type JwtPayload = {
  iss?: string;
  dest?: string;
  aud?: string;
  exp?: number;
  nbf?: number;
  sub?: string;
};

declare global {
  namespace Express {
    interface Request {
      shop?: Awaited<ReturnType<typeof prisma.shop.findUnique>>;
    }
  }
}

function base64url(input: Buffer | string) {
  return Buffer.from(input).toString("base64url");
}

export function beginOAuth(req: Request, res: Response) {
  const shop = normalizeShopDomain(String(req.query.shop || ""));
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("shiprelease_oauth_state", state, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax"
  });
  const params = new URLSearchParams({
    client_id: env.SHOPIFY_API_KEY,
    scope: env.SCOPES,
    redirect_uri: `${env.SHOPIFY_APP_URL}/auth/callback`,
    state,
    "grant_options[]": "per-user"
  });
  res.redirect(`https://${shop}/admin/oauth/authorize?${params.toString()}`);
}

export async function finishOAuth(req: Request, res: Response) {
  const shop = normalizeShopDomain(String(req.query.shop || ""));
  if (!verifyOAuthQuery(req.query)) return res.status(401).send("Invalid OAuth signature");
  if (String(req.query.state || "") !== req.cookies.shiprelease_oauth_state) {
    return res.status(401).send("Invalid OAuth state");
  }

  const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.SHOPIFY_API_KEY,
      client_secret: env.SHOPIFY_API_SECRET,
      code: req.query.code
    })
  });
  if (!tokenResponse.ok) return res.status(502).send("OAuth token exchange failed");
  const token = await tokenResponse.json() as { access_token: string; scope: string };

  const record = await prisma.shop.upsert({
    where: { domain: shop },
    update: {
      accessToken: token.access_token,
      scope: token.scope,
      installedAt: new Date(),
      uninstalledAt: null
    },
    create: {
      domain: shop,
      accessToken: token.access_token,
      scope: token.scope
    }
  });

  await prisma.automationSetting.upsert({
    where: { shopId: record.id },
    update: {},
    create: { shopId: record.id }
  });
  await syncManagedPricing(record.id);
  res.redirect(`/app?shop=${encodeURIComponent(shop)}`);
}

export function verifySessionToken(token: string): JwtPayload {
  const [encodedHeader, encodedPayload, signature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !signature) throw new Error("Malformed session token");
  const expected = base64url(crypto.createHmac("sha256", env.SHOPIFY_API_SECRET).update(`${encodedHeader}.${encodedPayload}`).digest());
  if (signature !== expected) throw new Error("Invalid session token signature");
  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as JwtPayload;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error("Expired session token");
  if (payload.nbf && payload.nbf > now) throw new Error("Session token not active");
  if (payload.aud !== env.SHOPIFY_API_KEY) throw new Error("Invalid session token audience");
  return payload;
}

export async function requireShopSession(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.get("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const payload = verifySessionToken(token);
    const shop = normalizeShopDomain(String(payload.dest || payload.iss || "").replace(/^https?:\/\//, ""));
    const record = await prisma.shop.findUnique({ where: { domain: shop } });
    if (!record || record.uninstalledAt) return res.status(401).json({ error: "Shop is not installed" });
    req.shop = record;
    next();
  } catch (error) {
    res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
}

export async function shopifyGraphql<T>(shopId: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  const response = await fetch(`https://${shop.domain}/admin/api/2026-04/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": shop.accessToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ query, variables })
  });
  if (!response.ok) throw new Error(`Shopify GraphQL ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json() as Promise<T>;
}

export async function syncManagedPricing(shopId: string) {
  const data = await shopifyGraphql<{
    data?: { currentAppInstallation?: { activeSubscriptions?: Array<{ id: string; name: string; status: string; trialDays: number }> } };
  }>(shopId, `query { currentAppInstallation { activeSubscriptions { id name status trialDays } } }`);
  const subscription = data.data?.currentAppInstallation?.activeSubscriptions?.[0];
  await prisma.shop.update({
    where: { id: shopId },
    data: subscription ? {
      planName: normalizePlanName(subscription.name),
      planStatus: subscription.status.toLowerCase(),
      managedPricingSubscriptionId: subscription.id
    } : {
      planName: "unknown",
      planStatus: "inactive",
      managedPricingSubscriptionId: null
    }
  });
}
