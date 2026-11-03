import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import { financialStatements } from '@/lib/pharmacy/financial-statements';
import { forecastPharmacyCashFlow } from '@/lib/pharmacy/cash-flow-forecast';
import {
  grossMargin,
  grossMarginComparison,
  landedProfit,
  leakageReport,
  marginComparisonPeriods,
  perpetualValuation,
} from '@/lib/pharmacy/finance-reports';
import {
  closeAccountingPeriod,
  createSettlementBatch,
  PharmacyBookkeepingError,
  postBookkeepingTransaction,
  reconcileBankLine,
  reconcileSettlementBankLine,
  reopenAccountingPeriod,
  reverseBookkeepingTransaction,
} from '@/lib/pharmacy/bookkeeping';
import { PharmacyTaxProfileError, publishPharmacyTaxProfile } from '@/lib/pharmacy/tax-profiles';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { assertInOrganization } from '../org-refs';
import { adminProcedure, router, type TRPCContext } from '../trpc';

const id = z.string().trim().min(1).max(128);
const moneyMinor = z.number().int().positive().max(999_999_999);
const at = z.coerce.date();

// Server pages also use a standalone caller, where the root router prefix is
// absent. Enforce bookkeeping licensing here as well as in the module registry.
const bookkeepingProcedure = adminProcedure.use(({ ctx, next }) => {
  if (
    !hasModule(ctx.entitlements, 'pharmacy-finance') ||
    !ctx.organization?.id ||
    ctx.entitlements.organizationId !== ctx.organization.id
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Pharmacy Finance access is required.' });
  }
  return next({ ctx });
});

const reportInstant = z.iso.datetime({ offset: true });
const reportPeriod = z
  .object({ branchId: id, from: reportInstant, to: reportInstant })
  .strict()
  .refine(
    ({ from, to }) => {
      const duration = new Date(to).getTime() - new Date(from).getTime();
      return duration > 0 && duration <= 92 * 86_400_000;
    },
    { message: 'Choose a valid period of at most 92 days.' }
  );

const cashEstimate = z.object({
  id,
  date: z.iso.date(),
  amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
const forecastPayable = z.object({
  id,
  dueDate: z.iso.date(),
  amountMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  earlyPayDate: z.iso.date().optional(),
  earlyPayDiscountBps: z.number().int().min(0).max(10_000).optional(),
});
const cashFlowForecastInput = z.object({
  branchId: id,
  asOfDate: z.iso.date(),
  openingCashMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  minimumCashReserveMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  annualCashValueBps: z.number().int().min(0).max(100_000),
  salesCashEstimates: z.array(cashEstimate).max(366),
  khataCollectionEstimates: z.array(cashEstimate).max(10_000),
  payables: z.array(forecastPayable).max(10_000),
});

const ledgerReportProcedure = adminProcedure
  .input(z.object({ branchId: id }))
  .use(async ({ ctx, input, next }) => {
    if (ctx.session.user.role !== 'ADMIN' || !hasModule(ctx.entitlements, 'pharmacy-reports')) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Owner financial reports access is required.',
      });
    }
    for (const action of ['reports:operational', 'reports:financial'] as const) {
      if (
        !(await can(subjectFromSession(ctx.session.user), action, undefined, {
          db: ctx.db,
          source: 'TRPC',
          ip: ctx.requestMeta.ip,
        }))
      ) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Financial report permission is required.',
        });
      }
    }
    const organizationId = ctx.entitlements.organizationId;
    if (!organizationId || organizationId !== ctx.organization?.id) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Organization is outside your report scope.',
      });
    }
    const branch = await ctx.db.pharmacyBranch.findFirst({
      where: { organizationId, id: input.branchId, active: true },
      select: { id: true },
    });
    if (!branch)
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your report scope.' });
    return next({ ctx: { ...ctx, reportScope: { organizationId, branchId: branch.id } } });
  });

function ledgerMetadata(
  reportScope: { organizationId: string; branchId: string },
  definition: string
) {
  return {
    scope: reportScope,
    timezone: 'UTC' as const,
    moneyUnit: 'integer_minor' as const,
    currency: null,
    currencyStatus: 'not_recorded_by_ledger_reader' as const,
    definition,
    source: 'finance_journal_lines' as const,
    coverage: {
      basis: 'posted_entries_only' as const,
      completeness: 'unknown' as const,
      costCoverage: 'unknown' as const,
      refunds: 'included_only_when_posted_as_reversals' as const,
      emptyRows: 'no_matching_postings_not_proof_of_zero_activity' as const,
    },
    freshness: { retrievedAt: new Date(), latestPostingAt: null },
  };
}

function txDb(tx: unknown) {
  return tx as ScopedDb;
}

