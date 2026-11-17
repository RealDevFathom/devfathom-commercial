import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** Shared by journal posting, bookkeeping, and accounting-period close/reopen. */
export function pharmacyLedgerLockKey(scope: { organizationId: string; branchId: string }) {
  return `pharmacy-ledger:${scope.organizationId}:${scope.branchId}`;
}

/**
 * DEV-877: one transaction-scoped lock per org+branch ledger.
 *
 * - `exclusive` is taken FIRST by period close/reopen and by the back-office
 *   bookkeeping, AP and journal-voucher commands, before any other lock.
 * - `shared` is taken by every operational posting (counter, refunds, stock,
 *   transfers, offline replay, khata repayment) at the moment it posts.
 *
 * Postings never wait for each other, so the lock cannot join a deadlock with
 * the customer, drawer, device or stock locks those paths take in differing
 * orders. A posting still waits for an in-flight close, and a close waits for
 * accepted postings to commit, so no posting passes its open-period check
 * while a close that would refuse it is committing.
 */
export async function lockPharmacyLedgerScope(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  mode: 'exclusive' | 'shared' = 'exclusive'
) {
  const key = pharmacyLedgerLockKey(scope);
  await db.$queryRaw(
    mode === 'shared'
      ? // Prisma cannot read the void result of the shared variant, so select it as text.
        Prisma.sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))::text AS locked`
      : Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
  );
}
