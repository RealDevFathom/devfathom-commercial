import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-837 — read-only integrity report for the upload registry, so a file the
 * download route now refuses never disappears silently. Runs on the caller's
 * tenant-scoped database (row level security limits every count to that
 * organization) and changes nothing; nothing is ever deleted from storage.
 *
 * - `tombstoned`: bound files with no live owning record left (the primary
 *   binding and every grandfathered binding point at deleted rows). These are
 *   refused by `/api/files`.
 * - `unregisteredReferences`: records that still reference an `/api/files`
 *   object the registry does not know. These are refused by `/api/files`.
 *
 * Unregistered stored objects that no record references at all cannot be counted from the
 * database; the report says so instead of guessing.
 */
export type UploadRegistryCount = { recordType: string; count: number };

export type UploadRegistryReport = {
  tombstoned: UploadRegistryCount[];
  unregisteredReferences: UploadRegistryCount[];
  unattached: { count: number; oldest: Date | null; newest: Date | null; withoutUploader: number };
  note: string;
};

const TOMBSTONED = Prisma.sql`
  SELECT u."ownerType" AS "recordType", count(*)::int AS "count"
    FROM "uploaded_files" u
   WHERE u."ownerType" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM (
           SELECT u."ownerType" AS "ownerType", u."ownerId" AS "ownerId"
           UNION ALL
           SELECT l."ownerType", l."ownerId"
             FROM "uploaded_file_legacy_bindings" l
            WHERE l."organizationId" = u."organizationId" AND l."name" = u."name"
         ) b
        WHERE (b."ownerType" = 'PROJECT_FILE'
                AND EXISTS (SELECT 1 FROM "project_files" r WHERE r."id" = b."ownerId"))
           OR (b."ownerType" = 'TASK_ATTACHMENT'
                AND EXISTS (SELECT 1 FROM "task_attachments" r WHERE r."id" = b."ownerId"))
           OR (b."ownerType" = 'CLIENT_LOGO' AND EXISTS (
                 SELECT 1 FROM clients r
                  WHERE r.id = b."ownerId" AND r.logo = '/api/files/' || u.name))
           OR (b."ownerType" = 'CHAT_ATTACHMENT' AND EXISTS (
                 SELECT 1 FROM message_attachments a JOIN messages m ON m.id = a."messageId"
                  WHERE a.id = b."ownerId" AND a.url = '/api/files/' || u.name AND m."deletedAt" IS NULL))
           OR (b."ownerType" IN ('PHARMACY_LICENCE_EVIDENCE','PHARMACY_COVERAGE_ROSTER') AND EXISTS (
                 SELECT 1 FROM pharmacy_branch_regulatory_profiles r
                  WHERE r."branchId"=b."ownerId"
                    AND CASE b."ownerType" WHEN 'PHARMACY_LICENCE_EVIDENCE' THEN r."licenceEvidenceFileRef" ELSE r."qualifiedPersonCoverageRosterRef" END='/api/files/' || u.name))
           OR (b."ownerType" = 'CONTRACT'
                AND EXISTS (SELECT 1 FROM "contracts" r WHERE r."id" = b."ownerId"))
     )
   GROUP BY u."ownerType"
   ORDER BY 1`;

const UNREGISTERED_REFERENCES = Prisma.sql`
  SELECT ref."recordType", count(*)::int AS "count"
    FROM (
      SELECT 'PROJECT_FILE' AS "recordType", "organizationId", substr("url", 12) AS "name"
        FROM "project_files" WHERE "url" LIKE '/api/files/%'
      UNION ALL
      SELECT 'TASK_ATTACHMENT', "organizationId", substr("url", 12)
        FROM "task_attachments" WHERE "url" LIKE '/api/files/%'
      UNION ALL
      SELECT 'CONTRACT', "organizationId", substr("fileUrl", 12)
        FROM "contracts" WHERE "fileUrl" LIKE '/api/files/%'
      UNION ALL
      SELECT 'CLIENT_LOGO', "organizationId", substr("logo", 12)
        FROM "clients" WHERE "logo" LIKE '/api/files/%'
      UNION ALL
      SELECT 'LICENCE_EVIDENCE', "organizationId", substr("licenceEvidenceFileRef", 12)
        FROM "pharmacy_branch_regulatory_profiles"
       WHERE "licenceEvidenceFileRef" LIKE '/api/files/%'
      UNION ALL
      SELECT 'COVERAGE_ROSTER', "organizationId", substr("qualifiedPersonCoverageRosterRef", 12)
        FROM "pharmacy_branch_regulatory_profiles"
       WHERE "qualifiedPersonCoverageRosterRef" LIKE '/api/files/%'
      UNION ALL
      SELECT 'CHAT_ATTACHMENT', "organizationId", substr("url", 12)
        FROM "message_attachments" WHERE "url" LIKE '/api/files/%'
    ) ref
   WHERE NOT EXISTS (
     SELECT 1 FROM "uploaded_files" u
      WHERE u."organizationId" = ref."organizationId" AND u."name" = ref."name"
   )
   GROUP BY ref."recordType"
   ORDER BY 1`;

export async function readUploadRegistryReport(
  db: Pick<ScopedDb, '$queryRaw'>
): Promise<UploadRegistryReport> {
  const tombstoned = await db.$queryRaw<UploadRegistryCount[]>(TOMBSTONED);
  const unregisteredReferences = await db.$queryRaw<UploadRegistryCount[]>(UNREGISTERED_REFERENCES);
  const [unattached] = await db.$queryRaw<UploadRegistryReport['unattached'][]>(Prisma.sql`
    SELECT count(*)::int AS count, min("createdAt") AS oldest, max("createdAt") AS newest,
      count(*) FILTER (WHERE "uploadedById" IS NULL)::int AS "withoutUploader"
    FROM "uploaded_files" WHERE "ownerType" IS NULL`);
  return {
    unattached,
    tombstoned,
    unregisteredReferences,
    note: 'Unregistered stored objects that no record references are not counted; nothing is deleted from storage.',
  };
}
