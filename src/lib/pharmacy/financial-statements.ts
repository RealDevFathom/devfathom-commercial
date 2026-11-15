import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { projectProfitAndLoss } from './accounts/profit-loss';
import { journalDisplayContext } from './accounts/journal-display-context';
import { loadLedgerLabels } from './finance-label-lookup';
import { tenderTypeLabel } from './finance-labels';

export { projectProfitAndLoss } from './accounts/profit-loss';

type Scope = { organizationId: string; branchId: string };
type AccountTotals = {
  accountCode: string;
  currency: string;
  opening: bigint;
  debit: bigint;
  credit: bigint;
};

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
        actorId: true,
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
  const tenderTypes = await journalTenderTypes(db, scope.organizationId, journal);
  const paymentMethods = Object.fromEntries(
    [...tenderTypes].map(([entryId, type]) => [entryId, tenderTypeLabel(type)])
  );
  const lotIds = journal.flatMap((entry) => (entry.lines ?? []).map((line) => line.lotId));
  const { lots } = lotIds.some(Boolean)
    ? await loadLedgerLabels(db, scope.organizationId, { lots: lotIds })
    : { lots: {} as Record<string, string> };
  return {
    from: input.from,
    to: input.to,
    page: input.page,
    journal: await journalDisplayContext(db, scope, journal),
    // Kept beside the journal so each entry stays the exact posted evidence.
    journalLabels: { paymentMethods, lots },
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

/** Payment method behind each payment or refund entry, so titles can say "Refund · Cash". */
async function journalTenderTypes(
  db: ScopedDb,
  organizationId: string,
  journal: { id: string; sourceKind: string; sourceId: string }[]
) {
  const ids = (kind: string) =>
    journal.filter((entry) => entry.sourceKind === kind).map((entry) => entry.sourceId);
  const refundIds = ids('PHARMACY_REFUND');
  const tenderIds = ids('PHARMACY_TENDER');
  const [refunds, tenders] = await Promise.all([
    refundIds.length
      ? db.pharmacyRefund.findMany({
          where: { organizationId, id: { in: refundIds } },
          select: { id: true, drawerSessionId: true, originalTender: { select: { type: true } } },
        })
      : [],
    tenderIds.length
      ? db.pharmacyTender.findMany({
          where: { organizationId, id: { in: tenderIds } },
          select: { id: true, type: true },
        })
      : [],
  ]);
  const bySource = new Map<string, string | undefined>([
    // Match postTenderRefundEntry: a refund paid from a cash drawer (including
    // a card/wallet refund settled by manual cash fallback) left as cash.
    ...refunds.map(
      (row) =>
        [
          `PHARMACY_REFUND:${row.id}`,
          row.drawerSessionId ? 'CASH' : row.originalTender?.type,
        ] as const
    ),
    ...tenders.map((row) => [`PHARMACY_TENDER:${row.id}`, row.type] as const),
  ]);
  return new Map(
    journal.flatMap((entry) => {
      const type = bySource.get(`${entry.sourceKind}:${entry.sourceId}`);
      return type ? [[entry.id, type] as const] : [];
    })
  );
}
