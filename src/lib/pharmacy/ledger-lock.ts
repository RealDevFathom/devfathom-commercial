import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/** Shared by journal posting, bookkeeping, and accounting-period close/reopen. */
export function pharmacyLedgerLockKey(scope: { organizationId: string; branchId: string }) {
  return `pharmacy-ledger:${scope.organizationId}:${scope.branchId}`;
}

export async function lockPharmacyLedgerScope(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string }
) {
  await db.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${pharmacyLedgerLockKey(scope)}, 0))`
  );
}
