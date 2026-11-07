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
    BigInt(0)
  );
  if (netMinor === BigInt(0)) {
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
    exact('PHARMACY_KHATA_COLLECTION', ['ACCOUNTS_RECEIVABLE']) ||
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

type RawEvidence = Omit<CashFlowEvidence, 'occurredAt' | 'lines'> & {
  occurredAt: string;
  lines: Array<{ accountCode: string; side: 'DEBIT' | 'CREDIT'; amountMinor: string }>;
};
type SnapshotRow = {
  balances: Array<{ currency: string; opening: string }> | null;
  evidence: RawEvidence[] | null;
};

/** Canonical CASH/BANK account controls, e.g. `financialStatements(...).accounts`. */
export type CashControlAccount = { accountCode: string; currency: string; closingMinor: string };

type Totals = {
  opening: bigint;
  operating: bigint;
  investing: bigint;
  financing: bigint;
  unclassified: bigint;
};

const zeroTotals = (): Totals => ({
  opening: BigInt(0),
  operating: BigInt(0),
  investing: BigInt(0),
  financing: BigInt(0),
  unclassified: BigInt(0),
});

/**
 * One statement (one snapshot): the pre-period opening is a SQL sum of scoped CASH/BANK
 * lines, and per-entry evidence is fetched only for [from,to) entries whose branch cash/bank net is
 * non-zero. Noncash entries and netted internal transfers never reach Node. `occurredAt` is a
 * UTC timestamp(3) column, so it is emitted with an explicit `Z` to avoid local-time parsing.
 */
export async function loadCashFlowProjection(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  period: { from: Date; to: Date },
  canonicalControls: CashControlAccount[]
) {
  const [snapshot] = await db.$queryRaw<SnapshotRow[]>(Prisma.sql`
    WITH cash_moves AS (
      SELECT e.id, e.currency::text AS currency, e."occurredAt",
        SUM(CASE WHEN l.side='DEBIT' THEN l."amountMinor"::bigint ELSE -l."amountMinor"::bigint END)::bigint AS net
      FROM finance_journal_lines l
      JOIN finance_journal_entries e ON e."organizationId"=l."organizationId" AND e.id=l."entryId"
      WHERE e."organizationId"=${scope.organizationId} AND l."organizationId"=${scope.organizationId}
        AND l."branchId"=${scope.branchId} AND l."accountCode" IN ('CASH','BANK')
        AND e."occurredAt"<${period.to}
      GROUP BY e.id, e.currency, e."occurredAt"
    ), balances AS (
      SELECT currency,
        COALESCE(SUM(net) FILTER (WHERE "occurredAt"<${period.from}),0)::bigint AS opening
      FROM cash_moves GROUP BY currency
    ), evidence AS (
      SELECT e.id, e."sourceKind"::text AS "sourceKind", e."sourceId", e.description,
        e.currency::text AS currency, e."occurredAt", e."reversesEntryId",
        bt.kind::text AS "sourceDetail",
        jsonb_agg(jsonb_build_object('accountCode',l."accountCode"::text,'side',l.side::text,
          'amountMinor',l."amountMinor"::text) ORDER BY l.id) AS lines
      FROM cash_moves m
      JOIN finance_journal_entries e ON e."organizationId"=${scope.organizationId} AND e.id=m.id
      JOIN finance_journal_lines l ON l."organizationId"=e."organizationId" AND l."entryId"=e.id
        AND l."branchId"=${scope.branchId}
      LEFT JOIN pharmacy_bookkeeping_transactions bt ON e."sourceKind"='PHARMACY_BOOKKEEPING_TRANSACTION'
        AND bt."organizationId"=e."organizationId" AND bt.id=e."sourceId"
      WHERE m."occurredAt">=${period.from} AND m.net<>0
      GROUP BY e.id, bt.kind
    )
    SELECT
      (SELECT jsonb_agg(jsonb_build_object('currency',currency,'opening',opening::text)
        ORDER BY currency) FROM balances) AS balances,
      (SELECT jsonb_agg(jsonb_build_object('id',ev.id,'sourceKind',ev."sourceKind",
        'sourceId',ev."sourceId",'sourceDetail',ev."sourceDetail",'description',ev.description,
        'currency',ev.currency,'reversesEntryId',ev."reversesEntryId",'lines',ev.lines,
        'occurredAt',to_char(ev."occurredAt",'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        ORDER BY ev."occurredAt", ev.id) FROM evidence ev) AS evidence`);

  const openingBalances = new Map(
    (snapshot?.balances ?? []).map((row) => [row.currency, BigInt(row.opening)])
  );
  const canonicalClosing = new Map<string, bigint>();
  for (const account of canonicalControls) {
    if (!cashAccounts.has(account.accountCode)) continue;
    canonicalClosing.set(
      account.currency,
      (canonicalClosing.get(account.currency) ?? BigInt(0)) + BigInt(account.closingMinor)
    );
  }

  const details = (snapshot?.evidence ?? []).map((row) => {
    const entry: CashFlowEvidence = {
      ...row,
      occurredAt: new Date(row.occurredAt),
      lines: row.lines.map((line) => ({ ...line, amountMinor: BigInt(line.amountMinor) })),
    };
    return { ...entry, ...classifyCashEvidence(entry) };
  });

  const currencies = new Map<string, Totals>();
  for (const [currency, opening] of openingBalances) {
    currencies.set(currency, { ...zeroTotals(), opening });
  }
  for (const currency of canonicalClosing.keys()) {
    if (!currencies.has(currency)) currencies.set(currency, zeroTotals());
  }
  for (const entry of details) {
    const totals = currencies.get(entry.currency) ?? zeroTotals();
    totals[
      entry.classification.toLowerCase() as 'operating' | 'investing' | 'financing' | 'unclassified'
    ] += entry.netMinor;
    currencies.set(entry.currency, totals);
  }
  return {
    period: { ...period, bounds: '[from,to)' as const },
    scope,
    evidence: details,
    totals: [...currencies]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, value]) => {
        const netMovement =
          value.operating + value.investing + value.financing + value.unclassified;
        const closing = value.opening + netMovement;
        return {
          currency,
          ...value,
          netMovement,
          closing,
          // Canonical CASH+BANK account closing from the authorized financial statements, read in
          // the same snapshot by the caller; non-zero exposes a projection/classifier defect.
          canonicalClosing: canonicalClosing.get(currency) ?? BigInt(0),
          discrepancy: (canonicalClosing.get(currency) ?? BigInt(0)) - closing,
        };
      }),
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
