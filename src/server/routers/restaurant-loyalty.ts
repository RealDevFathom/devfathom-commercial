import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  LoyaltyError,
  adjustLoyaltyPoints,
  configureLoyaltyProgram,
  enrollLoyaltyAccount,
  getLoyaltyAccount,
  getLoyaltyEntry,
  getLoyaltyProgram,
  listLoyaltyAccounts,
  listLoyaltyEntries,
  listLoyaltyPrograms,
  redeemLoyaltyPoints,
} from '@/lib/restaurant/loyalty';
import { annotateAudit } from '@/server/audit';

import { capabilityProcedure, router } from '../trpc';

const readProcedure = capabilityProcedure('customers:read');
const configureProcedure = capabilityProcedure('restaurant:configure');
const redeemProcedure = capabilityProcedure('loyalty:redeem');

const ID = z.string().trim().min(1).max(191);
const IDEMPOTENCY_KEY = z.string().trim().min(1).max(200);
const ACTIVE_CUSTOMERS_LIMIT = 'loyalty.activeCustomers.max';
const BOOTSTRAPPED_ACTIVE_CUSTOMERS_LIMIT = `restaurant-core.${ACTIVE_CUSTOMERS_LIMIT}`;
const DECIMAL_18_6 = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/, 'Expected a positive Decimal string.');
const LIMIT = z.number().int().min(1).max(200).default(100);

function activeCustomersMax(limits: Record<string, number>): number {
  const value = limits[ACTIVE_CUSTOMERS_LIMIT] ?? limits[BOOTSTRAPPED_ACTIVE_CUSTOMERS_LIMIT];
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'The loyalty active-customer entitlement limit is not configured correctly.',
    });
  }
  return value;
}

function mapLoyaltyError(error: unknown): never {
  if (!(error instanceof LoyaltyError)) throw error;
  const code =
    error.reason === 'NOT_FOUND'
      ? 'NOT_FOUND'
      : error.reason === 'ACCOUNT_BILL_MISMATCH'
        ? 'FORBIDDEN'
        : error.reason === 'ACTIVE_CUSTOMER_LIMIT_REACHED' ||
            error.reason === 'ACCOUNT_INACTIVE' ||
            error.reason === 'BILL_NOT_OPEN' ||
            error.reason === 'INSUFFICIENT_BALANCE' ||
            error.reason === 'REDEMPTION_EXCEEDS_BILL' ||
            error.reason === 'IDEMPOTENCY_CONFLICT'
          ? 'CONFLICT'
          : 'BAD_REQUEST';
  throw new TRPCError({ code, message: error.message });
}

function programView<
  T extends { earnRate: { toString(): string }; redemptionValue: { toString(): string } },
>(program: T) {
  return {
    ...program,
    earnRate: program.earnRate.toString(),
    redemptionValue: program.redemptionValue.toString(),
  };
}

function entryView<
  T extends {
    programVersion: { earnRate: { toString(): string }; redemptionValue: { toString(): string } };
  },
>(entry: T) {
  return { ...entry, programVersion: programView(entry.programVersion) };
}

export const restaurantLoyaltyRouter = router({
  listPrograms: readProcedure
    .input(z.object({ limit: LIMIT.optional() }).strict().optional())
    .query(async ({ ctx, input }) =>
      (await listLoyaltyPrograms(ctx.db, input?.limit)).map(programView)
    ),

  getProgram: readProcedure.input(z.object({ id: ID }).strict()).query(async ({ ctx, input }) => {
    try {
      return programView(await getLoyaltyProgram(ctx.db, input.id));
    } catch (error) {
      mapLoyaltyError(error);
    }
  }),

  listAccounts: readProcedure
    .input(
      z.object({ active: z.boolean().optional(), limit: LIMIT.optional() }).strict().optional()
    )
    .query(async ({ ctx, input }) =>
      listLoyaltyAccounts(ctx.db, { active: input?.active, limit: input?.limit })
    ),

  getAccount: readProcedure.input(z.object({ id: ID }).strict()).query(async ({ ctx, input }) => {
    try {
      return await getLoyaltyAccount(ctx.db, input.id);
    } catch (error) {
      mapLoyaltyError(error);
    }
  }),

  enrollAccount: configureProcedure
    .input(z.object({ customerId: ID }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        const account = await enrollLoyaltyAccount(ctx.db, {
          customerId: input.customerId,
          activeCustomersMax: activeCustomersMax(ctx.entitlements.limits),
        });
        annotateAudit(ctx, {
          targetType: 'LoyaltyAccount',
          targetId: account.id,
          description: 'Enrolled loyalty account',
        });
        return account;
      } catch (error) {
        mapLoyaltyError(error);
      }
    }),

  listLedger: readProcedure
    .input(z.object({ accountId: ID.optional(), limit: LIMIT.optional() }).strict().optional())
    .query(async ({ ctx, input }) => (await listLoyaltyEntries(ctx.db, input)).map(entryView)),

  getLedgerEntry: readProcedure
    .input(z.object({ id: ID }).strict())
    .query(async ({ ctx, input }) => {
      try {
        return entryView(await getLoyaltyEntry(ctx.db, input.id));
      } catch (error) {
        mapLoyaltyError(error);
      }
    }),

  configure: configureProcedure
    .input(
      z
        .object({
          effectiveFrom: z.string().datetime({ offset: true }),
          earnRate: DECIMAL_18_6,
          redemptionValue: DECIMAL_18_6,
          expiryDays: z.number().int().min(1).max(36_500).nullable().optional(),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const program = await configureLoyaltyProgram(ctx.db, {
          ...input,
          effectiveFrom: new Date(input.effectiveFrom),
        });
        annotateAudit(ctx, {
          targetType: 'LoyaltyProgramVersion',
          targetId: program.id,
          description: `Configured loyalty program version ${program.versionNumber}`,
        });
        return programView(program);
      } catch (error) {
        mapLoyaltyError(error);
      }
    }),

  adjust: configureProcedure
    .input(
      z
        .object({
          accountId: ID,
          points: z
            .number()
            .int()
            .min(-2_147_483_648)
            .max(2_147_483_647)
            .refine((points) => points !== 0),
          reason: z.string().trim().min(1).max(2_000),
          idempotencyKey: IDEMPOTENCY_KEY,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const entry = await adjustLoyaltyPoints(ctx.db, {
          ...input,
          actorId: ctx.session.user.id,
        });
        annotateAudit(ctx, {
          targetType: 'LoyaltyAccount',
          targetId: input.accountId,
          description: 'Adjusted loyalty points',
          metadata: { points: input.points },
        });
        return entry;
      } catch (error) {
        mapLoyaltyError(error);
      }
    }),

  redeem: redeemProcedure
    .input(
      z
        .object({
          accountId: ID,
          billId: ID,
          points: z.number().int().positive().max(2_147_483_647),
          idempotencyKey: IDEMPOTENCY_KEY,
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const result = await redeemLoyaltyPoints(ctx.db, {
          ...input,
          actorId: ctx.session.user.id,
        });
        annotateAudit(ctx, {
          targetType: 'RestaurantBill',
          targetId: input.billId,
          description: 'Redeemed loyalty points',
          metadata: { accountId: input.accountId, points: input.points },
        });
        return { ...result, value: result.value.toFixed(2) };
      } catch (error) {
        mapLoyaltyError(error);
      }
    }),
});
