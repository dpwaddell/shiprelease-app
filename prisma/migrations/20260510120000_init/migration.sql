CREATE TABLE "shops" (
  "id" TEXT NOT NULL,
  "domain" TEXT NOT NULL,
  "access_token" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "installed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "uninstalled_at" TIMESTAMP(3),
  "plan_name" TEXT NOT NULL DEFAULT 'unknown',
  "plan_status" TEXT NOT NULL DEFAULT 'inactive',
  "trial_ends_at" TIMESTAMP(3),
  "managed_pricing_subscription_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shipstation_credentials" (
  "id" TEXT NOT NULL,
  "shop_id" TEXT NOT NULL,
  "encrypted_api_key" TEXT NOT NULL,
  "encrypted_api_secret" TEXT NOT NULL,
  "connection_status" TEXT NOT NULL DEFAULT 'untested',
  "last_checked_at" TIMESTAMP(3),
  "last_success_at" TIMESTAMP(3),
  "last_failure_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "shipstation_credentials_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "automation_settings" (
  "id" TEXT NOT NULL,
  "shop_id" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "financial_statuses" JSONB NOT NULL DEFAULT '["pending","unpaid"]',
  "payment_methods" JSONB NOT NULL DEFAULT '["Bank Deposit","Purchase Order","COD","Net Terms","Manual Payment"]',
  "include_tags" JSONB NOT NULL DEFAULT '[]',
  "exclude_tags" JSONB NOT NULL DEFAULT '["sampleguard:hold","fraud","review"]',
  "release_delay_minutes" INTEGER NOT NULL DEFAULT 0,
  "notification_email" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "automation_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "release_events" (
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
  CONSTRAINT "release_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "usage_counters" (
  "id" TEXT NOT NULL,
  "shop_id" TEXT NOT NULL,
  "billing_month" TEXT NOT NULL,
  "release_count" INTEGER NOT NULL DEFAULT 0,
  "warning_80_sent_at" TIMESTAMP(3),
  "warning_100_sent_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "app_events" (
  "id" TEXT NOT NULL,
  "shop_id" TEXT,
  "event_type" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "app_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shops_domain_key" ON "shops"("domain");
CREATE UNIQUE INDEX "shipstation_credentials_shop_id_key" ON "shipstation_credentials"("shop_id");
CREATE UNIQUE INDEX "automation_settings_shop_id_key" ON "automation_settings"("shop_id");
CREATE UNIQUE INDEX "release_events_idempotency_key_key" ON "release_events"("idempotency_key");
CREATE INDEX "release_events_shop_id_created_at_idx" ON "release_events"("shop_id", "created_at");
CREATE INDEX "release_events_shop_id_status_idx" ON "release_events"("shop_id", "status");
CREATE UNIQUE INDEX "usage_counters_shop_id_billing_month_key" ON "usage_counters"("shop_id", "billing_month");
CREATE INDEX "app_events_shop_id_created_at_idx" ON "app_events"("shop_id", "created_at");

ALTER TABLE "shipstation_credentials" ADD CONSTRAINT "shipstation_credentials_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_settings" ADD CONSTRAINT "automation_settings_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "release_events" ADD CONSTRAINT "release_events_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app_events" ADD CONSTRAINT "app_events_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;
