import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';

export const OFFBOARDING_ORGANIZATION_LIMIT = 100;

/** Find tenants with approved resignations whose confirmed departure has arrived. */
export const DUE_OFFBOARDING_ORGANIZATIONS_SQL = `SELECT DISTINCT r."organizationId"
FROM "resignations" r
JOIN "User" u
  ON u.id = r."userId" AND u."organizationId" = r."organizationId"
WHERE r.status = 'APPROVED'
  AND r."lastWorkingDay" <= $1
  AND u.status <> 'INACTIVE'
ORDER BY r."organizationId"
LIMIT $2`;

type OffboardingDb = {
  user: {
    updateMany: (args: {
      where: {
        status: { not: 'INACTIVE' };
        resignations: {
          some: { status: 'APPROVED'; lastWorkingDay: { lte: Date } };
        };
      };
      data: { status: 'INACTIVE'; tokenVersion: { increment: 1 } };
    }) => Promise<{ count: number }>;
  };
};

/**
 * Deactivate due employees inside one tenant scope. The relation predicate makes
 * the update idempotent and prevents a withdrawn/changed resignation selected by
 * an earlier discovery query from offboarding anyone.
 */
export async function offboardDueResignationsForTenant(
  organizationId: string,
  now: Date
): Promise<number> {
  return withTenantDb(
    organizationId,
    async (tenantDb) => {
      const result = await (tenantDb as unknown as OffboardingDb).user.updateMany({
        where: {
          status: { not: 'INACTIVE' },
          resignations: {
            some: { status: 'APPROVED', lastWorkingDay: { lte: now } },
          },
        },
        data: { status: 'INACTIVE', tokenVersion: { increment: 1 } },
      });
      return result.count;
    },
    { skipDrain: true }
  );
}

/** Sweep due resignations across tenants without ever mixing tenant writes. */
export async function processDueResignationOffboarding(now = new Date()): Promise<{
  organizations: number;
  users: number;
}> {
  const rows = await withPlatformDb((platformDb) =>
    platformDb.$queryRawUnsafe<Array<{ organizationId: string }>>(
      DUE_OFFBOARDING_ORGANIZATIONS_SQL,
      now,
      OFFBOARDING_ORGANIZATION_LIMIT
    )
  );

  let users = 0;
  for (const { organizationId } of rows) {
    users += await offboardDueResignationsForTenant(organizationId, now);
  }
  return { organizations: rows.length, users };
}
