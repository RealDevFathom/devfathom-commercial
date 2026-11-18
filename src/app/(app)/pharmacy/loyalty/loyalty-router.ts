import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { hasModule } from '@/lib/entitlements';
import { can, subjectFromSession } from '@/lib/abac';
import {
  adjustLoyaltyPoints,
  listLoyaltyCustomers,
  listLoyaltyRedemptions,
  readLoyaltyHistory,
  readLoyaltyLiability,
  LOYALTY_HISTORY_MAX_PAGE,
  LOYALTY_MAX_ADJUSTMENT_POINTS,
  PharmacyLoyaltyError,
} from '@/lib/pharmacy/customer-loyalty';
import {
  DEFAULT_MANAGER_ADJUST_LIMIT_POINTS,
  LOYALTY_EARN_PRESETS,
  LOYALTY_MAX_EXPIRY_DAYS,
  LOYALTY_MAX_MANAGER_ADJUST_LIMIT_POINTS,
  listLoyaltyProgramVersions,
  lockedLoyaltyProgram,
  percentRule,
  publishLoyaltyProgramVersion,
  stepRule,
  type LoyaltyProgramSettings,
} from '@/lib/pharmacy/loyalty-program';
import {
  assertLoyaltyEarnRule,
  LOYALTY_MAX_POINT_VALUE_MINOR,
  LOYALTY_POINT_VALUE_MINOR,
  type LoyaltyEarnRule,
} from '@/lib/commerce/loyalty-arithmetic';
import {
  issueLoyaltyCard,
  readActiveLoyaltyCard,
  revokeLoyaltyCard,
} from '@/lib/pharmacy/loyalty-card';
import {
  LOYALTY_MEMBERSHIP_REASON_MAX,
  LOYALTY_MEMBERSHIP_REASON_MIN,
  setLoyaltyMembership,
} from '@/lib/pharmacy/loyalty-membership';
import { annotateAudit } from '@/server/audit';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { requireDrawerManagerAccess } from '@/server/routers/pharmacy-sales';
import {
  adminProcedure,
  auditedProtectedProcedure,
  protectedProcedure,
  router,
  type TRPCContext,
} from '@/server/trpc';

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

export const adjustPointsInput = branchInput
  .extend({
    customerId: z.string().trim().min(1).max(128),
    points: z
      .number()
      .int()
      .min(-LOYALTY_MAX_ADJUSTMENT_POINTS)
      .max(LOYALTY_MAX_ADJUSTMENT_POINTS)
      .refine((points) => points !== 0),
    reason: z.string().trim().min(3).max(500),
    idempotencyKey: z.string().trim().min(8).max(128),
  })
  .strict();

export const membershipInput = branchInput
  .extend({
    customerId: z.string().trim().min(1).max(128),
    active: z.boolean(),
    reason: z.string().trim().min(LOYALTY_MEMBERSHIP_REASON_MIN).max(LOYALTY_MEMBERSHIP_REASON_MAX),
  })
  .strict();

/**
 * DEV-764: an owner (session administrator of this organization) or a manager actively
 * assigned to the branch, through the same manager gate as drawer cash movements. A cashier
 * is refused before any lock or write.
 */
async function isOwner(ctx: TRPCContext) {
  const user = ctx.session!.user;
  return (
    user.role === 'ADMIN' &&
    (await can(subjectFromSession(user), 'admin:access', undefined, { db: ctx.db }))
  );
}

async function requireAdjustAccess(ctx: TRPCContext, branchId: string) {
  const scope = scopeFor(ctx, branchId);
  if (await isOwner(ctx)) return { scope, authority: 'OWNER' as const };
  const managed = await requireDrawerManagerAccess(ctx, branchId);
  if (managed.organizationId !== scope.organizationId || managed.branchId !== branchId)
    throw new TRPCError({ code: 'FORBIDDEN' });
  return { scope, authority: 'MANAGER' as const };
}

/**
 * DEV-909: deactivating a member stops them earning and redeeming at every branch, so only the
 * owner may do it. A branch manager is refused before the manager gate, any lock or any write.
 */
