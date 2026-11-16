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
 * Stored objects that no record references at all cannot be counted from the
 * database; the report says so instead of guessing.
 */
export type UploadRegistryCount = { recordType: string; count: number };

export type UploadRegistryReport = {
  tombstoned: UploadRegistryCount[];
  unregisteredReferences: UploadRegistryCount[];
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
  return {
    tombstoned,
    unregisteredReferences,
    note: 'Stored objects that no record references are not counted; nothing is deleted from storage.',
  };
}
