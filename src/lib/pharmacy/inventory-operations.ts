/** PH-INV INV-06/07/08(manual)/09 workflows layered on the append-only ledger. */
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  postCountAdjustmentEntry,
  postInterbranchTransferEntry,
  postInterbranchTransferReceiptEntry,
} from './finance-postings';
import { arrangementFor, PharmacyInventoryError } from './inventory';
import type { LedgerScope } from './stock-ledger';
import { lockStockBalances, lockStockRowsFrom } from './stock-lock-order';
import { hasKnownExpiryPassed } from './unrecorded-batch';

/** Serialize recall-authority decisions that can overlap at batch or medicine scope. */
export async function lockRecallAuthority(db: ScopedDb, organizationId: string) {
  await db.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pharmacy-recall-authority:${organizationId}`}, 0))`
  );
}

/** Caller holds the recall-authority lock until this notice is closed and committed. */
export async function releaseRecallBatches(
  db: ScopedDb,
  organizationId: string,
  notice: { id: string; batchId: string | null; medicineId: string | null }
) {
  // DEV-825: batch class first, in key order, through the shared helper.
  await lockRecallBatches(db, organizationId, notice);
  // Decide per batch: a medicine recall can overlap batch recalls for only some
  // of its batches, and a batch recall can overlap a medicine-wide recall.
  await db.$executeRaw(Prisma.sql`
    UPDATE "pharmacy_manufacturing_batches" AS batch
    SET state = 'ACTIVE', "stateReason" = NULL, "stateChangedAt" = NULL,
        "updatedAt" = clock_timestamp()
    WHERE batch."organizationId" = ${organizationId}
      AND ${notice.batchId ? Prisma.sql`batch.id = ${notice.batchId}` : Prisma.sql`batch."medicineId" = ${notice.medicineId}`}
      AND NOT EXISTS (
        SELECT 1 FROM "pharmacy_recall_notices" AS recall
        WHERE recall."organizationId" = batch."organizationId"
          AND recall.status = 'OPEN' AND recall.id <> ${notice.id}
          AND (recall."batchId" = batch.id OR recall."medicineId" = batch."medicineId")
      )
  `);
}

export class OpenRecallConflictError extends Error {
  constructor() {
    super('Close the open recall before reactivating this batch.');
  }
}

export async function setManufacturingBatchState(
  db: ScopedDb,
  organizationId: string,
  input: {
    manufacturingBatchId: string;
    state: 'ACTIVE' | 'RECALLED' | 'QUARANTINED';
    reason?: string;
  }
) {
  // Callers run this inside a scoped interactive transaction. The lock is held
  // through commit, closing the READ COMMITTED check/write race with recalls.
  await lockRecallAuthority(db, organizationId);
  const batch = await db.pharmacyManufacturingBatch.findFirst({
    where: { id: input.manufacturingBatchId, organizationId },
  });
  if (!batch) throw new PharmacyInventoryError('NOT_FOUND');

  if (input.state === 'ACTIVE') {
    const openRecalls = await db.pharmacyRecallNotice.count({
      where: {
        organizationId,
        status: 'OPEN',
        OR: [{ batchId: batch.id }, { medicineId: batch.medicineId }],
      },
    });
    if (openRecalls) throw new OpenRecallConflictError();
  }

  return db.pharmacyManufacturingBatch.update({
    where: { id: batch.id },
    data: {
      state: input.state,
      stateReason: input.state === 'ACTIVE' ? null : (input.reason ?? null),
      stateChangedAt: input.state === 'ACTIVE' ? null : new Date(),
    },
  });
}

function assertPositive(units: number) {
  if (!Number.isSafeInteger(units) || units <= 0) throw new PharmacyInventoryError('INVALID_UNITS');
}

/** Keep recall-managed units available for the safety-authorized reversal. */
async function manualQuarantineBalance(
  db: ScopedDb,
  scope: LedgerScope,
  input: { inventoryLotId: string; stockLocationId: string; units: number }
) {
  // Lock before reading the reserve, then read it in a separate statement so a
  // waiter sees the preceding transaction's committed balance and recall action.
  // AVAILABLE comes first (the global balance key order, stock-lock-order.ts),
  // so a release never takes the two projection locks in the opposite order.
  await lockStockBalances(
    db,
    scope,
    (['AVAILABLE', 'QUARANTINE'] as const).map((disposition) => ({
      inventoryLotId: input.inventoryLotId,
      stockLocationId: input.stockLocationId,
      disposition,
    }))
  );
  const [balance, recallActions] = await Promise.all([
    db.pharmacyStockBalance.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        inventoryLotId: input.inventoryLotId,
        stockLocationId: input.stockLocationId,
        disposition: 'QUARANTINE',
      },
      select: { onHandUnits: true, sealedPacks: true, looseUnits: true },
    }),
    db.pharmacyRecallQuarantineAction.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        inventoryLotId: input.inventoryLotId,
        stockLocationId: input.stockLocationId,
        reversedAt: null,
      },
      select: { quantityUnits: true, heldMovementId: true },
    }),
  ]);
  const reservedUnits = recallActions.reduce((sum, action) => sum + action.quantityUnits, 0);
  if (!balance || balance.onHandUnits - reservedUnits < input.units) {
    throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
  }
  if (!recallActions.length) return balance;
  // Reversal negates each original movement's exact arrangement. Manual removals
  // must leave those sealed packs and loose units intact, not just the total.
  const recallReserve = await db.pharmacyStockMovement.aggregate({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: input.inventoryLotId,
      stockLocationId: input.stockLocationId,
      id: { in: recallActions.map((action) => action.heldMovementId) },
    },
    _sum: { sealedPackDelta: true, looseUnitDelta: true },
  });
  const manual = {
    onHandUnits: balance.onHandUnits - reservedUnits,
    sealedPacks: balance.sealedPacks - (recallReserve._sum.sealedPackDelta ?? 0),
    looseUnits: balance.looseUnits - (recallReserve._sum.looseUnitDelta ?? 0),
  };
  if (manual.sealedPacks < 0 || manual.looseUnits < 0) {
    throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
  }
  return manual;
}

