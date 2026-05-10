# ShipRelease

ShipRelease is a standalone embedded Shopify app that releases eligible unpaid or manual-payment Shopify orders into ShipStation workflows. It is built for operational visibility: merchants can see why an order was queued, waiting, released, ignored, retried, or failed.

ShipRelease is intentionally isolated from SampleGuard. It has its own database, Redis queue, worker, environment variables, deployment files, and codebase.

## Core Release Flow

1. Shopify sends an order webhook to ShipRelease.
2. ShipRelease validates the Shopify webhook HMAC.
3. The app finds the installed shop and loads shop-scoped automation settings.
4. Eligibility rules are evaluated against financial status, payment method, tags, risk, amount thresholds, and pause state.
5. Eligible orders create a `release_jobs` row and a BullMQ job.
6. The worker looks for the matching order in ShipStation.
7. Once found, the worker calls ShipStation `orders/restorefromhold`.
8. Release history is written to `release_events` and operational events are written to `app_events`.

Duplicate webhook delivery is expected. Release queueing uses idempotency keys and active-job checks so duplicate Shopify webhooks do not create duplicate active release jobs.

## Shopify Webhooks

Configured webhook topics:

- `orders/create`
- `orders/updated`
- `app/uninstalled`
- `customers/data_request`
- `customers/redact`
- `shop/redact`

Order webhooks are acknowledged quickly after HMAC validation. Processing then runs server-side and logs audit events. If Shopify misses a webhook or delivery is delayed, operators can run reconciliation from the dashboard.

Compliance webhooks validate HMAC and write minimal audit records without exposing customer data.

## ShipStation Import Wait

Shopify can send a webhook before ShipStation has imported the order. A missing ShipStation match is treated as import pending, not as an immediate release failure.

Lookup schedule from the release job queued/created time:

- 0 minutes: immediate lookup
- 0 to 1 hour: retry lookup every 2 minutes
- 1 to 5 hours: retry lookup every 10 minutes
- After 5 hours: mark failed and notify

Import waiting uses the same BullMQ job with `job.moveToDelayed(...)` and `DelayedError`. This keeps the release job alive and does not burn BullMQ failure attempts.

### ShipStation Outcome Types

- ShipStation import pending: ShipStation API responds successfully, but no matching order is found. The release job moves to `waiting_for_shipstation_import`, records lookup attempts and next check time, and is delayed for the next lookup.
- ShipStation API/auth failure: ShipStation returns an API error such as authentication or service failure. This remains a normal worker error and uses BullMQ retry/failure handling.
- ShipStation restore/release failure: The order is found, but `restorefromhold` fails. This remains a normal worker error and uses BullMQ retry/failure handling.

No ShipStation API key, API secret, authorization header, or encrypted credential is logged or returned by the API.

## Automation Pause And Resume

Each shop has a global automation control:

- Automation active
- Pause all releases

When paused:

- New release jobs are not queued.
- Simulator dry runs still work.
- Audit events still log.
- Existing queued/delayed jobs are deferred safely and are not converted into failed releases just because automation is paused.

When automation resumes, deferred jobs run naturally on their next scheduled attempt.

Audit events:

- `automation_paused`
- `automation_resumed`
- `release_deferred`

## Reconciliation

Dashboard reconciliation calls:

```sh
POST /api/reconcile/recent-orders
```

It fetches Shopify orders updated in the last 24 hours, reruns eligibility logic, and safely creates missing release jobs. It is idempotent and avoids duplicate active jobs.

When reconciliation repairs a previously failed release, it creates a fresh `release_jobs` row linked to the original failed job through `retryOfJobId`. Manual retry and reconciliation share retry idempotency for the same failed parent.

The dashboard reports:

- Scanned orders
- Queued fixes
- Ignored orders

## Manual Retry

Failed releases can be retried from the dashboard or with:

```sh
POST /api/releases/:id/retry
```

Manual retry creates a new queue job and preserves the original failed job history. It will not queue a duplicate active job for the same order. Manual retry respects automation rules, including pause state.

