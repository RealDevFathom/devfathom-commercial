import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { can, subjectFromSession } from '@/lib/abac';
import { hasModule } from '@/lib/entitlements';
import { financialStatements } from '@/lib/pharmacy/financial-statements';
import { forecastPharmacyCashFlow } from '@/lib/pharmacy/cash-flow-forecast';
import {
  grossMargin,
  grossMarginComparison,
  leakageReport,
  ledgerCurrencies,
  marginComparisonPeriods,
  perpetualValuation,
  unallocatedInventoryValue,
  TRUE_PROFIT_TIMEZONE,
  trueProfit,
} from '@/lib/pharmacy/finance-reports';
import { loadLedgerLabels } from '@/lib/pharmacy/finance-label-lookup';
import {
  DeliveryRadiusAssumptionError,
  deliveryRadiusProfitability,
  loadDeliveryRadiusOrders,
  MAX_DELIVERY_DISTANCE_METERS,
} from '@/lib/pharmacy/delivery-radius-profitability';
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
import {
  PHARMACY_FINANCE_MANAGE,
  PHARMACY_FINANCE_READ,
} from '@/lib/abac/pharmacy-finance-actions';
import { canManagePharmacyAccounts } from '@/lib/pharmacy/finance-access';
import { pharmacyFinanceGate } from '../pharmacy-finance-gate';
import { assertInOrganization } from '../org-refs';
import { adminProcedure, router, type TRPCContext } from '../trpc';

const id = z.string().trim().min(1).max(128);
const moneyMinor = z.number().int().positive().max(999_999_999);
const at = z.coerce.date();

// Server pages also use a standalone caller, where the root router prefix is
// absent. Enforce bookkeeping licensing here as well as in the module registry.
const bookkeepingProcedure = adminProcedure
  .use(({ ctx, next }) => {
    if (
      !hasModule(ctx.entitlements, 'pharmacy-finance') ||
      !ctx.organization?.id ||
      ctx.entitlements.organizationId !== ctx.organization.id
    ) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Pharmacy Finance access is required.' });
    }
    return next({ ctx });
  })
  .use(pharmacyFinanceGate(PHARMACY_FINANCE_READ));

const bookkeepingMutation = bookkeepingProcedure.use(pharmacyFinanceGate(PHARMACY_FINANCE_MANAGE));

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

type ReportCurrency = {
  currency: string | null;
  currencyStatus:
    | 'posted_entry_currency'
    | 'organization_setting'
    | 'mixed_posted_currencies'
    | 'not_recorded_by_ledger_reader';
};

/**
 * Currency for summed ledger amounts: the currency the contributing entries
 * were posted in. Mixed currencies are never relabelled as one. With no
 * contributing entries, the organization's own setting (e.g. PKR) is used.
 */
function reportCurrency(
  ctx: TRPCContext,
  organizationId: string,
  posted: readonly string[]
): ReportCurrency {
  if (posted.length > 1) return { currency: null, currencyStatus: 'mixed_posted_currencies' };
  if (posted.length === 1) return { currency: posted[0], currencyStatus: 'posted_entry_currency' };
  const setting = ctx.organization?.id === organizationId ? ctx.organization.currency : null;
  return setting && /^[A-Z]{3}$/.test(setting)
    ? { currency: setting, currencyStatus: 'organization_setting' }
    : { currency: null, currencyStatus: 'not_recorded_by_ledger_reader' };
}

const VALUATION_ACCOUNTS = ['INVENTORY', 'INVENTORY_IN_TRANSIT'] as const;
const MARGIN_ACCOUNTS = ['SALES_REVENUE', 'SALES_DISCOUNT', 'COST_OF_GOODS_SOLD'] as const;
const LEAKAGE_ACCOUNTS = ['SALES_DISCOUNT', 'INVENTORY_WRITE_OFF', 'INVENTORY_SHRINKAGE'] as const;

