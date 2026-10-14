-- WHA-302: additive tax/promotion reconstruction evidence. Existing rows remain
-- legacy-compatible: no promotion identity/hash and zero explicit allocations.
CREATE TYPE "RestaurantTaxDiscountTreatment" AS ENUM ('BEFORE_TAX', 'AFTER_TAX');

ALTER TABLE "restaurant_tax_rule_versions"
  ADD COLUMN "discountTreatment" "RestaurantTaxDiscountTreatment" NOT NULL DEFAULT 'BEFORE_TAX';

ALTER TABLE "restaurant_tax_transaction_snapshots"
  ADD COLUMN "promotionEvaluationId" TEXT,
  ADD COLUMN "promotionEvaluationHash" TEXT;

ALTER TABLE "restaurant_tax_rate_bucket_snapshots"
  ADD COLUMN "preDiscountGrossAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "beforeTaxDiscountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "afterTaxDiscountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
