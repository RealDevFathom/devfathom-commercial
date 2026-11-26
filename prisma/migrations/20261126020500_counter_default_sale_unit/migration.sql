BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE pharmacy_branches
  ADD COLUMN IF NOT EXISTS "counterDefaultSaleUnit" "PharmacySaleUnit" NOT NULL DEFAULT 'UNIT';
COMMIT;
