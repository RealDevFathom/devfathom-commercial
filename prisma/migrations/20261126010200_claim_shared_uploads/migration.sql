BEGIN;
SET LOCAL lock_timeout = '10s';
SELECT set_config('app.is_platform_admin', 'true', true);

ALTER TABLE "uploaded_files" DROP CONSTRAINT IF EXISTS "uploaded_files_owner_type_ck";
ALTER TABLE "uploaded_files" ADD CONSTRAINT "uploaded_files_owner_type_ck"
  CHECK ("ownerType" IS NULL OR "ownerType" IN ('PROJECT_FILE', 'TASK_ATTACHMENT', 'CONTRACT', 'CLIENT_LOGO', 'CHAT_ATTACHMENT', 'PHARMACY_LICENCE_EVIDENCE', 'PHARMACY_COVERAGE_ROSTER'));

ALTER TABLE "uploaded_file_legacy_bindings" DROP CONSTRAINT IF EXISTS "uploaded_file_legacy_bindings_owner_type_ck";
ALTER TABLE "uploaded_file_legacy_bindings" ADD CONSTRAINT "uploaded_file_legacy_bindings_owner_type_ck"
  CHECK ("ownerType" IN ('PROJECT_FILE', 'TASK_ATTACHMENT', 'CONTRACT', 'CLIENT_LOGO', 'CHAT_ATTACHMENT', 'PHARMACY_LICENCE_EVIDENCE', 'PHARMACY_COVERAGE_ROSTER'));

-- Snapshot only unclaimed registrations. Never turn a reference to an already
-- protected file into a new grant. One branch may have many profile versions.
CREATE TEMP TABLE dev1018_refs ON COMMIT DROP AS
SELECT DISTINCT u.id, u."organizationId", u.name, r.kind, r.owner
FROM uploaded_files u
JOIN (
  SELECT "organizationId", logo AS ref, 'CLIENT_LOGO' AS kind, id AS owner
    FROM clients WHERE logo ~* '\.(png|jpe?g|gif|webp)$'
  UNION ALL
  SELECT a."organizationId", a.url, 'CHAT_ATTACHMENT', a.id FROM message_attachments a
    JOIN messages m ON m.id = a."messageId" AND m."organizationId" = a."organizationId"
    WHERE m."deletedAt" IS NULL
  UNION ALL
  SELECT "organizationId", "licenceEvidenceFileRef", 'PHARMACY_LICENCE_EVIDENCE', "branchId"
    FROM pharmacy_branch_regulatory_profiles
  UNION ALL
  SELECT "organizationId", "qualifiedPersonCoverageRosterRef", 'PHARMACY_COVERAGE_ROSTER', "branchId"
    FROM pharmacy_branch_regulatory_profiles
) r ON r."organizationId" = u."organizationId" AND r.ref = '/api/files/' || u.name
WHERE u."ownerType" IS NULL;

UPDATE uploaded_files u
SET "ownerType" = 'CLIENT_LOGO', "ownerId" = r.owner, "boundAt" = CURRENT_TIMESTAMP
FROM (SELECT id, min(owner) AS owner FROM dev1018_refs WHERE kind = 'CLIENT_LOGO' GROUP BY id) r
WHERE u.id = r.id AND u."ownerType" IS NULL;

UPDATE uploaded_files u
SET "ownerType" = 'CHAT_ATTACHMENT', "ownerId" = r.owner, "boundAt" = CURRENT_TIMESTAMP
FROM (SELECT id, min(owner) AS owner FROM dev1018_refs WHERE kind = 'CHAT_ATTACHMENT' GROUP BY id) r
WHERE u.id = r.id AND u."ownerType" IS NULL;

UPDATE uploaded_files u
SET "ownerType" = 'PHARMACY_LICENCE_EVIDENCE', "ownerId" = r.owner, "boundAt" = CURRENT_TIMESTAMP
FROM (SELECT id, min(owner) AS owner FROM dev1018_refs WHERE kind = 'PHARMACY_LICENCE_EVIDENCE' GROUP BY id) r
WHERE u.id = r.id AND u."ownerType" IS NULL;

UPDATE uploaded_files u
SET "ownerType" = 'PHARMACY_COVERAGE_ROSTER', "ownerId" = r.owner, "boundAt" = CURRENT_TIMESTAMP
FROM (SELECT id, min(owner) AS owner FROM dev1018_refs WHERE kind = 'PHARMACY_COVERAGE_ROSTER' GROUP BY id) r
WHERE u.id = r.id AND u."ownerType" IS NULL;

-- Only the migration role may insert during this transaction. The table
-- lock spans policy creation and removal; the runtime role stays read-only.
DROP POLICY IF EXISTS dev1018_backfill ON uploaded_file_legacy_bindings;
CREATE POLICY dev1018_backfill ON uploaded_file_legacy_bindings FOR INSERT
  TO CURRENT_USER WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
INSERT INTO uploaded_file_legacy_bindings (id, "organizationId", name, "ownerType", "ownerId")
SELECT 'uflb_' || md5(json_build_array(r."organizationId", r.name, r.kind, r.owner)::text),
       r."organizationId", r.name, r.kind, r.owner
FROM dev1018_refs r JOIN uploaded_files u ON u.id = r.id
WHERE (u."ownerType", u."ownerId") <> (r.kind, r.owner)
ON CONFLICT ("organizationId", name, "ownerType", "ownerId") DO NOTHING;
DROP POLICY dev1018_backfill ON uploaded_file_legacy_bindings;

COMMIT;
