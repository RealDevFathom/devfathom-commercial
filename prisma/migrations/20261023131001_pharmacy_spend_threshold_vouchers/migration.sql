-- Loyalty 2/6: owner-configured, sale-idempotent spend-threshold vouchers.
ALTER TABLE pharmacy_loyalty_settings
  ADD COLUMN "spendVoucherTiers" JSONB NOT NULL DEFAULT '[{"thresholdMinor":1000000,"valueMinor":50000},{"thresholdMinor":2000000,"valueMinor":100000}]'::jsonb,
  ADD COLUMN "spendVoucherMinBasketMinor" INTEGER NOT NULL DEFAULT 0
    CHECK ("spendVoucherMinBasketMinor" >= 0),
  ADD CONSTRAINT pharmacy_loyalty_settings_spend_tiers_array
    CHECK (jsonb_typeof("spendVoucherTiers") = 'array');

ALTER TABLE pharmacy_vouchers ADD COLUMN "issuedSaleId" TEXT;
CREATE UNIQUE INDEX pharmacy_vouchers_issued_sale_key
  ON pharmacy_vouchers("organizationId", "issuedSaleId") WHERE "issuedSaleId" IS NOT NULL;
CREATE INDEX pharmacy_vouchers_issued_sale_lookup_idx
  ON pharmacy_vouchers("organizationId", "branchId", "issuedSaleId");

