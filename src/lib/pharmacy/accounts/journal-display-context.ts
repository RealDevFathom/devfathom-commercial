import 'server-only';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

type Entry = { sourceKind: string; sourceId: string; actorId: string };

/** Enrich only the authorized journal page; never infer a bill from an internal ID. */
export async function journalDisplayContext<T extends Entry>(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  entries: T[]
) {
  const sourceIds = (kind: string) =>
    entries.filter((e) => e.sourceKind === kind).map((e) => e.sourceId);
  const saleIds = sourceIds('PHARMACY_SALE_LINE');
  const tenderIds = sourceIds('PHARMACY_TENDER');
  const refundIds = sourceIds('PHARMACY_REFUND');
  const returnIds = sourceIds('PHARMACY_SALE_RETURN_LINE');
  const holdIds = sourceIds('PHARMACY_UNIDENTIFIED_RETURN_HOLD');
  const actorIds = [...new Set(entries.map((e) => e.actorId))];
  const sale = { select: { receiptNumber: true } } as const;
  const [sales, tenders, refunds, returns, holds, users] = await Promise.all([
    saleIds.length
      ? db.pharmacySaleLine.findMany({
          where: { ...scope, id: { in: saleIds } },
          select: { id: true, sale },
        })
      : [],
    tenderIds.length
      ? db.pharmacyTender.findMany({
          where: { ...scope, id: { in: tenderIds } },
          select: { id: true, sale },
        })
      : [],
    refundIds.length
      ? db.pharmacyRefund.findMany({
          where: { ...scope, id: { in: refundIds } },
          select: { id: true, sale },
        })
      : [],
    returnIds.length
      ? db.pharmacySaleReturnLine.findMany({
          where: { ...scope, id: { in: returnIds }, saleLine: scope },
          select: { id: true, saleLine: { select: { sale } } },
        })
      : [],
    holdIds.length
      ? db.pharmacyUnidentifiedReturnHold.findMany({
          where: { ...scope, id: { in: holdIds } },
          select: { id: true, saleLine: { select: { sale } } },
        })
      : [],
    actorIds.length
      ? db.user.findMany({
          where: { organizationId: scope.organizationId, id: { in: actorIds } },
          select: { id: true, name: true },
        })
      : [],
  ]);
  // Key by kind as well as ID: different operational tables can share an ID.
  const bills = new Map<string, number | null>();
  for (const [kind, rows] of [
    ['PHARMACY_SALE_LINE', sales],
    ['PHARMACY_TENDER', tenders],
    ['PHARMACY_REFUND', refunds],
  ] as const) {
    for (const row of rows) bills.set(`${kind}:${row.id}`, row.sale.receiptNumber);
  }
  for (const [kind, rows] of [
    ['PHARMACY_SALE_RETURN_LINE', returns],
    ['PHARMACY_UNIDENTIFIED_RETURN_HOLD', holds],
  ] as const) {
    for (const row of rows) bills.set(`${kind}:${row.id}`, row.saleLine.sale.receiptNumber);
  }
  const names = new Map(users.map((user) => [user.id, user.name]));
  return entries.map((entry) => ({
    ...entry,
    billNumber: bills.get(`${entry.sourceKind}:${entry.sourceId}`) ?? null,
    userName: names.get(entry.actorId)?.trim() || null,
  }));
}
