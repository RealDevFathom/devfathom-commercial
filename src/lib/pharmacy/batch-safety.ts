import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import type { LedgerScope } from './stock-ledger';

export type PharmacyBatchSafetyBlocker = 'RECALLED' | 'QUARANTINED' | 'EXPIRED';

/** A sale cannot accept money or complete while one of its allocated batches is unsafe. */
export class PharmacyBatchSafetyError extends Error {
  readonly reason = 'BLOCKED_STOCK' as const;

  constructor(readonly blocker: PharmacyBatchSafetyBlocker) {
    super('BLOCKED_STOCK');
    this.name = 'PharmacyBatchSafetyError';
  }
}

/**
 * Re-read and lock every manufacturing batch allocated to the sale. The lock is
 * deliberately taken by the batch row, so recall/quarantine updates serialize
 * with this check rather than racing the tender or completion transaction.
 */
export async function assertSaleBatchesSafeForSettlement(
  db: ScopedDb,
  scope: LedgerScope,
  saleId: string,
  at: Date
) {
  const rows = await db.$queryRaw<Array<{ blocker: PharmacyBatchSafetyBlocker | null }>>(Prisma.sql`
    SELECT CASE
      WHEN batch.state = 'RECALLED'::"PharmacyBatchState" THEN 'RECALLED'
      WHEN batch.state = 'QUARANTINED'::"PharmacyBatchState" THEN 'QUARANTINED'
      WHEN batch."expiresAt" <= ${at} THEN 'EXPIRED'
      ELSE NULL
    END AS blocker
    FROM pharmacy_manufacturing_batches AS batch
    WHERE batch."organizationId" = ${scope.organizationId}
      AND EXISTS (
        SELECT 1
        FROM pharmacy_inventory_lots AS lot
        INNER JOIN pharmacy_sale_line_allocations AS allocation
          ON allocation."organizationId" = lot."organizationId"
         AND allocation."branchId" = lot."branchId"
         AND allocation."inventoryLotId" = lot.id
        INNER JOIN pharmacy_sale_lines AS line
          ON line."organizationId" = allocation."organizationId"
         AND line."branchId" = allocation."branchId"
         AND line.id = allocation."saleLineId"
        WHERE lot."organizationId" = ${scope.organizationId}
          AND lot."branchId" = ${scope.branchId}
          AND lot."manufacturingBatchId" = batch.id
          AND line."organizationId" = ${scope.organizationId}
          AND line."branchId" = ${scope.branchId}
          AND line."saleId" = ${saleId}
      )
    ORDER BY batch.id
    FOR UPDATE`);

  const blocked = rows.find((row) => row.blocker !== null)?.blocker;
  if (blocked) throw new PharmacyBatchSafetyError(blocked);
}
