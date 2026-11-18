import type { PharmacyCardTerminalAttemptStatus } from '@/generated/prisma/enums';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from '../stock-ledger';

/**
 * DEV-743: the attempt states that hold a sale. While an attempt is in one of these, no second
 * terminal charge or other tender may start on the sale, and its business day cannot be closed.
 * The migrations' partial unique index, tender guard and day-close guard hold the same list.
 */
export const OPEN_ATTEMPT_STATUSES: readonly PharmacyCardTerminalAttemptStatus[] = Object.freeze([
  'CREATED',
  'SENT',
  'UNKNOWN',
  'APPROVED',
  'MANUAL_REVIEW',
]);

/** How many terminal payments are still open on the branch's business day. */
export function countOpenCardTerminalAttempts(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  businessDate: Date
) {
  return db.pharmacyCardTerminalAttempt.count({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      businessDate,
      status: { in: [...OPEN_ATTEMPT_STATUSES] },
    },
  });
}