async function removalArrangement(
  db: ScopedDb,
  scope: LedgerScope,
  inventoryLotId: string,
  stockLocationId: string,
  units: number,
  unitsPerPack: number,
  disposition: 'AVAILABLE' | 'QUARANTINE' | 'DAMAGED' = 'AVAILABLE'
) {
  const balance =
    disposition === 'QUARANTINE'
      ? await manualQuarantineBalance(db, scope, { inventoryLotId, stockLocationId, units })
      : await db.pharmacyStockBalance.findFirst({
          where: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            inventoryLotId,
            stockLocationId,
            disposition,
          },
        });
  if (!balance || balance.onHandUnits < units)
    throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
  // Prefer loose units, but a shelf can hold more than a pack's worth of them
  // (a freshly broken strip), so step down to the largest loose take that
  // leaves whole sealed packs instead of refusing a removal that fits.
  let looseUnits = Math.min(balance.looseUnits, units);
  looseUnits -= (unitsPerPack - ((units - looseUnits) % unitsPerPack)) % unitsPerPack;
  const sealedPacks = (units - looseUnits) / unitsPerPack;
  if (looseUnits < 0 || sealedPacks > balance.sealedPacks)
    throw new PharmacyInventoryError('INVALID_ARRANGEMENT');
  return { sealedPacks, looseUnits };
}

/** DEV-682: the longest variance reason a confirming person may record. */
export const CYCLE_COUNT_REASON_MAX = 500;
/** DEV-682: sales inside this window decide which positions move fastest. */
export const CYCLE_COUNT_SALES_WINDOW_DAYS = 30;
/** DEV-682: a position counted this recently stays off the daily list. */
export const CYCLE_COUNT_RECOUNT_AFTER_DAYS = 7;
export const CYCLE_COUNT_DEFAULT_SIZE = 10;
export const CYCLE_COUNT_MAX_SIZE = 50;

export type DailyCycleCountItem = {
  inventoryLotId: string;
  stockLocationId: string;
  medicineName: string;
  /** DEV-853: null when the batch number was never recorded. */
  batchNumber: string | null;
  locationName: string;
  unitsPerPack: number;
  /** Canonical units sold from this position in the sales window. */
  soldUnits: number;
  /** On-hand value at lot cost, in minor units. */
  stockValueMinor: number;
  basis: ReadonlyArray<'FAST_MOVER' | 'HIGH_VALUE'>;
};

type DailyCycleCountRow = {
  inventoryLotId: string;
  stockLocationId: string;
  medicineName: string;
  /** DEV-853: null when the batch number was never recorded. */
  batchNumber: string | null;
  locationName: string;
  unitsPerPack: number;
  soldUnits: number | bigint;
  stockValueMinor: number | bigint;
  fastRank: number | bigint;
  valueRank: number | bigint;
};

/**
 * DEV-682: today's small cycle-count list. SQL ranks every sellable position in
 * the branch twice — by units sold in the last 30 days and by on-hand value at
 * lot cost — and takes the top half of each, skipping positions counted in the
 * last 7 days so the list rotates. The list carries no book quantity: staff
 * count blind, then `createCount` and `approveCount` post the variance.
 */
export async function dailyCycleCountList(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  at: Date,
  size: number = CYCLE_COUNT_DEFAULT_SIZE
): Promise<DailyCycleCountItem[]> {
  if (!Number.isSafeInteger(size) || size < 1 || size > CYCLE_COUNT_MAX_SIZE)
    throw new PharmacyInventoryError('INVALID_QUANTITY');
  const day = 24 * 60 * 60 * 1000;
  const salesSince = new Date(at.getTime() - CYCLE_COUNT_SALES_WINDOW_DAYS * day);
  const countedSince = new Date(at.getTime() - CYCLE_COUNT_RECOUNT_AFTER_DAYS * day);
  const perBasis = Math.ceil(size / 2);
  const rows = await db.$queryRaw<DailyCycleCountRow[]>(Prisma.sql`
    WITH positions AS (
      SELECT b."inventoryLotId", b."stockLocationId",
        m."productName" AS "medicineName", mb."batchNumber", loc.name AS "locationName",
        l."unitsPerPack",
        (b."onHandUnits"::bigint * l."unitCostMinor"::bigint) AS "stockValueMinor",
        COALESCE((
          SELECT -SUM(mv."quantityUnits") FROM "pharmacy_stock_movements" mv
          WHERE mv."organizationId" = b."organizationId"
            AND mv."branchId" = b."branchId"
            AND mv."inventoryLotId" = b."inventoryLotId"
            AND mv."stockLocationId" = b."stockLocationId"
            AND mv.kind = 'SALE'
            AND mv."reversesMovementId" IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM "pharmacy_stock_movements" r
              WHERE r."organizationId" = mv."organizationId" AND r."reversesMovementId" = mv.id
            )
            -- An OPEN, HELD or VOID sale already holds its SALE movement, but
            -- nothing was sold until checkout completes.
            AND NOT EXISTS (
              SELECT 1 FROM "pharmacy_sale_line_allocations" a
              JOIN "pharmacy_sale_lines" sl
                ON sl."organizationId" = a."organizationId" AND sl.id = a."saleLineId"
              JOIN "pharmacy_sales" s
                ON s."organizationId" = sl."organizationId" AND s.id = sl."saleId"
              WHERE a."organizationId" = mv."organizationId"
                AND a."stockMovementId" = mv.id
                AND s.status <> 'COMPLETED'
            )
            AND mv."occurredAt" >= ${salesSince}
            AND mv."occurredAt" <= ${at}
        ), 0)::bigint AS "soldUnits"
      FROM "pharmacy_stock_balances" b
      JOIN "pharmacy_inventory_lots" l
        ON l."organizationId" = b."organizationId" AND l.id = b."inventoryLotId"
      JOIN "pharmacy_manufacturing_batches" mb
        ON mb."organizationId" = l."organizationId" AND mb.id = l."manufacturingBatchId"
      JOIN "pharmacy_medicines" m
        ON m."organizationId" = mb."organizationId" AND m.id = mb."medicineId"
      JOIN "pharmacy_stock_locations" loc
        ON loc."organizationId" = b."organizationId" AND loc.id = b."stockLocationId"
      WHERE b."organizationId" = ${scope.organizationId}
        AND b."branchId" = ${scope.branchId}
        AND b.disposition = 'AVAILABLE'
        AND b."onHandUnits" > 0
        AND NOT EXISTS (
          SELECT 1 FROM "pharmacy_inventory_count_lines" cl
          JOIN "pharmacy_inventory_counts" c
            ON c."organizationId" = cl."organizationId" AND c.id = cl."countId"
          WHERE cl."organizationId" = b."organizationId"
            AND cl."branchId" = b."branchId"
            AND cl."inventoryLotId" = b."inventoryLotId"
            AND cl."stockLocationId" = b."stockLocationId"
            AND c."createdAt" >= ${countedSince}
        )
    ), ranked AS (
      SELECT p.*,
        ROW_NUMBER() OVER (
          ORDER BY p."soldUnits" DESC, p."stockValueMinor" DESC, p."inventoryLotId", p."stockLocationId"
        ) AS "fastRank",
        ROW_NUMBER() OVER (
          ORDER BY p."stockValueMinor" DESC, p."soldUnits" DESC, p."inventoryLotId", p."stockLocationId"
        ) AS "valueRank"
      FROM positions p
    )
    SELECT * FROM ranked
    WHERE ("fastRank" <= ${perBasis} AND "soldUnits" > 0) OR "valueRank" <= ${perBasis}
    ORDER BY LEAST("fastRank", "valueRank"), "fastRank", "valueRank"
    LIMIT ${size}
  `);
  return rows.map((row) => {
    const soldUnits = Number(row.soldUnits);
    const basis: Array<'FAST_MOVER' | 'HIGH_VALUE'> = [];
    if (soldUnits > 0 && Number(row.fastRank) <= perBasis) basis.push('FAST_MOVER');
    if (Number(row.valueRank) <= perBasis) basis.push('HIGH_VALUE');
    return {
      inventoryLotId: row.inventoryLotId,
      stockLocationId: row.stockLocationId,
      medicineName: row.medicineName,
      batchNumber: row.batchNumber,
      locationName: row.locationName,
      unitsPerPack: row.unitsPerPack,
      soldUnits,
      stockValueMinor: Number(row.stockValueMinor),
      basis,
    };
  });
}

