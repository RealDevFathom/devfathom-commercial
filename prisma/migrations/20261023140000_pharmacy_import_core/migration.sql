-- Import 1/5 CORE: extend the existing PH-MIG evidence/staging tables.
ALTER TYPE "PharmacyMigrationBatchStatus" RENAME TO "PharmacyMigrationBatchStatus_old";
CREATE TYPE "PharmacyMigrationBatchStatus" AS ENUM
  ('UPLOADED','PARSING','PREVIEW','COMMITTING','COMMITTED','ROLLED_BACK','FAILED');
ALTER TABLE "pharmacy_migration_batches" DROP CONSTRAINT "pharmacy_migration_batches_status_time_check";
ALTER TABLE "pharmacy_migration_batches" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "pharmacy_migration_batches" ALTER COLUMN "status" TYPE "PharmacyMigrationBatchStatus"
  USING (CASE "status"::text WHEN 'PROFILING' THEN 'PARSING' WHEN 'PROFILED' THEN 'PREVIEW' ELSE "status"::text END)::"PharmacyMigrationBatchStatus";
ALTER TABLE "pharmacy_migration_batches" ALTER COLUMN "status" SET DEFAULT 'UPLOADED';
DROP TYPE "PharmacyMigrationBatchStatus_old";
ALTER TABLE "pharmacy_migration_batches" ADD CONSTRAINT "pharmacy_migration_batches_status_time_check" CHECK (
 ("status" IN ('PREVIEW','COMMITTING','COMMITTED','ROLLED_BACK') AND "profiledAt" IS NOT NULL) OR
 ("status" NOT IN ('PREVIEW','COMMITTING','COMMITTED','ROLLED_BACK'))
);

CREATE TYPE "PharmacyMigrationEntityOperation" AS ENUM ('CREATED','STOCK_MOVEMENT');
-- Existing evidence has no truthful branch provenance. Refuse an unsafe guessed backfill.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM "pharmacy_migration_sources") THEN
   RAISE EXCEPTION 'existing pharmacy migration evidence requires an explicit branch remediation before import-core';
 END IF;
END $$;
ALTER TABLE "pharmacy_migration_sources"
 ADD COLUMN "branchId" TEXT NOT NULL,
 ADD COLUMN "createdByUserId" TEXT,
 ADD COLUMN "createdBySystem" BOOLEAN NOT NULL DEFAULT false,
 ADD CONSTRAINT "pharmacy_migration_sources_actor_check" CHECK (("createdByUserId" IS NOT NULL) <> "createdBySystem"),
 ADD CONSTRAINT "pharmacy_migration_sources_branch_fkey" FOREIGN KEY ("organizationId","branchId") REFERENCES "pharmacy_branches"("organizationId","id") ON DELETE RESTRICT,
 ADD CONSTRAINT "pharmacy_migration_sources_actor_fkey" FOREIGN KEY ("organizationId","createdByUserId") REFERENCES "users"("organizationId","id") ON DELETE RESTRICT;
ALTER TABLE "pharmacy_migration_sources" DROP CONSTRAINT "pharmacy_migration_sources_organizationId_contentHash_key";
ALTER TABLE "pharmacy_migration_sources" ADD CONSTRAINT "pharmacy_migration_sources_branch_hash_key" UNIQUE ("organizationId","branchId","contentHash");
CREATE INDEX "pharmacy_migration_sources_branch_kind_idx" ON "pharmacy_migration_sources"("organizationId","branchId","kind","capturedAt");
ALTER TABLE "pharmacy_migration_sources" ADD CONSTRAINT "pharmacy_migration_sources_org_branch_id_key" UNIQUE ("organizationId","branchId","id");
ALTER TABLE "pharmacy_migration_batches"
 ADD COLUMN "branchId" TEXT NOT NULL,
 ADD COLUMN "createdByUserId" TEXT,
 ADD COLUMN "createdBySystem" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "committedAt" TIMESTAMP(3), ADD COLUMN "rolledBackAt" TIMESTAMP(3), ADD COLUMN "failureReason" TEXT,
 ADD CONSTRAINT "pharmacy_migration_batches_actor_check" CHECK (("createdByUserId" IS NOT NULL) <> "createdBySystem"),
 ADD CONSTRAINT "pharmacy_migration_batches_branch_fkey" FOREIGN KEY ("organizationId","branchId") REFERENCES "pharmacy_branches"("organizationId","id") ON DELETE RESTRICT,
 ADD CONSTRAINT "pharmacy_migration_batches_actor_fkey" FOREIGN KEY ("organizationId","createdByUserId") REFERENCES "users"("organizationId","id") ON DELETE RESTRICT,
 ADD CONSTRAINT "pharmacy_migration_batches_branch_source_fkey" FOREIGN KEY ("organizationId","branchId","sourceId") REFERENCES "pharmacy_migration_sources"("organizationId","branchId","id") ON DELETE RESTRICT;
