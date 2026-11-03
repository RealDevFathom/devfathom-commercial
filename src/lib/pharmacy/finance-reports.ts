/**
 * PH-FIN / PRD §6.8 FIN-03 — perpetual valuation, gross margin and leakage.
 *
 * Every read here is one query over `finance_journal_lines`. That is the point:
 * valuation, margin and leakage are three groupings of the SAME postings the
 * FIN-01 adapters wrote, so a number in a margin report and a number in the
 * valuation cannot disagree — there is no second store to drift from, and no
 * report-time re-derivation of cost that could pick a different lot than the
 * allocator did.
 *
 * SIGNS. Amounts are stored as positive magnitudes with a `side`, so each read
 * folds them with `SUM(debit) - SUM(credit)` in the account's own normal
 * direction: inventory and cost read positive when they increase, revenue reads
 * positive when it is earned. A reversal is an ordinary entry with the sides
 * swapped, so it nets out of every one of these queries with no special case.
 *
 * All queries are organization-scoped in SQL as well as by row level security,
 * and branch-scoped when a branch is given.
 */
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export type ReportScope = {
  organizationId: string;
  /** Omit to report across every branch in the organization. */
  branchId?: string;
};

type JournalReportScope = Omit<ReportScope, 'organizationId'> & {
  organizationId: string | Prisma.Sql;
  branchIds?: string[];
};

function branchFilter(scope: JournalReportScope) {
  if (scope.branchIds) return Prisma.sql`AND line."branchId" IN (${Prisma.join(scope.branchIds)})`;
  return scope.branchId
    ? Prisma.sql`AND line."branchId" = ${scope.branchId}`
    : Prisma.sql`AND TRUE`;
}

export type ValuationRow = {
  branchId: string | null;
  lotId: string;
  locationId: string | null;
  medicineId: string | null;
  manufacturingBatchId: string | null;
  unitCostMinor: number | null;
  valueMinor: number;
};

/**
 * FIN-03: perpetual valuation per lot and location, as at an instant.
 *
 * "Perpetual" is literal — the value is the running fold of every inventory
 * posting up to `at`, not a period-end snapshot, so it is answerable at any
 * instant including one in the past. Stock in transit is included and reported
 * against the branch that will receive it, which is where its value sits.
 *
 * Lots whose postings net to zero are dropped: sold-out stock is not inventory.
 */
export async function perpetualValuation(
  db: ScopedDb,
  scope: ReportScope,
  at: Date
): Promise<ValuationRow[]> {
  return db.$queryRaw<ValuationRow[]>(Prisma.sql`
    SELECT line."branchId",
           line."lotId",
           line."locationId",
           batch."medicineId",
           lot."manufacturingBatchId",
           lot."unitCostMinor",
           SUM(CASE WHEN line."side" = 'DEBIT' THEN line."amountMinor" ELSE -line."amountMinor" END)::int AS "valueMinor"
      FROM "finance_journal_lines" line
      JOIN "finance_journal_entries" entry
        ON entry."organizationId" = line."organizationId" AND entry."id" = line."entryId"
      LEFT JOIN "pharmacy_inventory_lots" lot
        ON lot."organizationId" = line."organizationId" AND lot."id" = line."lotId"
      LEFT JOIN "pharmacy_manufacturing_batches" batch
        ON batch."organizationId" = lot."organizationId" AND batch."id" = lot."manufacturingBatchId"
     WHERE line."organizationId" = ${scope.organizationId}
       AND line."accountCode" IN ('INVENTORY', 'INVENTORY_IN_TRANSIT')
       AND line."lotId" IS NOT NULL
       AND entry."occurredAt" <= ${at}
       ${branchFilter(scope)}
     GROUP BY line."branchId", line."lotId", line."locationId",
              batch."medicineId", lot."manufacturingBatchId", lot."unitCostMinor"
    HAVING SUM(CASE WHEN line."side" = 'DEBIT' THEN line."amountMinor" ELSE -line."amountMinor" END) <> 0
     ORDER BY line."branchId", line."lotId", line."locationId"`);
}