export async function createCount(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    varianceThreshold: number;
    readings: ReadonlyArray<{
      inventoryLotId: string;
      stockLocationId: string;
      countedSealedPacks: number;
      countedLooseUnits: number;
    }>;
  }
) {
  if (!Number.isSafeInteger(input.varianceThreshold) || input.varianceThreshold < 0)
    throw new PharmacyInventoryError('INVALID_UNITS');
  const count = await db.pharmacyInventoryCount.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      varianceThreshold: input.varianceThreshold,
      createdById: scope.actorId,
    },
  });
  for (const reading of input.readings) {
    const [lot, balance] = await Promise.all([
      db.pharmacyInventoryLot.findFirst({
        where: {
          id: reading.inventoryLotId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
        },
      }),
      db.pharmacyStockBalance.findFirst({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          inventoryLotId: reading.inventoryLotId,
          stockLocationId: reading.stockLocationId,
          disposition: 'AVAILABLE',
        },
      }),
    ]);
    if (!lot || !balance) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
    if (
      ![reading.countedSealedPacks, reading.countedLooseUnits].every(
        (n) => Number.isSafeInteger(n) && n >= 0
      )
    )
      throw new PharmacyInventoryError('INVALID_UNITS');
    const countedUnits = reading.countedSealedPacks * lot.unitsPerPack + reading.countedLooseUnits;
    await db.pharmacyInventoryCountLine.create({
      data: {
        organizationId: scope.organizationId,
        countId: count.id,
        branchId: scope.branchId,
        inventoryLotId: reading.inventoryLotId,
        stockLocationId: reading.stockLocationId,
        expectedUnits: balance.onHandUnits,
        expectedSealedPacks: balance.sealedPacks,
        expectedLooseUnits: balance.looseUnits,
        countedSealedPacks: reading.countedSealedPacks,
        countedLooseUnits: reading.countedLooseUnits,
        countedUnits,
        varianceUnits: countedUnits - balance.onHandUnits,
      },
    });
  }
  const lines = await db.pharmacyInventoryCountLine.findMany({ where: { countId: count.id } });
  const coauth = lines.some((line) => Math.abs(line.varianceUnits ?? 0) > input.varianceThreshold);
  return db.pharmacyInventoryCount.update({
    where: { id: count.id },
    data: { status: coauth ? 'AWAITING_COAUTH' : 'OPEN' },
    include: { lines: true },
  });
}

