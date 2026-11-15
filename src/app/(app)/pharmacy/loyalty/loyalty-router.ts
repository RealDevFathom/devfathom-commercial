import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { hasModule } from '@/lib/entitlements';
import {
  listLoyaltyCustomers,
  readLoyaltyHistory,
  LOYALTY_HISTORY_MAX_PAGE,
  PharmacyLoyaltyError,
} from '@/lib/pharmacy/customer-loyalty';
import {
  LOYALTY_EARN_PRESETS,
  listLoyaltyProgramVersions,
  percentRule,
  publishLoyaltyProgramVersion,
  stepRule,
} from '@/lib/pharmacy/loyalty-program';
import { assertLoyaltyEarnRule, type LoyaltyEarnRule } from '@/lib/commerce/loyalty-arithmetic';
import { annotateAudit } from '@/server/audit';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { adminProcedure, router, type TRPCContext } from '@/server/trpc';

const txDb = (tx: unknown) => tx as ScopedDb;

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

export const LOYALTY_EARN_OPTIONS: [string, ...string[]] = [
  'custom-percent',
  'custom-step',
  ...LOYALTY_EARN_PRESETS.map((preset) => preset.id),
];

export const earnRateInput = z
  .object({
    option: z.enum(LOYALTY_EARN_OPTIONS),
    // Up to two decimals, e.g. "1.5" for 1.5% of spend.
    percent: z
      .string()
      .trim()
      .regex(/^\d{1,3}(\.\d{1,2})?$/)
      .optional(),
    stepPoints: z.number().int().min(1).max(1_000_000).optional(),
    stepRupees: z.number().int().min(1).max(20_000_000).optional(),
  })
  .strict();

/** Resolves the owner's chosen setup option to an earning rule; refuses an invalid one. */
export function earnRuleFor(input: z.infer<typeof earnRateInput>): LoyaltyEarnRule {
  const preset = LOYALTY_EARN_PRESETS.find((option) => option.id === input.option);
  let rule: LoyaltyEarnRule | null = preset ? { ...preset.rule } : null;
  if (input.option === 'custom-percent' && input.percent) {
    const [whole, fraction = ''] = input.percent.split('.');
    rule = percentRule(Number(whole) * 100 + Number(fraction.padEnd(2, '0')));
  } else if (input.option === 'custom-step' && input.stepPoints && input.stepRupees) {
    rule = stepRule(input.stepPoints, input.stepRupees);
  }
  try {
    if (!rule) throw new RangeError('INVALID_EARN_RULE');
    assertLoyaltyEarnRule(rule);
  } catch {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Choose an earning rate above 0% that pays back no more than 100% of spend.',
    });
  }
  return rule;
}

// Server-page caller: no central router mutation. Explicit CRM check also applies
// when composed by core integration; see evidence/handoff-loyalty-20261008.md.
export const pharmacyLoyaltyRouter = router({
  // DEV-746: the owner's earning rate, as dated, immutable program versions.
  earnRate: adminProcedure.query(async ({ ctx }) => {
    const scope = scopeFor(ctx);
    const versions = await listLoyaltyProgramVersions(ctx.db, scope.organizationId);
    return { current: versions[0] ?? null, versions };
  }),
  setEarnRate: adminProcedure.input(earnRateInput).mutation(async ({ ctx, input }) => {
    const scope = scopeFor(ctx);
    const rule = earnRuleFor(input);
    // The previous version is read under the publication lock, so concurrent saves each
    // audit the transition they actually made.
    const { prior, version } = await ctx.db.$transaction((tx) =>
      publishLoyaltyProgramVersion(txDb(tx), scope, rule)
    );
    annotateAudit(ctx, {
      category: 'PHARMACY',
      operation: 'CREATE',
      action: 'pharmacyLoyalty.setEarnRate',
      targetType: 'PharmacyLoyaltyProgramVersion',
      targetId: version.id,
      changes: {
        earnRule: {
          before: prior
            ? {
                version: prior.version,
                earnMode: prior.earnMode,
                earnPoints: prior.earnPoints,
                perSpendMinor: prior.perSpendMinor,
              }
            : null,
          after: {
            version: version.version,
            earnMode: version.earnMode,
            earnPoints: version.earnPoints,
            perSpendMinor: version.perSpendMinor,
          },
        },
      },
      metadata: { option: input.option },
    });
    return version;
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
