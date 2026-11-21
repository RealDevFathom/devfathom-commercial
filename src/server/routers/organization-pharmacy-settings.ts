import { requirePharmacyFinance } from '@/lib/pharmacy/finance-access';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { hasModule } from '@/lib/entitlements';
import { protectedProcedure, router, type TRPCContext } from '../trpc';

export async function requireProviderRefundMappingAccess(ctx: TRPCContext) {
  const org = ctx.organization?.id;
  const user = ctx.session?.user;
  if (
    !org ||
    !user ||
    (user.organizationId && user.organizationId !== org) ||
    ctx.entitlements.organizationId !== org ||
    !hasModule(ctx.entitlements, 'pharmacy-core') ||
    !hasModule(ctx.entitlements, 'pharmacy-finance')
  )
    throw new TRPCError({ code: 'FORBIDDEN' });
  const member = await ctx.db.user.findUnique({
    where: { id: user.id, organizationId: org, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!member || !ctx.session)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Active finance membership is required to view the provider refund account.',
    });
  await requirePharmacyFinance({ ...ctx, session: ctx.session });
  return org;
}

export const organizationPharmacySettingsRouter = router({
  refundMapping: protectedProcedure.input(z.void()).query(async ({ ctx }) => {
    await requireProviderRefundMappingAccess(ctx);
    return { terminalRefundAccount: 'CARD_REFUNDS_PAYABLE' as const };
  }),
});
