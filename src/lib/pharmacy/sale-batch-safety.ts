import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { blockReasonFor, type BatchState, type BlockReason } from './inventory';
import type { LedgerScope } from './stock-ledger';

export type SaleBatchErrorReason =
  'SALE_BATCH_RECALLED' | 'SALE_BATCH_QUARANTINED' | 'SALE_BATCH_EXPIRED' | 'SALE_BATCH_BLOCKED';

/** #633: a batch on the sale stopped being sellable after its line was added. */
export class PharmacySaleBatchError extends Error {
  constructor(
    readonly reason: SaleBatchErrorReason,
    readonly blockReason: BlockReason,
    readonly saleLineId: string,
    readonly inventoryLotId: string
  ) {
    super(reason);
  }
}

export type CheckedSaleBatch = { batchNumber: string; expiresAt: Date };

type AllocationRow = {
  saleLineId: string;
  inventoryLotId: string;
  stockLocationId: string;
  canonicalUnits: number;
};

type LotRow = {
  inventoryLotId: string;
  organizationId: string;
  branchId: string;
  receivedAt: Date | null;
  batchNumber: string;
  batchState: BatchState;
  expiresAt: Date;
};

// Most severe first, so the counter names the reason an operator must act on.
const SEVERITY: readonly BlockReason[] = ['RECALLED', 'QUARANTINED', 'EXPIRED'];

function errorReason(reason: BlockReason): SaleBatchErrorReason {
  if (reason === 'RECALLED') return 'SALE_BATCH_RECALLED';
  if (reason === 'QUARANTINED') return 'SALE_BATCH_QUARANTINED';
  if (reason === 'EXPIRED') return 'SALE_BATCH_EXPIRED';
  return 'SALE_BATCH_BLOCKED';
}

function rank(reason: BlockReason): number {
  const index = SEVERITY.indexOf(reason);
  return index === -1 ? SEVERITY.length : index;
}

/**
 * #633: batch safety is decided when a line is added to the cart, but the batch can be
 * recalled or quarantined, or reach its expiry instant, before the bill is paid. Every
 * tender and every completion therefore re-loads the batch behind each allocated lot in
 * the caller's transaction and refuses the sale, before any money or receipt is written,
 * when one is no longer sellable at `at`.
 *
 * The decision is INV-03's own `blockReasonFor`. The allocated units are the candidate:
 * add-to-cart debited them from AVAILABLE stock, so the bucket checks pass and what can
 * newly fail is the batch (recall, quarantine, expiry at the stored exclusive instant),
 * receipt state or tenant/branch ownership.
 *
 * The batch rows are taken FOR SHARE, in id order, until the caller commits. A recall,
 * quarantine or expiry change waits for this sale, and a sale that waited for one of
 * them sees it. Other sales of the same batch, in this branch or another, still proceed
 * concurrently: `loadCandidates` deliberately never locks batches exclusively.
 *
 * Returns the checked batch facts by lot, for the receipt snapshot.
 */
export async function assertSaleBatchesSellable(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  saleId: string
): Promise<Map<string, CheckedSaleBatch>> {
  const allocations = await db.$queryRaw<AllocationRow[]>(Prisma.sql`
    SELECT allocation."saleLineId", allocation."inventoryLotId", allocation."stockLocationId",
           allocation."canonicalUnits"
    FROM pharmacy_sale_line_allocations allocation
    JOIN pharmacy_sale_lines line
      ON line.id = allocation."saleLineId" AND line."organizationId" = allocation."organizationId"
    WHERE line."saleId" = ${saleId}
      AND line."organizationId" = ${scope.organizationId}
      AND line."branchId" = ${scope.branchId}
    ORDER BY allocation."saleLineId", allocation.id`);
  const checked = new Map<string, CheckedSaleBatch>();
  if (allocations.length === 0) return checked;

  const lotIds = [...new Set(allocations.map((allocation) => allocation.inventoryLotId))];
  const lots = await db.$queryRaw<LotRow[]>(Prisma.sql`
    SELECT lot.id AS "inventoryLotId", lot."organizationId", lot."branchId", lot."receivedAt",
           batch."batchNumber", batch."state"::text AS "batchState", batch."expiresAt"
    FROM pharmacy_inventory_lots lot
    JOIN pharmacy_manufacturing_batches batch
      ON batch.id = lot."manufacturingBatchId" AND batch."organizationId" = lot."organizationId"
    WHERE lot."organizationId" = ${scope.organizationId}
      AND lot.id IN (${Prisma.join(lotIds)})
    ORDER BY batch.id, lot.id
    FOR SHARE OF batch`);
  // PostgreSQL's transaction timestamp is fixed at BEGIN, and a JavaScript time
  // captured before the query can become stale while FOR SHARE waits. Read the
  // wall clock only after every batch lock has been acquired.
  const [{ at }] = await db.$queryRaw<Array<{ at: Date }>>(
    Prisma.sql`SELECT clock_timestamp() AS at`
  );
  if (!at) throw new Error('DATABASE_CLOCK_UNAVAILABLE');
  const lotById = new Map(lots.map((lot) => [lot.inventoryLotId, lot]));

  let refusal: PharmacySaleBatchError | null = null;
  for (const allocation of allocations) {
    const lot = lotById.get(allocation.inventoryLotId);
    // A lot or batch this tenant cannot see fails closed like any other unsafe stock.
    const reason: BlockReason | null = lot
      ? blockReasonFor(
          {
            inventoryLotId: allocation.inventoryLotId,
            stockLocationId: allocation.stockLocationId,
            organizationId: lot.organizationId,
            branchId: lot.branchId,
            batchState: lot.batchState,
            disposition: 'AVAILABLE',
            expiresAt: lot.expiresAt,
            receivedAt: lot.receivedAt,
            availableUnits: Number(allocation.canonicalUnits),
          },
          { organizationId: scope.organizationId, branchId: scope.branchId, at }
        )
      : 'UNAUTHORIZED';
    if (reason && (!refusal || rank(reason) < rank(refusal.blockReason)))
      refusal = new PharmacySaleBatchError(
        errorReason(reason),
        reason,
        allocation.saleLineId,
        allocation.inventoryLotId
      );
    if (lot)
      checked.set(lot.inventoryLotId, { batchNumber: lot.batchNumber, expiresAt: lot.expiresAt });
  }
  if (refusal) throw refusal;
  return checked;
}
