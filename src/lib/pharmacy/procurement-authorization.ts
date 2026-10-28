import 'server-only';
import { createHash } from 'node:crypto';

import { TRPCError } from '@trpc/server';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { actorCanProcure } from './procurement-access';

export function isPharmacyOwner(user: {
  role?: string;
  organizationRole?: { key?: string; isSystem?: boolean } | null;
}) {
  return (
    user.role === 'ADMIN' ||
    (user.organizationRole?.isSystem === true &&
      ['owner', 'owner-operator'].includes(user.organizationRole.key ?? ''))
  );
}

export async function requireProcurement(db: ScopedDb, actorId: string) {
  if (!(await actorCanProcure(db, actorId))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
  }
}

/** Resolve both the live tenant branch and the acting member's assignment. */
export async function requireProcurementBranch(
  db: ScopedDb,
  organizationId: string,
  actorId: string,
  branchId: string
) {
  const branch = await db.pharmacyBranch.findFirst({
    where: { id: branchId, organizationId, active: true },
    select: { id: true },
  });
  if (!branch) throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
  const actor = await db.user.findUnique({
    where: { id: actorId },
    select: {
      organizationId: true,
      status: true,
      role: true,
      organizationRole: { select: { key: true, isSystem: true } },
    },
  });
  if (
    !actor ||
    actor.organizationId !== organizationId ||
    !['ACTIVE', 'ON_LEAVE'].includes(actor.status)
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
  }
  if (isPharmacyOwner(actor)) {
    // Heal pre-migration assignments as well as providing an immediate owner grant.
    const branches = await db.pharmacyBranch.findMany({
      where: { organizationId },
      select: { id: true },
    });
    for (const branch of branches)
      await db.pharmacyBranchAssignment.upsert({
        where: {
          organizationId_branchId_userId: { organizationId, branchId: branch.id, userId: actorId },
        },
        create: {
          id: `pba_${createHash('md5').update(`${organizationId}:${branch.id}:${actorId}`).digest('hex')}`,
          organizationId,
          branchId: branch.id,
          userId: actorId,
          active: true,
        },
        update: { active: true },
      });
    return;
  }
  if (
    !(await db.pharmacyBranchAssignment.findFirst({
      where: { organizationId, branchId, userId: actorId, active: true },
      select: { id: true },
    }))
  )
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
}
