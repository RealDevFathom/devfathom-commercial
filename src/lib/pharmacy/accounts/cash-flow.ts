import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export type CashFlowCategory = 'OPERATING' | 'INVESTING' | 'FINANCING' | 'UNCLASSIFIED';

export type CashFlowPosting = {
  entryId: string;
  sourceKind: string;
  sourceId: string;
  description: string;
  currency: string;
  occurredAt: Date;
  createdAt: Date;
  reversesEntryId: string | null;
  accountCode: string;
  side: 'DEBIT' | 'CREDIT';
  amountMinor: bigint;
};

export type CashFlowControls = Array<{
  currency: string;
  openingMinor: string;
  closingMinor: string;
  movementMinor: string;
}>;

const CASH = new Set(['CASH', 'BANK']);
const operatingPolicy: Readonly<Record<string, ReadonlySet<string>>> = {
  PHARMACY_TENDER: new Set(['SALES_CLEARING']),
  PHARMACY_REFUND: new Set(['SALES_CLEARING']),
  PHARMACY_DAILY_CLOSE: new Set(['CASH_OVER_SHORT']),
  PHARMACY_BOOKKEEPING_TRANSACTION: new Set([
    'ACCOUNTS_RECEIVABLE',
    'ACCOUNTS_PAYABLE',
    'GOODS_RECEIVED_ACCRUAL',
    'INVENTORY',
    'OPERATING_EXPENSE',
    'CASH_OVER_SHORT',
  ]),
};

/** Deliberately narrow: classification requires both a supported source adapter and counterpart. */
export function classifyCashEntry(rows: readonly CashFlowPosting[]): CashFlowCategory {
  if (!rows.length) return 'UNCLASSIFIED';
  const sourceKind = rows[0]!.sourceKind;
  const cashNet = rows
    .filter((row) => CASH.has(row.accountCode))
    .reduce((sum, row) => sum + signed(row), BigInt(0));
  const counterpartRows = rows.filter((row) => !CASH.has(row.accountCode));
  const counterpartNet = counterpartRows.reduce((sum, row) => sum + signed(row), BigInt(0));
  // A branch-scoped slice can omit null-branch or other-branch legs. Fail closed unless the
  // visible slice balances and every counterpart moves opposite to the cash movement.
  if (
    cashNet === BigInt(0) ||
    cashNet + counterpartNet !== BigInt(0) ||
    counterpartRows.some((row) => {
      const amount = signed(row);
      return amount === BigInt(0) || amount * cashNet > BigInt(0);
    })
  )
    return 'UNCLASSIFIED';
  const counterparts = new Set(counterpartRows.map((row) => row.accountCode));
  if (
    sourceKind === 'PHARMACY_OPENING_LEDGER' &&
    counterparts.size === 1 &&
    counterparts.has('OPENING_BALANCE_EQUITY')
  )
    return 'FINANCING';
  const allowed = operatingPolicy[sourceKind];
  if (
    allowed &&
    counterparts.size > 0 &&
    [...counterparts].every((account) => allowed.has(account))
  )
    return 'OPERATING';
  return 'UNCLASSIFIED';
}

const signed = (row: CashFlowPosting) =>
  (row.side === 'DEBIT' ? BigInt(1) : BigInt(-1)) * BigInt(row.amountMinor);

