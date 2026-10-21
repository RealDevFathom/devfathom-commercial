import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export async function readCounterBranchAssignments(
  db: ScopedDb,
  organizationId: string,
  userId: string
): Promise<{ branchId: string }[]> {
  return db.pharmacyBranchAssignment.findMany({
    where: { organizationId, userId, active: true, branch: { active: true, organizationId } },
    select: { branchId: true },
  });
}