ALTER TABLE "pharmacy_migration_batches" ADD CONSTRAINT "pharmacy_migration_batches_org_branch_id_key" UNIQUE ("organizationId","branchId","id");
CREATE TABLE "pharmacy_migration_batch_entities" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
 "batchId" TEXT NOT NULL, "branchId" TEXT NOT NULL, "rowSourceKey" TEXT NOT NULL, "entityType" TEXT NOT NULL, "entityId" TEXT NOT NULL,
 "operation" "PharmacyMigrationEntityOperation" NOT NULL, "reversedById" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "pharmacy_migration_batch_entities_batch_fkey" FOREIGN KEY ("organizationId","branchId","batchId") REFERENCES "pharmacy_migration_batches"("organizationId","branchId","id") ON DELETE RESTRICT,
 CONSTRAINT "pharmacy_migration_batch_entities_org_id_key" UNIQUE ("organizationId","id"),
 CONSTRAINT "pharmacy_migration_batch_entities_row_entity_key" UNIQUE ("organizationId","batchId","rowSourceKey","entityType","entityId","operation")
);
CREATE INDEX "pharmacy_migration_batch_entities_batch_operation_idx" ON "pharmacy_migration_batch_entities"("organizationId","branchId","batchId","operation");
ALTER TABLE "pharmacy_migration_batch_entities" ADD CONSTRAINT "pharmacy_migration_batch_entities_branch_fkey" FOREIGN KEY ("organizationId","branchId") REFERENCES "pharmacy_branches"("organizationId","id") ON DELETE RESTRICT;
CREATE FUNCTION guard_pharmacy_migration_batch_entity_update() RETURNS trigger AS $$
BEGIN
 IF (NEW."organizationId",NEW."batchId",NEW."rowSourceKey",NEW."entityType",NEW."entityId",NEW."operation",NEW."createdAt") IS DISTINCT FROM
    (OLD."organizationId",OLD."batchId",OLD."rowSourceKey",OLD."entityType",OLD."entityId",OLD."operation",OLD."createdAt") THEN
   RAISE EXCEPTION 'pharmacy import commit manifest identity is immutable' USING ERRCODE = '55000';
 END IF;
 IF OLD."reversedById" IS NOT NULL THEN RAISE EXCEPTION 'pharmacy import reversal link is final' USING ERRCODE = '55000'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "pharmacy_migration_batch_entities_update_guard" BEFORE UPDATE ON "pharmacy_migration_batch_entities"
 FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_migration_batch_entity_update();
CREATE FUNCTION prevent_pharmacy_migration_batch_entity_delete() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'pharmacy import commit manifests are never deleted' USING ERRCODE = '55000'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER "pharmacy_migration_batch_entities_no_delete" BEFORE DELETE ON "pharmacy_migration_batch_entities"
 FOR EACH ROW EXECUTE FUNCTION prevent_pharmacy_migration_batch_entity_delete();
ALTER TABLE "pharmacy_migration_batch_entities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_migration_batch_entities" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pharmacy_migration_batch_entities_tenant_select" ON "pharmacy_migration_batch_entities" FOR SELECT
 USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "pharmacy_migration_batch_entities_tenant_insert" ON "pharmacy_migration_batch_entities" FOR INSERT
 WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
CREATE POLICY "pharmacy_migration_batch_entities_tenant_update" ON "pharmacy_migration_batch_entities" FOR UPDATE
 USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
 WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));


