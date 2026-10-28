import { TRPCError } from '@trpc/server';
import { can } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';

import { isPharmacyOwner } from './owner';

/** The common tenant, live membership, branch assignment and optional counter/device boundary. */
export async function assertBranchAssignment(
  db: ScopedDb,
  scope: LedgerScope,
  options: { counter?: boolean; deviceId?: string } = {}
): Promise<LedgerScope> {
  const deny = () => new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: scope.branchId, organizationId: scope.organizationId, active: true },
    select: { id: true },
  });
  if (!branch) throw deny();
  const member = await db.user.findUnique({
    where: { id: scope.actorId },
    select: {
      id: true,
      role: true,
      status: true,
      organizationId: true,
      organizationRole: { select: { key: true } },
    },
  });
  if (!member || member.organizationId !== scope.organizationId || member.status !== 'ACTIVE')
    throw deny();
  if (!(await isPharmacyOwner(db, scope.organizationId, scope.actorId))) {
    const assignments = await db.pharmacyBranchAssignment.findMany({
      where: {
        organizationId: scope.organizationId,
        userId: scope.actorId,
        active: true,
        branch: { organizationId: scope.organizationId, active: true },
      },
      select: { branchId: true },
    });
    if (!assignments.some((row) => row.branchId === scope.branchId)) throw deny();
  }
  if (options.counter && !(await can(member, 'pharmacy:counter', undefined, { db }))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
  }
  if (options.deviceId !== undefined) {
    const device = await db.pharmacyRegisteredDevice.findFirst({
      where: {
        id: options.deviceId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        status: 'ACTIVE',
        revokedAt: null,
      },
      select: { id: true },
    });
    if (!device)
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Counter device is outside your scope.' });
  }
  return scope;
}