async function requireOwnerAccess(ctx: TRPCContext, branchId: string) {
  const scope = scopeFor(ctx, branchId);
  if (!(await isOwner(ctx)))
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only the owner may deactivate a member for the whole organisation.',
    });
  return { scope, authority: 'OWNER' as const };
}

/**
 * DEV-909: the owner reads every branch's history. A manager of the requested branch reads the
 * shared balance, with detailed history limited to the active branches they are assigned to.
 */
async function requireHistoryAccess(ctx: TRPCContext, branchId: string) {
  const { scope, authority } = await requireAdjustAccess(ctx, branchId);
  if (authority === 'OWNER') return { scope, visibleBranchIds: undefined };
  const assigned = await ctx.db.pharmacyBranchAssignment.findMany({
    where: {
      organizationId: scope.organizationId,
      userId: scope.actorId,
      active: true,
      branch: { organizationId: scope.organizationId, active: true },
    },
    select: { branchId: true },
  });
  const visibleBranchIds = [...new Set([branchId, ...assigned.map((row) => row.branchId)])];
  return { scope, visibleBranchIds };
}

const cardInput = branchInput.extend({ customerId: z.string().trim().min(1).max(128) });

/** DEV-748: card domain refusals as the console shows them. */
async function cardWrite<T>(write: () => Promise<T>) {
  try {
    return await write();
  } catch (error) {
    if (error instanceof PharmacyLoyaltyError) {
      if (error.reason === 'CUSTOMER_NOT_FOUND')
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch or customer unavailable.' });
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          error.reason === 'LOYALTY_CONSENT_REQUIRED'
            ? 'This customer has not given loyalty consent. Record consent before issuing a card.'
            : error.reason === 'LOYALTY_CARD_NOT_ACTIVE'
              ? 'This customer has no working card.'
              : error.reason === 'LOYALTY_CARD_REASON_REQUIRED'
                ? 'Give a reason of 3 to 200 characters, such as "Card lost".'
                : 'The card was changed at the same time. Reload and try again.',
      });
    }
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
    // DEV-764: what one point redeems for, in rupees with up to two decimals ("1", "0.50").
    pointValue: z
      .string()
      .trim()
      .regex(/^\d{1,4}(\.\d{1,2})?$/)
      .optional(),
    // DEV-764: days a point lasts; null means points never expire.
    expiryDays: z.number().int().min(1).max(LOYALTY_MAX_EXPIRY_DAYS).nullable().optional(),
    // DEV-764: whether khata purchases earn once the customer pays them off.
    khataEarns: z.boolean().optional(),
    // DEV-764: the largest manual adjustment a manager may make; larger ones need the owner.
    managerAdjustLimitPoints: z
      .number()
      .int()
      .min(0)
      .max(LOYALTY_MAX_MANAGER_ADJUST_LIMIT_POINTS)
      .optional(),
  })
  .strict();

const rupeesToMinor = (value: string) => {
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
};

/**
 * Resolves the owner's chosen setup option to an earning rule at the given redemption value;
 * refuses an invalid one.
 */
export function earnRuleFor(
  input: z.infer<typeof earnRateInput>,
  pointValueMinor = LOYALTY_POINT_VALUE_MINOR
): LoyaltyEarnRule {
  const preset = LOYALTY_EARN_PRESETS.find((option) => option.id === input.option);
  let rule: LoyaltyEarnRule | null = preset
    ? preset.rule.earnMode === 'PERCENT_OF_SPEND'
      ? percentRule(preset.rule.earnPoints, pointValueMinor)
      : { ...preset.rule }
    : null;
  if (input.option === 'custom-percent' && input.percent) {
    rule = percentRule(rupeesToMinor(input.percent), pointValueMinor);
  } else if (input.option === 'custom-step' && input.stepPoints && input.stepRupees) {
    rule = stepRule(input.stepPoints, input.stepRupees);
  }
  try {
    if (!rule) throw new RangeError('INVALID_EARN_RULE');
    rule = { ...rule, redemptionValueMinor: pointValueMinor };
    assertLoyaltyEarnRule(rule);
  } catch {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'Choose an earning rate above 0% that pays back no more than 100% of spend at the redemption value.',
    });
  }
  return rule;
}