export type MarginDimension = 'line' | 'batch' | 'product' | 'branch';

export type MarginRow = {
  key: string | null;
  revenueMinor: number;
  discountMinor: number;
  cogsMinor: number;
  grossMarginMinor: number;
};

export type LandedProfitDimension = 'item' | 'category' | 'hour' | 'staff';

export type LandedProfitRow = MarginRow & {
  dimension: LandedProfitDimension;
};

/**
 * DEV-77: landed-profit report over the canonical finance postings.
 *
 * This deliberately extends, rather than recalculates, FIN-03. Receipt posting
 * has already spread discount, rebate, non-recoverable tax, freight and bonus
 * quantity into the lot cost; the sale adapter then posts that exact lot cost
 * to COGS. Reading the postings here therefore also handles mixed lots and
 * return reversals without introducing a second costing implementation.
 */
export async function landedProfit(
  db: ScopedDb,
  scope: ReportScope,
  input: { from: Date; to: Date }
): Promise<LandedProfitRow[]> {
  const rows = await db.$queryRaw<
    Array<
      Omit<LandedProfitRow, 'revenueMinor' | 'discountMinor' | 'cogsMinor' | 'grossMarginMinor'> & {
        revenueMinor: bigint | number;
        discountMinor: bigint | number;
        cogsMinor: bigint | number;
        grossMarginMinor: bigint | number;
      }
    >
  >(landedProfitQuery(scope, input));
  return rows.map((row) => {
    const amounts = {
      revenueMinor: Number(row.revenueMinor),
      discountMinor: Number(row.discountMinor),
      cogsMinor: Number(row.cogsMinor),
      grossMarginMinor: Number(row.grossMarginMinor),
    };
    if (!Object.values(amounts).every(Number.isSafeInteger))
      throw new Error('Profit totals exceed the supported numeric range.');
    return { ...row, ...amounts };
  });
}

export function landedProfitQuery(scope: JournalReportScope, input: { from: Date; to: Date }) {
  return Prisma.sql`
    WITH posted AS (
      SELECT line."accountCode",
             CASE WHEN line."side" = 'DEBIT' THEN line."amountMinor" ELSE -line."amountMinor" END AS "debitMinor",
             line."productId" AS "itemKey",
             medicine."productFamily"::text AS "categoryKey",
             to_char(date_trunc('hour', entry."occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Karachi'), 'YYYY-MM-DD"T"HH24:00:00') || '+05:00' AS "hourKey",
             sale."createdByUserId" AS "staffKey"
        FROM "finance_journal_lines" line
        JOIN "finance_journal_entries" entry
          ON entry."organizationId" = line."organizationId" AND entry."id" = line."entryId"
        LEFT JOIN "pharmacy_sale_lines" sale_line
          ON sale_line."organizationId" = line."organizationId" AND sale_line."branchId" = line."branchId" AND sale_line."id" = line."sourceLineId"
        LEFT JOIN "pharmacy_sales" sale
          ON sale."organizationId" = sale_line."organizationId" AND sale."branchId" = sale_line."branchId" AND sale."id" = sale_line."saleId"
        LEFT JOIN "pharmacy_medicines" medicine
          ON medicine."organizationId" = line."organizationId" AND medicine."id" = line."productId"
       WHERE line."organizationId" = ${scope.organizationId}
         AND line."accountCode" IN ('SALES_REVENUE', 'SALES_DISCOUNT', 'COST_OF_GOODS_SOLD')
         AND entry."occurredAt" >= ${input.from}
         AND entry."occurredAt" < ${input.to}
         ${branchFilter(scope)}
    ), dimensions AS (
      SELECT 'item'::text AS "dimension", "itemKey" AS "key", "accountCode", "debitMinor" FROM posted
      UNION ALL
      SELECT 'category', "categoryKey", "accountCode", "debitMinor" FROM posted
      UNION ALL
      SELECT 'hour', "hourKey", "accountCode", "debitMinor" FROM posted
      UNION ALL
      SELECT 'staff', "staffKey", "accountCode", "debitMinor" FROM posted
    )
    SELECT "dimension",
           "key",
           COALESCE(SUM(CASE WHEN "accountCode" = 'SALES_REVENUE' THEN -"debitMinor" ELSE 0 END), 0)::bigint AS "revenueMinor",
           COALESCE(SUM(CASE WHEN "accountCode" = 'SALES_DISCOUNT' THEN "debitMinor" ELSE 0 END), 0)::bigint AS "discountMinor",
           COALESCE(SUM(CASE WHEN "accountCode" = 'COST_OF_GOODS_SOLD' THEN "debitMinor" ELSE 0 END), 0)::bigint AS "cogsMinor",
           COALESCE(-SUM("debitMinor"), 0)::bigint AS "grossMarginMinor"
      FROM dimensions
     GROUP BY "dimension", "key"
     ORDER BY "dimension", "key"`;
}

