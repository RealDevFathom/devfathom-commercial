import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export type CashFlowClass = 'OPERATING' | 'INVESTING' | 'FINANCING' | 'UNCLASSIFIED';
export type CashFlowLine = { accountCode: string; side: 'DEBIT' | 'CREDIT'; amountMinor: bigint };
export type CashFlowEvidence = {
  id: string;
  sourceKind: string;
  sourceId: string;
  sourceDetail: string | null;
  description: string;
  currency: string;
  occurredAt: Date;
  reversesEntryId: string | null;
  lines: CashFlowLine[];
};

const cashAccounts = new Set(['CASH', 'BANK']);

/** Conservative policy: both the adapter and every non-cash counterpart must be explicit. */
export function classifyCashEvidence(entry: CashFlowEvidence): {
  classification: CashFlowClass;
  netMinor: bigint;
  reason: string;
} {
  const netMinor = entry.lines.reduce(
    (sum, line) =>
      cashAccounts.has(line.accountCode)
        ? sum + (line.side === 'DEBIT' ? line.amountMinor : -line.amountMinor)
        : sum,
    0n
  );
  if (netMinor === 0n) {
    return {
      classification: 'UNCLASSIFIED',
      netMinor,
      reason: 'No net cash or bank movement (including internal transfers).',
    };
  }
  const counterparts = new Set(
    entry.lines
      .filter((line) => !cashAccounts.has(line.accountCode))
      .map((line) => line.accountCode)
  );
  const exact = (sourceKind: string, accounts: string[], sourceDetail?: string[]) =>
    entry.sourceKind === sourceKind &&
    [...counterparts].every((account) => accounts.includes(account)) &&
    counterparts.size > 0 &&
    (!sourceDetail || (!!entry.sourceDetail && sourceDetail.includes(entry.sourceDetail)));

  if (
    exact('PHARMACY_TENDER', ['SALES_CLEARING']) ||
    exact('PHARMACY_REFUND', ['SALES_CLEARING']) ||
    exact('PHARMACY_DAILY_CLOSE', ['CASH_OVER_SHORT']) ||
    exact('PHARMACY_BOOKKEEPING_TRANSACTION', ['ACCOUNTS_RECEIVABLE'], ['CUSTOMER_RECEIPT']) ||
    exact(
      'PHARMACY_BOOKKEEPING_TRANSACTION',
      ['ACCOUNTS_PAYABLE'],
      ['SUPPLIER_PAYMENT', 'VOUCHER', 'CHEQUE']
    ) ||
    exact('PHARMACY_BOOKKEEPING_TRANSACTION', ['OPERATING_EXPENSE'], ['EXPENSE', 'PETTY_CASH']) ||
    exact('PHARMACY_BOOKKEEPING_TRANSACTION', ['SALES_CLEARING'], ['SETTLEMENT'])
  )
    return {
      classification: 'OPERATING',
      netMinor,
      reason: 'Supported operating source and counterpart policy.',
    };

  if (exact('PHARMACY_OPENING_LEDGER', ['OPENING_BALANCE_EQUITY']))
    return {
      classification: 'FINANCING',
      netMinor,
      reason: 'Explicit opening cash funding; not operating income.',
    };

  return {
    classification: 'UNCLASSIFIED',
    netMinor,
    reason: 'Unsupported, unknown, or mixed source/counterpart evidence.',
  };
}

type RawRow = Omit<CashFlowEvidence, 'lines'> & { lines: unknown };

export async function loadCashFlowProjection(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  period: { from: Date; to: Date }
) {
  const rows = await db.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT e.id, e."sourceKind"::text AS "sourceKind", e."sourceId", e.description,
      e.currency::text AS currency, e."occurredAt", e."reversesEntryId",
      bt.kind::text AS "sourceDetail",
      jsonb_agg(jsonb_build_object('accountCode',l."accountCode"::text,'side',l.side::text,
        'amountMinor',l."amountMinor"::text) ORDER BY l.id) AS lines
    FROM finance_journal_entries e
    JOIN finance_journal_lines l ON l."organizationId"=e."organizationId" AND l."entryId"=e.id
    LEFT JOIN pharmacy_bookkeeping_transactions bt ON e."sourceKind"='PHARMACY_BOOKKEEPING_TRANSACTION'
      AND bt."organizationId"=e."organizationId" AND bt.id=e."sourceId"
    WHERE e."organizationId"=${scope.organizationId} AND l."organizationId"=${scope.organizationId}
      AND l."branchId"=${scope.branchId} AND e."occurredAt"<${period.to}
    GROUP BY e.id,bt.kind
    ORDER BY e."occurredAt",e.id`);
  const evidence = rows.map((row) => ({
    ...row,
    lines: (
      row.lines as Array<{ accountCode: string; side: 'DEBIT' | 'CREDIT'; amountMinor: string }>
    ).map((line) => ({ ...line, amountMinor: BigInt(line.amountMinor) })),
  }));
  const currencies = new Map<
    string,
    {
      opening: bigint;
      operating: bigint;
      investing: bigint;
      financing: bigint;
      unclassified: bigint;
    }
  >();
  const details = evidence
    .filter((entry) => entry.occurredAt >= period.from)
    .map((entry) => ({ ...entry, ...classifyCashEvidence(entry) }));
  for (const entry of evidence) {
    const net = classifyCashEvidence(entry).netMinor;
    const totals = currencies.get(entry.currency) ?? {
      opening: 0n,
      operating: 0n,
      investing: 0n,
      financing: 0n,
      unclassified: 0n,
    };
    if (entry.occurredAt < period.from) totals.opening += net;
    currencies.set(entry.currency, totals);
  }
  for (const entry of details) {
    const totals = currencies.get(entry.currency) ?? {
      opening: 0n,
      operating: 0n,
      investing: 0n,
      financing: 0n,
      unclassified: 0n,
    };
    totals[
      entry.classification.toLowerCase() as 'operating' | 'investing' | 'financing' | 'unclassified'
    ] += entry.netMinor;
    currencies.set(entry.currency, totals);
  }
  return {
    period: { ...period, bounds: '[from,to)' as const },
    scope,
    evidence: details,
    totals: [...currencies].map(([currency, value]) => ({
      currency,
      ...value,
      netMovement: value.operating + value.investing + value.financing + value.unclassified,
      closing:
        value.opening + value.operating + value.investing + value.financing + value.unclassified,
      discrepancy: 0n,
    })),
    metadata: {
      source: 'all_scoped_posted_finance_journal_lines' as const,
      retrievedAt: new Date(),
      moneyUnit: 'integer_minor' as const,
      completeness: 'unknown' as const,
      completenessReason:
        'Unposted activity and unknown future adapters cannot be asserted complete.',
    },
  };
}
