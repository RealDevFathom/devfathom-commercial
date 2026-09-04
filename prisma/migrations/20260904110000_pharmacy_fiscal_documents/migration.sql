-- FIN-05 / D04: an explicit, disabled-by-default fiscal integration contract.
CREATE TYPE "PharmacyFiscalIntegratorMode" AS ENUM ('OFF', 'SANDBOX');
CREATE TYPE "PharmacyFiscalDocumentKind" AS ENUM ('INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE');
CREATE TYPE "PharmacyFiscalDocumentStatus" AS ENUM ('QUEUED', 'SUBMITTING', 'ACCEPTED', 'REJECTED', 'DEAD');

CREATE TABLE "pharmacy_fiscal_configurations" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "integratorMode" "PharmacyFiscalIntegratorMode" NOT NULL DEFAULT 'OFF',
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "baseRetrySeconds" INTEGER NOT NULL DEFAULT 60,
  "updatedByActorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_fiscal_configurations_org_key" UNIQUE ("organizationId"),
  CONSTRAINT "pharmacy_fiscal_configurations_retry_check" CHECK ("maxAttempts" BETWEEN 1 AND 10 AND "baseRetrySeconds" BETWEEN 1 AND 3600)
);

CREATE TABLE "pharmacy_fiscal_documents" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "saleId" TEXT,
  "kind" "PharmacyFiscalDocumentKind" NOT NULL,
  "originalDocumentId" TEXT,
  "localReference" TEXT NOT NULL,
  "externalReference" TEXT,
  "externalQr" TEXT,
  "integratorMode" "PharmacyFiscalIntegratorMode" NOT NULL,
  "status" "PharmacyFiscalDocumentStatus" NOT NULL DEFAULT 'QUEUED',
  "payload" JSONB NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL,
  "nextAttemptAt" TIMESTAMP(3),
  "submittedAt" TIMESTAMP(3),
  "acceptedAt" TIMESTAMP(3),
  "rejectedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "retentionUntil" TIMESTAMP(3) NOT NULL,
  "createdByActorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_fiscal_documents_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_fiscal_documents_org_branch_id_key" UNIQUE ("organizationId", "branchId", "id"),
  CONSTRAINT "pharmacy_fiscal_documents_local_ref_key" UNIQUE ("organizationId", "localReference"),
  CONSTRAINT "pharmacy_fiscal_documents_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_fiscal_documents_sale_fkey" FOREIGN KEY ("organizationId", "branchId", "saleId") REFERENCES "pharmacy_sales" ("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_fiscal_documents_original_fkey" FOREIGN KEY ("organizationId", "branchId", "originalDocumentId") REFERENCES "pharmacy_fiscal_documents" ("organizationId", "branchId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_fiscal_documents_link_check" CHECK (("kind" = 'INVOICE' AND "originalDocumentId" IS NULL) OR ("kind" IN ('CREDIT_NOTE', 'DEBIT_NOTE') AND "originalDocumentId" IS NOT NULL)),
  CONSTRAINT "pharmacy_fiscal_documents_attempt_check" CHECK ("maxAttempts" BETWEEN 1 AND 10 AND "attempts" BETWEEN 0 AND "maxAttempts"),
  CONSTRAINT "pharmacy_fiscal_documents_sandbox_check" CHECK ("integratorMode" <> 'SANDBOX' OR ("externalQr" IS NULL AND ("externalReference" IS NULL OR "externalReference" LIKE 'SANDBOX-%'))),
  CONSTRAINT "pharmacy_fiscal_documents_off_check" CHECK ("integratorMode" <> 'OFF' OR ("status" = 'DEAD' AND "externalReference" IS NULL AND "externalQr" IS NULL)),
  CONSTRAINT "pharmacy_fiscal_documents_retention_check" CHECK ("retentionUntil" >= "createdAt" + INTERVAL '6 years')
);
CREATE INDEX "pharmacy_fiscal_documents_queue_idx" ON "pharmacy_fiscal_documents" ("organizationId", "branchId", "status", "nextAttemptAt");
CREATE INDEX "pharmacy_fiscal_documents_age_idx" ON "pharmacy_fiscal_documents" ("organizationId", "branchId", "createdAt");
CREATE UNIQUE INDEX "pharmacy_fiscal_documents_external_ref_key" ON "pharmacy_fiscal_documents" ("organizationId", "externalReference") WHERE "externalReference" IS NOT NULL;

CREATE FUNCTION pharmacy_assert_fiscal_original_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original_kind "PharmacyFiscalDocumentKind";
BEGIN
  IF NEW."kind" IN ('CREDIT_NOTE','DEBIT_NOTE') THEN
    SELECT "kind" INTO original_kind FROM "pharmacy_fiscal_documents"
     WHERE "organizationId"=NEW."organizationId" AND "branchId"=NEW."branchId"
       AND "id"=NEW."originalDocumentId";
    IF original_kind IS DISTINCT FROM 'INVOICE' THEN
      RAISE EXCEPTION 'credit and debit notes must link to an original invoice' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_fiscal_documents_original_invoice
BEFORE INSERT ON "pharmacy_fiscal_documents"
FOR EACH ROW EXECUTE FUNCTION pharmacy_assert_fiscal_original_invoice();

CREATE TABLE "pharmacy_fiscal_document_events" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  "fromStatus" "PharmacyFiscalDocumentStatus",
  "toStatus" "PharmacyFiscalDocumentStatus" NOT NULL,
  "attempt" INTEGER NOT NULL,
  "detail" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_fiscal_document_events_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_fiscal_document_events_document_fkey" FOREIGN KEY ("organizationId", "branchId", "documentId") REFERENCES "pharmacy_fiscal_documents" ("organizationId", "branchId", "id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_fiscal_document_events_document_idx" ON "pharmacy_fiscal_document_events" ("organizationId", "branchId", "documentId", "occurredAt");

CREATE FUNCTION pharmacy_refuse_fiscal_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'fiscal records have a six-year minimum retention and cannot be hard-deleted' USING ERRCODE='55000';
END $$;
CREATE TRIGGER pharmacy_fiscal_documents_no_delete BEFORE DELETE ON "pharmacy_fiscal_documents" FOR EACH ROW EXECUTE FUNCTION pharmacy_refuse_fiscal_delete();
CREATE TRIGGER pharmacy_fiscal_document_events_append_only BEFORE UPDATE OR DELETE ON "pharmacy_fiscal_document_events" FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();

CREATE FUNCTION pharmacy_guard_fiscal_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."branchId" <> OLD."branchId"
     OR NEW."kind" <> OLD."kind" OR NEW."localReference" <> OLD."localReference"
     OR NEW."payloadHash" <> OLD."payloadHash" OR NEW."payload" <> OLD."payload"
     OR NEW."originalDocumentId" IS DISTINCT FROM OLD."originalDocumentId"
     OR NEW."retentionUntil" <> OLD."retentionUntil" THEN
    RAISE EXCEPTION 'fiscal document identity, payload, linkage, and retention are immutable' USING ERRCODE='55000';
  END IF;
  IF NOT ((OLD."status"='QUEUED' AND NEW."status"='SUBMITTING') OR
          (OLD."status"='SUBMITTING' AND NEW."status" IN ('QUEUED','ACCEPTED','REJECTED','DEAD'))) THEN
    RAISE EXCEPTION 'invalid fiscal lifecycle transition % -> %', OLD."status", NEW."status" USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pharmacy_fiscal_documents_transition
BEFORE UPDATE ON "pharmacy_fiscal_documents"
FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_fiscal_transition();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_fiscal_configurations','pharmacy_fiscal_documents','pharmacy_fiscal_document_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'',true)=''true'' OR "organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),'''')) WITH CHECK (current_setting(''app.is_platform_admin'',true)=''true'' OR "organizationId"=NULLIF(current_setting(''app.current_organization_id'',true),''''))', t);
  END LOOP;
END $$;

DROP POLICY tenant_isolation ON "pharmacy_fiscal_documents";
CREATE POLICY tenant_branch_isolation ON "pharmacy_fiscal_documents"
USING (current_setting('app.is_platform_admin',true)='true' OR ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR "branchId"=current_setting('app.current_branch_id',true))))
WITH CHECK (current_setting('app.is_platform_admin',true)='true' OR ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR "branchId"=current_setting('app.current_branch_id',true))));
DROP POLICY tenant_isolation ON "pharmacy_fiscal_document_events";
CREATE POLICY tenant_branch_isolation ON "pharmacy_fiscal_document_events"
USING (current_setting('app.is_platform_admin',true)='true' OR ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR "branchId"=current_setting('app.current_branch_id',true))))
WITH CHECK (current_setting('app.is_platform_admin',true)='true' OR ("organizationId"=NULLIF(current_setting('app.current_organization_id',true),'') AND (NULLIF(current_setting('app.current_branch_id',true),'') IS NULL OR "branchId"=current_setting('app.current_branch_id',true))));
