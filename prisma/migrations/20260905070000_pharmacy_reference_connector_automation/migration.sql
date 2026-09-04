CREATE TYPE "PharmacyReferenceConnectorAdapter" AS ENUM ('MANUAL_FILE');
CREATE TYPE "PharmacyReferenceConnectorRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');
CREATE TYPE "PharmacyReferenceProposalStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

CREATE TABLE "pharmacy_reference_connectors" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "adapter" "PharmacyReferenceConnectorAdapter" NOT NULL DEFAULT 'MANUAL_FILE',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "schedule" JSONB NOT NULL,
  "cursor" JSONB,
  "lastRunState" "PharmacyReferenceConnectorRunStatus",
  "lastRunAt" TIMESTAMP(3),
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX "pharmacy_reference_connectors_org_id_key"
  ON "pharmacy_reference_connectors"("organizationId", "id");
CREATE UNIQUE INDEX "pharmacy_reference_connectors_org_key_key"
  ON "pharmacy_reference_connectors"("organizationId", "key");
CREATE INDEX "pharmacy_reference_connectors_org_enabled_idx"
  ON "pharmacy_reference_connectors"("organizationId", "enabled");

CREATE TABLE "pharmacy_reference_connector_runs" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "connectorId" TEXT NOT NULL,
  "inputDigest" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "status" "PharmacyReferenceConnectorRunStatus" NOT NULL DEFAULT 'RUNNING',
  "triggerKind" TEXT NOT NULL,
  "triggeredBy" TEXT NOT NULL,
  "replayOfRunId" TEXT,
  "cursorStart" INTEGER NOT NULL DEFAULT 0,
  "cursorEnd" INTEGER NOT NULL DEFAULT 0,
  "rowsSeen" INTEGER NOT NULL DEFAULT 0,
  "rowsApplied" INTEGER NOT NULL DEFAULT 0,
  "rowsSkipped" INTEGER NOT NULL DEFAULT 0,
  "rowsRejected" INTEGER NOT NULL DEFAULT 0,
  "directFieldsApplied" INTEGER NOT NULL DEFAULT 0,
  "regulatedFieldsProposed" INTEGER NOT NULL DEFAULT 0,
  "rejectionReasons" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "error" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "pharmacy_reference_connector_runs_cursor_check"
    CHECK ("cursorStart" >= 0 AND "cursorEnd" >= "cursorStart"),
  CONSTRAINT "pharmacy_reference_connector_runs_counts_check"
    CHECK ("rowsSeen" >= 0 AND "rowsApplied" >= 0 AND "rowsSkipped" >= 0
      AND "rowsRejected" >= 0 AND "directFieldsApplied" >= 0
      AND "regulatedFieldsProposed" >= 0),
  CONSTRAINT "pharmacy_reference_connector_runs_connector_fkey"
    FOREIGN KEY ("organizationId", "connectorId")
    REFERENCES "pharmacy_reference_connectors"("organizationId", "id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "pharmacy_reference_connector_runs_org_id_key"
  ON "pharmacy_reference_connector_runs"("organizationId", "id");
CREATE INDEX "ph_ref_runs_org_connector_started_idx"
  ON "pharmacy_reference_connector_runs"("organizationId", "connectorId", "startedAt");
CREATE INDEX "ph_ref_runs_org_connector_digest_status_idx"
  ON "pharmacy_reference_connector_runs"("organizationId", "connectorId", "inputDigest", "status");
CREATE UNIQUE INDEX "pharmacy_reference_connector_runs_one_active_input_key"
  ON "pharmacy_reference_connector_runs"("organizationId", "connectorId", "inputDigest")
  WHERE "status" = 'RUNNING';

CREATE TABLE "pharmacy_reference_connector_proposals" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "runId" TEXT NOT NULL,
  "connectorId" TEXT NOT NULL,
  "inputDigest" TEXT NOT NULL,
  "rowSourceKey" TEXT NOT NULL,
  "targetMedicineId" TEXT,
  "payload" JSONB NOT NULL,
  "status" "PharmacyReferenceProposalStatus" NOT NULL DEFAULT 'PENDING',
  "decidedBy" TEXT,
  "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_reference_connector_proposals_run_fkey"
    FOREIGN KEY ("organizationId", "runId")
    REFERENCES "pharmacy_reference_connector_runs"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_reference_connector_proposals_medicine_fkey"
    FOREIGN KEY ("organizationId", "targetMedicineId")
    REFERENCES "pharmacy_medicines"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_reference_connector_proposals_decision_check"
    CHECK (("status" = 'PENDING' AND "decidedBy" IS NULL AND "decidedAt" IS NULL)
      OR ("status" IN ('CONFIRMED', 'REJECTED') AND "decidedBy" IS NOT NULL AND "decidedAt" IS NOT NULL))
);

