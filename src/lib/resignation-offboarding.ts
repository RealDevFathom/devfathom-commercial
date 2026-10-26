import { Prisma } from '@/generated/prisma/client';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

type OffboardedUser = { id: string; organizationId: string };

/**
 * Deactivate every user whose approved resignation has reached its confirmed
 * last working day. The organization equality is intentional defense in depth:
 * the platform worker can see every tenant, so even a corrupt cross-tenant
 * relation must never offboard an account in another organization.
 *
 * Claiming each resignation, changing the status, and bumping the token version
 * happen in one statement. Consuming the resignation makes later administrator
 * reactivation durable, while the row lock makes overlapping sweeps idempotent.
 */
export async function processDueResignationOffboarding(
  now = new Date()
): Promise<{ offboarded: number }> {
  return withPlatformDb(async (db) => {
    const users = await db.$queryRaw<OffboardedUser[]>(Prisma.sql`
       WITH due_resignations AS (
         UPDATE "resignations" AS r
         SET "offboardedAt" = NOW(),
             "updatedAt" = NOW()
         WHERE r."status" = 'APPROVED'
           AND r."lastWorkingDay" IS NOT NULL
           AND r."lastWorkingDay" <= ${now}
           AND r."offboardedAt" IS NULL
         RETURNING r."userId", r."organizationId"
       )
       UPDATE "users" AS u
       SET "status" = 'INACTIVE',
           "tokenVersion" = u."tokenVersion" + 1,
           "updatedAt" = NOW()
       WHERE u."status" <> 'INACTIVE'
         AND EXISTS (
           SELECT 1
           FROM due_resignations AS r
           WHERE r."userId" = u."id"
             AND r."organizationId" = u."organizationId"
         )
       RETURNING u."id", u."organizationId"
    `);

    return { offboarded: users.length };
  });
}
