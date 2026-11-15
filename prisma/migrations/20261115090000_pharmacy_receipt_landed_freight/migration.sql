-- DEV-77: receipt freight is part of the landed cost of every lot it delivered.
-- The receipt keeps the billed freight and each line keeps its exact share, so a
-- lot's unit cost can always be explained as (net + non-creditable tax + freight
-- share) / (received + bonus units). Existing rows default to no freight, which
-- leaves every historical unit cost exactly as it was.
BEGIN;

ALTER TABLE "pharmacy_goods_receipts"
  ADD COLUMN IF NOT EXISTS "freightMinor" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "pharmacy_goods_receipt_lines"
  ADD COLUMN IF NOT EXISTS "allocatedFreightMinor" INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pharmacy_goods_receipts_freight_nonnegative'
  ) THEN
    ALTER TABLE "pharmacy_goods_receipts"
      ADD CONSTRAINT "pharmacy_goods_receipts_freight_nonnegative" CHECK ("freightMinor" >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pharmacy_grl_allocated_freight_nonnegative'
  ) THEN
    ALTER TABLE "pharmacy_goods_receipt_lines"
      ADD CONSTRAINT "pharmacy_grl_allocated_freight_nonnegative" CHECK ("allocatedFreightMinor" >= 0);
  END IF;
END $$;

COMMIT;
