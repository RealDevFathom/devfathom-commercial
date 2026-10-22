SET lock_timeout = '5s';

ALTER TABLE "pharmacy_sale_lines"
  ADD COLUMN "prescriptionLineId" TEXT,
  ADD COLUMN "prescriptionPatientId" TEXT;

CREATE INDEX "pharmacy_sale_lines_organizationId_prescriptionLineId_idx"
  ON "pharmacy_sale_lines" ("organizationId", "prescriptionLineId")
  WHERE "prescriptionLineId" IS NOT NULL;

ALTER TABLE "pharmacy_sale_lines"
  ADD CONSTRAINT "pharmacy_sale_lines_prescription_line_fkey"
  FOREIGN KEY ("organizationId", "prescriptionLineId")
  REFERENCES "pharmacy_prescription_lines" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE
  NOT VALID;