export async function approveCount(
  db: ScopedDb,
  scope: LedgerScope,
  countId: string,
  idempotencyKeyPrefix: string,
  varianceReason?: string,
  options: {
    /**
     * DEV-682 solo-pharmacy rule: the caller has already proved the actor is the
     * pharmacy's only active member and re-verified their PIN, and records the
     * audit row in this transaction. Only then may the counter co-authorize
     * their own above-threshold variance.
     */
    soloSelfApproval?: boolean;
  } = {}
) {
  // Approval reads the lifecycle state and posts its variance as one critical
  // section. Idempotency keys only deduplicate a replay that uses the same
  // prefix; two operators may legitimately submit different prefixes. Locking
  // the count before reading its status makes those requests serialize, so the
  // follower observes APPROVED and cannot post the variance a second time.
  // The router (and every direct domain caller) runs this operation inside an
  // interactive transaction, which holds this lock through the movements and
  // final status update.
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM "pharmacy_inventory_counts"
      WHERE id=${countId}
        AND "organizationId"=${scope.organizationId}
        AND "branchId"=${scope.branchId}
      FOR UPDATE`
  );
  const count = await db.pharmacyInventoryCount.findFirst({
    where: { id: countId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: { lines: true },
  });
  if (!count) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  if (count.status === 'APPROVED') throw new PharmacyInventoryError('INVALID_STATE');
  if (
    count.status === 'AWAITING_COAUTH' &&
    count.createdById === scope.actorId &&
    options.soloSelfApproval !== true
  )
    throw new PharmacyInventoryError('COAUTH_REQUIRED');
  // DEV-682: a variance is posted only with the reason the confirming person
  // gave for it; a count that matches the book needs none.
  const reason = varianceReason?.trim() || null;
  const hasVariance = count.lines.some((line) => (line.varianceUnits ?? 0) !== 0);
  if (hasVariance && !reason) throw new PharmacyInventoryError('VARIANCE_REASON_REQUIRED');
  if (reason && reason.length > CYCLE_COUNT_REASON_MAX)
    throw new PharmacyInventoryError('VARIANCE_REASON_REQUIRED');
  // DEV-825: lock every balance the variances write, in the global key order,
  // before the first adjustment; count-line order is not that order.
  await lockStockBalances(
    db,
    scope,
    count.lines
      .filter((line) => (line.varianceUnits ?? 0) !== 0)
      .map((line) => ({
        inventoryLotId: line.inventoryLotId,
        stockLocationId: line.stockLocationId,
        disposition: 'AVAILABLE',
      }))
  );
  for (const [index, line] of count.lines.entries()) {
    const variance = line.varianceUnits ?? 0;
    if (!variance) continue;
    await db.pharmacyStockMovement.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        inventoryLotId: line.inventoryLotId,
        stockLocationId: line.stockLocationId,
        kind: 'ADJUSTMENT',
        disposition: 'AVAILABLE',
        quantityUnits: variance,
        sealedPackDelta: (line.countedSealedPacks ?? 0) - line.expectedSealedPacks,
        looseUnitDelta: (line.countedLooseUnits ?? 0) - line.expectedLooseUnits,
        actorId: scope.actorId,
        reason: `Inventory count ${count.id}`,
        idempotencyKey: `${idempotencyKeyPrefix}:${index}`,
      },
    });
  }
  const approved = await db.pharmacyInventoryCount.update({
    where: { id: count.id },
    data: {
      status: 'APPROVED',
      approvedById: scope.actorId,
      approvedAt: new Date(),
      varianceReason: hasVariance ? reason : null,
    },
  });
  // FIN-01: each approved variance is journalled in the transaction that moved
  // the stock, so GL inventory and the stock ledger change together.
  for (const line of count.lines) {
    if (!line.varianceUnits) continue;
    await postCountAdjustmentEntry(db, scope, {
      countLineId: line.id,
      at: approved.approvedAt ?? new Date(),
    });
  }
  return approved;
}

export async function writeOff(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    inventoryLotId: string;
    stockLocationId: string;
    units: number;
    witnessId: string;
    reason: string;
    evidenceRef: string;
    idempotencyKey: string;
    /** QUARANTINE and DAMAGED retire stock held by `quarantinePart`. */
    disposition?: 'AVAILABLE' | 'QUARANTINE' | 'DAMAGED';
  },
  /**
   * DEV-628: set only after `authorizeWriteOffWitness` accepted the actor's own
   * fresh PIN under the solo-pharmacy rule. Otherwise the witness is a second person.
   */
  options: { soloSelfWitness?: boolean } = {}
) {
  assertPositive(input.units);
  const selfWitness = input.witnessId === scope.actorId;
  if (selfWitness !== (options.soloSelfWitness === true))
    throw new PharmacyInventoryError('COAUTH_REQUIRED');
  // The solo self-witness was already admitted to this branch by the router.
  if (!selfWitness) {
    const witness = await db.user.findFirst({
      where: {
        id: input.witnessId,
        organizationId: scope.organizationId,
        status: 'ACTIVE',
        pharmacyBranchAssignments: {
          some: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            active: true,
          },
        },
      },
      select: { id: true },
    });
    if (!witness) throw new PharmacyInventoryError('COAUTH_REQUIRED');
  }
  const lot = await db.pharmacyInventoryLot.findFirst({
    where: {
      id: input.inventoryLotId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
  });
  if (!lot) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  // DEV-825: lock the one balance this write-off removes from through the shared
  // helper (after the witness credential, a document-class lock), then read it.
  await lockStockBalances(db, scope, [
    {
      inventoryLotId: input.inventoryLotId,
      stockLocationId: input.stockLocationId,
      disposition: input.disposition ?? 'AVAILABLE',
    },
  ]);
  const a = await removalArrangement(
    db,
    scope,
    input.inventoryLotId,
    input.stockLocationId,
    input.units,
    lot.unitsPerPack,
    input.disposition
  );
  const movement = await db.pharmacyStockMovement.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: input.inventoryLotId,
      stockLocationId: input.stockLocationId,
      kind: 'WRITE_OFF',
      disposition: input.disposition ?? 'AVAILABLE',
      quantityUnits: -input.units,
      sealedPackDelta: -a.sealedPacks,
      looseUnitDelta: -a.looseUnits,
      actorId: scope.actorId,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    },
  });
  const custody = await db.pharmacyCustodyRecord.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      movementId: movement.id,
      actorId: scope.actorId,
      witnessId: input.witnessId,
      reason: input.reason,
      evidenceRef: input.evidenceRef,
    },
  });
  return { movement, custody };
}

export async function quarantinePart(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    inventoryLotId: string;
    stockLocationId: string;
    units: number;
    damaged?: boolean;
    reason: string;
    idempotencyKeyPrefix: string;
  }
) {
  assertPositive(input.units);
  const lot = await db.pharmacyInventoryLot.findFirst({
    where: {
      id: input.inventoryLotId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
  });
  if (!lot) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  // DEV-825: both balances this move writes, through the shared helper in key
  // order (AVAILABLE before DAMAGED or QUARANTINE), before reading either.
  await lockStockBalances(
    db,
    scope,
    (['AVAILABLE', input.damaged ? 'DAMAGED' : 'QUARANTINE'] as const).map((disposition) => ({
      inventoryLotId: input.inventoryLotId,
      stockLocationId: input.stockLocationId,
      disposition,
    }))
  );
  const a = await removalArrangement(
    db,
    scope,
    input.inventoryLotId,
    input.stockLocationId,
    input.units,
    lot.unitsPerPack
  );
  const common = {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    inventoryLotId: input.inventoryLotId,
    stockLocationId: input.stockLocationId,
    kind: 'ADJUSTMENT' as const,
    actorId: scope.actorId,
    reason: input.reason,
  };
  const removed = await db.pharmacyStockMovement.create({
    data: {
      ...common,
      disposition: 'AVAILABLE',
      quantityUnits: -input.units,
      sealedPackDelta: -a.sealedPacks,
      looseUnitDelta: -a.looseUnits,
      idempotencyKey: `${input.idempotencyKeyPrefix}:out`,
    },
  });
  const held = await db.pharmacyStockMovement.create({
    data: {
      ...common,
      disposition: input.damaged ? 'DAMAGED' : 'QUARANTINE',
      quantityUnits: input.units,
      sealedPackDelta: a.sealedPacks,
      looseUnitDelta: a.looseUnits,
      idempotencyKey: `${input.idempotencyKeyPrefix}:in`,
    },
  });
  return { removed, held };
}

/** Return manually held stock to saleable inventory after it has been cleared. */
export async function releaseQuarantinedPart(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    inventoryLotId: string;
    stockLocationId: string;
    units: number;
    reason: string;
    idempotencyKeyPrefix: string;
  }
) {
  assertPositive(input.units);
  const lot = await db.pharmacyInventoryLot.findFirst({
    where: {
      id: input.inventoryLotId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
  });
  if (!lot) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  const a = await removalArrangement(
    db,
    scope,
    input.inventoryLotId,
    input.stockLocationId,
    input.units,
    lot.unitsPerPack,
    'QUARANTINE'
  );
  const common = {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    inventoryLotId: input.inventoryLotId,
    stockLocationId: input.stockLocationId,
    kind: 'ADJUSTMENT' as const,
    actorId: scope.actorId,
    reason: input.reason,
  };
  const removed = await db.pharmacyStockMovement.create({
    data: {
      ...common,
      disposition: 'QUARANTINE',
      quantityUnits: -input.units,
      sealedPackDelta: -a.sealedPacks,
      looseUnitDelta: -a.looseUnits,
      idempotencyKey: `${input.idempotencyKeyPrefix}:out`,
    },
  });
  const released = await db.pharmacyStockMovement.create({
    data: {
      ...common,
      disposition: 'AVAILABLE',
      quantityUnits: input.units,
      sealedPackDelta: a.sealedPacks,
      looseUnitDelta: a.looseUnits,
      idempotencyKey: `${input.idempotencyKeyPrefix}:in`,
    },
  });
  return { removed, released };
}

export async function allocateTransfer(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    toBranchId: string;
    lines: ReadonlyArray<{
      sourceLotId: string;
      sourceStockLocationId: string;
      destinationStockLocationId: string;
      quantityUnits: number;
    }>;
  }
) {
  if (input.toBranchId === scope.branchId)
    throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  for (const line of input.lines) {
    assertPositive(line.quantityUnits);
    const [lot, destination] = await Promise.all([
      db.pharmacyInventoryLot.findFirst({
        where: {
          id: line.sourceLotId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
        },
      }),
      db.pharmacyStockLocation.findFirst({
        where: {
          id: line.destinationStockLocationId,
          organizationId: scope.organizationId,
          branchId: input.toBranchId,
        },
      }),
    ]);
    if (!lot || !destination) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  }
  const transfer = await db.pharmacyInterbranchTransfer.create({
    data: {
      organizationId: scope.organizationId,
      fromBranchId: scope.branchId,
      toBranchId: input.toBranchId,
      allocatedById: scope.actorId,
    },
  });
  await db.pharmacyInterbranchTransferLine.createMany({
    data: input.lines.map((line) => ({
      organizationId: scope.organizationId,
      transferId: transfer.id,
      sourceBranchId: scope.branchId,
      ...line,
    })),
  });
  return db.pharmacyInterbranchTransfer.findFirstOrThrow({
    where: { id: transfer.id },
    include: { lines: true },
  });
}

/**
 * DEV-80 — the source branch takes up a DRAFT transfer request (raised by another
 * branch from lost-demand advice or a stock signal). A person at the source branch
 * allocates it, becoming its allocator; it then needs the usual second-person
 * approval before dispatch. Lines are re-checked against the two branches, and the
 * status flip is conditional so two people cannot both allocate the same request.
 */
export async function allocateRequestedTransfer(
  db: ScopedDb,
  scope: LedgerScope,
  transferId: string
) {
  const transfer = await db.pharmacyInterbranchTransfer.findFirst({
    where: { id: transferId, organizationId: scope.organizationId, fromBranchId: scope.branchId },
    include: { lines: true },
  });
  if (!transfer) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  if (transfer.status !== 'DRAFT' || transfer.lines.length === 0)
    throw new PharmacyInventoryError('INVALID_STATE');
  for (const line of transfer.lines) {
    assertPositive(line.quantityUnits);
    const [lot, destination] = await Promise.all([
      db.pharmacyInventoryLot.findFirst({
        where: {
          id: line.sourceLotId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
        },
      }),
      db.pharmacyStockLocation.findFirst({
        where: {
          id: line.destinationStockLocationId,
          organizationId: scope.organizationId,
          branchId: transfer.toBranchId,
        },
      }),
    ]);
    if (line.sourceBranchId !== scope.branchId || !lot || !destination)
      throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  }
  const flipped = await db.pharmacyInterbranchTransfer.updateMany({
    where: { id: transfer.id, organizationId: scope.organizationId, status: 'DRAFT' },
    data: { status: 'ALLOCATED', allocatedById: scope.actorId },
  });
  if (flipped.count !== 1) throw new PharmacyInventoryError('INVALID_STATE');
  return db.pharmacyInterbranchTransfer.findFirstOrThrow({
    where: { id: transfer.id, organizationId: scope.organizationId },
    include: { lines: true },
  });
}

export async function approveTransfer(
  db: ScopedDb,
  scope: LedgerScope,
  transferId: string,
  options: { soloSelfApproval?: boolean } = {}
) {
  const transfer = await db.pharmacyInterbranchTransfer.findFirst({
    where: { id: transferId, organizationId: scope.organizationId, fromBranchId: scope.branchId },
  });
  if (!transfer) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  // Solo-pharmacy rule: only the router, after a fresh PIN from a sole owner, may
  // let the allocator approve their own transfer.
  if (
    transfer.status !== 'ALLOCATED' ||
    (transfer.allocatedById === scope.actorId && !options.soloSelfApproval)
  )
    throw new PharmacyInventoryError('COAUTH_REQUIRED');
  // The solo path is self-approval only; a colleague's allocation is approved
  // the ordinary way, so its audit never records a self-approval.
  if (options.soloSelfApproval && transfer.allocatedById !== scope.actorId)
    throw new PharmacyInventoryError('INVALID_STATE');
  return db.pharmacyInterbranchTransfer.update({
    where: { id: transfer.id },
    data: { status: 'APPROVED', approvedById: scope.actorId },
  });
}

export async function dispatchTransfer(
  db: ScopedDb,
  scope: LedgerScope,
  transferId: string,
  key: string
) {
  const transfer = await db.pharmacyInterbranchTransfer.findFirst({
    where: { id: transferId, organizationId: scope.organizationId, fromBranchId: scope.branchId },
    include: { lines: true },
  });
  if (!transfer || transfer.status !== 'APPROVED')
    throw new PharmacyInventoryError('INVALID_STATE');
  // DEV-825: lock every balance the dispatch writes (each line's AVAILABLE source
  // and its IN_TRANSIT bucket), in the global key order, before the first line;
  // then read each line in a fresh statement.
  await lockStockBalances(
    db,
    scope,
    transfer.lines.flatMap((line) =>
      (['AVAILABLE', 'IN_TRANSIT'] as const).map((disposition) => ({
        inventoryLotId: line.sourceLotId,
        stockLocationId: line.sourceStockLocationId,
        disposition,
      }))
    )
  );
  for (const [i, line] of transfer.lines.entries()) {
    const balances = await db.$queryRaw<
      Array<{ onHandUnits: number; unitsPerPack: number; state: string; expiresAt: Date | null }>
    >(
      Prisma.sql`SELECT (b."onHandUnits"-COALESCE((SELECT SUM(c."reservedUnits") FROM "pharmacy_supplier_claims" c WHERE c."organizationId"=b."organizationId" AND c."inventoryLotId"=b."inventoryLotId" AND c.status='RESERVED'),0))::int AS "onHandUnits",l."unitsPerPack",mb.state::text,mb."expiresAt" FROM "pharmacy_stock_balances" b JOIN "pharmacy_inventory_lots" l ON l.id=b."inventoryLotId" JOIN "pharmacy_manufacturing_batches" mb ON mb.id=l."manufacturingBatchId" WHERE b."organizationId"=${scope.organizationId} AND b."branchId"=${scope.branchId} AND b."inventoryLotId"=${line.sourceLotId} AND b."stockLocationId"=${line.sourceStockLocationId} AND b."disposition"='AVAILABLE'`
    );
    const balance = balances[0];
    if (!balance || Number(balance.onHandUnits) < line.quantityUnits)
      throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
    // DEV-853: an unrecorded expiry is never treated as expired.
    if (balance.state !== 'ACTIVE' || hasKnownExpiryPassed(balance.expiresAt, new Date()))
      throw new PharmacyInventoryError('BLOCKED_STOCK');
    const a = arrangementFor(line.quantityUnits, balance.unitsPerPack);
    const common = {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: line.sourceLotId,
      stockLocationId: line.sourceStockLocationId,
      actorId: scope.actorId,
    };
    await db.pharmacyStockMovement.create({
      data: {
        ...common,
        kind: 'TRANSFER_OUT',
        disposition: 'AVAILABLE',
        quantityUnits: -line.quantityUnits,
        sealedPackDelta: -a.sealedPacks,
        looseUnitDelta: -a.looseUnits,
        idempotencyKey: `${key}:${i}:out`,
      },
    });
    await db.pharmacyStockMovement.create({
      data: {
        ...common,
        kind: 'TRANSFER_IN',
        disposition: 'IN_TRANSIT',
        quantityUnits: line.quantityUnits,
        sealedPackDelta: a.sealedPacks,
        looseUnitDelta: a.looseUnits,
        idempotencyKey: `${key}:${i}:transit`,
      },
    });
  }
  const dispatched = await db.pharmacyInterbranchTransfer.update({
    where: { id: transfer.id },
    data: { status: 'DISPATCHED', dispatchedById: scope.actorId, dispatchedAt: new Date() },
  });
  // FIN-01: the value leaving the source branch is moved into transit in the
  // same transaction as the units.
  for (const line of transfer.lines) {
    await postInterbranchTransferEntry(db, scope, {
      transferLineId: line.id,
      at: dispatched.dispatchedAt ?? new Date(),
    });
  }
  return dispatched;
}

export async function receiveTransferLine(
  db: ScopedDb,
  scope: LedgerScope,
  input: { transferId: string; lineId: string; receivedUnits: number; idempotencyKeyPrefix: string }
) {
  assertPositive(input.receivedUnits);
  const transfer = await db.pharmacyInterbranchTransfer.findFirst({
    where: {
      id: input.transferId,
      organizationId: scope.organizationId,
      toBranchId: scope.branchId,
    },
    include: { lines: true },
  });
  const line = transfer?.lines.find((one) => one.id === input.lineId);
  if (
    !transfer ||
    !line ||
    !['DISPATCHED', 'PARTIALLY_RECEIVED', 'EXCEPTION'].includes(transfer.status)
  )
    throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  if (line.receivedUnits + input.receivedUnits > line.quantityUnits)
    throw new PharmacyInventoryError('INVALID_UNITS');
  const source = await db.pharmacyInventoryLot.findFirstOrThrow({
    where: { id: line.sourceLotId },
    include: { batch: true },
  });
  const a = arrangementFor(input.receivedUnits, source.unitsPerPack);
  await db.pharmacyStockMovement.create({
    data: {
      organizationId: scope.organizationId,
      branchId: transfer.fromBranchId,
      inventoryLotId: source.id,
      stockLocationId: line.sourceStockLocationId,
      kind: 'TRANSFER_OUT',
      disposition: 'IN_TRANSIT',
      quantityUnits: -input.receivedUnits,
      sealedPackDelta: -a.sealedPacks,
      looseUnitDelta: -a.looseUnits,
      actorId: scope.actorId,
      idempotencyKey: `${input.idempotencyKeyPrefix}:transit-out`,
    },
  });
  const destinationLot = await db.pharmacyInventoryLot.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      manufacturingBatchId: source.manufacturingBatchId,
      packLevelId: source.packLevelId,
      unitsPerPack: source.unitsPerPack,
      supplierName: source.supplierName,
      supplierInvoiceRef: `${source.supplierInvoiceRef}:transfer:${line.id}:${line.receivedUnits}`,
      unitCostMinor: source.unitCostMinor,
      printedMrpMinor: source.printedMrpMinor,
      receivedExpiresAt: source.receivedExpiresAt,
      receivedExpiryPrecision: source.receivedExpiryPrecision,
      receivedAt: new Date(),
    },
  });
  const received = await db.pharmacyStockMovement.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: destinationLot.id,
      stockLocationId: line.destinationStockLocationId,
      kind: 'TRANSFER_IN',
      disposition: 'AVAILABLE',
      quantityUnits: input.receivedUnits,
      sealedPackDelta: a.sealedPacks,
      looseUnitDelta: a.looseUnits,
      actorId: scope.actorId,
      idempotencyKey: `${input.idempotencyKeyPrefix}:received`,
    },
  });
  // FIN-01: what arrived leaves transit and joins the destination's inventory.
  await postInterbranchTransferReceiptEntry(db, scope, {
    transferLineId: line.id,
    stockMovementId: received.id,
    at: received.occurredAt,
  });
  await db.pharmacyInterbranchTransferLine.update({
    where: { id: line.id },
    data: { receivedUnits: { increment: input.receivedUnits } },
  });
  const totalReceived =
    transfer.lines.reduce((n, one) => n + one.receivedUnits, 0) + input.receivedUnits;
  const totalExpected = transfer.lines.reduce((n, one) => n + one.quantityUnits, 0);
  return db.pharmacyInterbranchTransfer.update({
    where: { id: transfer.id },
    data: {
      status:
        totalReceived === totalExpected
          ? 'RECEIVED'
          : input.receivedUnits + line.receivedUnits === line.quantityUnits
            ? 'PARTIALLY_RECEIVED'
            : 'EXCEPTION',
      receivedAt: totalReceived === totalExpected ? new Date() : null,
      // DEV-908: the receiving side names who closed the receipt.
      receivedById: totalReceived === totalExpected ? scope.actorId : null,
    },
  });
}

export async function createRecall(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'actorId'>,
  input: { batchId?: string; medicineId?: string; reference: string; reason: string }
) {
  if ((input.batchId ? 1 : 0) + (input.medicineId ? 1 : 0) !== 1)
    throw new PharmacyInventoryError('INVALID_STATE');
  await lockRecallAuthority(db, scope.organizationId);
  const lockedBatches = await lockRecallBatches(db, scope.organizationId, input);
  if (!lockedBatches.length) throw new PharmacyInventoryError('NOT_FOUND');
  const where = input.batchId ? { id: input.batchId } : { medicineId: input.medicineId! };
  const result = await db.pharmacyManufacturingBatch.updateMany({
    where: { organizationId: scope.organizationId, ...where },
    data: { state: 'RECALLED', stateReason: input.reason, stateChangedAt: new Date() },
  });
  if (!result.count) throw new PharmacyInventoryError('NOT_FOUND');
  return db.pharmacyRecallNotice.create({
    data: {
      organizationId: scope.organizationId,
      batchId: input.batchId,
      medicineId: input.medicineId,
      reference: input.reference,
      reason: input.reason,
      createdById: scope.actorId,
    },
  });
}

export async function lockRecallBatches(
  db: ScopedDb,
  organizationId: string,
  target: { batchId?: string | null; medicineId?: string | null }
) {
  const batches = Prisma.sql`
    FROM "pharmacy_manufacturing_batches"
    WHERE "organizationId" = ${organizationId}
      AND ${
        target.batchId
          ? Prisma.sql`id = ${target.batchId}`
          : Prisma.sql`"medicineId" = ${target.medicineId}`
      }`;
  // DEV-825: batch class, ascending id, through the shared lock helper.
  await lockStockRowsFrom(db, organizationId, Prisma.sql`SELECT id AS "batchId" ${batches}`, {
    batch: 'update',
  });
  return db.$queryRaw<Array<{ id: string; medicineId: string }>>(Prisma.sql`
    SELECT id, "medicineId" ${batches}
    ORDER BY id COLLATE "C"
  `);
}

/**
 * DEV-965: `branchIds` limits the trace to those branches; it is omitted only for a
 * caller who may see every branch of the organization. An empty list reads nothing.
 */
export async function recallTrace(
  db: ScopedDb,
  organizationId: string,
  recallNoticeId: string,
  branchIds?: readonly string[]
) {
  const notice = await db.pharmacyRecallNotice.findFirst({
    where: { id: recallNoticeId, organizationId },
  });
  if (!notice) throw new PharmacyInventoryError('NOT_FOUND');
  if (branchIds?.length === 0) return [];
  const branchFilter = branchIds
    ? Prisma.sql` AND l."branchId" IN (${Prisma.join(branchIds)})`
    : Prisma.empty;
  return db.$queryRaw<
    Array<{
      branchId: string;
      inventoryLotId: string;
      disposition: string;
      units: number;
      soldUnits: number;
    }>
  >(
    // soldUnits is lot-level, so it repeats on each disposition row of a lot.
    // It counts only stock that actually left with a customer: a SALE movement
    // that has been reversed (a voided draft restores its stock) or that is
    // still held by a sale that never completed (OPEN, HELD, VOID) is not sold.
    // A SALE movement with no sale line behind it is kept, so the recall trace
    // never under-reports stock that left the shelf.
    Prisma.sql`SELECT l."branchId",l.id AS "inventoryLotId",b.disposition::text,SUM(b."onHandUnits")::int AS units,COALESCE((SELECT -SUM(m."quantityUnits") FROM "pharmacy_stock_movements" m WHERE m."organizationId"=l."organizationId" AND m."inventoryLotId"=l.id AND m.kind='SALE' AND NOT EXISTS (SELECT 1 FROM "pharmacy_stock_movements" r WHERE r."organizationId"=m."organizationId" AND r."reversesMovementId"=m.id) AND NOT EXISTS (SELECT 1 FROM "pharmacy_sale_line_allocations" a JOIN "pharmacy_sale_lines" sl ON sl."organizationId"=a."organizationId" AND sl.id=a."saleLineId" JOIN "pharmacy_sales" s ON s."organizationId"=sl."organizationId" AND s.id=sl."saleId" WHERE a."organizationId"=m."organizationId" AND a."stockMovementId"=m.id AND s.status<>'COMPLETED')),0)::int AS "soldUnits" FROM "pharmacy_inventory_lots" l JOIN "pharmacy_manufacturing_batches" mb ON mb.id=l."manufacturingBatchId" JOIN "pharmacy_stock_balances" b ON b."inventoryLotId"=l.id AND b."organizationId"=l."organizationId" WHERE l."organizationId"=${organizationId} AND (${notice.batchId}::text IS NULL OR mb.id=${notice.batchId}) AND (${notice.medicineId}::text IS NULL OR mb."medicineId"=${notice.medicineId})${branchFilter} GROUP BY l."organizationId",l."branchId",l.id,b.disposition`
  );
}

export async function acknowledgeRecall(db: ScopedDb, scope: LedgerScope, noticeId: string) {
  // Closing and acknowledging a notice both take this row lock. The status
  // check and immutable acknowledgement insert therefore form one atomic
  // decision in the caller's transaction.
  const [lockedNotice] = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM "pharmacy_recall_notices"
    WHERE id = ${noticeId} AND "organizationId" = ${scope.organizationId}
    FOR UPDATE
  `);
  if (!lockedNotice) throw new PharmacyInventoryError('INVALID_STATE');
  const notice = await db.pharmacyRecallNotice.findFirst({
    where: { id: noticeId, organizationId: scope.organizationId, status: 'OPEN' },
  });
  if (!notice) throw new PharmacyInventoryError('INVALID_STATE');
  const affectedLot = await db.pharmacyInventoryLot.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      ...(notice.batchId
        ? { manufacturingBatchId: notice.batchId }
        : { batch: { medicineId: notice.medicineId! } }),
    },
    select: { id: true },
  });
  if (!affectedLot) throw new PharmacyInventoryError('INVALID_STATE');
  return db.pharmacyRecallAcknowledgement.create({
    data: {
      organizationId: scope.organizationId,
      recallNoticeId: noticeId,
      branchId: scope.branchId,
      actorId: scope.actorId,
    },
  });
}

