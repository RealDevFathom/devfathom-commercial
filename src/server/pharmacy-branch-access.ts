import { TRPCError } from '@trpc/server';
import { ACTIVE_STATUSES } from '@/lib/auth/session-state';
import { annotateAudit } from './audit';
import type { TRPCContext } from './trpc';

/** Canonical capability is checked by the procedure before any patient query. */
export async function pharmacyReadBranches(ctx: TRPCContext) {
  const organizationId = ctx.entitlements?.organizationId;
  const user = ctx.session?.user;
  if (!organizationId || !user || user.organizationId !== organizationId)
    throw new TRPCError({ code: 'FORBIDDEN' });
  const member = await ctx.db.user.findFirst({
    where: {
      id: user.id,
      organizationId,
      status: { in: [...ACTIVE_STATUSES] as ('ACTIVE' | 'ON_LEAVE')[] },
    },
    select: { id: true, role: true },
  });
  if (!member) throw new TRPCError({ code: 'FORBIDDEN' });
  const branches = await ctx.db.pharmacyBranch.findMany({
    where: {
      organizationId,
      active: true,
      ...(user.role === 'ADMIN' && member.role === 'ADMIN'
        ? {}
        : {
            branchAssignments: { some: { organizationId, userId: user.id, active: true } },
          }),
    },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
  return branches;
}

export async function requirePharmacyReadBranch(ctx: TRPCContext, branchId?: string) {
  const branches = await pharmacyReadBranches(ctx);
  const branch = branchId ? branches.find((b) => b.id === branchId) : branches[0];
  if (!branch) throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
  annotateAudit(ctx, {
    targetType: 'PharmacyBranch',
    targetId: branch.id,
    metadata: { branchId: branch.id, reason: 'pharmacy-dispense-branch-access' },
  });
  return { branch, branches };
}
