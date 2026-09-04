-- SUP-01/SUP-03, PRD invariants 24-28. Supplier traffic is limited to one
-- active relationship and one PO. All inbound records are append-only evidence.
CREATE TYPE "PharmacySupplierSubmissionKind" AS ENUM ('ACKNOWLEDGEMENT','REJECTION','PARTIAL_ACCEPTANCE','ETA','SUBSTITUTION_PROPOSAL','DOCUMENT');
CREATE TYPE "PharmacySupplierSubmissionSource" AS ENUM ('SIGNED_LINK','PHONE','WHATSAPP');

CREATE TABLE "pharmacy_supplier_relationships" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "supplierId" TEXT NOT NULL, "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "revokedAt" TIMESTAMP(3),
  UNIQUE ("organizationId","id"), UNIQUE ("organizationId","branchId","supplierId"),
  FOREIGN KEY ("organizationId","supplierId") REFERENCES "pharmacy_suppliers"("organizationId","id") ON DELETE RESTRICT,
  CHECK (("active" = true AND "revokedAt" IS NULL) OR ("active" = false AND "revokedAt" IS NOT NULL))
);
CREATE INDEX "pharmacy_supplier_relationships_organizationId_branchId_active_idx" ON "pharmacy_supplier_relationships"("organizationId","branchId","active");

CREATE TABLE "pharmacy_supplier_action_links" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "supplierRelationshipId" TEXT NOT NULL, "purchaseOrderId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL UNIQUE, "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3),
  "createdByUserId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId","id"), UNIQUE ("organizationId","supplierRelationshipId","purchaseOrderId"),
  FOREIGN KEY ("organizationId","supplierRelationshipId") REFERENCES "pharmacy_supplier_relationships"("organizationId","id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId","purchaseOrderId") REFERENCES "pharmacy_purchase_orders"("organizationId","id") ON DELETE RESTRICT,
  CHECK ("expiresAt" > "createdAt")
);
CREATE INDEX "pharmacy_supplier_action_links_organizationId_branchId_expiresAt_idx" ON "pharmacy_supplier_action_links"("organizationId","branchId","expiresAt");

CREATE TABLE "pharmacy_supplier_submissions" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "actionLinkId" TEXT NOT NULL, "versionGroupId" TEXT NOT NULL,
  "version" INTEGER NOT NULL CHECK ("version" > 0), "supersedesId" TEXT,
  "kind" "PharmacySupplierSubmissionKind" NOT NULL, "source" "PharmacySupplierSubmissionSource" NOT NULL,
  "idempotencyKey" TEXT NOT NULL, "payload" JSONB NOT NULL, "sourceEvidence" TEXT,
  "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId","id"), UNIQUE ("organizationId","actionLinkId","idempotencyKey"),
  UNIQUE ("organizationId","versionGroupId","version"),
  FOREIGN KEY ("organizationId","actionLinkId") REFERENCES "pharmacy_supplier_action_links"("organizationId","id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId","supersedesId") REFERENCES "pharmacy_supplier_submissions"("organizationId","id") ON DELETE RESTRICT,
  CHECK (("source" = 'SIGNED_LINK' AND "sourceEvidence" IS NULL) OR ("source" <> 'SIGNED_LINK' AND length(btrim("sourceEvidence")) > 0))
);
CREATE INDEX "pharmacy_supplier_submissions_organizationId_branchId_submittedAt_idx" ON "pharmacy_supplier_submissions"("organizationId","branchId","submittedAt");

CREATE TABLE "pharmacy_supplier_documents" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "submissionId" TEXT NOT NULL, "fileName" TEXT NOT NULL, "mimeType" TEXT NOT NULL,
  "byteSize" INTEGER NOT NULL CHECK ("byteSize" > 0 AND "byteSize" <= 10485760),
  "sha256" TEXT NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'), "storageUri" TEXT NOT NULL,
  "scanMode" TEXT NOT NULL, "malwareChecked" BOOLEAN NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId","id"), UNIQUE ("organizationId","submissionId","sha256"),
  FOREIGN KEY ("organizationId","submissionId") REFERENCES "pharmacy_supplier_submissions"("organizationId","id") ON DELETE RESTRICT,
  CHECK ("mimeType" IN ('application/pdf','image/png','image/jpeg')),
  CHECK ("scanMode" IN ('STRUCTURAL','MALWARE_SCANNED')),
  CHECK (("scanMode" = 'STRUCTURAL' AND "malwareChecked" = false) OR ("scanMode" = 'MALWARE_SCANNED' AND "malwareChecked" = true))
);
CREATE INDEX "pharmacy_supplier_documents_organizationId_branchId_createdAt_idx" ON "pharmacy_supplier_documents"("organizationId","branchId","createdAt");

