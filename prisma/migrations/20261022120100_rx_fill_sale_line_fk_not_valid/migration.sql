ALTER TABLE "pharmacy_prescription_fills"
  ADD CONSTRAINT "pharmacy_prescription_fills_saleLine_fkey"
  FOREIGN KEY ("organizationId", "saleLineId")
  REFERENCES "pharmacy_sale_lines"("organizationId", "id")
  ON DELETE RESTRICT
  NOT VALID;
