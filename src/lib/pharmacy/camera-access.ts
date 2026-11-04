import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-740 pharmacy live camera branch boundary, shared by the tRPC router and the
 * stream route so both apply one rule on every request.
 *
 * The branch must be active in the organization. A session ADMIN of that
 * organization may use every active branch (the counter's existing exception);
 * anyone else needs an active pharmacy branch assignment to that branch.
 * Restaurant staff profiles are never consulted.
 */
export async function hasPharmacyCameraBranchAccess(
  db: Pick<ScopedDb, 'pharmacyBranch' | 'pharmacyBranchAssignment'>,
  scope: {
    organizationId: string;
    branchId: string;
    user: { id: string; role?: string | null; organizationId?: string | null };
  }
): Promise<boolean> {
  const { organizationId, branchId, user } = scope;
  if (!organizationId || !branchId || !user.id || user.organizationId !== organizationId)
    return false;
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: branchId, organizationId, active: true },
    select: { id: true },
  });
  if (!branch) return false;
  if (user.role === 'ADMIN') return true;
  const assignment = await db.pharmacyBranchAssignment.findFirst({
    where: { organizationId, branchId, userId: user.id, active: true },
    select: { id: true },
  });
  return Boolean(assignment);
}
