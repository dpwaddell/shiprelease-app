# ShipRelease

ShipRelease is a standalone Shopify app that automatically releases eligible unpaid/manual-payment Shopify orders into ShipStation workflows.

It is intentionally isolated from SampleGuard: its own database, Redis queue, worker, environment variables, deployment files, and codebase.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill Shopify app credentials, `SHOPIFY_APP_URL`, `DATABASE_URL`, `REDIS_URL`, and `SHIPRELEASE_SECRET_ENCRYPTION_KEY`.
3. Generate Prisma client and run migrations:

```sh
npm run prisma:generate
npm run prisma:dev
```

4. Start the app and worker:

```sh
npm run dev
npm run worker
```

## Required Environment Variables

- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_APP_URL`
- `SCOPES=read_orders`
- `DATABASE_URL`
- `REDIS_URL`
- `RESEND_API_KEY`
- `EMAIL_FROM`
- `SUPPORT_EMAIL`
- `SHIPRELEASE_SECRET_ENCRYPTION_KEY`
- `NODE_ENV`
- `PORT`

`SHIPRELEASE_SECRET_ENCRYPTION_KEY` must be a long random secret. ShipStation API credentials are encrypted at rest with AES-256-GCM.

## Docker

```sh
docker compose build
docker compose up -d
```

The default compose file exposes `shiprelease-app` on port `3300` and runs `shiprelease-worker` against the isolated `shiprelease-release-orders` queue. PostgreSQL and Redis run as separate `shiprelease-db` and `shiprelease-redis` containers.

## Shopify

Configured webhooks:

- `orders/create`
- `orders/updated`
- `app/uninstalled`
- `customers/data_request`
- `customers/redact`
- `shop/redact`

The app uses Shopify Managed Pricing data through `currentAppInstallation.activeSubscriptions`. It does not create custom Shopify Billing subscriptions.

## Plan Limits

- Starter: 100 releases/month
- Pro: 1,000 releases/month
- Scale: 10,000 releases/month

Usage limits are soft for the MVP. ShipRelease sends/logs warnings at 80% and 100%, continues releasing, and records over-limit usage for review.

## Test Checklist

- App starts: `npm run dev`, then `GET /health`.
- Worker starts: `npm run worker`.
- OAuth install works: open `/auth?shop=your-store.myshopify.com`.
- Embedded admin loads after install at `/app`.
- Session token authenticated API call works by loading Dashboard inside Shopify admin.
- ShipStation credentials can be saved and tested on the ShipStation page.
- Automation settings save on the Automation page.
- `orders/create` webhook validates HMAC and enqueues with `npm run test:webhook -- your-store.myshopify.com`.
- `orders/updated` uses the same `/webhooks/orders` handler and validates HMAC.
- Ineligible order is skipped with a `release_events.skip_reason`.
- Eligible order creates a queued `release_events` row and BullMQ job.
- Duplicate webhook reuses the idempotency key and does not duplicate release.
- Worker logs success/failure in `release_events` and `app_events`.
- Release event appears on Dashboard recent activity.
- Usage counter increments after a successful release.
- 80% and 100% usage warnings can be simulated by adjusting `usage_counters.release_count` near the plan limit and processing a successful job.
- Plans page displays current managed plan, status, limit, usage, and Shopify plan management link.
- `app/uninstalled` marks the shop uninstalled and deactivates plan state.
- Compliance webhooks validate HMAC and write audit events without exposing customer data.

## MVP Limitations

- ShipStation release uses the v1 `orders/restorefromhold` endpoint as the Awaiting Shipment release action.
- No multi-store account management is included; each Shopify shop installs and pays separately.
- No hard usage cut-offs, Slack alerts, ERP integrations, or advanced workflow builder are included.
