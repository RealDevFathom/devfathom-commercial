BEGIN;

-- Durable proposals do not change the live catalogue until an authorized review.
CREATE TABLE IF NOT EXISTS pharmacy_catalogue_edits (
  id TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "medicineId" TEXT NOT NULL,
  "editorId" TEXT NOT NULL,
  changes JSONB NOT NULL CHECK (jsonb_typeof(changes) = 'object' AND changes <> '{}'::jsonb),
  "baseUpdatedAt" TIMESTAMP(3) NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  "reviewerId" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "soloOwnerReauthenticatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("organizationId", "medicineId") REFERENCES pharmacy_medicines ("organizationId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "editorId") REFERENCES users ("organizationId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "reviewerId") REFERENCES users ("organizationId", id) ON DELETE RESTRICT,
  CHECK ((status = 'PENDING' AND "reviewerId" IS NULL AND "reviewedAt" IS NULL AND "soloOwnerReauthenticatedAt" IS NULL)
    OR (status <> 'PENDING' AND "reviewerId" IS NOT NULL AND "reviewedAt" IS NOT NULL)),
  CHECK (status <> 'APPROVED' OR "reviewerId" <> "editorId" OR "soloOwnerReauthenticatedAt" IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS "pharmacy_catalogue_edits_organizationId_status_createdAt_idx"
  ON pharmacy_catalogue_edits ("organizationId", status, "createdAt");
ALTER TABLE pharmacy_catalogue_edits ENABLE ROW LEVEL SECURITY;
ALTER TABLE pharmacy_catalogue_edits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON pharmacy_catalogue_edits;
CREATE POLICY tenant_isolation ON pharmacy_catalogue_edits
  USING ("organizationId" = current_setting('app.current_organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

-- Preserve submitted payload and review evidence, including against concurrent decisions.
CREATE OR REPLACE FUNCTION pharmacy_catalogue_edit_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Catalogue review history is immutable' USING ERRCODE = '23514'; END IF;
  IF OLD.status <> 'PENDING' OR NEW.id <> OLD.id OR NEW."organizationId" <> OLD."organizationId"
    OR NEW."medicineId" <> OLD."medicineId" OR NEW."editorId" <> OLD."editorId"
    OR NEW.changes <> OLD.changes OR NEW."baseUpdatedAt" <> OLD."baseUpdatedAt"
    OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'Catalogue proposal is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pharmacy_catalogue_edit_immutable ON pharmacy_catalogue_edits;
CREATE TRIGGER pharmacy_catalogue_edit_immutable BEFORE UPDATE OR DELETE ON pharmacy_catalogue_edits
  FOR EACH ROW EXECUTE FUNCTION pharmacy_catalogue_edit_immutable();

-- Old assertions retain unknown authorship and cannot be newly self-approved.
ALTER TABLE pharmacy_medicine_provenance ADD COLUMN IF NOT EXISTS "editorId" TEXT;

COMMIT;
