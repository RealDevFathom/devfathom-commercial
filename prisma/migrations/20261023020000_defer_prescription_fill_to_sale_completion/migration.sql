ALTER TABLE "pharmacy_sale_lines"
  ADD COLUMN "prescriptionLineId" TEXT;

ALTER TABLE "pharmacy_sale_lines"
  ADD CONSTRAINT "pharmacy_sale_lines_prescription_line_fkey"
  FOREIGN KEY ("organizationId", "prescriptionLineId")
  REFERENCES "pharmacy_prescription_lines" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