function ledgerMetadata(
  reportScope: { organizationId: string; branchId: string },
  definition: string,
  currency: ReportCurrency = { currency: null, currencyStatus: 'not_recorded_by_ledger_reader' }
) {
  return {
    scope: reportScope,
    timezone: 'UTC' as const,
    moneyUnit: 'integer_minor' as const,
    ...currency,
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
    .use(pharmacyFinanceGate(PHARMACY_FINANCE_READ))
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
      const [rows, unallocatedValueMinor, currencies] = await Promise.all([
        perpetualValuation(ctx.db, ctx.reportScope, at),
        unallocatedInventoryValue(ctx.db, ctx.reportScope, at),
        ledgerCurrencies(ctx.db, ctx.reportScope, {
          accountCodes: VALUATION_ACCOUNTS,
          to: at,
          inclusive: true,
        }),
      ]);
      const labels = await loadLedgerLabels(ctx.db, ctx.reportScope.organizationId, {
        branches: rows.map((row) => row.branchId),
        lots: rows.map((row) => row.lotId),
        batches: rows.map((row) => row.manufacturingBatchId),
        medicines: rows.map((row) => row.medicineId),
        locations: rows.map((row) => row.locationId),
      });
      return {
        ...ledgerMetadata(
          ctx.reportScope,
          'Net posted inventory and inventory-in-transit value by lot/location through the inclusive instant; zero-net lots omitted. Stock posted without a lot (such as opening stock entered as one branch total) is reported separately. Missing unit cost remains unknown.',
          reportCurrency(ctx, ctx.reportScope.organizationId, currencies)
        ),
        period: { at, bounds: 'through_inclusive' as const },
        rows,
        unallocatedValueMinor,
        labels,
      };
    }),

  grossMargin: ledgerReportProcedure
    .input(
      reportPeriod.safeExtend({
        by: z.enum(['line', 'batch', 'product', 'branch', 'productClass']),
      })
    )
    .query(async ({ ctx, input }) => {
      const period = { from: new Date(input.from), to: new Date(input.to) };
      const [rows, currencies] = await Promise.all([
        grossMargin(ctx.db, ctx.reportScope, { ...period, by: input.by }),
        ledgerCurrencies(ctx.db, ctx.reportScope, { accountCodes: MARGIN_ACCOUNTS, ...period }),
      ]);
      const keys = rows.map((row) => row.key);
      const labels = await loadLedgerLabels(ctx.db, ctx.reportScope.organizationId, {
        branches: input.by === 'branch' ? keys : [],
        batches: input.by === 'batch' ? keys : [],
        medicines: input.by === 'product' ? keys : [],
      });
      return {
        ...ledgerMetadata(
          ctx.reportScope,
          'Posted gross revenue minus discounts minus posted lot COGS; reversals net against postings. Gross margin is neither net profit nor cash flow; unposted costs are unknown.',
          reportCurrency(ctx, ctx.reportScope.organizationId, currencies)
        ),
        period: { ...period, bounds: '[from,to)' as const },
        by: input.by,
        rows,
        labels,
      };
    }),

  trueProfit: ledgerReportProcedure
    .input(reportPeriod.safeExtend({ by: z.enum(['item', 'category', 'hour', 'staff']) }))
    .query(async ({ ctx, input }) => {
      const period = { from: new Date(input.from), to: new Date(input.to) };
      const [rows, currencies] = await Promise.all([
        trueProfit(ctx.db, ctx.reportScope, { ...period, by: input.by }),
        ledgerCurrencies(ctx.db, ctx.reportScope, { accountCodes: MARGIN_ACCOUNTS, ...period }),
      ]);
      const keys = rows.flatMap((row) => (row.key === null ? [] : [row.key]));
      const { organizationId } = ctx.reportScope;
      const names = new Map<string, string | null>(
        input.by === 'item'
          ? (
              await ctx.db.medicine.findMany({
                where: { organizationId, id: { in: keys } },
                select: { id: true, productName: true },
              })
            ).map((row) => [row.id, row.productName])
          : input.by === 'staff'
            ? (
                await ctx.db.user.findMany({
                  where: { organizationId, id: { in: keys } },
                  select: { id: true, name: true },
                })
              ).map((row) => [row.id, row.name])
            : []
      );
      return {
        ...ledgerMetadata(
          ctx.reportScope,
          `Posted gross revenue minus discounts minus posted COGS at each lot's landed cost (invoice net, non-creditable tax and freight share over received plus bonus units). Hour is the sale completion hour in ${TRUE_PROFIT_TIMEZONE}; staff is the user who completed the sale (falling back to its creator); returns stay with the original sale. Totals reconcile with ledger gross margin; this is not net profit or cash flow.`,
          reportCurrency(ctx, ctx.reportScope.organizationId, currencies)
        ),
        period: { ...period, bounds: '[from,to)' as const },
        hourTimezone: TRUE_PROFIT_TIMEZONE,
        by: input.by,
        rows: rows.map((row) => ({
          ...row,
          label: row.key === null ? null : (names.get(row.key) ?? null),
        })),
      };
    }),

  leakageReport: ledgerReportProcedure.input(reportPeriod).query(async ({ ctx, input }) => {
    const period = { from: new Date(input.from), to: new Date(input.to) };
    const [rows, currencies] = await Promise.all([
      leakageReport(ctx.db, ctx.reportScope, period),
      ledgerCurrencies(ctx.db, ctx.reportScope, { accountCodes: LEAKAGE_ACCOUNTS, ...period }),
    ]);
    const labels = await loadLedgerLabels(ctx.db, ctx.reportScope.organizationId, {
      branches: rows.map((row) => row.branchId),
      medicines: rows.map((row) => row.medicineId),
    });
    return {
      ...ledgerMetadata(
        ctx.reportScope,
        'Posted discounts plus write-offs plus signed shrinkage by branch/product; stock found offsets stock lost. This is recorded ledger leakage, not expiry exposure or inferred causation.',
        reportCurrency(ctx, ctx.reportScope.organizationId, currencies)
      ),
      period: { ...period, bounds: '[from,to)' as const },
      rows,
      labels,
    };
  }),

  /**
   * DEV-63: delivered-order profitability by radius band. The delivery cost
   * is an estimate from the owner's own assumptions, supplied with the query.
   */
  deliveryRadiusProfitability: ledgerReportProcedure
    .input(
      reportPeriod.safeExtend({
        bandEdgesMeters: z
          .array(z.number().int().positive().max(MAX_DELIVERY_DISTANCE_METERS))
          .min(1)
          .max(12),
        costPerKmMinor: z.number().int().min(0).max(999_999_999),
        fixedCostPerOrderMinor: z.number().int().min(0).max(999_999_999),
      })
    )
    .query(async ({ ctx, input }) => {
      const period = { from: new Date(input.from), to: new Date(input.to) };
      const orders = await loadDeliveryRadiusOrders(ctx.db, ctx.reportScope, period);
      try {
        return {
          scope: ctx.reportScope,
          period: { ...period, bounds: '[from,to)' as const },
          moneyUnit: 'integer_minor' as const,
          ...deliveryRadiusProfitability(orders, {
            bandEdgesMeters: input.bandEdgesMeters,
            costPerKmMinor: input.costPerKmMinor,
            fixedCostPerOrderMinor: input.fixedCostPerOrderMinor,
          }),
        };
      } catch (error) {
        if (error instanceof DeliveryRadiusAssumptionError)
          throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
        throw error;
      }
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
        mayManageAccounts: await canManagePharmacyAccounts(ctx),
        branch,
        transactions,
        periods,
        bankLines,
        taxProfiles,
        settlementCandidates,
        settlementBatches,
      };
    }),

  post: bookkeepingMutation
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

  reverse: bookkeepingMutation
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

  closePeriod: bookkeepingMutation
    .input(z.object({ branchId: id, startsAt: at, endsAt: at }))
    .mutation(async ({ ctx, input }) => {
      try {
        const scoped = await scope(ctx, input.branchId);
        return await ctx.db.$transaction((tx) => closeAccountingPeriod(txDb(tx), scoped, input));
      } catch (error) {
        fail(error);
      }
    }),

  reopenPeriod: bookkeepingMutation
    .input(z.object({ branchId: id, periodId: id, reason: z.string().trim().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const scoped = await scope(ctx, input.branchId);
        return await ctx.db.$transaction((tx) => reopenAccountingPeriod(txDb(tx), scoped, input));
      } catch (error) {
        fail(error);
      }
    }),

  importBankLine: bookkeepingMutation
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

  reconcile: bookkeepingMutation
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

  createSettlementBatch: bookkeepingMutation
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

  publishTaxProfile: bookkeepingMutation
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