export async function closeRecall(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'actorId'>,
  noticeId: string
) {
  // Batch reactivation is organization-wide, so branch-narrowed RLS must not
  // hide holdings or acknowledgements used to authorize that decision.
  const [binding] = await db.$queryRaw<Array<{ branchId: string | null }>>(
    Prisma.sql`SELECT NULLIF(current_setting('app.current_branch_id', true), '') AS "branchId"`
  );
  if (!binding || binding.branchId !== null) throw new PharmacyInventoryError('INVALID_STATE');
  await lockRecallAuthority(db, scope.organizationId);
  const [lockedNotice] = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM "pharmacy_recall_notices"
    WHERE id = ${noticeId} AND "organizationId" = ${scope.organizationId}
    FOR UPDATE
  `);
  if (!lockedNotice) throw new PharmacyInventoryError('INVALID_STATE');
  const notice = await db.pharmacyRecallNotice.findFirst({
    where: { id: noticeId, organizationId: scope.organizationId, status: 'OPEN' },
    include: { acknowledgements: true },
  });
  if (!notice) throw new PharmacyInventoryError('INVALID_STATE');
  // Recall creation and closure serialize on the affected batches. Lock before
  // checking competing notices so a recall that was waiting on this batch can
  // never be hidden by the snapshot and then overwritten with ACTIVE.
  const lockedBatches = await lockRecallBatches(db, scope.organizationId, notice);
  if (!lockedBatches.length) throw new PharmacyInventoryError('INVALID_STATE');
  const affectedLots = {
    organizationId: scope.organizationId,
    ...(notice.batchId
      ? { manufacturingBatchId: notice.batchId }
      : { batch: { medicineId: notice.medicineId! } }),
  };
  const affectedBranches = await db.pharmacyInventoryLot.findMany({
    where: {
      ...affectedLots,
      balances: { some: { onHandUnits: { gt: 0 } } },
    },
    distinct: ['branchId'],
    select: { branchId: true },
  });
  const acknowledgedBranches = new Set(notice.acknowledgements.map(({ branchId }) => branchId));
  if (affectedBranches.some(({ branchId }) => !acknowledgedBranches.has(branchId)))
    throw new PharmacyInventoryError('INVALID_STATE');
  if (!acknowledgedBranches.size) {
    // A registered batch can be recalled before receipt. No branch can
    // acknowledge it then. Historical lots, including disposed stock, still
    // require acknowledgement even when their current balances are zero.
    const affectedLot = await db.pharmacyInventoryLot.findFirst({
      where: affectedLots,
      select: { id: true },
    });
    if (affectedLot) throw new PharmacyInventoryError('INVALID_STATE');
  }
  const batchIds = lockedBatches.map(({ id }) => id);
  const medicineIds = [...new Set(lockedBatches.map(({ medicineId }) => medicineId))];
  const remaining = await db.pharmacyRecallNotice.findMany({
    where: {
      organizationId: scope.organizationId,
      status: 'OPEN',
      id: { not: notice.id },
      OR: [{ batchId: { in: batchIds } }, { medicineId: { in: medicineIds } }],
    },
    select: { batchId: true, medicineId: true },
  });
  // Release only locked batches with no other open recall. A medicine-wide
  // update could overwrite a newly inserted batch's independent recall, and
  // one overlapping notice must not keep every other batch blocked.
  const releasableIds = lockedBatches
    .filter((batch) =>
      remaining.every(
        (other) => other.batchId !== batch.id && other.medicineId !== batch.medicineId
      )
    )
    .map(({ id }) => id);
  if (releasableIds.length)
    await db.pharmacyManufacturingBatch.updateMany({
      where: { organizationId: scope.organizationId, id: { in: releasableIds } },
      data: { state: 'ACTIVE', stateReason: null, stateChangedAt: null },
    });
  return db.pharmacyRecallNotice.update({
    where: { id: notice.id },
    data: { status: 'CLOSED', closedById: scope.actorId, closedAt: new Date() },
  });
}

export async function reserveSupplierClaim(
  db: ScopedDb,
  scope: LedgerScope,
  input: { inventoryLotId: string; reservedUnits: number; returnBy: Date }
) {
  assertPositive(input.reservedUnits);
  // Serialize against sales, transfers and purchase returns: lock EVERY AVAILABLE
  // balance row of the lot (the same rows sale allocation and purchase returns
  // lock) FOR UPDATE in key (stockLocationId) order, exactly like purchase returns, then measure availability from the locked rows.
  // SHARE on the batch excludes recall updates while remaining compatible with
  // checkout's batch safety check after it has already locked the balances.
  // The caller must keep this lock and the check/create below in one transaction.
  // DEV-825: batch (SHARE) then balances, in the global order, then a fresh read.
  const lotBalances = Prisma.sql`
    FROM "pharmacy_stock_balances" b
    JOIN "pharmacy_inventory_lots" l
      ON l.id = b."inventoryLotId" AND l."organizationId" = b."organizationId"
    JOIN "pharmacy_manufacturing_batches" mb
      ON mb.id = l."manufacturingBatchId" AND mb."organizationId" = l."organizationId"
    WHERE b."organizationId" = ${scope.organizationId}
      AND b."branchId" = ${scope.branchId}
      AND l."branchId" = ${scope.branchId}
      AND b."inventoryLotId" = ${input.inventoryLotId}
      AND b."disposition" = 'AVAILABLE'`;
  await lockStockRowsFrom(
    db,
    scope.organizationId,
    Prisma.sql`SELECT mb.id AS "batchId", b."branchId", b."inventoryLotId", b."stockLocationId",
      b."disposition"::text AS "disposition" ${lotBalances}`,
    { batch: 'share', balance: true }
  );
  const locked = await db.$queryRaw<Array<{ onHandUnits: number; state: string }>>(Prisma.sql`
    SELECT b."onHandUnits", mb.state::text ${lotBalances}
  `);
  if (locked.some((row) => row.state !== 'ACTIVE'))
    throw new PharmacyInventoryError('BLOCKED_STOCK');
  const onHand = locked.reduce((total, row) => total + Number(row.onHandUnits), 0);
  const already = await db.pharmacySupplierClaim.aggregate({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: input.inventoryLotId,
      status: 'RESERVED',
    },
    _sum: { reservedUnits: true },
  });
  if (onHand - (already._sum.reservedUnits ?? 0) < input.reservedUnits)
    throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
  return db.pharmacySupplierClaim.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: input.inventoryLotId,
      reservedUnits: input.reservedUnits,
      returnBy: input.returnBy,
      createdById: scope.actorId,
    },
  });
}

export async function nearExpiryBoard(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  at: Date
) {
  return db.$queryRaw<
    Array<{
      bucketDays: number;
      units: number;
      valueAtRiskMinor: number;
      withinSupplierReturnWindow: boolean;
    }>
  >(
    Prisma.sql`WITH windows(days) AS (VALUES (30),(60),(90),(180)) SELECT w.days AS "bucketDays",COALESCE(SUM(b."onHandUnits"),0)::int units,COALESCE(SUM(b."onHandUnits"*l."unitCostMinor"),0)::int AS "valueAtRiskMinor",COALESCE(bool_or(EXISTS(SELECT 1 FROM "pharmacy_supplier_claims" c WHERE c."organizationId"=l."organizationId" AND c."inventoryLotId"=l.id AND c.status='RESERVED' AND c."returnBy">=${at}::timestamp)),false) AS "withinSupplierReturnWindow" FROM windows w LEFT JOIN "pharmacy_manufacturing_batches" mb ON mb."organizationId"=${scope.organizationId} AND mb."expiresAt">${at}::timestamp AND mb."expiresAt"<=(${at}::timestamp+make_interval(days=>w.days)) LEFT JOIN "pharmacy_inventory_lots" l ON l."manufacturingBatchId"=mb.id AND l."branchId"=${scope.branchId} LEFT JOIN "pharmacy_stock_balances" b ON b."inventoryLotId"=l.id AND b.disposition='AVAILABLE' GROUP BY w.days ORDER BY w.days`
  );
}