/**
 * FIN-03: gross margin by sale line, manufacturing batch, product or branch.
 *
 * Gross margin is `revenue - discount - cost`: revenue is recognised gross and
 * the discount is subtracted explicitly, so a report can always say how much of
 * the margin was given away rather than never having seen it. Cost is whatever
 * the sale-line adapter posted, which is the exact landed cost of the lots the
 * allocator drew from.
 *
 * `batch` resolves through the lot dimension every sale leg carries — which is
 * why revenue and discount are apportioned across allocations at posting time
 * rather than sitting on one lot-less leg.
 */
export async function grossMargin(
  db: ScopedDb,
  scope: ReportScope,
  input: { from: Date; to: Date; by: MarginDimension }
): Promise<MarginRow[]> {
  return db.$queryRaw<MarginRow[]>(grossMarginQuery(scope, input));
}

export function grossMarginQuery(
  scope: JournalReportScope,
  input: { from: Date; to: Date; by: MarginDimension }
) {
  const key = {
    line: Prisma.sql`line."sourceLineId"`,
    batch: Prisma.sql`lot."manufacturingBatchId"`,
    product: Prisma.sql`line."productId"`,
    branch: Prisma.sql`line."branchId"`,
  }[input.by];

  return Prisma.sql`
    WITH signed AS (
      SELECT ${key} AS "key",
             line."accountCode",
             CASE WHEN line."side" = 'DEBIT' THEN line."amountMinor" ELSE -line."amountMinor" END AS "debitMinor"
        FROM "finance_journal_lines" line
        JOIN "finance_journal_entries" entry
          ON entry."organizationId" = line."organizationId" AND entry."id" = line."entryId"
        LEFT JOIN "pharmacy_inventory_lots" lot
          ON lot."organizationId" = line."organizationId" AND lot."id" = line."lotId"
       WHERE line."organizationId" = ${scope.organizationId}
         AND line."accountCode" IN ('SALES_REVENUE', 'SALES_DISCOUNT', 'COST_OF_GOODS_SOLD')
         AND entry."occurredAt" >= ${input.from}
         AND entry."occurredAt" < ${input.to}
         ${branchFilter(scope)}
    )
    SELECT "key",
           -- Revenue is a credit account: a credit increases it, so its signed
           -- debit total is negated to read as earned revenue.
           COALESCE(SUM(CASE WHEN "accountCode" = 'SALES_REVENUE' THEN -"debitMinor" ELSE 0 END), 0)::int AS "revenueMinor",
           COALESCE(SUM(CASE WHEN "accountCode" = 'SALES_DISCOUNT' THEN "debitMinor" ELSE 0 END), 0)::int AS "discountMinor",
           COALESCE(SUM(CASE WHEN "accountCode" = 'COST_OF_GOODS_SOLD' THEN "debitMinor" ELSE 0 END), 0)::int AS "cogsMinor",
           -- revenue - discount - cost. Revenue is the only credit account of
           -- the three, so negating the signed total of all three gives exactly
           -- that, and a reversal (sides swapped) nets itself out here too.
           COALESCE(-SUM("debitMinor"), 0)::int AS "grossMarginMinor"
      FROM signed
     GROUP BY "key"
     ORDER BY "key"`;
}