/**
 * DEV-764: the full settings of the next version. A setting the owner did not send is carried
 * forward from the version in force (read under the publication lock).
 */
export function programSettingsFor(
  input: z.infer<typeof earnRateInput>,
  prior: {
    redemptionValueMinor?: number;
    expiryDays?: number | null;
    khataEarns?: boolean;
    managerAdjustLimitPoints?: number;
  } | null
): LoyaltyProgramSettings {
  const pointValueMinor =
    input.pointValue !== undefined
      ? rupeesToMinor(input.pointValue)
      : (prior?.redemptionValueMinor ?? LOYALTY_POINT_VALUE_MINOR);
  if (pointValueMinor < 1 || pointValueMinor > LOYALTY_MAX_POINT_VALUE_MINOR)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Choose a redemption value from PKR 0.01 to PKR 1,000 per point.',
    });
  const rule = earnRuleFor(input, pointValueMinor);
  return {
    ...rule,
    // Not sent and nothing in force: leave unset, so the database default applies.
    redemptionValueMinor:
      input.pointValue !== undefined || prior?.redemptionValueMinor !== undefined
        ? pointValueMinor
        : undefined,
    expiryDays: input.expiryDays !== undefined ? input.expiryDays : prior?.expiryDays,
    khataEarns: input.khataEarns ?? prior?.khataEarns,
    managerAdjustLimitPoints: input.managerAdjustLimitPoints ?? prior?.managerAdjustLimitPoints,
  };
}

