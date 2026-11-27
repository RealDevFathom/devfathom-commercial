import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * PUR-02 — how much of each ordered line has actually arrived on a POSTED
 * receipt. Draft receipts are excluded: a document nobody has posted has not
 * delivered anything, and counting it would let the bench believe a line was
 * closed while the ledger still had no stock.
 */
export async function receivedAgainstOrder(
  db: ScopedDb,
  scope: { organizationId: string },
  purchaseOrderId: string
): Promise<Map<string, { receivedUnits: number; acceptedUnits: number; rejectedUnits: number }>> {
  const lines = await db.pharmacyGoodsReceiptLine.findMany({
    where: {
      organizationId: scope.organizationId,
      goodsReceipt: { organizationId: scope.organizationId, purchaseOrderId, status: 'POSTED' },
      purchaseOrderLineId: { not: null },
    },
    select: {
      purchaseOrderLineId: true,
      receivedCanonicalUnits: true,
      bonusCanonicalUnits: true,
      acceptedCanonicalUnits: true,
      rejectedCanonicalUnits: true,
    },
  });
  const totals = new Map<
    string,
    { receivedUnits: number; acceptedUnits: number; rejectedUnits: number }
  >();
  for (const line of lines) {
    const key = line.purchaseOrderLineId!;
    const running = totals.get(key) ?? { receivedUnits: 0, acceptedUnits: 0, rejectedUnits: 0 };
    running.receivedUnits += line.receivedCanonicalUnits + line.bonusCanonicalUnits;
    running.acceptedUnits += line.acceptedCanonicalUnits;
    running.rejectedUnits += line.rejectedCanonicalUnits;
    totals.set(key, running);
  }
  return totals;
}
