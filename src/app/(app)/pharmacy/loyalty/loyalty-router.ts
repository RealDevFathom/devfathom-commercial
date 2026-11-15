import 'server-only';
import {
  configureLoyaltyProgram,
  currentLoyaltyProgram,
  loyaltyReconciliation,
} from '@/lib/pharmacy/loyalty-program';
import { LOYALTY_RATE_OPTIONS } from '@/lib/pharmacy/loyalty-rate';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { hasModule } from '@/lib/entitlements';
import {
  listLoyaltyCustomers,
  readLoyaltyHistory,
  LOYALTY_HISTORY_MAX_PAGE,
  PharmacyLoyaltyError,
} from '@/lib/pharmacy/customer-loyalty';
import { annotateAudit } from '@/server/audit';
import { adminProcedure, router, type TRPCContext } from '@/server/trpc';

function scopeFor(ctx: TRPCContext, branchId = '') {
  const organizationId = ctx.session?.user.organizationId;
  const actorId = ctx.session?.user.id;
  if (
    !organizationId ||
    !actorId ||
    organizationId !== ctx.entitlements.organizationId ||
    (ctx.organization && ctx.organization.id !== organizationId) ||
    !hasModule(ctx.entitlements, 'pharmacy-crm')
  ) {
    throw new TRPCError({ code: 'FORBIDDEN' });
  }
  return { organizationId, actorId, branchId };
}

const branchInput = z.object({ branchId: z.string().trim().min(1).max(128) });
async function historyRead<T>(read: () => Promise<T>) {
  try {
    return await read();
  } catch (error) {
    if (error instanceof PharmacyLoyaltyError)
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch or customer unavailable.' });
    throw error;
  }
}

// Server-page caller: no central router mutation. Explicit CRM check also applies
// when composed by core integration; see evidence/handoff-loyalty-20261008.md.
export const pharmacyLoyaltyRouter = router({
  settings: adminProcedure.query(async ({ ctx }) => {
    const scope = scopeFor(ctx);
    const [program, migration, reconciliation] = await Promise.all([
      currentLoyaltyProgram(ctx.db, scope.organizationId),
      ctx.db.pharmacyLoyaltyMigration.findUnique({
        where: { organizationId: scope.organizationId },
      }),
      loyaltyReconciliation(ctx.db, scope.organizationId),
    ]);
    return { program, migrated: Boolean(migration), reconciliation };
  }),
  configure: adminProcedure
    .input(
      z
        .object({
          option: z.enum(['percent-1', 'percent-2', 'step-1000', 'percent-custom', 'step-custom']),
          percentage: z
            .string()
            .regex(/^\d{1,3}(\.\d{1,2})?$/)
            .optional(),
          pointsPerStep: z.number().int().min(1).max(1_000_000).optional(),
          spendRupees: z.number().int().min(1).max(20_000_000).optional(),
          khataEnabled: z.boolean(),
          approveReconciliation: z.literal(true),
          reconciliationDigest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = scopeFor(ctx);
      let rate: { mode: string; rewardPoints: number; spendMinor: number };
      const preset = LOYALTY_RATE_OPTIONS.find((option) => option.id === input.option);
      if (preset) rate = preset;
      else if (input.option === 'percent-custom' && input.percentage) {
        const [whole, fraction = ''] = input.percentage.split('.');
        rate = {
          mode: 'PERCENT',
          rewardPoints: Number(whole) * 100 + Number(fraction.padEnd(2, '0')),
          spendMinor: 1_000_000,
        };
      } else if (input.option === 'step-custom' && input.pointsPerStep && input.spendRupees) {
        rate = {
          mode: 'STEP',
          rewardPoints: input.pointsPerStep,
          spendMinor: input.spendRupees * 100,
        };
      } else
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Enter the selected earning rate.' });
      if (
        rate.rewardPoints <= 0 ||
        BigInt(rate.rewardPoints) * BigInt(100) > BigInt(rate.spendMinor)
      )
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Choose an earning rate above 0% and at most 100%.',
        });
      const program = await ctx.db.$transaction((tx) =>
        configureLoyaltyProgram(tx as typeof ctx.db, scope.organizationId, scope.actorId, {
          ...input,
          ...rate,
        })
      );
      annotateAudit(ctx, {
        category: 'PHARMACY',
        operation: 'CREATE',
        action: 'pharmacyLoyalty.configure',
        targetType: 'PharmacyLoyaltyProgramVersion',
        targetId: program.id,
        metadata: {
          version: program.version,
          reconciliationDigest: input.reconciliationDigest,
          khataEnabled: input.khataEnabled,
        },
      });
      return program;
    }),
  branches: adminProcedure.query(({ ctx }) => {
    const scope = scopeFor(ctx);
    return ctx.db.pharmacyBranch.findMany({
      where: { organizationId: scope.organizationId, active: true },
      select: { id: true, name: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  }),
  customers: adminProcedure
    .input(branchInput.extend({ query: z.string().trim().max(100).default('') }).strict())
    .query(({ ctx, input }) =>
      historyRead(() => listLoyaltyCustomers(ctx.db, scopeFor(ctx, input.branchId), input.query))
    ),
  history: adminProcedure
    .input(
      branchInput
        .extend({
          customerId: z.string().trim().min(1).max(128),
          page: z.number().int().min(1).max(LOYALTY_HISTORY_MAX_PAGE).default(1),
        })
        .strict()
    )
    .query(({ ctx, input }) =>
      historyRead(() =>
        readLoyaltyHistory(ctx.db, scopeFor(ctx, input.branchId), input.customerId, input.page)
      )
    ),
  setReminderLanguage: adminProcedure
    .input(
      branchInput
        .extend({
          customerId: z.string().trim().min(1).max(128),
          preferredLanguage: z.enum(['en', 'ur']),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const scope = scopeFor(ctx, input.branchId);
      const branch = await ctx.db.pharmacyBranch.findFirst({
        where: { id: input.branchId, organizationId: scope.organizationId, active: true },
        select: { id: true },
      });
      if (!branch) throw new TRPCError({ code: 'NOT_FOUND' });
      const current = await ctx.db.pharmacyCustomer.findFirst({
        where: { id: input.customerId, organizationId: scope.organizationId, active: true },
        select: { id: true, preferredLanguage: true },
      });
      if (!current) throw new TRPCError({ code: 'NOT_FOUND' });
      const updated = await ctx.db.pharmacyCustomer.updateMany({
        where: { id: input.customerId, organizationId: scope.organizationId, active: true },
        data: { preferredLanguage: input.preferredLanguage },
      });
      if (updated.count !== 1) throw new TRPCError({ code: 'NOT_FOUND' });
      annotateAudit(ctx, {
        category: 'PHARMACY',
        operation: 'UPDATE',
        action: 'pharmacyCustomer.setReminderLanguage',
        targetType: 'PharmacyCustomer',
        targetId: current.id,
        changes: {
          preferredLanguage: { before: current.preferredLanguage, after: input.preferredLanguage },
        },
        metadata: { branchId: input.branchId },
      });
      return { preferredLanguage: input.preferredLanguage };
    }),
});
