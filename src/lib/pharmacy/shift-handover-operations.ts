import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { readPharmacyCashCloseCheck } from './cash-close-check-operations';
import {
  buildPharmacyShiftHandover,
  OPEN_CUSTOMER_ORDER_STATUSES,
  type ShiftHandoverNote,
} from './shift-handover';

/**
 * DEV-695 — reads the handover facts for one branch/business day and drafts the
 * note. Strictly read-only like the #728 check it reuses: no lock, no write, no
 * notification. Every query is pinned to the caller's organization and branch on
 * top of RLS, and every number is counted by the database, not by a model.
 */
export async function readPharmacyShiftHandover(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  businessDate: Date,
  now = new Date()
): Promise<ShiftHandoverNote & { branchName: string }> {
  // Throws NOT_FOUND for a branch outside the organization before anything else is read.
  const check = await readPharmacyCashCloseCheck(db, scope, businessDate);
  const where = { organizationId: scope.organizationId, branchId: scope.branchId };
  const [pendingRxCount, oldestRx, orders, restockCount, restockReserve] = await Promise.all([
    db.pharmacyEmergencyRxFollowUp.count({ where: { ...where, status: 'OPEN' } }),
    db.pharmacyEmergencyRxFollowUp.findFirst({
      where: { ...where, status: 'OPEN' },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    db.pharmacyCustomerOrder.findMany({
      where: { ...where, status: { in: [...OPEN_CUSTOMER_ORDER_STATUSES] } },
      select: { status: true, reservationExpiresAt: true },
    }),
    db.pharmacyRestockInterest.count({ where: { ...where, status: { in: ['OPEN', 'NOTIFIED'] } } }),
    db.pharmacyRestockInterest.count({
      where: { ...where, status: { in: ['OPEN', 'NOTIFIED'] }, reserveOnArrival: true },
    }),
  ]);
  const note = buildPharmacyShiftHandover({
    check,
    pendingRx: { count: pendingRxCount, oldestAt: oldestRx?.createdAt ?? null },
    orders: orders.map((order) => ({
      status: order.status as (typeof OPEN_CUSTOMER_ORDER_STATUSES)[number],
      reservationExpiresAt: order.reservationExpiresAt,
    })),
    restock: { count: restockCount, reserveOnArrival: restockReserve },
    now,
  });
  return { ...note, branchName: check.branchName };
}