/** UTC elapsed-time windows; both use [from, to), capped at 92 days each. */
export function marginComparisonPeriods(from: Date, to: Date) {
  const duration = to.getTime() - from.getTime();
  const previousFrom = new Date(from.getTime() - duration);
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 92 * 86_400_000 ||
    !Number.isFinite(previousFrom.getTime())
  )
    throw new RangeError('Choose a valid period of at most 92 days.');
  return { previous: { from: previousFrom, to: from }, current: { from, to } };
}

function exactMoney(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new RangeError('Ledger totals exceed safe integer-money bounds.');
  return result;
}

/** Accounting identity only: no inference about price, quantity, mix or expenses. */
export function explainGrossMargin(
  previous: MarginRow | undefined,
  current: MarginRow | undefined
) {
  const normalize = (row: MarginRow | undefined) => {
    const totals = row ?? {
      key: null,
      revenueMinor: 0,
      discountMinor: 0,
      cogsMinor: 0,
      grossMarginMinor: 0,
    };
    for (const value of [
      totals.revenueMinor,
      totals.discountMinor,
      totals.cogsMinor,
      totals.grossMarginMinor,
    ]) {
      if (!Number.isSafeInteger(value)) throw new RangeError('Invalid integer-money total.');
    }
    if (
      BigInt(totals.revenueMinor) - BigInt(totals.discountMinor) - BigInt(totals.cogsMinor) !==
      BigInt(totals.grossMarginMinor)
    ) {
      throw new RangeError('Ledger gross margin does not reconcile.');
    }
    return { ...totals, hasEntries: row !== undefined };
  };
  const before = normalize(previous);
  const after = normalize(current);
  const delta = (key: 'revenueMinor' | 'discountMinor' | 'cogsMinor' | 'grossMarginMinor') =>
    exactMoney(BigInt(after[key]) - BigInt(before[key]));
  const revenueDeltaMinor = delta('revenueMinor');
  const discountDeltaMinor = delta('discountMinor');
  const cogsDeltaMinor = delta('cogsMinor');
  const differenceMinor = delta('grossMarginMinor');
  return {
    previous: before,
    current: after,
    revenueDeltaMinor,
    discountDeltaMinor,
    cogsDeltaMinor,
    differenceMinor,
    reconciledMinor: exactMoney(
      BigInt(revenueDeltaMinor) - BigInt(discountDeltaMinor) - BigInt(cogsDeltaMinor)
    ),
  };
}

/** Reuses the posted-journal read model, with at most one group per period. */
export async function grossMarginComparison(
  db: ScopedDb,
  scope: ReportScope & { branchId: string },
  input: { from: Date; to: Date }
) {
  if (!scope.organizationId || !scope.branchId)
    throw new RangeError('An explicit tenant and branch are required.');
  const periods = marginComparisonPeriods(input.from, input.to);
  // One statement guarantees a shared snapshot even through the tenant DB facade.
  const rows = await db.$queryRaw<(MarginRow & { period: 'previous' | 'current' })[]>(Prisma.sql`
    SELECT 'previous' AS "period", totals.*
      FROM (${grossMarginQuery(scope, { ...periods.previous, by: 'branch' })}) totals
    UNION ALL
    SELECT 'current' AS "period", totals.*
      FROM (${grossMarginQuery(scope, { ...periods.current, by: 'branch' })}) totals`);
  const previous = rows.filter((row) => row.period === 'previous');
  const current = rows.filter((row) => row.period === 'current');
  if (
    [previous, current].some(
      (rows) => rows.length > 1 || rows.some((row) => row.key !== scope.branchId)
    )
  ) {
    throw new RangeError('Unexpected ledger branch group.');
  }
  return {
    branchId: scope.branchId,
    timezone: 'UTC' as const,
    periods,
    ...explainGrossMargin(previous[0], current[0]),
  };
}

