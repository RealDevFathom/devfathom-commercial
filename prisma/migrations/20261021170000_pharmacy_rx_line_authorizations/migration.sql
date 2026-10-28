-- SEC: server-side prescription gate for Rx / restricted (non-controlled) sale lines.
-- One append-only row per sale line records either the linked prescription line or an
-- audited pharmacist override (pharmacist + reason). Tender/complete re-check this.
CREATE TABLE "pharmacy_rx_line_authorizations" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "saleLineId" TEXT NOT NULL,
  "medicineId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "prescriptionLineId" TEXT,
  "pharmacistUserId" TEXT NOT NULL,
  "recordedByUserId" TEXT NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId","id"),
  UNIQUE ("organizationId","saleLineId"),
  FOREIGN KEY ("organizationId","prescriptionLineId") REFERENCES "pharmacy_prescription_lines"("organizationId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_rx_line_authorizations_kind_check" CHECK (
    ("kind"='PRESCRIPTION' AND "prescriptionLineId" IS NOT NULL)
    OR ("kind"='OVERRIDE' AND "prescriptionLineId" IS NULL AND length(btrim(coalesce("reason",''))) > 0)
  )
);
CREATE TRIGGER pharmacy_rx_line_authorizations_append_only BEFORE UPDATE OR DELETE ON "pharmacy_rx_line_authorizations" FOR EACH ROW EXECUTE FUNCTION pharmacy_rx_append_only();
ALTER TABLE "pharmacy_rx_line_authorizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_rx_line_authorizations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_rx_line_authorizations"
  USING (current_setting('app.is_platform_admin',true)='true' OR "organizationId"=NULLIF(current_setting('app.current_organization_id',true),''))
  WITH CHECK (current_setting('app.is_platform_admin',true)='true' OR "organizationId"=NULLIF(current_setting('app.current_organization_id',true),''));
