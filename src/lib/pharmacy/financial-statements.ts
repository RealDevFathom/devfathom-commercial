import 'server-only';
import { reportLabel } from './report-presentation';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { projectProfitAndLoss } from './accounts/profit-loss';

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
  const sourceIds = (kind: string) =>
    journal.filter((entry) => entry.sourceKind === kind).map((entry) => entry.sourceId);
  const lotIds = [
    ...new Set(
      journal.flatMap((entry) => entry.lines.flatMap((line) => (line.lotId ? [line.lotId] : [])))
    ),
  ];
  // Fixed-size bulk reads preserve old postings and avoid a query per journal row.
  const [refunds, tenders, lots] = await Promise.all([
    sourceIds('PHARMACY_REFUND').length
      ? db.pharmacyRefund.findMany({
          where: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            id: { in: sourceIds('PHARMACY_REFUND') },
          },
          select: {
            id: true,
            originalTenderId: true,
            originalTender: { select: { type: true } },
            sale: { select: { receiptNumber: true } },
          },
        })
      : [],
    sourceIds('PHARMACY_TENDER').length
      ? db.pharmacyTender.findMany({
          where: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            id: { in: sourceIds('PHARMACY_TENDER') },
          },
          select: { id: true, type: true, sale: { select: { receiptNumber: true } } },
        })
      : [],
    lotIds.length
      ? db.pharmacyInventoryLot.findMany({
          where: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            id: { in: lotIds },
          },
          select: {
            id: true,
            supplierInvoiceRef: true,
            batch: { select: { batchNumber: true, medicine: { select: { productName: true } } } },
          },
        })
      : [],
  ]);
  const refundMap = new Map(refunds.map((refund) => [refund.id, refund]));
  const tenderMap = new Map(tenders.map((tender) => [tender.id, tender]));
  const lotMap = new Map(lots.map((lot) => [lot.id, lot]));
  return {
    from: input.from,
    to: input.to,
    page: input.page,
    journal: journal.map((entry) => {
      const refund = entry.sourceKind === 'PHARMACY_REFUND' ? refundMap.get(entry.sourceId) : undefined;
      const tender = entry.sourceKind === 'PHARMACY_TENDER' ? tenderMap.get(entry.sourceId) : undefined;
      const tenderType = refund?.originalTender.type ?? tender?.type;
      const paymentLabel = [reportLabel(entry.sourceKind), tenderType ? reportLabel(tenderType) : null]
        .filter(Boolean)
        .join(' · ');
      const receiptNumber = refund?.sale.receiptNumber ?? tender?.sale.receiptNumber;
      const sourceLabel = receiptNumber == null ? paymentLabel : `${paymentLabel} · Receipt ${receiptNumber}`;
      // Only replace generated payment descriptions; operator notes remain the title.
      const generatedDescription =
        (entry.sourceKind === 'PHARMACY_REFUND' && /^Refund of tender \S+$/.test(entry.description)) ||
        (entry.sourceKind === 'PHARMACY_TENDER' && entry.description === `Pharmacy tender ${entry.sourceId}`);
      return {
        ...entry,
        sourceLabel,
        displayTitle: generatedDescription ? paymentLabel
          : entry.description.includes(entry.sourceId) || (entry.reversesEntryId && entry.description.includes(entry.reversesEntryId)) || /\bc[a-z0-9]{20,}\b/.test(entry.description)
            ? (entry.reversesEntryId ? `Reversal · ${paymentLabel}` : paymentLabel)
            : entry.description,
        originalTenderId: refund?.originalTenderId ?? null,
        lines: entry.lines.map((line) => {
          const lot = line.lotId ? lotMap.get(line.lotId) : undefined;
          return {
            ...line,
            lotLabel: lot
              ? `${lot.batch.batchNumber} · ${lot.batch.medicine.productName} · Receipt ${lot.supplierInvoiceRef}`
              : null,
          };
        }),
      };
    }),
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
