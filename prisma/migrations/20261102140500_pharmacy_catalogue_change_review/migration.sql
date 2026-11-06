-- Catalogue edits go through catalogue review.
--
-- Ingredient, medicine, pack, pack revision, printed MRP, barcode and alias edits
-- are stored here as PENDING and written to the catalogue only when a reviewer
-- approves them. A reviewer is a different user holding pharmacy:catalogue-review;
-- the workspace's sole administrator may decide their own change (SOLO_OWNER).
-- No existing row or role grant is changed by this migration.
-- Retimestamped after develop tip 20261102140100; DDL is safe to re-run.
BEGIN;

DO $$ BEGIN
  CREATE TYPE "PharmacyCatalogueChangeKind" AS ENUM (
    'INGREDIENT', 'MEDICINE', 'PACK_LEVEL', 'PACK_REVISION', 'PRINTED_MRP', 'BARCODE', 'ALIAS'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PharmacyCatalogueChangeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PharmacyCatalogueReviewMode" AS ENUM ('SECOND_REVIEWER', 'SOLO_OWNER');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "pharmacy_catalogue_changes" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "kind" "PharmacyCatalogueChangeKind" NOT NULL,
  "payload" JSONB NOT NULL,
  "summary" TEXT NOT NULL,
  "status" "PharmacyCatalogueChangeStatus" NOT NULL DEFAULT 'PENDING',
  "proposedBy" TEXT NOT NULL,
  "proposedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedBy" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "reviewMode" "PharmacyCatalogueReviewMode",
  "reviewNote" TEXT,
  "publishedRecordId" TEXT,
  CONSTRAINT "pharmacy_catalogue_changes_decision_check"
    CHECK (("status" = 'PENDING' AND "reviewedBy" IS NULL AND "reviewedAt" IS NULL
              AND "reviewMode" IS NULL AND "publishedRecordId" IS NULL)
      OR ("status" = 'APPROVED' AND "reviewedBy" IS NOT NULL AND "reviewedAt" IS NOT NULL
              AND "reviewMode" IS NOT NULL AND "publishedRecordId" IS NOT NULL)
      OR ("status" = 'REJECTED' AND "reviewedBy" IS NOT NULL AND "reviewedAt" IS NOT NULL
              AND "reviewMode" IS NOT NULL AND "publishedRecordId" IS NULL)),
  -- Separation of duties: only the sole-owner mode may decide one's own change.
  CONSTRAINT "pharmacy_catalogue_changes_reviewer_check"
    CHECK ("reviewedBy" IS NULL OR "reviewedBy" <> "proposedBy" OR "reviewMode" = 'SOLO_OWNER')
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_catalogue_changes_org_id_key"
  ON "pharmacy_catalogue_changes"("organizationId", "id");
CREATE INDEX IF NOT EXISTS "pharmacy_catalogue_changes_org_status_idx"
  ON "pharmacy_catalogue_changes"("organizationId", "status", "proposedAt");

-- One decision per change; the proposal itself never changes. Only the
-- sanctioned purge of the row's own tenant (platform control plane) may delete.
CREATE OR REPLACE FUNCTION pharmacy_guard_catalogue_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId"
       AND current_setting('app.is_platform_admin', true) = 'true' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'catalogue changes are review records and cannot be deleted'
      USING ERRCODE = 'P0001';
  END IF;
  IF OLD.status <> 'PENDING' OR NEW.status NOT IN ('APPROVED', 'REJECTED')
    OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.summary IS DISTINCT FROM OLD.summary
    OR NEW."proposedBy" IS DISTINCT FROM OLD."proposedBy"
    OR NEW."proposedAt" IS DISTINCT FROM OLD."proposedAt" THEN
    RAISE EXCEPTION 'catalogue change is immutable after one review decision'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS pharmacy_catalogue_changes_guard ON "pharmacy_catalogue_changes";
CREATE TRIGGER pharmacy_catalogue_changes_guard
BEFORE UPDATE OR DELETE ON "pharmacy_catalogue_changes"
FOR EACH ROW EXECUTE FUNCTION pharmacy_guard_catalogue_change();

ALTER TABLE "pharmacy_catalogue_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_catalogue_changes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "pharmacy_catalogue_changes";
CREATE POLICY tenant_isolation ON "pharmacy_catalogue_changes"
  USING (current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

COMMIT;
