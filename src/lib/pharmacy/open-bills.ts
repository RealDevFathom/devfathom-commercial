import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { saleTotalMinor } from './settlement';
import type { LedgerScope } from './stock-ledger';

/** DEV-623: the most bills one read returns; the oldest come first. */
export const OPEN_BILLS_LIMIT = 200;

export type OpenBill = {
  saleId: string;
  status: 'OPEN' | 'HELD';
  createdAt: Date;
  updatedAt: Date;
  openedBy: string | null;
  lineCount: number;
  /** Canonical units this bill has taken off the shelf until it is paid or voided. */
  reservedUnits: number;
  netMinor: number;
  /** Paid and not refunded. While above zero the server refuses to void the bill. */
  tenderedMinor: number;
  /** Opened from a customer order rather than at the counter. */
  customerOrder: boolean;
};

/**
 * DEV-623: every unpaid bill in the branch, OPEN or HELD. Their lines keep stock
 * allocated, so a bill lost to a page reload or another browser must still be
 * findable to resume or void. Branch-scoped; the caller authorizes the branch.
 */
export async function listOpenBills(db: ScopedDb, scope: LedgerScope): Promise<OpenBill[]> {
  const sales = await db.pharmacySale.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: { in: ['OPEN', 'HELD'] },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: OPEN_BILLS_LIMIT,
    select: {
      id: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      createdByUserId: true,
      customerOrder: { select: { id: true } },
      lines: {
        select: {
          quantity: true,
          unitPriceMinor: true,
          grossMinor: true,
          discountMinor: true,
          canonicalUnits: true,
        },
      },
      tenders: { select: { amountMinor: true, refunds: { select: { amountMinor: true } } } },
    },
  });
  const creatorIds = [...new Set(sales.map((sale) => sale.createdByUserId))];
  const creators = creatorIds.length
    ? await db.user.findMany({
        where: { organizationId: scope.organizationId, id: { in: creatorIds } },
        select: { id: true, name: true },
      })
    : [];
  const names = new Map(creators.map((user) => [user.id, user.name]));
  return sales.map((sale) => ({
    saleId: sale.id,
    status: sale.status === 'HELD' ? 'HELD' : 'OPEN',
    createdAt: sale.createdAt,
    updatedAt: sale.updatedAt,
    openedBy: names.get(sale.createdByUserId) ?? null,
    lineCount: sale.lines.length,
    reservedUnits: sale.lines.reduce((units, line) => units + line.canonicalUnits, 0),
    netMinor: saleTotalMinor(sale.lines),
    tenderedMinor: sale.tenders.reduce(
      (paid, tender) =>
        paid +
        tender.amountMinor -
        tender.refunds.reduce((refunded, refund) => refunded + refund.amountMinor, 0),
      0
    ),
    customerOrder: sale.customerOrder !== null,
  }));
}
