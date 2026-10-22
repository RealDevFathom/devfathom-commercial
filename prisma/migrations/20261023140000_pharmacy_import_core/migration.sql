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
ALTER TABLE "pharmacy_migration_sources" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "pharmacy_migration_sources" DISABLE TRIGGER "pharmacy_migration_sources_read_only";
UPDATE "pharmacy_migration_sources" s SET "createdByUserId" = COALESCE(
  (SELECT u.id FROM users u WHERE u."organizationId" = s."organizationId" ORDER BY u."createdAt" LIMIT 1), 'migration-system');
ALTER TABLE "pharmacy_migration_sources" ENABLE TRIGGER "pharmacy_migration_sources_read_only";
ALTER TABLE "pharmacy_migration_sources" ALTER COLUMN "createdByUserId" SET NOT NULL;
ALTER TABLE "pharmacy_migration_batches" ADD COLUMN "createdByUserId" TEXT;
UPDATE "pharmacy_migration_batches" b SET "createdByUserId" = s."createdByUserId" FROM "pharmacy_migration_sources" s
 WHERE s.id=b."sourceId" AND s."organizationId"=b."organizationId";
ALTER TABLE "pharmacy_migration_batches" ALTER COLUMN "createdByUserId" SET NOT NULL;
ALTER TABLE "pharmacy_migration_batches" ADD COLUMN "committedAt" TIMESTAMP(3), ADD COLUMN "rolledBackAt" TIMESTAMP(3), ADD COLUMN "failureReason" TEXT;

CREATE TABLE "pharmacy_migration_batch_entities" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
 "batchId" TEXT NOT NULL, "rowSourceKey" TEXT NOT NULL, "entityType" TEXT NOT NULL, "entityId" TEXT NOT NULL,
 "operation" "PharmacyMigrationEntityOperation" NOT NULL, "reversedById" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "pharmacy_migration_batch_entities_batch_fkey" FOREIGN KEY ("organizationId","batchId") REFERENCES "pharmacy_migration_batches"("organizationId","id") ON DELETE RESTRICT,
 CONSTRAINT "pharmacy_migration_batch_entities_org_id_key" UNIQUE ("organizationId","id"),
 CONSTRAINT "pharmacy_migration_batch_entities_row_entity_key" UNIQUE ("organizationId","batchId","rowSourceKey","entityType","operation")
);
CREATE INDEX "pharmacy_migration_batch_entities_batch_operation_idx" ON "pharmacy_migration_batch_entities"("organizationId","batchId","operation");
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
