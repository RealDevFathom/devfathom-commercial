BEGIN;

-- Both tables force RLS, including for a NOSUPERUSER/NOBYPASSRLS owner.
-- Keep administrative scope local to this atomic backfill.
SELECT set_config('app.is_platform_admin', 'true', true);

-- Existing printed expiries were converted to the next UTC midnight. Pharmacy
-- expiry is governed by the Pakistan calendar, whose midnight is 19:00 UTC on
-- the preceding date. Bring stored exclusive boundaries in line with new writes.
UPDATE "pharmacy_manufacturing_batches"
SET "expiresAt" = "expiresAt" - INTERVAL '5 hours'
WHERE "expiresAt"::time = TIME '00:00:00';

-- Receipt expiry is also an exclusive instant, exported in offline PRICES
-- snapshots. Correct it independently so previously repaired batches and new
-- writes at 19:00 UTC are not shifted a second time.
UPDATE "pharmacy_inventory_lots"
SET "receivedExpiresAt" = "receivedExpiresAt" - INTERVAL '5 hours'
WHERE "receivedExpiresAt"::time = TIME '00:00:00';

COMMIT;