export function projectCashFlow(
  postings: readonly CashFlowPosting[],
  period: { from: Date; to: Date },
  controls: CashFlowControls = []
) {
  const entries = new Map<string, CashFlowPosting[]>();
  for (const row of postings) {
    const list = entries.get(row.entryId) ?? [];
    list.push(row);
    entries.set(row.entryId, list);
  }
  const currency = new Map<
    string,
    {
      opening: bigint;
      categories: Record<CashFlowCategory, bigint>;
      evidence: ReturnType<typeof evidence>[];
      latest: Date | null;
    }
  >();
  const ensure = (code: string) => {
    let value = currency.get(code);
    if (!value) {
      value = {
        opening: BigInt(0),
        categories: {
          OPERATING: BigInt(0),
          INVESTING: BigInt(0),
          FINANCING: BigInt(0),
          UNCLASSIFIED: BigInt(0),
        },
        evidence: [],
        latest: null,
      };
      currency.set(code, value);
    }
    return value;
  };
  function evidence(rows: readonly CashFlowPosting[], net: bigint, category: CashFlowCategory) {
    const first = rows[0]!;
    return {
      entryId: first.entryId,
      sourceKind: first.sourceKind,
      sourceId: first.sourceId,
      description: first.description,
      occurredAt: first.occurredAt,
      reversesEntryId: first.reversesEntryId,
      category,
      netMinor: net.toString(),
      counterpartAccounts: [
        ...new Set(rows.filter((r) => !CASH.has(r.accountCode)).map((r) => r.accountCode)),
      ].sort(),
    };
  }
  for (const rows of entries.values()) {
    const first = rows[0]!;
    const cashNet = rows
      .filter((row) => CASH.has(row.accountCode))
      .reduce((sum, row) => sum + signed(row), BigInt(0));
    const bucket = ensure(first.currency);
    if (first.occurredAt < period.from) bucket.opening += cashNet;
    else if (first.occurredAt < period.to && cashNet !== BigInt(0)) {
      const category = classifyCashEntry(rows);
      bucket.categories[category] += cashNet;
      bucket.evidence.push(evidence(rows, cashNet, category));
      if (!bucket.latest || first.createdAt > bucket.latest) bucket.latest = first.createdAt;
    }
  }
  for (const control of controls) ensure(control.currency);
  const controlMap = new Map(controls.map((item) => [item.currency, item]));
  return [...currency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, value]) => {
      const movement = Object.values(value.categories).reduce(
        (sum, amount) => sum + amount,
        BigInt(0)
      );
      const closing = value.opening + movement;
      const control = controlMap.get(code);
      const openingDiscrepancy = control ? value.opening - BigInt(control.openingMinor) : null;
      const movementDiscrepancy = control ? movement - BigInt(control.movementMinor) : null;
      const closingDiscrepancy = control ? closing - BigInt(control.closingMinor) : null;
      return {
        currency: code,
        openingMinor: value.opening.toString(),
        ...Object.fromEntries(
          Object.entries(value.categories).map(([key, amount]) => [
            `${key.toLowerCase()}Minor`,
            amount.toString(),
          ])
        ),
        movementMinor: movement.toString(),
        closingMinor: closing.toString(),
        equationBalances: closing === value.opening + movement,
        canonicalOpeningDiscrepancyMinor: openingDiscrepancy?.toString() ?? null,
        canonicalMovementDiscrepancyMinor: movementDiscrepancy?.toString() ?? null,
        canonicalClosingDiscrepancyMinor: closingDiscrepancy?.toString() ?? null,
        canonicalControlMatches:
          openingDiscrepancy === BigInt(0) &&
          movementDiscrepancy === BigInt(0) &&
          closingDiscrepancy === BigInt(0),
        evidence: value.evidence,
        metadata: {
          latestPostingAt: value.latest,
          classifiedCompleteness: 'unknown' as const,
          completenessReason:
            'Unknown, unsupported, or unposted source adapters cannot be inferred from the posted ledger.',
        },
      };
    });
}

/** Read only after financialStatements has successfully returned its authorized scope. */
export async function loadCashFlowProjection(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  period: { from: Date; to: Date },
  controls: CashFlowControls = []
) {
  const rows = await db.$queryRaw<CashFlowPosting[]>(Prisma.sql`
    SELECT e.id::text AS "entryId", e."sourceKind"::text AS "sourceKind", e."sourceId"::text AS "sourceId",
      e.description::text, e.currency::text, e."occurredAt", e."createdAt", e."reversesEntryId"::text,
      l."accountCode"::text, l.side::text, l."amountMinor"::bigint AS "amountMinor"
    FROM finance_journal_entries e
    JOIN finance_journal_lines l ON l."organizationId"=e."organizationId" AND l."entryId"=e.id
    WHERE e."organizationId"=${scope.organizationId} AND l."organizationId"=${scope.organizationId}
      AND l."branchId"=${scope.branchId} AND e."occurredAt"<${period.to}
    ORDER BY e."occurredAt",e.id,l.id`);
  return projectCashFlow(rows, period, controls);
}