CREATE TABLE "pharmacy_supplier_submission_approvals" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "submissionId" TEXT NOT NULL, "actorUserId" TEXT NOT NULL,
  "approved" BOOLEAN NOT NULL, "reason" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId","id"),
  FOREIGN KEY ("organizationId","submissionId") REFERENCES "pharmacy_supplier_submissions"("organizationId","id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_supplier_submission_approvals_organizationId_branchId_submissionId_createdAt_idx" ON "pharmacy_supplier_submission_approvals"("organizationId","branchId","submissionId","createdAt");

CREATE FUNCTION pharmacy_supplier_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rel RECORD; po RECORD;
BEGIN
  SELECT * INTO rel FROM pharmacy_supplier_relationships WHERE "organizationId"=NEW."organizationId" AND id=NEW."supplierRelationshipId";
  SELECT * INTO po FROM pharmacy_purchase_orders WHERE "organizationId"=NEW."organizationId" AND id=NEW."purchaseOrderId";
  IF rel.id IS NULL OR po.id IS NULL OR rel."supplierId" <> po."supplierId" OR rel."branchId" <> po."branchId" OR NEW."branchId" <> rel."branchId" THEN
    RAISE EXCEPTION 'supplier link relationship/order mismatch' USING ERRCODE='23514';
  END IF;
  IF rel.active IS NOT TRUE OR rel."revokedAt" IS NOT NULL THEN RAISE EXCEPTION 'supplier relationship inactive' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_supplier_link_scope BEFORE INSERT OR UPDATE ON pharmacy_supplier_action_links FOR EACH ROW EXECUTE FUNCTION pharmacy_supplier_link_guard();

CREATE FUNCTION pharmacy_supplier_submission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE link RECORD; prior RECORD;
BEGIN
  SELECT * INTO link FROM pharmacy_supplier_action_links WHERE "organizationId"=NEW."organizationId" AND id=NEW."actionLinkId";
  IF link.id IS NULL OR NEW."branchId" <> link."branchId" THEN RAISE EXCEPTION 'supplier submission link mismatch' USING ERRCODE='23514'; END IF;
  IF NEW."supersedesId" IS NULL THEN
    IF NEW.version <> 1 OR NEW."versionGroupId" <> NEW.id THEN RAISE EXCEPTION 'first supplier submission version invalid' USING ERRCODE='23514'; END IF;
  ELSE
    SELECT * INTO prior FROM pharmacy_supplier_submissions WHERE "organizationId"=NEW."organizationId" AND id=NEW."supersedesId";
    IF prior.id IS NULL OR prior."actionLinkId" <> NEW."actionLinkId" OR prior.kind <> NEW.kind OR prior."versionGroupId" <> NEW."versionGroupId" OR NEW.version <> prior.version + 1 THEN
      RAISE EXCEPTION 'supplier correction chain mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_supplier_submission_scope BEFORE INSERT ON pharmacy_supplier_submissions FOR EACH ROW EXECUTE FUNCTION pharmacy_supplier_submission_guard();

CREATE FUNCTION pharmacy_supplier_reject_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% is append-only',TG_TABLE_NAME USING ERRCODE='23514'; END $$;
CREATE TRIGGER pharmacy_supplier_submission_append_only BEFORE UPDATE OR DELETE ON pharmacy_supplier_submissions FOR EACH ROW EXECUTE FUNCTION pharmacy_supplier_reject_append_only();
CREATE TRIGGER pharmacy_supplier_document_append_only BEFORE UPDATE OR DELETE ON pharmacy_supplier_documents FOR EACH ROW EXECUTE FUNCTION pharmacy_supplier_reject_append_only();
CREATE TRIGGER pharmacy_supplier_approval_append_only BEFORE UPDATE OR DELETE ON pharmacy_supplier_submission_approvals FOR EACH ROW EXECUTE FUNCTION pharmacy_supplier_reject_append_only();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_supplier_relationships','pharmacy_supplier_action_links','pharmacy_supplier_submissions','pharmacy_supplier_documents','pharmacy_supplier_submission_approvals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY %I ON %I USING (current_setting(''app.is_platform_admin'',true)=''true'' OR ("organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),'''') AND (NULLIF(current_setting(''app.current_branch_id'',true),'''') IS NULL OR "branchId"=current_setting(''app.current_branch_id'',true)))) WITH CHECK (current_setting(''app.is_platform_admin'',true)=''true'' OR ("organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),'''') AND (NULLIF(current_setting(''app.current_branch_id'',true),'''') IS NULL OR "branchId"=current_setting(''app.current_branch_id'',true))))','supplier_tenant_branch_'||t,t);
  END LOOP;
END $$;
