ALTER TABLE "automation_settings"
  ADD COLUMN "release_only_fully_paid" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "delay_minutes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ignore_high_risk_orders" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "require_manual_review_above_amount" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "manual_review_amount" DECIMAL(12,2) NOT NULL DEFAULT 0;

CREATE TABLE "release_jobs" (
  "id" TEXT NOT NULL,
  "shop_id" TEXT NOT NULL,
  "shopify_order_id" TEXT NOT NULL,
  "shopify_order_name" TEXT,
  "shopify_financial_status" TEXT,
  "shopify_gateway" TEXT,
  "shipstation_order_id" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "skip_reason" TEXT,
  "failure_reason" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "released_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "release_jobs_pkey" PRIMARY KEY ("id")
);

INSERT INTO "release_jobs" (
  "id",
  "shop_id",
  "shopify_order_id",
  "shopify_order_name",
  "shopify_financial_status",
  "shopify_gateway",
  "shipstation_order_id",
  "idempotency_key",
  "status",
  "skip_reason",
  "failure_reason",
  "attempts",
  "queued_at",
  "released_at",
  "created_at",
  "updated_at"
)
SELECT
  "id",
  "shop_id",
  "shopify_order_id",
  "shopify_order_name",
  "shopify_financial_status",
  "shopify_gateway",
  "shipstation_order_id",
  "idempotency_key",
  "status",
  "skip_reason",
  "failure_reason",
  "attempts",
  "queued_at",
  "released_at",
  "created_at",
  "updated_at"
FROM "release_events";

ALTER TABLE "release_events"
  ADD COLUMN "order_id" TEXT,
  ADD COLUMN "order_name" TEXT,
  ADD COLUMN "event_type" TEXT,
  ADD COLUMN "message" TEXT,
  ADD COLUMN "metadata" JSONB;

UPDATE "release_events"
SET
  "order_id" = "shopify_order_id",
  "order_name" = "shopify_order_name",
  "event_type" = CASE
    WHEN "status" = 'released' THEN 'release_success'
    WHEN "status" = 'failed' THEN 'release_failed'
    WHEN "status" = 'skipped' THEN 'ignored'
    WHEN "status" = 'retrying' THEN 'retry_scheduled'
    ELSE 'queued_for_release'
  END,
  "status" = CASE
    WHEN "status" = 'released' THEN 'success'
    WHEN "status" = 'failed' THEN 'failed'
    WHEN "status" IN ('queued', 'retrying') THEN 'pending'
    ELSE 'info'
  END,
  "message" = COALESCE("failure_reason", "skip_reason", 'Release event imported from previous activity history.'),
  "metadata" = jsonb_strip_nulls(jsonb_build_object(
    'shipstationOrderId', "shipstation_order_id",
    'financialStatus', "shopify_financial_status",
    'gateway', "shopify_gateway",
    'attempts', "attempts"
  ));

ALTER TABLE "release_events"
  ALTER COLUMN "order_id" SET NOT NULL,
  ALTER COLUMN "event_type" SET NOT NULL,
  ALTER COLUMN "message" SET NOT NULL;

DROP INDEX IF EXISTS "release_events_idempotency_key_key";
CREATE UNIQUE INDEX "release_jobs_idempotency_key_key" ON "release_jobs"("idempotency_key");
CREATE INDEX "release_jobs_shop_id_created_at_idx" ON "release_jobs"("shop_id", "created_at");
CREATE INDEX "release_jobs_shop_id_status_idx" ON "release_jobs"("shop_id", "status");
CREATE INDEX "release_events_shop_id_event_type_idx" ON "release_events"("shop_id", "event_type");

ALTER TABLE "release_jobs" ADD CONSTRAINT "release_jobs_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