export type LeakageRow = {
  branchId: string | null;
  medicineId: string | null;
  discountMinor: number;
  writeOffMinor: number;
  shrinkageMinor: number;
  totalMinor: number;
};

/**
 * FIN-03: the leakage report — value that left the business without being sold,
 * by branch and product.
 *
 * Three causes, kept apart because they have three different owners: discount
 * (a commercial decision at the counter), write-off (expiry and damage) and
 * shrinkage (count variance). Shrinkage is signed: stock found in a count nets
 * against stock lost, because a report that only ever adds losses overstates
 * them.
 */
export async function leakageReport(
  db: ScopedDb,
  scope: ReportScope,
  input: { from: Date; to: Date }
): Promise<LeakageRow[]> {
  return db.$queryRaw<LeakageRow[]>(Prisma.sql`
    WITH signed AS (
      SELECT line."branchId", line."productId",
             line."accountCode",
             CASE WHEN line."side" = 'DEBIT' THEN line."amountMinor" ELSE -line."amountMinor" END AS "debitMinor"
        FROM "finance_journal_lines" line
        JOIN "finance_journal_entries" entry
          ON entry."organizationId" = line."organizationId" AND entry."id" = line."entryId"
       WHERE line."organizationId" = ${scope.organizationId}
         AND line."accountCode" IN ('SALES_DISCOUNT', 'INVENTORY_WRITE_OFF', 'INVENTORY_SHRINKAGE')
         AND entry."occurredAt" >= ${input.from}
         AND entry."occurredAt" < ${input.to}
         ${branchFilter(scope)}
    )
    SELECT "branchId",
           "productId" AS "medicineId",
           COALESCE(SUM(CASE WHEN "accountCode" = 'SALES_DISCOUNT' THEN "debitMinor" ELSE 0 END), 0)::int AS "discountMinor",
           COALESCE(SUM(CASE WHEN "accountCode" = 'INVENTORY_WRITE_OFF' THEN "debitMinor" ELSE 0 END), 0)::int AS "writeOffMinor",
           COALESCE(SUM(CASE WHEN "accountCode" = 'INVENTORY_SHRINKAGE' THEN "debitMinor" ELSE 0 END), 0)::int AS "shrinkageMinor",
           COALESCE(SUM("debitMinor"), 0)::int AS "totalMinor"
      FROM signed
     GROUP BY "branchId", "productId"
     ORDER BY "branchId", "productId"`);
}

export type TrialBalanceRow = { accountCode: string; debitMinor: number; creditMinor: number };

/**
 * FIN-01 acceptance evidence: the organization's postings by account.
 *
 * The totals must be equal — that is the whole claim of a double-entry ledger —
 * and this is the read that lets an operator (or a test) see that they are,
 * without trusting that every adapter got it right individually.
 */
export function trialBalance(
  db: ScopedDb,
  scope: ReportScope,
  input: { from: Date; to: Date }
): Promise<TrialBalanceRow[]> {
  return db.$queryRaw<TrialBalanceRow[]>(Prisma.sql`
    SELECT line."accountCode"::text AS "accountCode",
           COALESCE(SUM(CASE WHEN line."side" = 'DEBIT' THEN line."amountMinor" ELSE 0 END), 0)::int AS "debitMinor",
           COALESCE(SUM(CASE WHEN line."side" = 'CREDIT' THEN line."amountMinor" ELSE 0 END), 0)::int AS "creditMinor"
      FROM "finance_journal_lines" line
      JOIN "finance_journal_entries" entry
        ON entry."organizationId" = line."organizationId" AND entry."id" = line."entryId"
     WHERE line."organizationId" = ${scope.organizationId}
       AND entry."occurredAt" >= ${input.from}
       AND entry."occurredAt" < ${input.to}
       ${branchFilter(scope)}
     GROUP BY line."accountCode"
     ORDER BY line."accountCode"`);
}
