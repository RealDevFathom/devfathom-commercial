-- PUR-03: record each receipt line's actual share of PO freight and other
-- charges so cancelled or reversed receipts release exactly what they held.
-- Existing lines were stamped without any charge share, so zero is accurate.
ALTER TABLE "pharmacy_goods_receipt_lines"
  ADD COLUMN "allocatedChargeMinor" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "pharmacy_goods_receipt_lines"
  ADD CONSTRAINT "pharmacy_goods_receipt_lines_allocated_charge_nonnegative"
  CHECK ("allocatedChargeMinor" >= 0);
