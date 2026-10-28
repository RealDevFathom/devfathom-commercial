import { TRPCError } from '@trpc/server';
import { actorCanProcure, actorCanReadPurchasing } from '@/lib/pharmacy/procurement-access';
import { assignedRegisterBranchIds } from '@/lib/pharmacy/controlled-register';
import type { TRPCContext } from './trpc';

export async function assertProcurement(ctx: TRPCContext) {
  const actorId = ctx.session?.user?.id;
  if (!actorId || !(await actorCanProcure(ctx.db, actorId))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
  }
}

export async function assertProcurementBranch(ctx: TRPCContext, branchId: string) {
  const organizationId = ctx.entitlements?.organizationId;
  const actorId = ctx.session?.user?.id;
  if (!organizationId || !actorId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  const assigned = await assignedRegisterBranchIds(ctx.db, organizationId, actorId);
  if (
    !assigned.includes(branchId) ||
    !(await ctx.db.pharmacyBranch.findFirst({
      where: { id: branchId, organizationId, active: true },
      select: { id: true },
    }))
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your pharmacy scope.' });
  }
  return { organizationId, branchId, actorId };
}

export async function assertPurchasingRead(ctx: TRPCContext) {
  const actorId = ctx.session?.user?.id;
  if (!actorId || !(await actorCanReadPurchasing(ctx.db, actorId))) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Purchasing read access required.' });
  }
}
