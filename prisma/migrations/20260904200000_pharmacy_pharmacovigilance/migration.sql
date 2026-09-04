-- RX-08; PRD §6.6 and §8A invariants 8, 14, 18 and 21.
CREATE TYPE "PharmacyPharmacovigilanceKind" AS ENUM ('ADVERSE_DRUG_REACTION','MEDICATION_ERROR','PRODUCT_QUALITY_COMPLAINT');
CREATE TYPE "PharmacyPharmacovigilanceState" AS ENUM ('DRAFT','UNDER_REVIEW','READY','SUBMITTED','CLOSED');
CREATE TYPE "PharmacyExternalSubmissionState" AS ENUM ('NOT_SUBMITTED','PENDING','SUBMITTED','FAILED');

CREATE TABLE "pharmacy_pharmacovigilance_reports" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "kind" "PharmacyPharmacovigilanceKind" NOT NULL,
  "state" "PharmacyPharmacovigilanceState" NOT NULL DEFAULT 'DRAFT',
  "externalSubmissionState" "PharmacyExternalSubmissionState" NOT NULL DEFAULT 'NOT_SUBMITTED',
  "patientId" TEXT, "medicineId" TEXT, "inventoryLotId" TEXT, "prescriberId" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "assertedDescription" TEXT NOT NULL CHECK (length(btrim("assertedDescription")) > 0),
  "externalReference" TEXT, "externalFailureReason" TEXT,
  "createdByUserId" TEXT NOT NULL, "reviewedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  UNIQUE ("organizationId", "branchId", "id"),
  CONSTRAINT "pharmacy_pv_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "patientId") REFERENCES "pharmacy_patients"("organizationId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "medicineId") REFERENCES "pharmacy_medicines"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_pv_lot_fkey" FOREIGN KEY ("organizationId", "branchId", "inventoryLotId") REFERENCES "pharmacy_inventory_lots"("organizationId", "branchId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "prescriberId") REFERENCES "pharmacy_prescribers"("organizationId", "id") ON DELETE RESTRICT,
  CHECK ("inventoryLotId" IS NULL OR "medicineId" IS NOT NULL),
  CHECK (("externalSubmissionState" = 'SUBMITTED') = ("externalReference" IS NOT NULL)),
  CHECK ("externalSubmissionState" = 'FAILED' OR "externalFailureReason" IS NULL)
);
CREATE INDEX "pharmacy_pv_org_branch_occurred_idx" ON "pharmacy_pharmacovigilance_reports"("organizationId","branchId","occurredAt");
CREATE FUNCTION pharmacy_pv_reject_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'pharmacovigilance reports cannot be deleted' USING ERRCODE='23514'; END $$;
CREATE TRIGGER pharmacy_pv_no_delete BEFORE DELETE ON "pharmacy_pharmacovigilance_reports" FOR EACH ROW EXECUTE FUNCTION pharmacy_pv_reject_delete();
ALTER TABLE "pharmacy_pharmacovigilance_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_pharmacovigilance_reports" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_branch_isolation ON "pharmacy_pharmacovigilance_reports"
USING (current_setting('app.is_platform_admin',true)='true' OR ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND "branchId"=NULLIF(current_setting('app.current_branch_id',true),'')))
WITH CHECK (current_setting('app.is_platform_admin',true)='true' OR ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND "branchId"=NULLIF(current_setting('app.current_branch_id',true),'')));
