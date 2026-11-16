import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * CEO-JVCORE-20261025: one transaction-scoped lock per org+branch ledger, taken
 * FIRST by every command that posts, reverses, closes or reopens. A post can
 * then never pass its open-period check while a concurrent close is committing
 * the period that would have refused it.
 */
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
