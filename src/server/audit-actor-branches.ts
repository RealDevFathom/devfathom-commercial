import { hasAllCapabilityAccess } from '@/lib/abac/owner-access';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-913 / DEV-937: the pharmacy branches a person really works at, read from the
 * database. `all` is the pharmacy owner (the live system Owner, or an ADMIN holding
 * `*` with no DENY), who acts at every branch. Anyone else works at the active
 * branches they are actively assigned to; an unknown or inactive person at none.
 */
export async function auditActorBranches(
  db: ScopedDb,
  organizationId: string,
  userId: string
): Promise<{ all: boolean; branchIds: string[] }> {
  const member = await db.user.findFirst({
    where: { id: userId, organizationId },
    select: {
      status: true,
      role: true,
      organizationRole: {
        select: {
          key: true,
          isSystem: true,
          permissions: { select: { capability: true, effect: true } },
        },
      },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  if (member && hasAllCapabilityAccess(member)) return { all: true, branchIds: [] };
  if (!member || member.status !== 'ACTIVE') return { all: false, branchIds: [] };
  const assignments = await db.pharmacyBranchAssignment.findMany({
    where: { organizationId, userId, active: true, branch: { organizationId, active: true } },
    select: { branchId: true },
  });
  return { all: false, branchIds: [...new Set(assignments.map((row) => row.branchId))] };
}
