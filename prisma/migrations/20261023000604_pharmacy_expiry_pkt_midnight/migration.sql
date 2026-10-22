-- Printed pharmacy expiry dates are Pakistan-local dates. Existing exclusive
-- expiry boundaries were stored at UTC midnight, five hours after PKT midnight.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

UPDATE "pharmacy_manufacturing_batches"
SET "expiresAt" = "expiresAt" - INTERVAL '5 hours'
-- Restrict the backfill to legacy UTC-midnight boundaries. This also leaves a
-- PKT-normalised row untouched if application rollout overlaps the migration.
WHERE "expiresAt" = date_trunc('day', "expiresAt");

COMMIT;
