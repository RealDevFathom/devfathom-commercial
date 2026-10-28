ALTER TABLE "pharmacy_khata_limit_decisions" ADD COLUMN "saleId" TEXT;

ALTER TABLE "pharmacy_khata_limit_decisions"
  ADD CONSTRAINT "pharmacy_khata_limit_decisions_sale_fkey"
  FOREIGN KEY ("organizationId", "branchId", "saleId")
  REFERENCES "pharmacy_sales" ("organizationId", "branchId", "id") ON DELETE RESTRICT;

-- Old override decisions predate sale linkage. Enforce sale linkage for every
-- new row without making deployment depend on reconstructing historical sales.
ALTER TABLE "pharmacy_khata_limit_decisions"
  ADD CONSTRAINT "pharmacy_khata_limit_decisions_override_sale_check"
  CHECK ("kind" <> 'OVERRIDDEN' OR "saleId" IS NOT NULL) NOT VALID;

CREATE UNIQUE INDEX "pharmacy_khata_limit_decisions_sale_key"
  ON "pharmacy_khata_limit_decisions" ("organizationId", "branchId", "saleId");
