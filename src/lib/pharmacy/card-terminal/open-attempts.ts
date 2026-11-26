import type { PharmacyCardTerminalAttemptStatus } from '@/generated/prisma/enums';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from '../stock-ledger';
import { RESERVED_PROVIDER_NAMES } from './contract';

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
  return countOutstandingCardAttempts(db, scope, businessDate);
}

/** Outstanding attempts remain actionable even when their business day has passed. */
export function countOutstandingCardAttempts(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  businessDate?: Date
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

/**
 * DEV-743: whether any of these tenders records an integrated card-terminal charge (a settled
 * attempt links to it). Such money goes back through the provider's own refund process, never as
 * cash from the drawer. Manual Card and Wallet tenders and the sandbox, prepaid and mock
 * providers are never terminal tenders, so they are not even looked up.
 */
export async function anyCardTerminalTender(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  tenders: readonly { id: string; type?: string | null; provider?: string | null }[]
) {
  const candidates = tenders
    .filter(
      (tender) =>
        tender.type === 'CARD' &&
        typeof tender.provider === 'string' &&
        !RESERVED_PROVIDER_NAMES.includes(tender.provider)
    )
    .map((tender) => tender.id);
  if (candidates.length === 0) return false;
  const linked = await db.pharmacyCardTerminalAttempt.count({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      tenderId: { in: candidates },
    },
  });
  return linked > 0;
}
