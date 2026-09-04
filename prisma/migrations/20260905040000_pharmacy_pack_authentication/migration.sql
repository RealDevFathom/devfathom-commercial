-- WHA-1336 / SAFE-05 — advisory pack authentication at receiving and dispensing.
CREATE TYPE "PharmacyPackAuthenticationSource" AS ENUM ('RECEIVING','DISPENSING');
CREATE TYPE "PharmacyPackAuthenticationStatus" AS ENUM ('VERIFIED','FLAGGED','NOT_VERIFIABLE','BLOCKED_RECALL');
CREATE TYPE "PharmacyPackAuthenticationEventKind" AS ENUM ('SCANNED','ACKNOWLEDGED');

CREATE TABLE "pharmacy_pack_authentication_scans" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "source" "PharmacyPackAuthenticationSource" NOT NULL,
  "status" "PharmacyPackAuthenticationStatus" NOT NULL,
  "gtin" TEXT,
  "batchNumber" TEXT,
  "expiresOn" TEXT,
  "serial" TEXT,
  "medicineId" TEXT,
  "manufacturingBatchId" TEXT,
  "issues" TEXT[] NOT NULL,
  "explanation" TEXT NOT NULL,
  "advisory" BOOLEAN NOT NULL,
  "scannedByUserId" TEXT NOT NULL,
  "acknowledgedAt" TIMESTAMP(3),
  "acknowledgedByUserId" TEXT,
  "acknowledgementReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_pack_authentication_scans_branch_fkey" FOREIGN KEY ("organizationId","branchId") REFERENCES "pharmacy_branches"("organizationId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_pack_authentication_scans_org_id_key" UNIQUE ("organizationId","id"),
  CONSTRAINT "pharmacy_pack_authentication_scans_org_branch_id_key" UNIQUE ("organizationId","branchId","id"),
  CONSTRAINT "pharmacy_pack_authentication_scans_text_check" CHECK (length(btrim("explanation"))>0 AND length(btrim("scannedByUserId"))>0),
  CONSTRAINT "pharmacy_pack_authentication_scans_gtin_check" CHECK ("gtin" IS NULL OR "gtin" ~ '^[0-9]{14}$'),
  CONSTRAINT "pharmacy_pack_authentication_scans_ack_check" CHECK (("acknowledgedAt" IS NULL AND "acknowledgedByUserId" IS NULL AND "acknowledgementReason" IS NULL) OR ("acknowledgedAt" IS NOT NULL AND length(btrim("acknowledgedByUserId"))>0 AND length(btrim("acknowledgementReason"))>0)),
  CONSTRAINT "pharmacy_pack_authentication_scans_verified_check" CHECK ("status"<>'VERIFIED' OR cardinality("issues")=0),
  CONSTRAINT "pharmacy_pack_authentication_scans_recall_check" CHECK (("status"='BLOCKED_RECALL')=("issues" @> ARRAY['RECALLED_BATCH']::TEXT[]))
);
CREATE INDEX "pharmacy_pack_auth_scans_org_branch_status_idx" ON "pharmacy_pack_authentication_scans"("organizationId","branchId","status","createdAt" DESC);
CREATE INDEX "pharmacy_pack_auth_scans_org_serial_idx" ON "pharmacy_pack_authentication_scans"("organizationId","serial");

CREATE TABLE "pharmacy_pack_authentication_events" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "scanId" TEXT NOT NULL,
  "kind" "PharmacyPackAuthenticationEventKind" NOT NULL,
  "actorId" TEXT NOT NULL,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_pack_authentication_events_scan_fkey" FOREIGN KEY ("organizationId","branchId","scanId") REFERENCES "pharmacy_pack_authentication_scans"("organizationId","branchId","id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_pack_authentication_events_org_id_key" UNIQUE ("organizationId","id"),
  CONSTRAINT "pharmacy_pack_authentication_events_actor_check" CHECK (length(btrim("actorId"))>0),
  CONSTRAINT "pharmacy_pack_authentication_events_reason_check" CHECK ("kind"<>'ACKNOWLEDGED' OR ("reason" IS NOT NULL AND length(btrim("reason"))>0))
);
CREATE INDEX "pharmacy_pack_authentication_events_org_scan_idx" ON "pharmacy_pack_authentication_events"("organizationId","branchId","scanId","createdAt");

CREATE TRIGGER pharmacy_pack_authentication_events_append_only BEFORE UPDATE OR DELETE ON "pharmacy_pack_authentication_events" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
CREATE TRIGGER pharmacy_pack_authentication_scans_no_delete BEFORE DELETE ON "pharmacy_pack_authentication_scans" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_delete();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_pack_authentication_scans','pharmacy_pack_authentication_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_branch_isolation ON %I USING (current_setting(''app.is_platform_admin'',true)=''true'' OR ("organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),'''') AND (NULLIF(current_setting(''app.current_branch_id'',true),'''') IS NULL OR "branchId"=current_setting(''app.current_branch_id'',true)))) WITH CHECK (current_setting(''app.is_platform_admin'',true)=''true'' OR ("organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),'''') AND (NULLIF(current_setting(''app.current_branch_id'',true),'''') IS NULL OR "branchId"=current_setting(''app.current_branch_id'',true))))', t);
  END LOOP;
END $$;