ALTER TABLE "pharmacy_migration_rows" ADD COLUMN "branchId" TEXT NOT NULL;
ALTER TABLE "pharmacy_migration_exceptions" ADD COLUMN "branchId" TEXT NOT NULL;
ALTER TABLE "pharmacy_migration_rows" ADD CONSTRAINT "pharmacy_migration_rows_org_branch_id_key" UNIQUE ("organizationId","branchId","id");
ALTER TABLE "pharmacy_migration_rows" DROP CONSTRAINT "pharmacy_migration_rows_tenant_batch_fkey";
ALTER TABLE "pharmacy_migration_rows" ADD CONSTRAINT "pharmacy_migration_rows_branch_batch_fkey" FOREIGN KEY ("organizationId","branchId","batchId") REFERENCES "pharmacy_migration_batches"("organizationId","branchId","id") ON DELETE RESTRICT;
ALTER TABLE "pharmacy_migration_exceptions" DROP CONSTRAINT "pharmacy_migration_exceptions_tenant_batch_fkey";
ALTER TABLE "pharmacy_migration_exceptions" ADD CONSTRAINT "pharmacy_migration_exceptions_branch_batch_fkey" FOREIGN KEY ("organizationId","branchId","batchId") REFERENCES "pharmacy_migration_batches"("organizationId","branchId","id") ON DELETE RESTRICT;
ALTER TABLE "pharmacy_migration_exceptions" DROP CONSTRAINT "pharmacy_migration_exceptions_tenant_row_fkey";
ALTER TABLE "pharmacy_migration_exceptions" ADD CONSTRAINT "pharmacy_migration_exceptions_branch_row_fkey" FOREIGN KEY ("organizationId","branchId","rowId") REFERENCES "pharmacy_migration_rows"("organizationId","branchId","id") ON DELETE RESTRICT;
ALTER TABLE "pharmacy_migration_rows" ADD CONSTRAINT "pharmacy_migration_rows_branch_fkey" FOREIGN KEY ("organizationId","branchId") REFERENCES "pharmacy_branches"("organizationId","id") ON DELETE RESTRICT;
ALTER TABLE "pharmacy_migration_exceptions" ADD CONSTRAINT "pharmacy_migration_exceptions_branch_fkey" FOREIGN KEY ("organizationId","branchId") REFERENCES "pharmacy_branches"("organizationId","id") ON DELETE RESTRICT;
CREATE INDEX "pharmacy_migration_rows_branch_batch_idx" ON "pharmacy_migration_rows"("organizationId","branchId","batchId");
CREATE INDEX "pharmacy_migration_exceptions_branch_batch_idx" ON "pharmacy_migration_exceptions"("organizationId","branchId","batchId");

CREATE FUNCTION pharmacy_import_branch_allowed(row_org TEXT, row_branch TEXT) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT row_org = NULLIF(current_setting('app.current_organization_id', true),'') AND row_branch = NULLIF(current_setting('app.current_branch_id', true),'') $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['pharmacy_migration_sources','pharmacy_migration_batches','pharmacy_migration_rows','pharmacy_migration_exceptions','pharmacy_migration_batch_entities'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_select', t);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_insert', t);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_update', t);
  EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (pharmacy_import_branch_allowed("organizationId","branchId"))', t || '_branch_select', t);
  EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (pharmacy_import_branch_allowed("organizationId","branchId"))', t || '_branch_insert', t);
 END LOOP;
 CREATE POLICY "pharmacy_migration_batches_branch_update" ON "pharmacy_migration_batches" FOR UPDATE USING (pharmacy_import_branch_allowed("organizationId","branchId")) WITH CHECK (pharmacy_import_branch_allowed("organizationId","branchId"));
 CREATE POLICY "pharmacy_migration_exceptions_branch_update" ON "pharmacy_migration_exceptions" FOR UPDATE USING (pharmacy_import_branch_allowed("organizationId","branchId")) WITH CHECK (pharmacy_import_branch_allowed("organizationId","branchId"));
 CREATE POLICY "pharmacy_migration_batch_entities_branch_update" ON "pharmacy_migration_batch_entities" FOR UPDATE USING (pharmacy_import_branch_allowed("organizationId","branchId")) WITH CHECK (pharmacy_import_branch_allowed("organizationId","branchId"));
END $$;

CREATE FUNCTION guard_pharmacy_migration_batch_transition() RETURNS trigger AS $$
BEGIN
 IF NEW.status <> OLD.status AND NOT CASE OLD.status
  WHEN 'UPLOADED' THEN NEW.status IN ('PARSING','FAILED')
  WHEN 'PARSING' THEN NEW.status IN ('PREVIEW','FAILED')
  WHEN 'PREVIEW' THEN NEW.status IN ('PARSING','COMMITTING','FAILED')
  WHEN 'COMMITTING' THEN NEW.status IN ('COMMITTED','FAILED')
  WHEN 'COMMITTED' THEN NEW.status = 'ROLLED_BACK'
  WHEN 'FAILED' THEN NEW.status = 'PARSING'
  ELSE false END THEN
   RAISE EXCEPTION 'illegal pharmacy import batch transition: % -> %', OLD.status, NEW.status USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "pharmacy_migration_batches_transition_guard" BEFORE UPDATE OF status ON "pharmacy_migration_batches" FOR EACH ROW EXECUTE FUNCTION guard_pharmacy_migration_batch_transition();
ALTER TABLE "pharmacy_migration_batch_entities" ADD CONSTRAINT "pharmacy_migration_batch_entities_reversal_fkey" FOREIGN KEY ("organizationId","reversedById") REFERENCES "pharmacy_migration_batch_entities"("organizationId","id") ON DELETE RESTRICT;
CREATE UNIQUE INDEX "pharmacy_migration_batch_entities_reversed_by_key" ON "pharmacy_migration_batch_entities"("organizationId","reversedById") WHERE "reversedById" IS NOT NULL;
