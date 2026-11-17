BEGIN;

-- Preserve legacy quantities and leave their mapping choice unrecorded.
ALTER TABLE "pharmacy_migration_batches"
  ADD COLUMN IF NOT EXISTS "quantityUnit" TEXT
  CHECK ("quantityUnit" IN ('PACKS', 'UNITS'));

-- Header of the mapped quantity column, so review reads the mapped cell, not a guess.
ALTER TABLE "pharmacy_migration_batches"
  ADD COLUMN IF NOT EXISTS "quantityColumn" TEXT;

COMMIT;
