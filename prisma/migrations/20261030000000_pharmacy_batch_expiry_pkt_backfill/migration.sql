-- PR #84 changed new batch expiry boundaries from UTC midnight to PKT midnight.
-- Existing lots use their manufacturing batch's expiry for saleability.
BEGIN;

-- Set this in its own statement so FORCE RLS sees it during the UPDATE.
-- The bypass is transaction-local and is cleared by COMMIT.
SELECT set_config('app.is_platform_admin', 'true', true);

UPDATE "pharmacy_manufacturing_batches"
SET "expiresAt" = "expiresAt" - INTERVAL '5 hours'
WHERE "expiresAt" = date_trunc('day', "expiresAt");

COMMIT;
