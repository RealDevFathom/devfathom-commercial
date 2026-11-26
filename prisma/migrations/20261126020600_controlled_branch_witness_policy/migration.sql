BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "pharmacy_branches"
  ADD COLUMN "requireSecondPharmacist" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
