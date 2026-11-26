import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { actorIsPharmacyOwner } from './procurement-access';

export function isClinicalOwner(
  db: Pick<ScopedDb, 'user'>,
  organizationId: string,
  userId: string
) {
  return actorIsPharmacyOwner(db, organizationId, userId, 'system-owner');
}

export async function clinicalBranchAssignmentDenial(
  db: ScopedDb,
  user: { id: string; role: string },
  organizationId: string,
  branchId: string
): Promise<'branch_forbidden' | null> {
  async function ownsBranch() {
    if (!(await isClinicalOwner(db, organizationId, user.id))) return false;
    return Boolean(
      await db.pharmacyBranch.findFirst({
        where: { id: branchId, organizationId },
        select: { id: true },
      })
    );
  }
  // Check the usual admission path first. A session role only orders the live checks.
  if (user.role === 'ADMIN' && (await ownsBranch())) return null;
  const assignment = await db.pharmacyBranchAssignment.findFirst({
    where: {
      organizationId,
      userId: user.id,
      branchId,
      active: true,
      branch: { organizationId, active: true },
      user: { organizationId, status: 'ACTIVE' },
    },
    select: { branchId: true },
  });
  if (assignment?.branchId === branchId) return null;
  if (user.role !== 'ADMIN' && (await ownsBranch())) return null;
  return 'branch_forbidden';
}
