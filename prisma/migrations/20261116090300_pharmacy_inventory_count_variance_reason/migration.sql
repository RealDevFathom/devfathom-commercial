-- DEV-682: a daily cycle count posts its variance with the reason the
-- confirming person gave. The table already has row-level security.
BEGIN;

ALTER TABLE "pharmacy_inventory_counts" ADD COLUMN IF NOT EXISTS "varianceReason" TEXT;

COMMIT;
