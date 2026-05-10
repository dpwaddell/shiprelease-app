ALTER TABLE "release_jobs"
  ADD COLUMN "shipstation_lookup_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "first_shipstation_lookup_at" TIMESTAMP(3),
  ADD COLUMN "last_shipstation_lookup_at" TIMESTAMP(3),
  ADD COLUMN "next_shipstation_lookup_at" TIMESTAMP(3),
  ADD COLUMN "shipstation_import_wait_until" TIMESTAMP(3);
