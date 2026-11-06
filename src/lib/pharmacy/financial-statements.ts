import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { projectProfitAndLoss } from './accounts/profit-loss';

export { projectProfitAndLoss } from './accounts/profit-loss';

type Scope = { organizationId: string; branchId: string };
const eventLabels: Record<string, string> = {
  PHARMACY_GOODS_RECEIPT: 'Goods received',
  PHARMACY_SALE_LINE: 'Sale',
  PHARMACY_SALE_RETURN_LINE: 'Sale return',
  PHARMACY_UNIDENTIFIED_RETURN_HOLD: 'Return on hold',
  PHARMACY_STOCK_WRITE_OFF: 'Stock write-off',
  PHARMACY_SUPPLIER_CLAIM: 'Supplier claim',
  PHARMACY_INTERBRANCH_TRANSFER_LINE: 'Branch transfer',
  PHARMACY_INVENTORY_COUNT_LINE: 'Inventory count',
  PHARMACY_TENDER: 'Payment received',
  PHARMACY_REFUND: 'Refund',
  PHARMACY_DAILY_CLOSE: 'Daily close',
  PHARMACY_OPENING_STOCK: 'Opening stock',
  PHARMACY_OPENING_LEDGER: 'Opening balance',
  PHARMACY_BOOKKEEPING_TRANSACTION: 'Bookkeeping transaction',
};
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
  // The source identifiers refer to different tables. Resolve only the rows on
  // this page, and require both tenant and branch at every operational join.
  // A missing/deleted source or actor leaves a null display value, not an ID.
  const details = journal.length
    ? await db.$queryRaw<
        Array<{ id: string; billNumber: number | null; actorDisplayName: string | null }>
      >(Prisma.sql`
      SELECT e.id, s."receiptNumber" AS "billNumber", u.name AS "actorDisplayName"
      FROM finance_journal_entries e
      LEFT JOIN users u ON u.id=e."actorId" AND u."organizationId"=${scope.organizationId}
      LEFT JOIN pharmacy_sale_lines sl ON e."sourceKind"='PHARMACY_SALE_LINE' AND sl.id=e."sourceId" AND sl."organizationId"=${scope.organizationId} AND sl."branchId"=${scope.branchId}
      LEFT JOIN pharmacy_sale_return_lines rl ON e."sourceKind"='PHARMACY_SALE_RETURN_LINE' AND rl.id=e."sourceId" AND rl."organizationId"=${scope.organizationId} AND rl."branchId"=${scope.branchId}
      LEFT JOIN pharmacy_unidentified_return_holds h ON e."sourceKind"='PHARMACY_UNIDENTIFIED_RETURN_HOLD' AND h.id=e."sourceId" AND h."organizationId"=${scope.organizationId} AND h."branchId"=${scope.branchId}
      LEFT JOIN pharmacy_sale_lines returned ON returned.id=COALESCE(rl."saleLineId", h."saleLineId") AND returned."organizationId"=${scope.organizationId} AND returned."branchId"=${scope.branchId}
      LEFT JOIN pharmacy_tenders t ON e."sourceKind"='PHARMACY_TENDER' AND t.id=e."sourceId" AND t."organizationId"=${scope.organizationId} AND t."branchId"=${scope.branchId}
      LEFT JOIN pharmacy_refunds r ON e."sourceKind"='PHARMACY_REFUND' AND r.id=e."sourceId" AND r."organizationId"=${scope.organizationId} AND r."branchId"=${scope.branchId}
      LEFT JOIN pharmacy_sales s ON s.id=COALESCE(sl."saleId", returned."saleId", t."saleId", r."saleId") AND s."organizationId"=${scope.organizationId} AND s."branchId"=${scope.branchId}
      WHERE e."organizationId"=${scope.organizationId} AND e.id IN (${Prisma.join(journal.map((entry) => entry.id))})
        AND EXISTS (SELECT 1 FROM finance_journal_lines l WHERE l."entryId"=e.id AND l."organizationId"=${scope.organizationId} AND l."branchId"=${scope.branchId})`)
    : [];
  const detailsById = new Map(details.map((detail) => [detail.id, detail]));
  return {
    from: input.from,
    to: input.to,
    page: input.page,
    journal: journal.map((entry) => ({
      ...entry,
      billNumber: detailsById.get(entry.id)?.billNumber ?? null,
      actorDisplayName: detailsById.get(entry.id)?.actorDisplayName ?? null,
      eventLabel: `${entry.reversesEntryId ? 'Reversal: ' : ''}${eventLabels[entry.sourceKind] ?? 'Journal entry'}`,
    })),
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
