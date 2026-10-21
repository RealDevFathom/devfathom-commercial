-- AI-02: an explicit commercial term; null deliberately means "not recorded".
ALTER TABLE "pharmacy_supplier_relationships"
  ADD COLUMN "expiryReturnWindowDays" INTEGER;

ALTER TABLE "pharmacy_supplier_relationships"
  ADD CONSTRAINT "pharmacy_supplier_relationships_expiry_return_window_check"
  CHECK ("expiryReturnWindowDays" IS NULL OR "expiryReturnWindowDays" > 0);
