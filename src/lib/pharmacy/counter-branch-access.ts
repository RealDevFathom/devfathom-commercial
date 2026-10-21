import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export async function readCounterBranchAssignments(
  _db: ScopedDb,
  _organizationId: string,
  _userId: string
): Promise<{ branchId: string }[]> {
  // TODO(#107): use its canonical active branch-assignment helper once merged.
  // Fail closed for members until that dependency lands; do not duplicate its schema.
  return [];
}
