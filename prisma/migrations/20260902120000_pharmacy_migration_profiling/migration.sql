-- WHA-1163 / pharmacy PRD §6.10 MIG-01, MIG-02 — read-only source profiling and
-- the mapping/exception workbench.
--
-- MIG-01 ("source never modified") is enforced twice, on purpose:
--   1. `pharmacy_migration_sources` gets SELECT and INSERT policies only. An
--      UPDATE or DELETE from a row-level-security-subject role matches no policy
--      and therefore no rows.
--   2. A trigger raises on UPDATE/DELETE. Row-level security filters a statement
--      to zero rows SILENTLY, and it does not apply at all to a BYPASSRLS or
--      owner connection. The trigger turns both of those into a loud failure.
--
-- MIG-02 ("missing batch/expiry/MRP is never silently defaulted") is enforced in
-- the profiler, which writes an exception row rather than a default. The schema
-- keeps every parsed field NULLABLE so that a missing value stays missing: there
-- is deliberately no DEFAULT on any parsed column.
--
-- Money and quantities are canonical INTEGERS (minor currency units, canonical
-- dispensable units) — never floating point and never a rounded decimal.

CREATE TYPE "PharmacyMigrationSourceKind" AS ENUM ('ABUZAR', 'EXCEL_CSV');
CREATE TYPE "PharmacyMigrationBatchStatus" AS ENUM ('PROFILING', 'PROFILED', 'FAILED');
CREATE TYPE "PharmacyMigrationExceptionBucket" AS ENUM (
  'MISSING_BATCH',
  'MISSING_EXPIRY',
  'MISSING_MRP',
  'UNIT_AMBIGUOUS',
  'DUPLICATE_PRODUCT',
  'PARTY_UNMATCHED',
  'BALANCE_MISMATCH'
);
CREATE TYPE "PharmacyMigrationExceptionSeverity" AS ENUM ('BLOCKING', 'WARNING');
CREATE TYPE "PharmacyMigrationExceptionStatus" AS ENUM ('OPEN', 'SIGNED_OFF');

-- Immutable evidence of one incumbent export. The bytes themselves are NOT
-- stored here; `contentHash` is the evidence that the file the profiler read is
-- byte-identical to the file the pharmacy handed over.
CREATE TABLE "pharmacy_migration_sources" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "kind" "PharmacyMigrationSourceKind" NOT NULL,
  "fileName" TEXT NOT NULL,
  "byteSize" BIGINT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_migration_sources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_migration_sources_hash_check" CHECK ("contentHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "pharmacy_migration_sources_size_check" CHECK ("byteSize" >= 0),
  CONSTRAINT "pharmacy_migration_sources_file_name_check" CHECK (length(btrim("fileName")) > 0)
);

CREATE TABLE "pharmacy_migration_batches" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "sourceId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "status" "PharmacyMigrationBatchStatus" NOT NULL DEFAULT 'PROFILING',
  "rowCount" INTEGER NOT NULL DEFAULT 0,
  "exceptionCount" INTEGER NOT NULL DEFAULT 0,
  "profilerVersion" TEXT NOT NULL,
  "profiledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_migration_batches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_migration_batches_counts_check" CHECK ("rowCount" >= 0 AND "exceptionCount" >= 0),
  CONSTRAINT "pharmacy_migration_batches_status_time_check" CHECK (
    ("status" = 'PROFILED' AND "profiledAt" IS NOT NULL) OR
    ("status" <> 'PROFILED' AND "profiledAt" IS NULL)
  )
);

-- One incumbent record. `sourceKey` is the stable identity the incumbent gave
-- the record (MIG-01: "every imported row keeps a source key and import batch").
-- `rawPayload` is the untouched header→cell map, so a mapping decision can
-- always be re-derived without going back to the file.
CREATE TABLE "pharmacy_migration_rows" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "batchId" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "rowNumber" INTEGER NOT NULL,
  "rawPayload" JSONB NOT NULL,
  "targetModelKey" TEXT NOT NULL,
  "targetNaturalKey" TEXT,
  "productName" TEXT,
  "packLabel" TEXT,
  "packFactor" BIGINT,
  "barcode" TEXT,
  "batchNumber" TEXT,
  "expiryDate" DATE,
  "mrpMinor" BIGINT,
  "costMinor" BIGINT,
  "quantityCanonical" BIGINT,
  "supplierName" TEXT,
  "customerName" TEXT,
  "balanceMinor" BIGINT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_migration_rows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_migration_rows_source_key_check" CHECK (length(btrim("sourceKey")) > 0),
  CONSTRAINT "pharmacy_migration_rows_row_number_check" CHECK ("rowNumber" >= 1),
  CONSTRAINT "pharmacy_migration_rows_target_model_key_check" CHECK (length(btrim("targetModelKey")) > 0),
  CONSTRAINT "pharmacy_migration_rows_amount_check" CHECK (
    ("mrpMinor" IS NULL OR "mrpMinor" >= 0) AND
    ("costMinor" IS NULL OR "costMinor" >= 0) AND
    ("packFactor" IS NULL OR "packFactor" >= 1)
  )
);

