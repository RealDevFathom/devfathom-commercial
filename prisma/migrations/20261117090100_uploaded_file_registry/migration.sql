-- DEV-837 (security scan F15/F17): server-recorded upload ownership.
--
-- Every object written by /api/upload gets a row here with the uploader the
-- server saw. The first authorized attach (project file, task attachment,
-- contract document) binds the row to that record. The binding is write-once
-- and has no foreign key: when its owner row is deleted it stays behind as a
-- tombstone and /api/files denies the object. A file reference supplied later
-- by any client can neither bind nor re-bind an object.
--
-- Backfill: every existing /api/files reference is registered once per
-- (organization, file). A file referenced by a project file, task attachment or
-- contract document becomes bound to the earliest such row (ties ranked in that
-- order), whatever else references it. Licence evidence, coverage rosters,
-- client logos and chat attachments are registered unbound, so their existing
-- read rules keep applying. A legacy object that no table references stays unregistered and
-- is denied from now on.
BEGIN;

CREATE TABLE IF NOT EXISTS "uploaded_files" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "name" TEXT NOT NULL,
  "uploadedById" TEXT,
  "ownerType" TEXT,
  "ownerId" TEXT,
  "boundAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "uploaded_files_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uploaded_files_owner_type_ck"
    CHECK ("ownerType" IS NULL OR "ownerType" IN ('PROJECT_FILE', 'TASK_ATTACHMENT', 'CONTRACT')),
  CONSTRAINT "uploaded_files_owner_pair_ck"
    CHECK (("ownerType" IS NULL) = ("ownerId" IS NULL) AND ("ownerType" IS NULL) = ("boundAt" IS NULL)),
  CONSTRAINT "uploaded_files_name_ck"
    CHECK ("name" <> '' AND position('/' in "name") = 0 AND position(E'\\' in "name") = 0
           AND position('..' in "name") = 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "uploaded_files_org_name_key"
  ON "uploaded_files" ("organizationId", "name");
CREATE INDEX IF NOT EXISTS "uploaded_files_organizationId_idx"
  ON "uploaded_files" ("organizationId");

-- Backfill before row-level security is forced on the new table.
INSERT INTO "uploaded_files"
  ("id", "organizationId", "name", "uploadedById", "ownerType", "ownerId", "boundAt", "createdAt")
SELECT DISTINCT ON (ref."organizationId", ref."name")
  'upl_' || md5(ref."organizationId" || '/' || ref."name"),
  ref."organizationId",
  ref."name",
  ref."uploadedById",
  ref."ownerType",
  ref."ownerId",
  CASE WHEN ref."ownerType" IS NULL THEN NULL ELSE ref."createdAt" END,
  ref."createdAt"
FROM (
  SELECT "organizationId", substr("url", 12) AS "name", "uploadedById",
         'PROJECT_FILE' AS "ownerType", "id" AS "ownerId", "createdAt", 1 AS "rank"
    FROM "project_files" WHERE "url" LIKE '/api/files/%'
  UNION ALL
  SELECT "organizationId", substr("url", 12), NULL, 'TASK_ATTACHMENT', "id", "createdAt", 2
    FROM "task_attachments" WHERE "url" LIKE '/api/files/%'
  UNION ALL
  SELECT "organizationId", substr("fileUrl", 12), NULL, 'CONTRACT', "id", "createdAt", 3
    FROM "contracts" WHERE "fileUrl" LIKE '/api/files/%'
  UNION ALL
  SELECT "organizationId", substr("licenceEvidenceFileRef", 12), NULL, NULL, NULL, "createdAt", 4
    FROM "pharmacy_branch_regulatory_profiles" WHERE "licenceEvidenceFileRef" LIKE '/api/files/%'
  UNION ALL
  SELECT "organizationId", substr("qualifiedPersonCoverageRosterRef", 12), NULL, NULL, NULL, "createdAt", 4
    FROM "pharmacy_branch_regulatory_profiles"
   WHERE "qualifiedPersonCoverageRosterRef" LIKE '/api/files/%'
  UNION ALL
  SELECT "organizationId", substr("logo", 12), NULL, NULL, NULL, "createdAt", 4
    FROM "clients" WHERE "logo" LIKE '/api/files/%'
  UNION ALL
  SELECT "organizationId", substr("url", 12), NULL, NULL, NULL, "createdAt", 4
    FROM "message_attachments" WHERE "url" LIKE '/api/files/%'
) ref
WHERE ref."name" <> ''
  AND position('/' in ref."name") = 0
  AND position(E'\\' in ref."name") = 0
  AND position('..' in ref."name") = 0
ORDER BY ref."organizationId", ref."name", ref."ownerType" IS NULL, ref."createdAt", ref."rank"
ON CONFLICT ("organizationId", "name") DO NOTHING;

-- Identity is fixed at upload; a binding, once made, never changes.
CREATE OR REPLACE FUNCTION "uploaded_files_write_once"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
     OR NEW."name" IS DISTINCT FROM OLD."name"
     OR NEW."uploadedById" IS DISTINCT FROM OLD."uploadedById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'An uploaded file record cannot change its identity' USING ERRCODE = '23514';
  END IF;
  IF OLD."ownerType" IS NOT NULL AND (
       NEW."ownerType" IS DISTINCT FROM OLD."ownerType"
       OR NEW."ownerId" IS DISTINCT FROM OLD."ownerId"
       OR NEW."boundAt" IS DISTINCT FROM OLD."boundAt") THEN
    RAISE EXCEPTION 'An uploaded file binding cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "uploaded_files_write_once" ON "uploaded_files";
CREATE TRIGGER "uploaded_files_write_once"
  BEFORE UPDATE ON "uploaded_files"
  FOR EACH ROW EXECUTE FUNCTION "uploaded_files_write_once"();

-- Tenant isolation. SELECT, INSERT and UPDATE (binding) only: no DELETE policy,
-- so a tombstone cannot be removed by the application role.
ALTER TABLE "uploaded_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "uploaded_files" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_select ON "uploaded_files";
DROP POLICY IF EXISTS tenant_isolation_insert ON "uploaded_files";
DROP POLICY IF EXISTS tenant_isolation_update ON "uploaded_files";
CREATE POLICY tenant_isolation_select ON "uploaded_files" FOR SELECT
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
CREATE POLICY tenant_isolation_insert ON "uploaded_files" FOR INSERT
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
CREATE POLICY tenant_isolation_update ON "uploaded_files" FOR UPDATE
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

COMMIT;
