import { TRPCError } from '@trpc/server';
import {
  actorCanProcure,
  actorCanReadPurchasing,
} from '@/lib/pharmacy/procurement-access';
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

export { assertProcurementBranch } from './pharmacy-procurement-scope';

export async function assertPurchasingRead(ctx: TRPCContext) {
  const actorId = ctx.session?.user?.id;
  if (!actorId || !(await actorCanReadPurchasing(ctx.db, actorId))) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Purchasing read access required.' });
  }
}
