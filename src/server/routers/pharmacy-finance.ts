import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  closeAccountingPeriod,
  createSettlementBatch,
  PharmacyBookkeepingError,
  postBookkeepingTransaction,
  reconcileBankLine,
  reopenAccountingPeriod,
  reverseBookkeepingTransaction,
} from '@/lib/pharmacy/bookkeeping';
import { PharmacyTaxProfileError, publishPharmacyTaxProfile } from '@/lib/pharmacy/tax-profiles';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { adminProcedure, router, type TRPCContext } from '../trpc';

const id = z.string().trim().min(1).max(128);
const moneyMinor = z.number().int().positive().max(999_999_999);
const at = z.coerce.date();

function txDb(tx: unknown) {
  return tx as ScopedDb;
}

function scope(ctx: TRPCContext, branchId: string) {
  const organizationId = ctx.entitlements.organizationId;
  const actorId = ctx.session?.user?.id;
  if (!actorId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return { organizationId, branchId, actorId };
}

function fail(error: unknown): never {
  if (error instanceof PharmacyBookkeepingError || error instanceof PharmacyTaxProfileError) {
    throw new TRPCError({
      code: error.reason === 'NOT_FOUND' ? 'NOT_FOUND' : 'BAD_REQUEST',
      message: error.reason,
    });
  }
  throw error;
}

const allocation = z.object({
  sourceKind: z.enum(['PURCHASE_INVOICE', 'SUPPLIER_CREDIT', 'CUSTOMER_KHATA', 'EXPENSE']),
  sourceId: id,
  sourceReference: z.string().trim().min(1).max(160),
  amountMinor: moneyMinor,
});

export const pharmacyFinanceRouter = router({
  workspace: adminProcedure.input(z.object({ branchId: id })).query(async ({ ctx, input }) => {
    const organizationId = ctx.entitlements.organizationId;
    const branch = await ctx.db.pharmacyBranch.findFirst({
      where: { organizationId, id: input.branchId, active: true },
      select: { id: true, name: true },
    });
    if (!branch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch not found.' });
    const [transactions, periods, bankLines, taxProfiles, settlementCandidates, settlementBatches] =
      await Promise.all([
        ctx.db.pharmacyBookkeepingTransaction.findMany({
          where: { organizationId, branchId: branch.id },
          include: { allocations: true },
          orderBy: { occurredAt: 'desc' },
          take: 50,
        }),
        ctx.db.pharmacyAccountingPeriod.findMany({
          where: { organizationId, branchId: branch.id },
          orderBy: { startsAt: 'desc' },
          take: 12,
        }),
        ctx.db.pharmacyBankStatementLine.findMany({
          where: { organizationId, branchId: branch.id },
          include: { matches: true },
          orderBy: { bookedAt: 'desc' },
          take: 50,
        }),
        ctx.db.pharmacyTaxProfileVersion.findMany({
          where: { organizationId, branchId: branch.id },
          include: { rules: true },
          orderBy: { versionNumber: 'desc' },
        }),
        ctx.db.pharmacyTender.findMany({
          where: {
            organizationId,
            branchId: branch.id,
            type: { in: ['CARD', 'WALLET', 'BANK_TRANSFER'] },
            settlementMembers: { none: {} },
          },
          include: { sale: { select: { receiptNumber: true } } },
          orderBy: { createdAt: 'asc' },
          take: 100,
        }),
        ctx.db.pharmacySettlementBatch.findMany({
          where: { organizationId, branchId: branch.id },
          include: { tenders: true },
          orderBy: { businessDate: 'desc' },
          take: 25,
        }),
      ]);
    return {
      branch,
      transactions,
      periods,
      bankLines,
      taxProfiles,
      settlementCandidates,
      settlementBatches,
    };
  }),

  post: adminProcedure
    .input(
      z.object({
        branchId: id,
        reference: z.string().trim().min(1).max(80),
        kind: z.enum([
          'SUPPLIER_PAYMENT',
          'CUSTOMER_RECEIPT',
          'EXPENSE',
          'PETTY_CASH',
          'BANK_DEPOSIT',
          'SETTLEMENT',
          'VOUCHER',
          'CHEQUE',
        ]),
        amountMinor: moneyMinor,
        occurredAt: at,
        idempotencyKey: id,
        counterpartyName: z.string().trim().max(160).optional(),
        memo: z.string().trim().max(500).optional(),
        bankReference: z.string().trim().max(160).optional(),
        chequeNumber: z.string().trim().max(80).optional(),
        chequeDueAt: at.optional(),
        fundingAccount: z.enum(['CASH', 'BANK']).optional(),
        allocations: z.array(allocation).max(100).default([]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          postBookkeepingTransaction(txDb(tx), scope(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),

  reverse: adminProcedure
    .input(
      z.object({
        branchId: id,
        transactionId: id,
        reason: z.string().trim().min(1).max(500),
        at,
        idempotencyKey: id,
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          reverseBookkeepingTransaction(txDb(tx), scope(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),

  closePeriod: adminProcedure
    .input(z.object({ branchId: id, startsAt: at, endsAt: at }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          closeAccountingPeriod(txDb(tx), scope(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),

  reopenPeriod: adminProcedure
    .input(z.object({ branchId: id, periodId: id, reason: z.string().trim().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          reopenAccountingPeriod(txDb(tx), scope(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),

  importBankLine: adminProcedure
    .input(
      z.object({
        branchId: id,
        statementRef: id,
        lineReference: id,
        bookedAt: at,
        amountMinor: z
          .number()
          .int()
          .refine((v) => v !== 0),
        description: z.string().trim().min(1).max(300),
      })
    )
    .mutation(({ ctx, input }) =>
      ctx.db.pharmacyBankStatementLine.create({
        data: { organizationId: ctx.entitlements.organizationId, ...input },
      })
    ),

  reconcile: adminProcedure
    .input(
      z.object({ branchId: id, statementLineId: id, transactionId: id, amountMinor: moneyMinor })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          reconcileBankLine(txDb(tx), scope(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),

  createSettlementBatch: adminProcedure
    .input(
      z.object({
        branchId: id,
        reference: z.string().trim().min(1).max(80),
        provider: z.string().trim().min(1).max(120),
        tenderType: z.enum(['CARD', 'WALLET', 'BANK_TRANSFER']),
        businessDate: at,
        tenderIds: z.array(id).min(1).max(100),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          createSettlementBatch(txDb(tx), scope(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),

  publishTaxProfile: adminProcedure
    .input(
      z.object({
        branchId: id,
        name: z.string().trim().min(1).max(160),
        effectiveFrom: at,
        effectiveTo: at.optional(),
        approvalReference: z.string().trim().min(1).max(160),
        idempotencyKey: id,
        rules: z
          .array(
            z.object({
              productClass: z.enum(['MEDICINE', 'FRONT_SHOP']),
              pctHsCode: z.string().trim().min(1).max(32),
              sroReference: z.string().trim().max(160).optional(),
              exemptionCode: z.string().trim().max(80).optional(),
              priceMode: z.enum(['EXCLUSIVE', 'INCLUSIVE']),
              rate: z
                .string()
                .regex(
                  /^0(?:\.\d{1,6})?$|^1(?:\.0{1,6})?$/,
                  'Rate must be between 0 and 1 with up to 6 decimals.'
                ),
              roundingScale: z.number().int().min(0).max(4).default(2),
            })
          )
          .min(1)
          .max(100),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.db.$transaction((tx) =>
          publishPharmacyTaxProfile(txDb(tx), scope(ctx, input.branchId), input)
        );
      } catch (error) {
        fail(error);
      }
    }),
});