const programSnapshot = (version: {
  version: number;
  earnMode: string;
  earnPoints: number;
  perSpendMinor: number;
  redemptionValueMinor?: number;
  expiryDays?: number | null;
  khataEarns?: boolean;
  managerAdjustLimitPoints?: number;
}) => ({
  version: version.version,
  earnMode: version.earnMode,
  earnPoints: version.earnPoints,
  perSpendMinor: version.perSpendMinor,
  redemptionValueMinor: version.redemptionValueMinor,
  expiryDays: version.expiryDays,
  khataEarns: version.khataEarns,
  managerAdjustLimitPoints: version.managerAdjustLimitPoints,
});

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
    // The previous version is read under the publication lock, so concurrent saves each
    // audit the transition they actually made, and unchanged settings carry forward from it.
    const { prior, version } = await ctx.db.$transaction((tx) =>
      publishLoyaltyProgramVersion(txDb(tx), scope, (current) => programSettingsFor(input, current))
    );
    annotateAudit(ctx, {
      category: 'PHARMACY',
      operation: 'CREATE',
      action: 'pharmacyLoyalty.setEarnRate',
      targetType: 'PharmacyLoyaltyProgramVersion',
      targetId: version.id,
      changes: {
        earnRule: {
          before: prior ? programSnapshot(prior) : null,
          after: programSnapshot(version),
        },
      },
      metadata: { option: input.option },
    });
    return version;
  }),
  // DEV-764: value of unredeemed points, organization-wide and per branch.
  liability: adminProcedure.query(async ({ ctx }) => {
    const scope = scopeFor(ctx);
    return readLoyaltyLiability(ctx.db, scope.organizationId);
  }),
  // DEV-764: points redemptions at one branch, newest first.
  redemptions: adminProcedure
    .input(
      branchInput
        .extend({ page: z.number().int().min(1).max(LOYALTY_HISTORY_MAX_PAGE).default(1) })
        .strict()
    )
    .query(({ ctx, input }) =>
      historyRead(() => listLoyaltyRedemptions(ctx.db, scopeFor(ctx, input.branchId), input.page))
    ),
  // DEV-764: owner or manager correction of a customer's points, with a written reason.
  adjustPoints: protectedProcedure.input(adjustPointsInput).mutation(async ({ ctx, input }) => {
    const { scope, authority } = await requireAdjustAccess(ctx, input.branchId);
    let result: Awaited<ReturnType<typeof adjustLoyaltyPoints>>;
    let managerLimit = DEFAULT_MANAGER_ADJUST_LIMIT_POINTS;
    try {
      result = await ctx.db.$transaction(async (tx) => {
        // DEV-764: a manager may adjust up to the owner's ceiling; anything larger needs the
        // owner. Read under the program lock, in this transaction, so a concurrent owner save
        // cannot change the ceiling under the adjustment.
        const program = await lockedLoyaltyProgram(txDb(tx), scope.organizationId);
        managerLimit = program?.managerAdjustLimitPoints ?? DEFAULT_MANAGER_ADJUST_LIMIT_POINTS;
        if (authority === 'MANAGER' && Math.abs(input.points) > managerLimit)
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `Adjustments above ${managerLimit.toLocaleString('en-PK')} points need the owner.`,
          });
        return adjustLoyaltyPoints(txDb(tx), scope, {
          customerId: input.customerId,
          points: input.points,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        });
      });
    } catch (error) {
      if (error instanceof PharmacyLoyaltyError) {
        if (error.reason === 'CUSTOMER_NOT_FOUND')
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch or customer unavailable.' });
        throw new TRPCError({
          code: error.reason === 'IDEMPOTENCY_CONFLICT' ? 'CONFLICT' : 'BAD_REQUEST',
          message:
            error.reason === 'ADJUSTMENT_EXCEEDS_BALANCE'
              ? 'A removal cannot take the balance below zero.'
              : error.reason === 'IDEMPOTENCY_CONFLICT'
                ? 'This adjustment was already recorded with different details.'
                : error.reason === 'LOYALTY_INACTIVE'
                  ? 'This member is deactivated. Re-enrol them before adjusting their points.'
                  : 'Enter a whole number of points (not 0) and a reason of at least 3 characters.',
        });
      }
      throw error;
    }
    annotateAudit(ctx, {
      category: 'PHARMACY',
      operation: 'CREATE',
      action: 'pharmacyLoyalty.adjustPoints',
      targetType: 'PharmacyLoyaltyPointsEntry',
      targetId: result.entry.id,
      changes: {
        pointsBalance: { before: result.balanceBefore, after: result.balanceAfter },
      },
      metadata: {
        branchId: input.branchId,
        customerId: input.customerId,
        points: input.points,
        reason: result.entry.reason,
        authority,
        managerLimit,
        replayed: result.replayed,
      },
    });
    return {
      entryId: result.entry.id,
      points: result.entry.points,
      balanceAfter: result.balanceAfter,
      replayed: result.replayed,
    };
  }),
  // DEV-764: enrol (re-enrol) or deactivate a loyalty member, with a written reason. Enrolling
  // uses the same owner-or-branch-manager gate as adjustments; a cashier is refused before any
  // write. DEV-909: deactivating applies to the whole organisation, so only the owner may.
  setMembership: protectedProcedure.input(membershipInput).mutation(async ({ ctx, input }) => {
    const { scope, authority } = input.active
      ? await requireAdjustAccess(ctx, input.branchId)
      : await requireOwnerAccess(ctx, input.branchId);
    let result: Awaited<ReturnType<typeof setLoyaltyMembership>>;
    try {
      result = await ctx.db.$transaction((tx) =>
        setLoyaltyMembership(txDb(tx), scope, {
          customerId: input.customerId,
          active: input.active,
          reason: input.reason,
        })
      );
    } catch (error) {
      if (error instanceof PharmacyLoyaltyError) {
        if (error.reason === 'CUSTOMER_NOT_FOUND')
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch or customer unavailable.' });
        throw new TRPCError({
          code: error.reason === 'LOYALTY_CONSENT_REQUIRED' ? 'PRECONDITION_FAILED' : 'BAD_REQUEST',
          message:
            error.reason === 'LOYALTY_CONSENT_REQUIRED'
              ? 'The customer has not given current loyalty consent. Record consent at the counter, then enrol them.'
              : 'Give a reason of at least 3 characters.',
        });
      }
      throw error;
    }
    annotateAudit(ctx, {
      category: 'PHARMACY',
      operation: 'UPDATE',
      action: input.active ? 'pharmacyLoyalty.enrolMember' : 'pharmacyLoyalty.deactivateMember',
      targetType: 'PharmacyCustomer',
      targetId: result.customer.id,
      changes: { loyaltyActive: { before: result.before, after: result.after } },
      metadata: {
        branchId: input.branchId,
        reason: input.reason,
        pointsBalance: result.pointsBalance,
        authority,
        changed: result.changed,
      },
    });
    return { loyaltyActive: result.after, changed: result.changed };
  }),
  // DEV-748: the customer's working physical card, if any. Never the code or its hash.
  card: adminProcedure
    .input(branchInput.extend({ customerId: z.string().trim().min(1).max(128) }).strict())
    .query(({ ctx, input }) =>
      readActiveLoyaltyCard(ctx.db, scopeFor(ctx, input.branchId).organizationId, input.customerId)
    ),
  // DEV-748: an owner or branch manager issues a physical card, or replaces a lost one. The code
  // is returned once, for printing; only its hash is kept. A replacement revokes the old card.
  issueCard: protectedProcedure
    .input(cardInput.extend({ reason: z.string().trim().max(200).optional() }).strict())
    .mutation(async ({ ctx, input }) => {
      const { scope, authority } = await requireAdjustAccess(ctx, input.branchId);
      const issued = await cardWrite(() =>
        ctx.db.$transaction((tx) =>
          issueLoyaltyCard(txDb(tx), scope, {
            customerId: input.customerId,
            ...(input.reason ? { reason: input.reason } : {}),
          })
        )
      );
      annotateAudit(ctx, {
        category: 'PHARMACY',
        operation: 'CREATE',
        action: issued.replacedCardId ? 'pharmacyLoyalty.replaceCard' : 'pharmacyLoyalty.issueCard',
        targetType: 'PharmacyLoyaltyCard',
        targetId: issued.card.id,
        // Never the card code: it is a bearer token.
        metadata: {
          branchId: input.branchId,
          customerId: input.customerId,
          replacedCardId: issued.replacedCardId,
          reason: issued.replacedReason,
          authority,
        },
      });
      return {
        cardId: issued.card.id,
        issuedAt: issued.card.issuedAt,
        code: issued.code,
        replaced: issued.replacedCardId !== null,
      };
    }),
  // DEV-748: an owner or branch manager stops a card working (lost, stolen) without a new one.
  revokeCard: protectedProcedure
    .input(cardInput.extend({ reason: z.string().trim().min(3).max(200) }).strict())
    .mutation(async ({ ctx, input }) => {
      const { scope, authority } = await requireAdjustAccess(ctx, input.branchId);
      const revoked = await cardWrite(() =>
        ctx.db.$transaction((tx) =>
          revokeLoyaltyCard(txDb(tx), scope, {
            customerId: input.customerId,
            reason: input.reason,
          })
        )
      );
      annotateAudit(ctx, {
        category: 'PHARMACY',
        operation: 'UPDATE',
        action: 'pharmacyLoyalty.revokeCard',
        targetType: 'PharmacyLoyaltyCard',
        targetId: revoked.cardId,
        metadata: {
          branchId: input.branchId,
          customerId: input.customerId,
          reason: revoked.reason,
          authority,
        },
      });
      return { cardId: revoked.cardId };
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
  // DEV-909: the owner, or a manager of this branch (history scoped to their branches).
  history: auditedProtectedProcedure
    .input(
      branchInput
        .extend({
          customerId: z.string().trim().min(1).max(128),
          page: z.number().int().min(1).max(LOYALTY_HISTORY_MAX_PAGE).default(1),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      const { scope, visibleBranchIds } = await requireHistoryAccess(ctx, input.branchId);
      return historyRead(() =>
        readLoyaltyHistory(ctx.db, scope, input.customerId, input.page, visibleBranchIds)
      );
    }),
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