CREATE TABLE "pharmacy_migration_exceptions" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "batchId" TEXT NOT NULL,
  "rowId" TEXT,
  "bucket" "PharmacyMigrationExceptionBucket" NOT NULL,
  "severity" "PharmacyMigrationExceptionSeverity" NOT NULL,
  "status" "PharmacyMigrationExceptionStatus" NOT NULL DEFAULT 'OPEN',
  "detail" TEXT NOT NULL,
  "signedOffByUserId" TEXT,
  "signedOffAt" TIMESTAMP(3),
  "signOffNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_migration_exceptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_migration_exceptions_detail_check" CHECK (length(btrim("detail")) > 0),
  CONSTRAINT "pharmacy_migration_exceptions_sign_off_check" CHECK (
    ("status" = 'OPEN'
      AND "signedOffByUserId" IS NULL AND "signedOffAt" IS NULL AND "signOffNote" IS NULL) OR
    ("status" = 'SIGNED_OFF'
      AND "signedOffByUserId" IS NOT NULL AND "signedOffAt" IS NOT NULL)
  )
);

ALTER TABLE "pharmacy_migration_sources"
  ADD CONSTRAINT "pharmacy_migration_sources_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "pharmacy_migration_sources"
  ADD CONSTRAINT "pharmacy_migration_sources_organizationId_contentHash_key" UNIQUE ("organizationId", "contentHash");
ALTER TABLE "pharmacy_migration_batches"
  ADD CONSTRAINT "pharmacy_migration_batches_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "pharmacy_migration_rows"
  ADD CONSTRAINT "pharmacy_migration_rows_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "pharmacy_migration_rows"
  ADD CONSTRAINT "pharmacy_migration_rows_organizationId_batchId_sourceKey_key" UNIQUE ("organizationId", "batchId", "sourceKey");

