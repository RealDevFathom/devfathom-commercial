BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "pharmacy_branches"
  ADD COLUMN IF NOT EXISTS "requireSecondPharmacist" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
