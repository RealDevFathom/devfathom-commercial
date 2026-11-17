BEGIN;

-- Preserve legacy quantities and leave their mapping choice unrecorded.
ALTER TABLE "pharmacy_migration_batches"
  ADD COLUMN IF NOT EXISTS "quantityUnit" TEXT
  CHECK ("quantityUnit" IN ('PACKS', 'UNITS'));

COMMIT;
