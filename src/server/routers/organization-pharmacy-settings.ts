import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { FinanceAccountCode } from '@/generated/prisma/enums';
import { hasModule } from '@/lib/entitlements';
import { can, subjectFromSession } from '@/lib/abac';
import { actorIsPharmacyOwner } from '@/lib/pharmacy/procurement-access';
import { isBalanceSheetLiability } from '@/lib/pharmacy/accounts/balance-sheet';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { annotateAudit } from '@/server/audit';
import { protectedProcedure, router, type TRPCContext } from '../trpc';

export async function requireProviderRefundMappingAccess(ctx: TRPCContext) {
  const org = ctx.organization?.id;
  const user = ctx.session?.user;
  if (
    !org ||
    !user ||
    ctx.entitlements.organizationId !== org ||
    !hasModule(ctx.entitlements, 'pharmacy-core')
  )
    throw new TRPCError({ code: 'FORBIDDEN' });
  const db = ctx.db as ScopedDb;
  if (await actorIsPharmacyOwner(db, org, user.id)) return org;
  const accountant = await db.user.findFirst({
    where: {
      id: user.id,
      organizationId: org,
      status: 'ACTIVE',
      organizationRole: { key: 'accountant' },
    },
    select: { id: true },
  });
  if (
    !accountant ||
    !(await can(subjectFromSession(user), 'reports:financial', undefined, { db, source: 'TRPC' }))
  )
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only the owner or accountant can manage the provider refund account.',
    });
  return org;
}

export const organizationPharmacySettingsRouter = router({
  refundMapping: protectedProcedure.query(async ({ ctx }) => {
    const organizationId = await requireProviderRefundMappingAccess(ctx);
    return ctx.db.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { terminalRefundAccount: true, usesCustomFinanceChart: true },
    });
  }),
  setRefundMapping: protectedProcedure
    .input(
      z
        .object({
          usesCustomFinanceChart: z.boolean(),
          account: z.enum(FinanceAccountCode).nullable(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const organizationId = await requireProviderRefundMappingAccess(ctx);
      if (
        input.account &&
        (!isBalanceSheetLiability(input.account) || input.account === 'MANUAL_NONTRADE_ACCRUAL')
      )
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Choose a liability account available for provider refunds.',
        });
      await ctx.db.organization.update({
        where: { id: organizationId },
        data: {
          usesCustomFinanceChart: input.usesCustomFinanceChart,
          terminalRefundAccount: input.account,
        },
      });
      annotateAudit(ctx, {
        targetType: 'Organization',
        targetId: organizationId,
        operation: 'UPDATE',
        description: 'Updated the provider refund liability account mapping',
        metadata: { account: input.account, usesCustomFinanceChart: input.usesCustomFinanceChart },
      });
      return { saved: true };
    }),
});