ALTER TABLE "pharmacy_migration_batches" ADD CONSTRAINT "pharmacy_migration_batches_tenant_source_fkey"
  FOREIGN KEY ("organizationId", "sourceId") REFERENCES "pharmacy_migration_sources" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_migration_rows" ADD CONSTRAINT "pharmacy_migration_rows_tenant_batch_fkey"
  FOREIGN KEY ("organizationId", "batchId") REFERENCES "pharmacy_migration_batches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_migration_exceptions" ADD CONSTRAINT "pharmacy_migration_exceptions_tenant_batch_fkey"
  FOREIGN KEY ("organizationId", "batchId") REFERENCES "pharmacy_migration_batches" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_migration_exceptions" ADD CONSTRAINT "pharmacy_migration_exceptions_tenant_row_fkey"
  FOREIGN KEY ("organizationId", "rowId") REFERENCES "pharmacy_migration_rows" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "pharmacy_migration_exceptions" ADD CONSTRAINT "pharmacy_migration_exceptions_tenant_signer_fkey"
  FOREIGN KEY ("organizationId", "signedOffByUserId") REFERENCES "users" ("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "pharmacy_migration_sources_organizationId_kind_capturedAt_idx"
  ON "pharmacy_migration_sources" ("organizationId", "kind", "capturedAt");
CREATE INDEX "pharmacy_migration_batches_organizationId_sourceId_status_idx"
  ON "pharmacy_migration_batches" ("organizationId", "sourceId", "status");
CREATE INDEX "pharmacy_migration_rows_organizationId_batchId_targetModelKey_idx"
  ON "pharmacy_migration_rows" ("organizationId", "batchId", "targetModelKey");
CREATE INDEX "pharmacy_migration_rows_organizationId_targetModelKey_targetNaturalKey_idx"
  ON "pharmacy_migration_rows" ("organizationId", "targetModelKey", "targetNaturalKey");
CREATE INDEX "pharmacy_migration_exceptions_organizationId_batchId_bucket_idx"
  ON "pharmacy_migration_exceptions" ("organizationId", "batchId", "bucket");
CREATE INDEX "pharmacy_migration_exceptions_organizationId_batchId_status_severity_idx"
  ON "pharmacy_migration_exceptions" ("organizationId", "batchId", "status", "severity");
CREATE INDEX "pharmacy_migration_exceptions_organizationId_rowId_idx"
  ON "pharmacy_migration_exceptions" ("organizationId", "rowId");

-- MIG-01 second guard. Fires for owner/BYPASSRLS connections too, which is
-- exactly the class of connection the policies below cannot constrain.
CREATE FUNCTION prevent_pharmacy_migration_source_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'pharmacy migration sources are read-only evidence and are never modified'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pharmacy_migration_sources_read_only"
  BEFORE UPDATE OR DELETE ON "pharmacy_migration_sources"
  FOR EACH ROW EXECUTE FUNCTION prevent_pharmacy_migration_source_mutation();

-- A profiled row is evidence of what the profiler read. Re-profiling produces a
-- NEW batch rather than editing rows, so the only legal change is none.
CREATE FUNCTION prevent_pharmacy_migration_row_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'pharmacy migration rows are append-only; re-profile into a new batch'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pharmacy_migration_rows_append_only"
  BEFORE UPDATE OR DELETE ON "pharmacy_migration_rows"
  FOR EACH ROW EXECUTE FUNCTION prevent_pharmacy_migration_row_mutation();

-- An exception's identity (which row, which bucket, why) is what the pharmacist
-- signs off on, so it cannot drift after the fact. Sign-off is one-way.
CREATE FUNCTION guard_pharmacy_migration_exception_update() RETURNS trigger AS $$
BEGIN
  IF (NEW."organizationId", NEW."batchId", NEW."rowId", NEW."bucket", NEW."severity",
      NEW."detail", NEW."createdAt") IS DISTINCT FROM
     (OLD."organizationId", OLD."batchId", OLD."rowId", OLD."bucket", OLD."severity",
      OLD."detail", OLD."createdAt") THEN
    RAISE EXCEPTION 'pharmacy migration exception identity is immutable; only sign-off may change'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."status" = 'SIGNED_OFF' THEN
    RAISE EXCEPTION 'pharmacy migration exception sign-off is final' USING ERRCODE = '55000';
  END IF;

  IF NEW."status" = 'SIGNED_OFF' AND NEW."signedOffAt" IS NULL THEN
    RAISE EXCEPTION 'pharmacy migration exception sign-off requires an actor and a time'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pharmacy_migration_exceptions_sign_off_guard"
  BEFORE UPDATE ON "pharmacy_migration_exceptions"
  FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_migration_exception_update();

CREATE FUNCTION prevent_pharmacy_migration_exception_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'pharmacy migration exceptions are never deleted' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pharmacy_migration_exceptions_no_delete"
  BEFORE DELETE ON "pharmacy_migration_exceptions"
  FOR EACH ROW EXECUTE FUNCTION prevent_pharmacy_migration_exception_delete();

ALTER TABLE "pharmacy_migration_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_migration_sources" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pharmacy_migration_sources_tenant_select" ON "pharmacy_migration_sources"
  FOR SELECT USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "pharmacy_migration_sources_tenant_insert" ON "pharmacy_migration_sources"
  FOR INSERT WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "pharmacy_migration_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_migration_batches" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pharmacy_migration_batches_tenant_select" ON "pharmacy_migration_batches"
  FOR SELECT USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "pharmacy_migration_batches_tenant_insert" ON "pharmacy_migration_batches"
  FOR INSERT WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "pharmacy_migration_batches_tenant_update" ON "pharmacy_migration_batches"
  FOR UPDATE USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "pharmacy_migration_rows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_migration_rows" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pharmacy_migration_rows_tenant_select" ON "pharmacy_migration_rows"
  FOR SELECT USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "pharmacy_migration_rows_tenant_insert" ON "pharmacy_migration_rows"
  FOR INSERT WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "pharmacy_migration_exceptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_migration_exceptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pharmacy_migration_exceptions_tenant_select" ON "pharmacy_migration_exceptions"
  FOR SELECT USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "pharmacy_migration_exceptions_tenant_insert" ON "pharmacy_migration_exceptions"
  FOR INSERT WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "pharmacy_migration_exceptions_tenant_update" ON "pharmacy_migration_exceptions"
  FOR UPDATE USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
