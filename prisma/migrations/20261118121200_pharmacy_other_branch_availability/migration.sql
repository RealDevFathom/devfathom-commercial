-- DEV-907: optional, owner-enabled "also in stock at another branch" line on the
-- pharmacy counter. One organization-level switch, off by default; only the
-- owner turns it on. No new table, no stock, price, batch or customer data is
-- copied anywhere: the counter search reads the switch and decides on the
-- server which branch names of the same organization to show.
-- Idempotent: safe to re-run.
BEGIN;

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "pharmacyOtherBranchAvailability" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
