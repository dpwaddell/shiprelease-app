#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

redact_value() {
  local key="$1"
  local value="${2:-}"
  case "$key" in
    *SECRET*|*PASSWORD*|*TOKEN*|RESEND_API_KEY|SHIPRELEASE_SECRET_ENCRYPTION_KEY|DATABASE_URL|REDIS_URL)
      if [[ -z "$value" ]]; then
        printf '<empty>'
      else
        printf '<redacted>'
      fi
      ;;
    *)
      printf '%s' "${value:-<empty>}"
      ;;
  esac
}

print_env_key() {
  local key="$1"
  local value=""
  if [[ -f .env ]]; then
    value="$(grep -E "^${key}=" .env | tail -n 1 | cut -d= -f2- || true)"
  fi
  if [[ -z "$value" && -f .env.example ]]; then
    value="$(grep -E "^${key}=" .env.example | tail -n 1 | cut -d= -f2- || true)"
  fi
  printf '  %s=%s\n' "$key" "$(redact_value "$key" "$value")"
}

echo "== ShipRelease deploy check =="
echo "Root: $ROOT"
echo

echo "== Git remote =="
git remote -v || true
echo

echo "== Safe config preview =="
for key in \
  SHOPIFY_API_KEY \
  SHOPIFY_API_SECRET \
  SHOPIFY_APP_URL \
  SCOPES \
  DATABASE_URL \
  REDIS_URL \
  RESEND_API_KEY \
  EMAIL_FROM \
  SUPPORT_EMAIL \
  SHIPRELEASE_SECRET_ENCRYPTION_KEY \
  NODE_ENV \
  PORT
do
  print_env_key "$key"
done
echo

echo "== Required files =="
required_files=(
  package.json
  package-lock.json
  tsconfig.json
  Dockerfile
  docker-compose.yml
  shopify.app.toml
  .env.example
  prisma/schema.prisma
  src/server/index.ts
  src/worker/index.ts
  src/web/index.html
)
for file in "${required_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "Missing required file: $file" >&2
    exit 1
  fi
  echo "  ok: $file"
done
echo

echo "== Dependencies =="
if [[ ! -d node_modules ]]; then
  npm install
else
  echo "  node_modules present; skipping npm install"
fi
echo

echo "== Prisma generate =="
DATABASE_URL="${DATABASE_URL:-postgresql://shiprelease:shiprelease@127.0.0.1:5432/shiprelease}" npm run prisma:generate
echo

echo "== Typecheck =="
npm run typecheck
echo

echo "== Build =="
DATABASE_URL="${DATABASE_URL:-postgresql://shiprelease:shiprelease@127.0.0.1:5432/shiprelease}" npm run build
echo

echo "== Docker Compose config =="
docker compose --env-file .env.example config >/tmp/shiprelease-compose-config.yml
docker compose --env-file .env.example config --services
echo

echo "== Intended containers and ports =="
grep -E 'container_name:|published:|target:' /tmp/shiprelease-compose-config.yml || true
echo

echo "== SampleGuard reference scan =="
sampleguard_hits="$(grep -R -n -i 'sampleguard\|sample-guard' . \
  --exclude-dir=.git \
  --exclude-dir=node_modules \
  --exclude-dir=dist \
  --exclude-dir=src/web/dist \
  --exclude='shiprelease-deploy-check.sh' \
  --exclude=package-lock.json || true)"
if [[ -n "$sampleguard_hits" ]]; then
  echo "$sampleguard_hits"
  echo
  echo "Review these hits. Expected references include the production domain, README isolation note, and default excluded tag sampleguard:hold."
else
  echo "  no SampleGuard references found"
fi
echo

echo "== Production placeholder scan =="
placeholder_hits="$(grep -R -n -E 'localhost|127\.0\.0\.1|example\.com|shiprelease\.example' . \
  --exclude-dir=.git \
  --exclude-dir=node_modules \
  --exclude-dir=dist \
  --exclude-dir=src/web/dist \
  --exclude=package-lock.json \
  --exclude='shiprelease-deploy-check.sh' || true)"
if [[ -n "$placeholder_hits" ]]; then
  echo "$placeholder_hits"
  echo
  echo "Review these hits before deploying. Test-only references in README/scripts may be acceptable."
else
  echo "  no hardcoded localhost/example.com references found outside the deploy check script"
fi
echo

echo "== Next manual steps =="
cat <<'STEPS'
1. Create a production .env from .env.example and fill real secrets.
2. Set Shopify app URL to https://shiprelease.sample-guard.com.
3. Set allowed redirect URL to https://shiprelease.sample-guard.com/auth/callback.
4. Configure webhooks for /webhooks/orders, /webhooks/app-uninstalled, and /webhooks/compliance using API version 2026-04.
5. Configure Shopify Managed Pricing plans: Starter, Pro, Scale with a 14-day trial.
6. Run docker compose build && docker compose up -d on the deployment host.
7. Install the app on a real development store and test OAuth, embedded admin, ShipStation connection, and order webhooks.
STEPS
