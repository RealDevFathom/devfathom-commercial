import { Prisma } from '@/generated/prisma/client';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

type OffboardedUser = {
  id: string;
  organizationId: string;
  previousStatus: string;
  previousTokenVersion: number;
  tokenVersion: number;
  resignationIds: string[];
};

/** Offboard due approvals once, preserving a workspace administrator and a durable audit. */
export async function processDueResignationOffboarding(
  now = new Date()
): Promise<{ offboarded: number }> {
  const organizations = await withPlatformDb((db) =>
    db.resignation.findMany({
      where: { status: 'APPROVED', lastWorkingDay: { lte: now }, offboardedAt: null },
      select: { organizationId: true },
      distinct: ['organizationId'],
      orderBy: { organizationId: 'asc' },
    })
  );

  let offboarded = 0;
  for (const { organizationId } of organizations) {
    offboarded += await withPlatformDb(async (db) => {
      // Share the membership-management lock. Use a fresh statement after the
      // lock so overlapping sweeps see the committed membership/admin count.
      await db.$queryRaw`SELECT "id" FROM "organizations" WHERE "id" = ${organizationId} FOR UPDATE`;
      const users = await db.$queryRaw<OffboardedUser[]>(Prisma.sql`
        WITH eligible_users AS MATERIALIZED (
          SELECT u.*
          FROM "users" AS u
          WHERE u."organizationId" = ${organizationId}
            AND EXISTS (
              SELECT 1 FROM "resignations" AS due
              WHERE due."userId" = u."id"
                AND due."organizationId" = u."organizationId"
                AND due."status" = 'APPROVED'
                AND due."lastWorkingDay" <= ${now}
                AND due."offboardedAt" IS NULL
            )
            AND (
              u."role" <> 'ADMIN' OR u."status" <> 'ACTIVE'
              OR EXISTS (
                SELECT 1 FROM "users" AS other
                WHERE other."organizationId" = u."organizationId"
                  AND other."role" = 'ADMIN' AND other."status" = 'ACTIVE'
                  AND other."id" <> u."id"
                  -- If every active admin is due, retain the first one. An
                  -- admin without a due approval can instead keep the workspace.
                  AND (other."id" < u."id" OR NOT EXISTS (
                    SELECT 1 FROM "resignations" AS pending
                    WHERE pending."userId" = other."id"
                      AND pending."organizationId" = other."organizationId"
                      AND pending."status" = 'APPROVED'
                      AND pending."lastWorkingDay" <= ${now}
                      AND pending."offboardedAt" IS NULL
                  ))
              )
            )
          FOR UPDATE OF u
        ), due_resignations AS (
          UPDATE "resignations" AS r
          SET "offboardedAt" = NOW(), "updatedAt" = NOW()
          FROM eligible_users AS u
          WHERE r."userId" = u."id"
            AND r."organizationId" = u."organizationId"
            AND r."status" = 'APPROVED'
            AND r."lastWorkingDay" IS NOT NULL
            AND r."lastWorkingDay" <= ${now}
            AND r."offboardedAt" IS NULL
          RETURNING r."id", r."userId", r."organizationId"
        ), offboarded_users AS (
          UPDATE "users" AS u
          SET "status" = 'INACTIVE',
              "tokenVersion" = u."tokenVersion" + 1,
              "updatedAt" = NOW()
          FROM eligible_users AS previous
          WHERE u."id" = previous."id"
            AND u."organizationId" = previous."organizationId"
            AND u."status" <> 'INACTIVE'
            AND EXISTS (
              SELECT 1 FROM due_resignations AS r
              WHERE r."userId" = u."id"
                AND r."organizationId" = u."organizationId"
            )
          RETURNING u."id", u."organizationId", u."tokenVersion",
                    previous."status"::text AS "previousStatus",
                    previous."tokenVersion" AS "previousTokenVersion"
        )
        SELECT u.*, ARRAY(
          SELECT r."id" FROM due_resignations AS r
          WHERE r."userId" = u."id" AND r."organizationId" = u."organizationId"
          ORDER BY r."id"
        ) AS "resignationIds"
        FROM offboarded_users AS u
      `);

      for (const user of users) {
        // Await in the same transaction: failed audit persistence must also
        // roll back both the resignation claim and access/session revocation.
        await db.auditLog.create({
          data: {
            organizationId: user.organizationId,
            actorType: 'SYSTEM',
            source: 'SYSTEM',
            category: 'RESIGNATIONS',
            operation: 'UPDATE',
            action: 'resignations.offboard',
            targetType: 'User',
            targetId: user.id,
            description: 'Offboarded user after their approved last working day',
            changes: {
              status: { before: user.previousStatus, after: 'INACTIVE' },
              tokenVersion: { before: user.previousTokenVersion, after: user.tokenVersion },
            },
            metadata: { resignationIds: user.resignationIds },
          },
        });
      }
      return users.length;
    });
  }
  return { offboarded };
}
