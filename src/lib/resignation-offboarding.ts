import { Prisma } from '@/generated/prisma/client';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

type OffboardedUser = { id: string; organizationId: string };

/**
 * Deactivate every user whose approved resignation has reached its confirmed
 * last working day. The organization equality is intentional defense in depth:
 * the platform worker can see every tenant, so even a corrupt cross-tenant
 * relation must never offboard an account in another organization.
 *
 * The status change and token-version bump happen in one statement. Filtering
 * already-inactive users makes repeated or overlapping cron invocations
 * idempotent and prevents needless session-version churn.
 */
export async function processDueResignationOffboarding(
  now = new Date()
): Promise<{ offboarded: number }> {
  return withPlatformDb(async (db) => {
    const users = await db.$queryRaw<OffboardedUser[]>(Prisma.sql`
       UPDATE "users" AS u
       SET "status" = 'INACTIVE',
           "tokenVersion" = u."tokenVersion" + 1,
           "updatedAt" = NOW()
       WHERE u."status" <> 'INACTIVE'
         AND EXISTS (
           SELECT 1
           FROM "resignations" AS r
           WHERE r."userId" = u."id"
             AND r."organizationId" = u."organizationId"
             AND r."status" = 'APPROVED'
             AND r."lastWorkingDay" IS NOT NULL
             AND r."lastWorkingDay" <= ${now}
         )
       RETURNING u."id", u."organizationId"
    `);

    return { offboarded: users.length };
  });
}
