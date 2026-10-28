import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

type Scope = { organizationId: string; branchId: string };
type AccountTotals = {
  accountCode: string;
  currency: string;
  opening: bigint;
  debit: bigint;
  credit: bigint;
};

const profitAndLossAccounts = [
  'SALES_REVENUE',
  'SALES_DISCOUNT',
  'COST_OF_GOODS_SOLD',
  'INVENTORY_WRITE_OFF',
  'INVENTORY_SHRINKAGE',
  'OPERATING_EXPENSE',
  'LOYALTY_REDEMPTION',
  'CASH_OVER_SHORT',
] as const;

type ProfitAndLossAccount = (typeof profitAndLossAccounts)[number];

/**
 * Project net profit or loss from period movements in the canonical journal.
 *
 * Every P&L account is expressed in its natural presentation direction:
 * revenue is credit minus debit, while contra-revenue and expenses are debit
 * minus credit. Net profit is consequently revenue minus every other row. A
 * reversal needs no special handling because its journal sides are reversed.
 */
export function projectProfitAndLoss(totals: AccountTotals[]) {
  const accounts = new Set<string>(profitAndLossAccounts);
  const currencies = new Map<string, Map<ProfitAndLossAccount, bigint>>();

  for (const total of totals) {
    if (
      !accounts.has(total.accountCode) ||
      (total.debit === BigInt(0) && total.credit === BigInt(0))
    )
      continue;
    const accountCode = total.accountCode as ProfitAndLossAccount;
    const rows = currencies.get(total.currency) ?? new Map<ProfitAndLossAccount, bigint>();
    rows.set(
      accountCode,
      accountCode === 'SALES_REVENUE' ? total.credit - total.debit : total.debit - total.credit
    );
    currencies.set(total.currency, rows);
  }

  return [...currencies.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, values]) => {
      const rows = profitAndLossAccounts.map((accountCode) => ({
        accountCode,
        amountMinor: (values.get(accountCode) ?? BigInt(0)).toString(),
      }));
      const revenue = values.get('SALES_REVENUE') ?? BigInt(0);
      const deductions = profitAndLossAccounts
        .filter((accountCode) => accountCode !== 'SALES_REVENUE')
        .reduce((sum, accountCode) => sum + (values.get(accountCode) ?? BigInt(0)), BigInt(0));
      return { currency, rows, netProfitMinor: (revenue - deductions).toString() };
    });
}

/** Signed debit balances, including additive reversals. No operational revaluation. */
export async function financialStatements(
  db: ScopedDb,
  scope: Scope,
  input: { from: Date; to: Date; page: number }
) {
  const totals = await db.$queryRaw<AccountTotals[]>(Prisma.sql`
    SELECT l."accountCode"::text AS "accountCode", e.currency::text AS currency,
      COALESCE(SUM(CASE WHEN e."occurredAt" < ${input.from} THEN CASE WHEN l.side='DEBIT' THEN l."amountMinor"::bigint ELSE -l."amountMinor"::bigint END ELSE 0 END),0)::bigint AS opening,
      COALESCE(SUM(l."amountMinor"::bigint) FILTER (WHERE e."occurredAt" >= ${input.from} AND l.side='DEBIT'),0)::bigint AS debit,
      COALESCE(SUM(l."amountMinor"::bigint) FILTER (WHERE e."occurredAt" >= ${input.from} AND l.side='CREDIT'),0)::bigint AS credit
    FROM finance_journal_lines l JOIN finance_journal_entries e ON e."organizationId"=l."organizationId" AND e.id=l."entryId"
    WHERE l."organizationId"=${scope.organizationId} AND l."branchId"=${scope.branchId} AND e."occurredAt" < ${input.to}
    GROUP BY l."accountCode", e.currency ORDER BY e.currency,l."accountCode"`);
  const cash = await db.$queryRaw<
    Array<{ sourceKind: string; currency: string; inflow: bigint; outflow: bigint }>
  >(Prisma.sql`
    WITH movements AS (
      SELECT e.id,e."sourceKind",e.currency,
        SUM(CASE WHEN l.side='DEBIT' THEN l."amountMinor"::bigint ELSE -l."amountMinor"::bigint END)::bigint AS net
      FROM finance_journal_lines l JOIN finance_journal_entries e ON e."organizationId"=l."organizationId" AND e.id=l."entryId"
      WHERE l."organizationId"=${scope.organizationId} AND l."branchId"=${scope.branchId}
        AND l."accountCode" IN ('CASH','BANK') AND e."occurredAt">=${input.from} AND e."occurredAt"<${input.to}
      GROUP BY e.id,e."sourceKind",e.currency
    ) SELECT "sourceKind"::text,currency::text,
      COALESCE(SUM(net) FILTER (WHERE net>0),0)::bigint AS inflow,
      COALESCE(-SUM(net) FILTER (WHERE net<0),0)::bigint AS outflow
      FROM movements GROUP BY "sourceKind",currency ORDER BY currency,"sourceKind"`);
  const where = {
    organizationId: scope.organizationId,
    occurredAt: { gte: input.from, lt: input.to },
    lines: { some: { organizationId: scope.organizationId, branchId: scope.branchId } },
  };
  const [journal, journalCount] = await Promise.all([
    db.financeJournalEntry.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 25,
      skip: (input.page - 1) * 25,
      select: {
        id: true,
        sourceKind: true,
        sourceId: true,
        description: true,
        currency: true,
        occurredAt: true,
        reversesEntryId: true,
        lines: {
          where: { organizationId: scope.organizationId, branchId: scope.branchId },
          select: { id: true, accountCode: true, side: true, amountMinor: true, lotId: true },
        },
      },
    }),
    db.financeJournalEntry.count({ where }),
  ]);
  return {
    from: input.from,
    to: input.to,
    page: input.page,
    journal,
    journalCount,
    profitAndLoss: projectProfitAndLoss(totals),
    accounts: totals.map((t) => ({
      accountCode: t.accountCode,
      currency: t.currency,
      openingMinor: t.opening.toString(),
      debitMinor: t.debit.toString(),
      creditMinor: t.credit.toString(),
      closingMinor: (t.opening + t.debit - t.credit).toString(),
    })),
    cashflow: cash.map((t) => ({
      sourceKind: t.sourceKind,
      currency: t.currency,
      inflowMinor: t.inflow.toString(),
      outflowMinor: t.outflow.toString(),
      netMinor: (t.inflow - t.outflow).toString(),
    })),
  };
}
