import { TRPCError } from '@trpc/server';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { actorCanProcure } from './procurement-access';
import { assertBranchAssignment } from './branch-assignment';
export async function requireProcurement(db: ScopedDb, actorId: string) {
  if (!(await actorCanProcure(db, actorId))) throw new TRPCError({ code: 'FORBIDDEN' });
}
export async function requireProcurementBranch(
  db: ScopedDb,
  organizationId: string,
  actorId: string,
  branchId: string
) {
  await assertBranchAssignment(db, { organizationId, actorId, branchId });
}