CREATE UNIQUE INDEX "ph_ref_proposals_input_row_key"
  ON "pharmacy_reference_connector_proposals"("organizationId", "connectorId", "inputDigest", "rowSourceKey");
CREATE INDEX "ph_ref_proposals_org_status_created_idx"
  ON "pharmacy_reference_connector_proposals"("organizationId", "status", "createdAt");
CREATE INDEX "ph_ref_proposals_org_medicine_idx"
  ON "pharmacy_reference_connector_proposals"("organizationId", "targetMedicineId");

CREATE FUNCTION pharmacy_guard_reference_connector_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reference connector runs are audit records and cannot be deleted';
  END IF;
  IF OLD.status <> 'RUNNING' OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
    OR NEW."connectorId" IS DISTINCT FROM OLD."connectorId"
    OR NEW."inputDigest" IS DISTINCT FROM OLD."inputDigest"
    OR NEW."batchId" IS DISTINCT FROM OLD."batchId"
    OR NEW."fileName" IS DISTINCT FROM OLD."fileName"
    OR NEW."triggerKind" IS DISTINCT FROM OLD."triggerKind"
    OR NEW."triggeredBy" IS DISTINCT FROM OLD."triggeredBy"
    OR NEW."replayOfRunId" IS DISTINCT FROM OLD."replayOfRunId"
    OR NEW."cursorStart" IS DISTINCT FROM OLD."cursorStart"
    OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
    OR NEW."cursorEnd" < OLD."cursorEnd"
    OR NEW."rowsSeen" < OLD."rowsSeen"
    OR NEW."rowsApplied" < OLD."rowsApplied"
    OR NEW."rowsSkipped" < OLD."rowsSkipped"
    OR NEW."rowsRejected" < OLD."rowsRejected"
    OR NEW."directFieldsApplied" < OLD."directFieldsApplied"
    OR NEW."regulatedFieldsProposed" < OLD."regulatedFieldsProposed" THEN
    RAISE EXCEPTION 'reference connector run audit fields are immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER pharmacy_reference_connector_runs_guard
BEFORE UPDATE OR DELETE ON "pharmacy_reference_connector_runs"
FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_reference_connector_run();

CREATE FUNCTION pharmacy_guard_reference_connector_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reference connector proposals cannot be deleted';
  END IF;
  IF OLD.status <> 'PENDING' OR NEW.status NOT IN ('CONFIRMED', 'REJECTED')
    OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
    OR NEW."runId" IS DISTINCT FROM OLD."runId"
    OR NEW."connectorId" IS DISTINCT FROM OLD."connectorId"
    OR NEW."inputDigest" IS DISTINCT FROM OLD."inputDigest"
    OR NEW."rowSourceKey" IS DISTINCT FROM OLD."rowSourceKey"
    OR NEW.payload IS DISTINCT FROM OLD.payload THEN
    RAISE EXCEPTION 'reference connector proposal is immutable after one decision';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER pharmacy_reference_connector_proposals_guard
BEFORE UPDATE OR DELETE ON "pharmacy_reference_connector_proposals"
FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_reference_connector_proposal();

-- Existing pharmacist roles receive only this new, narrow decision capability.
-- Future organizations receive the same grant from PHARMACY_ROLE_TEMPLATES.
SELECT set_config('app.is_platform_admin', 'true', true);
INSERT INTO "organization_role_permissions"
  ("id", "organizationId", "organizationRoleId", "capability", "effect", "createdAt")
SELECT
  'wha1339_' || md5(role.id || ':pharmacy:catalogue-review'),
  role."organizationId",
  role.id,
  'pharmacy:catalogue-review',
  'ALLOW',
  CURRENT_TIMESTAMP
FROM "organization_roles" role
JOIN "organizations" organization ON organization.id = role."organizationId"
WHERE organization.vertical = 'PHARMACY' AND role.key = 'pharmacist'
ON CONFLICT ("organizationRoleId", "capability") DO NOTHING;

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'pharmacy_reference_connectors',
    'pharmacy_reference_connector_runs',
    'pharmacy_reference_connector_proposals'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'', true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''')) WITH CHECK (current_setting(''app.is_platform_admin'', true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))', table_name);
  END LOOP;
END $$;