Audit event:

- `manual_retry`

## Release Detail And Audit Timeline

Release detail shows operational context for a release job:

- Timeline of release audit events
- Timestamps
- Retry attempts
- Rule evaluation outcome
- ShipStation lookup candidates
- Lookup attempts
- Last ShipStation lookup time
- Next ShipStation lookup time
- ShipStation import timeout time
- Release decision reason
- Failure reason
- Sanitized metadata only

Sensitive values are stripped from metadata before storage.

## Retention Cleanup

The worker runs a daily idempotent cleanup for audit history older than 90 days.

Cleanup removes old records from:

- `release_events`
- `app_events`

Cleanup does not delete `release_jobs`. Release job history is kept permanently for operational reconciliation and retry lineage.

## Managed Pricing Plan Limits

ShipRelease uses Shopify Managed Pricing data from `currentAppInstallation.activeSubscriptions`.

Plan limits:

- Starter: 100 releases/month
- Pro: 1,000 releases/month
- Scale: 10,000 releases/month

Usage limits are soft. ShipRelease sends/logs warnings at 80% and 100%, continues releasing, and records over-limit usage for review.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill Shopify app credentials, `SHOPIFY_APP_URL`, `DATABASE_URL`, `REDIS_URL`, and `SHIPRELEASE_SECRET_ENCRYPTION_KEY`.
3. Generate Prisma client and run development migrations:

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

## Deployment Commands

Production deployment is Docker Compose first:

```sh
docker compose config --quiet
docker compose build
docker compose up -d
```

The app container runs Prisma migrations before starting the Express server. The worker container also runs migrations before starting the BullMQ worker. The default Compose file exposes `shiprelease-app` on port `3300` and runs `shiprelease-worker` against the isolated `shiprelease-release-orders` queue.

Health check:

```sh
curl -fsS http://127.0.0.1:3300/health
```

Logs:

```sh
docker compose logs --tail=100 shiprelease-app shiprelease-worker
```

## Validation Commands

Run before deployment or commit:

```sh
npx prisma validate
npx prisma generate
npm run typecheck
npm run build
docker compose config --quiet
```

For production validation after deployment:

```sh
docker compose up -d --build shiprelease-app shiprelease-worker
curl -fsS http://127.0.0.1:3300/health
docker compose logs --tail=100 shiprelease-app shiprelease-worker
```

## Safety Notes

- Do not commit `.env`, production secrets, private keys, database dumps, or logs.
- Do not print Shopify access tokens, session tokens, HMAC query strings, cookies, ShipStation API keys, ShipStation API secrets, authorization headers, encrypted credentials, or database passwords.
- API responses must expose only sanitized operational metadata.
- Logs should contain order identifiers, release job IDs, status, and sanitized errors only.
- Reconciliation and manual retry must preserve original release history.
- Do not delete Docker volumes as part of normal deployment.

## Test Checklist

- App starts and `GET /health` returns OK.
- Worker starts and logs `ShipRelease worker ready`.
- OAuth install works through `/auth?shop=your-store.myshopify.com`.
- Embedded admin loads after install at `/app`.
- Session-token authenticated API calls work inside Shopify admin.
- ShipStation credentials can be saved and tested without displaying the secret again.
- Automation settings save on the Automation page.
- `orders/create` and `orders/updated` validate HMAC and use `/webhooks/orders`.
- Eligible orders create a `release_jobs` row and BullMQ job.
- Duplicate webhook delivery does not create duplicate active release jobs.
- Missing ShipStation order enters `waiting_for_shipstation_import`.
- ShipStation import timeout fails only after 5 hours.
- Successful ShipStation lookup continues to `restorefromhold`.
- Release events appear in dashboard recent activity and release detail timeline.
- Usage counter increments after successful release.
- Plans page displays current managed plan, status, limit, usage, and Shopify plan management link.
- `app/uninstalled` marks the shop uninstalled and deactivates plan state.
- Compliance webhooks validate HMAC and write audit events without exposing customer data.
