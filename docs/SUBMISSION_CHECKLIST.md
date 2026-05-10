# ShipRelease Submission Checklist

Use this checklist before starting Shopify App Store submission or rerunning automated checks. Do not paste secrets, tokens, API keys, database URLs, cookies, auth headers, or encrypted credential values into this document or any submission notes.

## Shopify Dashboard Steps

- Confirm the production app URL is `https://shiprelease.sample-guard.com`.
- Confirm the allowed redirect URL is `https://shiprelease.sample-guard.com/auth/callback`.
- Confirm the app is embedded in Shopify admin.
- Confirm requested scopes are limited to the current app need: `read_orders`.
- Confirm Shopify Managed Pricing is enabled in the Partner Dashboard listing.
- Confirm public managed pricing plans are configured:
  - Starter: 100 releases/month
  - Pro: 1,000 releases/month
  - Scale: 10,000 releases/month
- Confirm support contact details, privacy policy URL, terms URL, screenshots, and listing copy are ready.

## App Config Deploy

Mandatory compliance webhooks are app-specific webhooks and must be present in the deployed Shopify app configuration, not only in the local repository.

Current `shopify.app.toml` webhook expectations:

```toml
[webhooks]
api_version = "2026-04"

[[webhooks.subscriptions]]
topics = ["orders/create", "orders/updated"]
uri = "/webhooks/orders"

[[webhooks.subscriptions]]
topics = ["app/uninstalled"]
uri = "/webhooks/app/uninstalled"

[[webhooks.subscriptions]]
compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]
uri = "/webhooks/compliance"
```

After any `shopify.app.toml` change, deploy the app configuration:

```sh
shopify app deploy
```

If using a named production config, pass `--config <name>`. Automated checks can continue to fail until this config is released to Shopify, even if the production web app already serves the routes.

## Automated Checks

Run from `/mnt/user/appdata/shiprelease`:

```sh
npm run typecheck
npm run build
docker compose config --quiet
docker compose up -d --build shiprelease-app
curl -fsS http://127.0.0.1:3300/health
docker compose logs --tail=100 shiprelease-app
npm run test:webhook
npm run diagnose:webhooks
```

Expected webhook diagnostic result for every required route:

- Valid HMAC: `200`
- Invalid HMAC: `401`

The diagnostic scripts print status codes only. They must not print secrets or payload data.

## Production Diagnostics

- Confirm `SHOPIFY_APP_URL` points to the production HTTPS app URL before running `npm run diagnose:webhooks`.
- Confirm `/health` returns OK locally and through the production URL if testing from outside the host.
- Confirm production diagnostics cover:
  - `/webhooks/orders`
  - `/webhooks/app/uninstalled`
  - `/webhooks/compliance`
  - compatibility aliases for `/webhooks/customers/data_request`, `/webhooks/customers/redact`, and `/webhooks/shop/redact`
- Confirm webhook HMAC verification uses the raw request body before JSON parsing.
- Confirm invalid HMAC requests are rejected and do not process.
- Confirm compliance webhooks return quickly with `200` after validation.

## Manual Smoke Test

- Install or reinstall the app on a development store.
- Confirm OAuth redirects back to `/auth/callback` and then `/app`.
- Confirm the embedded app loads in Shopify admin.
- Confirm session-token authenticated API calls work in the embedded app.
- Open every tab:
  - Dashboard
  - Automation
  - ShipStation
  - Simulator
  - Plans
  - Support
- Dashboard:
  - Pause automation.
  - Resume automation.
  - Run reconciliation.
  - Open a release detail view when release history exists.
  - Retry a failed release when one exists.
- Automation:
  - Save settings without changing field names or payload shape.
  - Confirm cards align with the page intro width.
- ShipStation:
  - Save credentials in a test account.
  - Test the connection.
  - Confirm the API secret is never displayed again.
- Simulator:
  - Run a dry run.
  - Confirm no real ShipStation release is made.
- Plans:
  - Confirm the CTA opens Shopify's managed pricing page.
  - Refresh plan status.
- Support:
  - Confirm Contact support opens a mail client.
  - Confirm Request a feature opens a mail client.
  - Confirm subjects include the shop domain.
  - Confirm the email body includes only safe diagnostics.

## Listing Assets Still Needed

- App icon and app listing images.
- App screenshots showing Dashboard, Automation, ShipStation, Simulator, Plans, and Support.
- Short app description and full app listing copy.
- Pricing copy matching Starter, Pro, and Scale plan limits.
- Privacy policy URL.
- Terms of service URL.
- Support email and support process description.
- Internal install-and-use walkthrough recording for review preparation.

## Privacy, Support, And Contact Notes

- Do not include customer personal data in screenshots or listing assets.
- Do not include real order details unless they are from a safe test store.
- Do not expose Shopify tokens, session tokens, HMAC values, ShipStation API keys, ShipStation API secrets, encrypted credentials, cookies, database URLs, or `.env` values.
- Support mailto links should include only safe diagnostics: shop domain, plan, ShipStation connection status, automation enabled state, and recent failure count.
- Compliance webhooks should log only minimal operational receipt details and should not return customer data.
