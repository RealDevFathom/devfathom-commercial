import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';

/** Locks the source review through payment/fulfillment; decision inserts use the same lock. */
export async function assertChronicRefillReviewCurrent(
  db: ScopedDb,
  scope: LedgerScope,
  orderId: string
) {
  await db.$queryRaw(Prisma.sql`
    SELECT pharmacy_assert_chronic_refill_review("organizationId", "branchId", "id")::text AS checked
    FROM "pharmacy_customer_orders"
    WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
      AND "id" = ${orderId}
  `);
}
