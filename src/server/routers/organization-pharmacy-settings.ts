import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { FinanceAccountCode } from '@/generated/prisma/enums';
import { hasModule } from '@/lib/entitlements';
import { can, subjectFromSession } from '@/lib/abac';
import { decideFromRules } from '@/lib/abac/capabilities';
import { actorIsPharmacyOwner } from '@/lib/pharmacy/procurement-access';
import { actorMayRefund } from '@/lib/pharmacy/refund-authorization';
import { isBalanceSheetLiability } from '@/lib/pharmacy/accounts/balance-sheet';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { annotateAudit, recordAudit } from '@/server/audit';
import { authorizeGeneralJournal } from '../pharmacy-general-journal-security';
import { adminProcedure, protectedProcedure, router, type TRPCContext } from '../trpc';
import { authorizeReversal } from './pharmacy-ap-invoices';

const mappingFields = { terminalRefundAccount: true, usesCustomFinanceChart: true } as const;
const action = 'organizationAdmin.pharmacySettings.setRefundMapping';

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

type SignedInContext = TRPCContext & { session: NonNullable<TRPCContext['session']> };
async function mappingWriteScope(ctx: SignedInContext, organizationId: string) {
  // This mapping is organization-wide. The shared journal gate still verifies an active finance branch.
  const branch = await ctx.db.pharmacyBranch.findFirst({
    where: { organizationId, active: true },
    orderBy: { id: 'asc' },
    select: { id: true },
  });
  if (!branch)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'An active finance branch is required.' });
  return authorizeGeneralJournal(ctx, branch.id);
}

export const organizationPharmacySettingsRouter = router({
  refundMapping: protectedProcedure.query(async ({ ctx }) => {
    const organizationId = await requireProviderRefundMappingAccess(ctx);
    let canEdit = false;
    if (
      (await actorMayRefund(ctx.db, ctx.session.user)) &&
      (await can(subjectFromSession(ctx.session.user), 'admin:access', undefined, {
        db: ctx.db,
        source: 'TRPC',
      }))
    ) {
      try {
        await mappingWriteScope(ctx, organizationId);
        canEdit = true;
      } catch (error) {
        if (!(error instanceof TRPCError && error.code === 'FORBIDDEN')) throw error;
      }
    }
    return {
      ...(await ctx.db.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: mappingFields,
      })),
      canEdit,
    };
  }),
  setRefundMapping: adminProcedure
    .input(
      z
        .object({
          usesCustomFinanceChart: z.boolean(),
          account: z.enum(FinanceAccountCode).nullable(),
          pin: z.string().regex(/^\d{4,8}$/),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      annotateAudit(ctx, { skipInput: true });
      const organizationId = await requireProviderRefundMappingAccess(ctx);
      const scope = await mappingWriteScope(ctx, organizationId);
      if (
        input.account &&
        (!isBalanceSheetLiability(input.account) || input.account === 'MANUAL_NONTRADE_ACCRUAL')
      )
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Choose a liability account available for provider refunds.',
        });
      return ctx.db.$transaction(async (tx) => {
        const db = tx as ScopedDb;
        // Serialize edits and their maker-checker decisions. A non-key lock permits the independent credential transaction.
        await db.$queryRaw`SELECT id FROM organizations WHERE id = ${organizationId} FOR NO KEY UPDATE`;
        const before = await db.organization.findUniqueOrThrow({
          where: { id: organizationId },
          select: { ...mappingFields, terminalRefundMappingActorId: true },
        });
        await authorizeReversal(
          { ...ctx, db },
          scope,
          { pin: input.pin, commandKey: action },
          before.terminalRefundMappingActorId
            ? { createdByUserId: before.terminalRefundMappingActorId, reverseCommandKey: null }
            : null,
          action
        );
        if (
          before.terminalRefundAccount === input.account &&
          before.usesCustomFinanceChart === input.usesCustomFinanceChart
        )
          return { saved: true };
        await db.organization.update({
          where: { id: organizationId },
          data: {
            terminalRefundAccount: input.account,
            usesCustomFinanceChart: input.usesCustomFinanceChart,
            terminalRefundMappingActorId: scope.actorId,
          },
        });
        const changes = {
          account: {
            before:
              before.terminalRefundAccount ??
              (before.usesCustomFinanceChart ? null : 'CARD_REFUNDS_PAYABLE'),
            after: input.account ?? (input.usesCustomFinanceChart ? null : 'CARD_REFUNDS_PAYABLE'),
          },
          terminalRefundAccount: { before: before.terminalRefundAccount, after: input.account },
          usesCustomFinanceChart: {
            before: before.usesCustomFinanceChart,
            after: input.usesCustomFinanceChart,
          },
        };
        const detail = {
          targetType: 'Organization',
          targetId: organizationId,
          operation: 'UPDATE' as const,
          description: 'Updated the provider refund liability account mapping',
          metadata: {
            account: input.account,
            usesCustomFinanceChart: input.usesCustomFinanceChart,
          },
          changes,
        };
        await recordAudit(
          {
            ...detail,
            organizationId,
            actorId: scope.actorId,
            actorName: ctx.session.user.name,
            actorEmail: ctx.session.user.email,
            source: 'TRPC',
            category: 'PHARMACY_FINANCE',
            action: 'pharmacy.providerRefundMappingChanged',
          },
          db
        );
        annotateAudit(ctx, { ...detail, skipInput: true });
        return { saved: true };
      });
    }),
});
