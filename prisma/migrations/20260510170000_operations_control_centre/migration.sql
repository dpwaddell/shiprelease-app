ALTER TABLE "automation_settings"
  ADD COLUMN "automation_paused" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "automation_paused_at" TIMESTAMP(3),
  ADD COLUMN "last_webhook_received_at" TIMESTAMP(3),
  ADD COLUMN "notify_automation_paused" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "notify_reconciliation_fixes" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "notify_repeated_failures" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "notify_webhook_failures" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "repeated_failure_threshold" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "notification_debounce_minutes" INTEGER NOT NULL DEFAULT 60;

ALTER TABLE "release_jobs"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'webhook',
  ADD COLUMN "retry_of_job_id" TEXT,
  ADD COLUMN "rule_evaluation" JSONB,
  ADD COLUMN "decision_reason" TEXT,
  ADD COLUMN "lookup_candidates" JSONB,
  ADD COLUMN "manual_retry_count" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "release_jobs_shop_id_shopify_order_id_idx" ON "release_jobs"("shop_id", "shopify_order_id");
