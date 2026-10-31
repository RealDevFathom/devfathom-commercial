-- #763: preserve the distributor tax identity exactly as evidenced by each
-- purchase bill. Null is intentionally allowed so legacy and incomplete bills
-- remain visible to the input-tax hygiene report instead of being rejected.
ALTER TABLE "pharmacy_goods_receipts"
  ADD COLUMN "distributorNtn" TEXT,
  ADD COLUMN "distributorStrn" TEXT;
