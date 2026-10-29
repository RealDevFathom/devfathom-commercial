-- Give review queries a tenant-bound sale-line relation so branch scope stays
-- inside PostgreSQL rather than expanding historical sale IDs into parameters.
ALTER TABLE "pharmacy_pharmacist_review_items"
  ADD CONSTRAINT "pharmacy_pharmacist_review_items_organizationId_saleLineId_fkey"
  FOREIGN KEY ("organizationId", "saleLineId")
  REFERENCES "pharmacy_sale_lines" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
