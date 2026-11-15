-- DEV-161: a goods receipt line against a purchase order carries its share of
-- the order's freight and other charges inside its landed unit cost. The line
-- keeps that share so posting can settle it again under the order's row lock
-- (from the receipts that have actually posted) and adjust the unit cost by the
-- difference alone. Existing rows default to no order charge, which leaves every
-- historical unit cost exactly as it was.
BEGIN;

ALTER TABLE "pharmacy_goods_receipt_lines"
  ADD COLUMN IF NOT EXISTS "allocatedOrderChargeMinor" INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pharmacy_grl_allocated_order_charge_nonnegative'
  ) THEN
    ALTER TABLE "pharmacy_goods_receipt_lines"
      ADD CONSTRAINT "pharmacy_grl_allocated_order_charge_nonnegative"
      CHECK ("allocatedOrderChargeMinor" >= 0);
  END IF;
END $$;

COMMIT;