async function scope(ctx: TRPCContext, branchId: string) {
  const organizationId = ctx.entitlements.organizationId;
  const actorId = ctx.session?.user?.id;
  if (!actorId) throw new TRPCError({ code: 'UNAUTHORIZED' });
  await assertInOrganization(ctx.db.pharmacyBranch, organizationId, [branchId], { active: true });
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
  cashFlowForecast: ledgerReportProcedure.input(cashFlowForecastInput).query(({ input }) => {
    try {
      return forecastPharmacyCashFlow(input);
    } catch (error) {
      if (error instanceof RangeError) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
      }
      throw error;
    }
  }),
  financialStatements: ledgerReportProcedure
    .input(reportPeriod.safeExtend({ page: z.number().int().min(1).max(10000).default(1) }))
    .query(async ({ ctx, input }) => ({
      ...ledgerMetadata(
        ctx.reportScope,
        'Branch journal lines posted before the exclusive cutoff. Opening balances precede from; movements use [from,to). Net P&L is projected only from canonical revenue, contra-revenue, and expense journal movements in that window. Receivables are debit balances; payables are credit balances. CASH and BANK are netted per entry, excluding internal transfers from cash inflow/outflow. Unposted activity and due-date aging remain unknown.'
      ),
      ...(await financialStatements(ctx.db, ctx.reportScope, {
        from: new Date(input.from),
        to: new Date(input.to),
        page: input.page,
      })),
    })),
  perpetualValuation: ledgerReportProcedure
    .input(
      z
        .object({ branchId: id, at: reportInstant })
        .strict()
        .refine(({ at }) => new Date(at).getTime() <= Date.now(), {
          message: 'Choose a valuation instant no later than now.',
        })
    )
    .query(async ({ ctx, input }) => {
      const at = new Date(input.at);
      const rows = await perpetualValuation(ctx.db, ctx.reportScope, at);
      return {
        ...ledgerMetadata(
          ctx.reportScope,
          'Net posted inventory and inventory-in-transit value by lot/location through the inclusive instant; zero-net lots omitted. Missing unit cost remains unknown.'
        ),
        period: { at, bounds: 'through_inclusive' as const },
        rows,
      };
    }),

  grossMargin: ledgerReportProcedure
    .input(reportPeriod.safeExtend({ by: z.enum(['line', 'batch', 'product', 'branch']) }))
    .query(async ({ ctx, input }) => {
      const period = { from: new Date(input.from), to: new Date(input.to) };
      const rows = await grossMargin(ctx.db, ctx.reportScope, { ...period, by: input.by });
      return {
        ...ledgerMetadata(
          ctx.reportScope,
          'Posted gross revenue minus discounts minus posted lot COGS; reversals net against postings. Gross margin is neither net profit nor cash flow; unposted costs are unknown.'
        ),
        period: { ...period, bounds: '[from,to)' as const },
        by: input.by,
        rows,
      };
    }),

  landedProfit: ledgerReportProcedure.input(reportPeriod).query(async ({ ctx, input }) => {
    const period = { from: new Date(input.from), to: new Date(input.to) };
    const rows = await landedProfit(ctx.db, ctx.reportScope, period);
    return {
      ...ledgerMetadata(
        ctx.reportScope,
        'Posted revenue less discounts and exact landed lot COGS, grouped by item, product family, PKT hour and sale staff. Landed cost already includes receipt-level bonus quantity, allocated freight and non-recoverable tax. This is landed gross profit, not net profit or cash flow; unposted costs are unknown.'
      ),
      period: { ...period, bounds: '[from,to)' as const },
      timeZone: 'Asia/Karachi' as const,
      dimensions: ['item', 'category', 'hour', 'staff'] as const,
      rows,
    };
  }),

  leakageReport: ledgerReportProcedure.input(reportPeriod).query(async ({ ctx, input }) => {
    const period = { from: new Date(input.from), to: new Date(input.to) };
    const rows = await leakageReport(ctx.db, ctx.reportScope, period);
    return {
      ...ledgerMetadata(
        ctx.reportScope,
        'Posted discounts plus write-offs plus signed shrinkage by branch/product; stock found offsets stock lost. This is recorded ledger leakage, not expiry exposure or inferred causation.'
      ),
      period: { ...period, bounds: '[from,to)' as const },
      rows,
    };
  }),

  marginComparison: adminProcedure
    .input(
      z
        .object({
          branchId: id,
          from: z.iso.datetime({ offset: true }),
          to: z.iso.datetime({ offset: true }),
        })
        .strict()
    )
    .query(async ({ ctx, input }) => {
      if (ctx.session!.user.role !== 'ADMIN' || !hasModule(ctx.entitlements, 'pharmacy-reports')) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Owner financial reports access is required.',
        });
      }
      for (const action of ['reports:operational', 'reports:financial'] as const) {
        if (
          !(await can(subjectFromSession(ctx.session!.user), action, undefined, {
            db: ctx.db,
            source: 'TRPC',
            ip: ctx.requestMeta.ip,
          }))
        ) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Financial report permission is required.',
          });
        }
      }
      const organizationId = ctx.entitlements.organizationId;
      const branch = await ctx.db.pharmacyBranch.findFirst({
        where: { organizationId, id: input.branchId, active: true },
        select: { id: true },
      });
      if (!branch)
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Branch is outside your report scope.' });
      const period = { from: new Date(input.from), to: new Date(input.to) };
      try {
        marginComparisonPeriods(period.from, period.to);
        return await grossMarginComparison(ctx.db, { organizationId, branchId: branch.id }, period);
      } catch (error) {
        if (error instanceof RangeError)
          throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
        throw error;
      }
    }),

  workspace: bookkeepingProcedure
    .input(z.object({ branchId: id }))
    .query(async ({ ctx, input }) => {
      const organizationId = ctx.entitlements.organizationId;
      const branch = await ctx.db.pharmacyBranch.findFirst({
        where: { organizationId, id: input.branchId, active: true },
        select: { id: true, name: true },
      });
      if (!branch) throw new TRPCError({ code: 'NOT_FOUND', message: 'Branch not found.' });
      const [
        transactions,
        periods,
        bankLines,
        taxProfiles,
        settlementCandidates,
        settlementBatches,
      ] = await Promise.all([
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
            type: { in: ['CARD', 'WALLET', 'BANK_TRANSFER', 'RAAST', 'JAZZCASH', 'EASYPAISA'] },
            settlementMembers: { none: {} },
          },
          include: { sale: { select: { receiptNumber: true } } },
          orderBy: { createdAt: 'asc' },
          take: 100,
        }),
        ctx.db.pharmacySettlementBatch.findMany({
          where: { organizationId, branchId: branch.id },
          include: { tenders: true, bankMatches: { where: { reversedAt: null } } },
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

  post: bookkeepingProcedure
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
        const scoped = await scope(ctx, input.branchId);
        return await ctx.db.$transaction((tx) =>
          postBookkeepingTransaction(txDb(tx), scoped, input)
        );
      } catch (error) {
        fail(error);
      }
    }),

  reverse: bookkeepingProcedure
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
        const scoped = await scope(ctx, input.branchId);
        return await ctx.db.$transaction((tx) =>
          reverseBookkeepingTransaction(txDb(tx), scoped, input)
        );
      } catch (error) {
        fail(error);
      }
    }),

  closePeriod: bookkeepingProcedure
    .input(z.object({ branchId: id, startsAt: at, endsAt: at }))
    .mutation(async ({ ctx, input }) => {
      try {
        const scoped = await scope(ctx, input.branchId);
        return await ctx.db.$transaction((tx) => closeAccountingPeriod(txDb(tx), scoped, input));
      } catch (error) {
        fail(error);
      }
    }),

  reopenPeriod: bookkeepingProcedure
    .input(z.object({ branchId: id, periodId: id, reason: z.string().trim().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const scoped = await scope(ctx, input.branchId);
        return await ctx.db.$transaction((tx) => reopenAccountingPeriod(txDb(tx), scoped, input));
      } catch (error) {
        fail(error);
      }
    }),

  importBankLine: bookkeepingProcedure
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
    .mutation(async ({ ctx, input }) => {
      await scope(ctx, input.branchId);
      return ctx.db.pharmacyBankStatementLine.create({
        data: { organizationId: ctx.entitlements.organizationId, ...input },
      });
    }),

  reconcile: bookkeepingProcedure
    .input(
      z
        .object({
          branchId: id,
          statementLineId: id,
          transactionId: id.optional(),
          settlementBatchId: id.optional(),
          amountMinor: moneyMinor,
        })
        .strict()
        .refine(
          (value) => Boolean(value.transactionId) !== Boolean(value.settlementBatchId),
          'Choose exactly one posted transaction or POS settlement batch.'
        )
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const scoped = await scope(ctx, input.branchId);
        return await ctx.db.$transaction((tx) =>
          input.settlementBatchId
            ? reconcileSettlementBankLine(txDb(tx), scoped, {
                ...input,
                settlementBatchId: input.settlementBatchId,
              })
            : reconcileBankLine(txDb(tx), scoped, { ...input, transactionId: input.transactionId! })
        );
      } catch (error) {
        fail(error);
      }
    }),

  createSettlementBatch: bookkeepingProcedure
    .input(
      z.object({
        branchId: id,
        reference: z.string().trim().min(1).max(80),
        provider: z.string().trim().min(1).max(120),
        tenderType: z.enum(['CARD', 'WALLET', 'BANK_TRANSFER', 'RAAST', 'JAZZCASH', 'EASYPAISA']),
        businessDate: at,
        tenderIds: z.array(id).min(1).max(100),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const scoped = await scope(ctx, input.branchId);
        return await ctx.db.$transaction((tx) => createSettlementBatch(txDb(tx), scoped, input));
      } catch (error) {
        fail(error);
      }
    }),

  publishTaxProfile: bookkeepingProcedure
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
        const scoped = await scope(ctx, input.branchId);
        return await ctx.db.$transaction((tx) =>
          publishPharmacyTaxProfile(txDb(tx), scoped, input)
        );
      } catch (error) {
        fail(error);
      }
    }),
});
