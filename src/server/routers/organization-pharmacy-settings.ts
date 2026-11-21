import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { hasModule } from '@/lib/entitlements';
import { can, subjectFromSession } from '@/lib/abac';
import { decideFromRules } from '@/lib/abac/capabilities';
import { actorIsPharmacyOwner } from '@/lib/pharmacy/procurement-access';
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
    select: {
      organizationRole: { select: { permissions: { select: { capability: true, effect: true } } } },
      permissionOverrides: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { capability: true, effect: true },
      },
    },
  });
  const explicitFinance =
    member &&
    decideFromRules(
      [...member.permissionOverrides, ...(member.organizationRole?.permissions ?? [])],
      'finance:read'
    );
  if (
    !member ||
    explicitFinance === false ||
    (!explicitFinance && !(await actorIsPharmacyOwner(ctx.db, org, user.id))) ||
    !(await can(subjectFromSession(user), 'finance:read', undefined, {
      db: ctx.db,
      source: 'TRPC',
    }))
  )
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Finance access is required to view the provider refund account.',
    });
  return org;
}

export const organizationPharmacySettingsRouter = router({
  refundMapping: protectedProcedure.input(z.void()).query(async ({ ctx }) => {
    await requireProviderRefundMappingAccess(ctx);
    return { terminalRefundAccount: 'CARD_REFUNDS_PAYABLE' as const };
  }),
});
