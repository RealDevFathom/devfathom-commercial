/** PH-INV INV-06/07/08(manual)/09 workflows layered on the append-only ledger. */
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { PharmacyInventoryError, planRemovalArrangement } from './inventory';
import type { LedgerScope } from './stock-ledger';

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

async function removalArrangement(
  db: ScopedDb,
  scope: LedgerScope,
  inventoryLotId: string,
  stockLocationId: string,
  units: number,
  unitsPerPack: number
) {
  const balance = await db.pharmacyStockBalance.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId,
      stockLocationId,
      disposition: 'AVAILABLE',
    },
  });
  if (!balance || balance.onHandUnits < units)
    throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
  const looseUnits = Math.min(balance.looseUnits, units);
  const sealedUnits = units - looseUnits;
  if (sealedUnits % unitsPerPack !== 0) throw new PharmacyInventoryError('INVALID_ARRANGEMENT');
  return { sealedPacks: sealedUnits / unitsPerPack, looseUnits };
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
  idempotencyKeyPrefix: string
) {
  const count = await db.pharmacyInventoryCount.findFirst({
    where: { id: countId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: { lines: true },
  });
  if (!count) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  if (count.status === 'APPROVED') throw new PharmacyInventoryError('INVALID_STATE');
  if (count.status === 'AWAITING_COAUTH' && count.createdById === scope.actorId)
    throw new PharmacyInventoryError('COAUTH_REQUIRED');
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
  return db.pharmacyInventoryCount.update({
    where: { id: count.id },
    data: { status: 'APPROVED', approvedById: scope.actorId, approvedAt: new Date() },
  });
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
  }
) {
  assertPositive(input.units);
  if (input.witnessId === scope.actorId) throw new PharmacyInventoryError('COAUTH_REQUIRED');
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
    lot.unitsPerPack
  );
  const movement = await db.pharmacyStockMovement.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: input.inventoryLotId,
      stockLocationId: input.stockLocationId,
      kind: 'WRITE_OFF',
      disposition: 'AVAILABLE',
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

export async function approveTransfer(db: ScopedDb, scope: LedgerScope, transferId: string) {
  const transfer = await db.pharmacyInterbranchTransfer.findFirst({
    where: { id: transferId, organizationId: scope.organizationId, fromBranchId: scope.branchId },
  });
  if (!transfer) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  if (transfer.status !== 'ALLOCATED' || transfer.allocatedById === scope.actorId)
    throw new PharmacyInventoryError('COAUTH_REQUIRED');
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
  const [lockedTransfer] = await db.$queryRaw<Array<{ status: string }>>(
    Prisma.sql`SELECT status::text FROM "pharmacy_interbranch_transfers" WHERE id=${transferId} AND "organizationId"=${scope.organizationId} AND "fromBranchId"=${scope.branchId} FOR UPDATE`
  );
  if (!lockedTransfer || lockedTransfer.status !== 'APPROVED')
    throw new PharmacyInventoryError('INVALID_STATE');
  const transfer = await db.pharmacyInterbranchTransfer.findFirst({
    where: { id: transferId, organizationId: scope.organizationId, fromBranchId: scope.branchId },
    include: { lines: true },
  });
  if (!transfer) throw new PharmacyInventoryError('INVALID_STATE');
  for (const [i, line] of transfer.lines.entries()) {
    const balances = await db.$queryRaw<
      Array<{
        onHandUnits: number;
        sealedPacks: number;
        looseUnits: number;
        unitsPerPack: number;
        state: string;
        expiresAt: Date;
      }>
    >(
      Prisma.sql`SELECT (b."onHandUnits"-COALESCE((SELECT SUM(c."reservedUnits") FROM "pharmacy_supplier_claims" c WHERE c."organizationId"=b."organizationId" AND c."inventoryLotId"=b."inventoryLotId" AND c.status='RESERVED'),0))::int AS "onHandUnits",b."sealedPacks",b."looseUnits",l."unitsPerPack",mb.state::text,mb."expiresAt" FROM "pharmacy_stock_balances" b JOIN "pharmacy_inventory_lots" l ON l."organizationId"=b."organizationId" AND l."branchId"=b."branchId" AND l.id=b."inventoryLotId" JOIN "pharmacy_manufacturing_batches" mb ON mb."organizationId"=l."organizationId" AND mb.id=l."manufacturingBatchId" WHERE b."organizationId"=${scope.organizationId} AND b."branchId"=${scope.branchId} AND b."inventoryLotId"=${line.sourceLotId} AND b."stockLocationId"=${line.sourceStockLocationId} AND b."disposition"='AVAILABLE' FOR UPDATE OF b`
    );
    const balance = balances[0];
    if (!balance || Number(balance.onHandUnits) < line.quantityUnits)
      throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
    if (balance.state !== 'ACTIVE' || balance.expiresAt <= new Date())
      throw new PharmacyInventoryError('BLOCKED_STOCK');
    const arrangement = planRemovalArrangement({
      sealedPacks: balance.sealedPacks,
      looseUnits: balance.looseUnits,
      unitsPerPack: balance.unitsPerPack,
      quantityUnits: line.quantityUnits,
    });
    const common = {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: line.sourceLotId,
      stockLocationId: line.sourceStockLocationId,
      actorId: scope.actorId,
    };
    if (arrangement.breakPack.packsToBreak > 0) {
      await db.pharmacyStockMovement.create({
        data: {
          ...common,
          kind: 'BREAK_PACK',
          disposition: 'AVAILABLE',
          quantityUnits: 0,
          sealedPackDelta: arrangement.breakPack.sealedPackDelta,
          looseUnitDelta: arrangement.breakPack.looseUnitDelta,
          idempotencyKey: `${key}:${i}:break-pack`,
        },
      });
    }
    await db.pharmacyStockMovement.create({
      data: {
        ...common,
        kind: 'TRANSFER_OUT',
        disposition: 'AVAILABLE',
        quantityUnits: -line.quantityUnits,
        sealedPackDelta: -arrangement.sealedPacks,
        looseUnitDelta: -arrangement.looseUnits,
        idempotencyKey: `${key}:${i}:out`,
      },
    });
    await db.pharmacyStockMovement.create({
      data: {
        ...common,
        kind: 'TRANSFER_IN',
        disposition: 'IN_TRANSIT',
        quantityUnits: line.quantityUnits,
        sealedPackDelta: arrangement.sealedPacks,
        looseUnitDelta: arrangement.looseUnits,
        reason: transferLineTransitReason(line.id),
        idempotencyKey: `${key}:${i}:transit`,
      },
    });
  }
  return db.pharmacyInterbranchTransfer.update({
    where: { id: transfer.id },
    data: { status: 'DISPATCHED', dispatchedById: scope.actorId, dispatchedAt: new Date() },
  });
}

/** Reason stamped on every IN_TRANSIT movement that belongs to one transfer line. */
export function transferLineTransitReason(lineId: string): string {
  return `Interbranch transfer line ${lineId}`;
}

/** One receipt variance per transfer line, whatever the caller's retry key. */
export function transferVarianceKey(transferId: string, lineId: string): string {
  return `transfer-variance:${transferId}:${lineId}`;
}

const TRANSFER_VARIANCE_KEY_PREFIX = 'transfer-variance:';

/**
 * The packaging of one transfer line still sitting in the shared IN_TRANSIT
 * bucket. Attributed lines (dispatched with a line reason) own exactly what
 * their dispatch put in, less what their receipts and receipt-variance
 * write-offs took out. Legacy lines have no attribution: they get the physical
 * bucket less the packaging still owed to attributed lines. Caller holds the
 * transit balance row lock.
 */
export async function transitPackagingForLine(
  db: ScopedDb,
  input: {
    organizationId: string;
    fromBranchId: string;
    inventoryLotId: string;
    stockLocationId: string;
    lineId: string;
    transit: { sealedPacks: number; looseUnits: number };
  }
): Promise<{ sealedPacks: number; looseUnits: number }> {
  const bucket = {
    organizationId: input.organizationId,
    branchId: input.fromBranchId,
    inventoryLotId: input.inventoryLotId,
    stockLocationId: input.stockLocationId,
    disposition: 'IN_TRANSIT' as const,
  };
  const select = {
    reason: true,
    kind: true,
    idempotencyKey: true,
    sealedPackDelta: true,
    looseUnitDelta: true,
  } as const;
  const [lineMovements, varianceMovements] = await Promise.all([
    db.pharmacyStockMovement.findMany({
      where: { ...bucket, reason: { startsWith: 'Interbranch transfer line ' } },
      select,
    }),
    db.pharmacyStockMovement.findMany({
      where: {
        ...bucket,
        kind: 'WRITE_OFF',
        idempotencyKey: { startsWith: TRANSFER_VARIANCE_KEY_PREFIX },
      },
      select,
    }),
  ]);
  const attributedLines = new Set(
    lineMovements
      .filter((movement) => movement.kind === 'TRANSFER_IN')
      .map((movement) => movement.reason)
  );
  // Variance write-offs carry the operator's reason, not the line reason; the
  // line is the last segment of their per-line idempotency key.
  const owned = [
    ...lineMovements.map((movement) => ({ owner: movement.reason, movement })),
    ...varianceMovements.map((movement) => ({
      owner: transferLineTransitReason(movement.idempotencyKey.split(':').pop() ?? ''),
      movement,
    })),
  ];
  const reason = transferLineTransitReason(input.lineId);
  const attributed = attributedLines.has(reason);
  return owned.reduce(
    (total, { owner, movement }) => {
      if (attributed ? owner === reason : attributedLines.has(owner)) {
        const sign = attributed ? 1 : -1;
        total.sealedPacks += sign * movement.sealedPackDelta;
        total.looseUnits += sign * movement.looseUnitDelta;
      }
      return total;
    },
    attributed
      ? { sealedPacks: 0, looseUnits: 0 }
      : {
          sealedPacks: Number(input.transit.sealedPacks),
          looseUnits: Number(input.transit.looseUnits),
        }
  );
}

export async function receiveTransferLine(
  db: ScopedDb,
  scope: LedgerScope,
  input: { transferId: string; lineId: string; receivedUnits: number; idempotencyKeyPrefix: string }
) {
  assertPositive(input.receivedUnits);
  // Keep the remaining line quantity and its packaging stable across receipts.
  const [lockedTransfer] = await db.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM "pharmacy_interbranch_transfers" WHERE id=${input.transferId} AND "organizationId"=${scope.organizationId} AND "toBranchId"=${scope.branchId} FOR UPDATE`
  );
  if (!lockedTransfer) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
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
    where: {
      id: line.sourceLotId,
      organizationId: scope.organizationId,
      branchId: transfer.fromBranchId,
    },
    include: { batch: true },
  });
  const [transit] = await db.$queryRaw<
    Array<{ onHandUnits: number; sealedPacks: number; looseUnits: number }>
  >(
    Prisma.sql`SELECT "onHandUnits", "sealedPacks", "looseUnits" FROM "pharmacy_stock_balances" WHERE "organizationId"=${scope.organizationId} AND "branchId"=${transfer.fromBranchId} AND "inventoryLotId"=${source.id} AND "stockLocationId"=${line.sourceStockLocationId} AND disposition='IN_TRANSIT' FOR UPDATE`
  );
  if (!transit || transit.onHandUnits < input.receivedUnits)
    throw new PharmacyInventoryError('INSUFFICIENT_STOCK');

  const reason = transferLineTransitReason(line.id);
  const remaining = await transitPackagingForLine(db, {
    organizationId: scope.organizationId,
    fromBranchId: transfer.fromBranchId,
    inventoryLotId: source.id,
    stockLocationId: line.sourceStockLocationId,
    lineId: line.id,
    transit,
  });
  const a = planRemovalArrangement({
    ...remaining,
    unitsPerPack: source.unitsPerPack,
    quantityUnits: input.receivedUnits,
  });
  const transitScope = {
    organizationId: scope.organizationId,
    branchId: transfer.fromBranchId,
    inventoryLotId: source.id,
    stockLocationId: line.sourceStockLocationId,
    disposition: 'IN_TRANSIT' as const,
    actorId: scope.actorId,
    reason,
  };
  if (a.breakPack.packsToBreak > 0) {
    await db.pharmacyStockMovement.create({
      data: {
        ...transitScope,
        kind: 'BREAK_PACK',
        quantityUnits: 0,
        sealedPackDelta: a.breakPack.sealedPackDelta,
        looseUnitDelta: a.breakPack.looseUnitDelta,
        idempotencyKey: `${input.idempotencyKeyPrefix}:transit-break-pack`,
      },
    });
  }
  await db.pharmacyStockMovement.create({
    data: {
      ...transitScope,
      kind: 'TRANSFER_OUT',
      quantityUnits: -input.receivedUnits,
      sealedPackDelta: -a.sealedPacks,
      looseUnitDelta: -a.looseUnits,
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
  await db.pharmacyStockMovement.create({
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

export async function recallTrace(db: ScopedDb, organizationId: string, recallNoticeId: string) {
  const notice = await db.pharmacyRecallNotice.findFirst({
    where: { id: recallNoticeId, organizationId },
  });
  if (!notice) throw new PharmacyInventoryError('NOT_FOUND');
  return db.$queryRaw<
    Array<{
      branchId: string;
      inventoryLotId: string;
      disposition: string;
      units: number;
      soldUnits: number;
    }>
  >(
    Prisma.sql`SELECT l."branchId",l.id AS "inventoryLotId",b.disposition::text,SUM(b."onHandUnits")::int AS units,COALESCE((SELECT -SUM(m."quantityUnits") FROM "pharmacy_stock_movements" m WHERE m."organizationId"=l."organizationId" AND m."inventoryLotId"=l.id AND m.kind='SALE'),0)::int AS "soldUnits" FROM "pharmacy_inventory_lots" l JOIN "pharmacy_manufacturing_batches" mb ON mb.id=l."manufacturingBatchId" JOIN "pharmacy_stock_balances" b ON b."inventoryLotId"=l.id AND b."organizationId"=l."organizationId" WHERE l."organizationId"=${organizationId} AND (${notice.batchId}::text IS NULL OR mb.id=${notice.batchId}) AND (${notice.medicineId}::text IS NULL OR mb."medicineId"=${notice.medicineId}) GROUP BY l."organizationId",l."branchId",l.id,b.disposition`
  );
}

export async function acknowledgeRecall(db: ScopedDb, scope: LedgerScope, noticeId: string) {
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
  await lockRecallAuthority(db, scope.organizationId);
  const notice = await db.pharmacyRecallNotice.findFirst({
    where: { id: noticeId, organizationId: scope.organizationId },
    include: { acknowledgements: true },
  });
  if (!notice || !notice.acknowledgements.length) throw new PharmacyInventoryError('INVALID_STATE');
  await releaseRecallBatches(db, scope.organizationId, notice);
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
  // The caller must keep this lock and the check/create below in one transaction.
  const locked = await db.$queryRaw<Array<{ onHandUnits: number }>>(Prisma.sql`
    SELECT "onHandUnits" FROM "pharmacy_stock_balances"
    WHERE "organizationId" = ${scope.organizationId}
      AND "branchId" = ${scope.branchId}
      AND "inventoryLotId" = ${input.inventoryLotId}
      AND "disposition" = 'AVAILABLE'
    ORDER BY "stockLocationId" ASC
    FOR UPDATE
  `);
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

// ── WHA-1603 / INV-07 closing receipt with variance ─────────────────────────

const RECEIVABLE_TRANSFER_STATUSES = ['DISPATCHED', 'PARTIALLY_RECEIVED', 'EXCEPTION'];

export type VarianceReceiptInput = {
  transferId: string;
  lines: ReadonlyArray<{ lineId: string; receivedUnits: number }>;
  variance?: { reason: string; witnessId: string; evidenceRef: string };
  idempotencyKeyPrefix: string;
};

/** Packaging of one transfer line held in its source branch's IN_TRANSIT bucket. */
function lineTransitPackaging(
  db: ScopedDb,
  scope: LedgerScope,
  fromBranchId: string,
  line: { id: string; sourceLotId: string; sourceStockLocationId: string },
  transit: { sealedPacks: number; looseUnits: number }
) {
  return transitPackagingForLine(db, {
    organizationId: scope.organizationId,
    fromBranchId,
    inventoryLotId: line.sourceLotId,
    stockLocationId: line.sourceStockLocationId,
    lineId: line.id,
    transit,
  });
}

/**
 * The closing receipt of a transfer. Every open line is answered with what
 * physically arrived; what did not is written off out of IN_TRANSIT at the
 * source branch, where dispatch left it. The transfer then closes RECEIVED, so
 * the line-by-line receipt path can never draw written-off units back out of
 * transit. Runs inside the caller's transaction.
 */
export async function receiveTransferWithVariance(
  db: ScopedDb,
  scope: LedgerScope,
  input: VarianceReceiptInput
) {
  // Serialize receipts of one transfer: the outstanding balances read below
  // must be the ones the postings land on.
  const locked = await db.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM "pharmacy_interbranch_transfers" WHERE "organizationId"=${scope.organizationId} AND id=${input.transferId} AND "toBranchId"=${scope.branchId} FOR UPDATE`
  );
  const transfer = locked[0]
    ? await db.pharmacyInterbranchTransfer.findFirst({
        where: {
          id: input.transferId,
          organizationId: scope.organizationId,
          toBranchId: scope.branchId,
        },
        include: { lines: true },
      })
    : null;
  if (!transfer) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  if (!RECEIVABLE_TRANSFER_STATUSES.includes(transfer.status))
    throw new PharmacyInventoryError('INVALID_STATE');

  const answered = new Map(input.lines.map((line) => [line.lineId, line.receivedUnits]));
  if (answered.size !== input.lines.length) throw new PharmacyInventoryError('INVALID_UNITS');
  for (const [lineId, units] of answered) {
    const line = transfer.lines.find((one) => one.id === lineId);
    if (!line) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
    if (
      !Number.isSafeInteger(units) ||
      units < 0 ||
      units > line.quantityUnits - line.receivedUnits
    )
      throw new PharmacyInventoryError('INVALID_UNITS');
  }
  const open = transfer.lines.filter((line) => line.receivedUnits < line.quantityUnits);
  // A closing receipt answers every open line; silence is not a count.
  if (open.some((line) => !answered.has(line.id)))
    throw new PharmacyInventoryError('INVALID_UNITS');

  const plan = [];
  for (const line of open) {
    const receivedUnits = answered.get(line.id)!;
    const outstanding = line.quantityUnits - line.receivedUnits;
    const balances = await db.$queryRaw<
      Array<{ onHandUnits: number; sealedPacks: number; looseUnits: number; unitsPerPack: number }>
    >(
      Prisma.sql`SELECT b."onHandUnits",b."sealedPacks",b."looseUnits",l."unitsPerPack" FROM "pharmacy_stock_balances" b JOIN "pharmacy_inventory_lots" l ON l.id=b."inventoryLotId" WHERE b."organizationId"=${scope.organizationId} AND b."branchId"=${transfer.fromBranchId} AND b."inventoryLotId"=${line.sourceLotId} AND b."stockLocationId"=${line.sourceStockLocationId} AND b."disposition"='IN_TRANSIT' FOR UPDATE OF b`
    );
    const transit = balances[0];
    if (!transit || Number(transit.onHandUnits) < outstanding)
      throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
    const unitsPerPack = Number(transit.unitsPerPack);
    // Plan against the packaging this line actually shipped (or, for legacy
    // dispatches, what is not owed to attributed shipments), never the whole
    // shared bucket: the receipt leg and the variance must not consume another
    // shipment's sealed packs or loose units.
    const varianceUnits = outstanding - receivedUnits;
    const owned = await lineTransitPackaging(db, scope, transfer.fromBranchId, line, transit);
    try {
      const receipt = planRemovalArrangement({
        ...owned,
        unitsPerPack,
        quantityUnits: receivedUnits,
      });
      planRemovalArrangement({
        sealedPacks: owned.sealedPacks + receipt.breakPack.sealedPackDelta - receipt.sealedPacks,
        looseUnits: owned.looseUnits + receipt.breakPack.looseUnitDelta - receipt.looseUnits,
        unitsPerPack,
        quantityUnits: varianceUnits,
      });
    } catch (error) {
      if (error instanceof PharmacyInventoryError)
        throw new PharmacyInventoryError('INVALID_ARRANGEMENT');
      throw error;
    }
    plan.push({ line, receivedUnits, varianceUnits, unitsPerPack });
  }

  const short = plan.some((step) => step.varianceUnits > 0);
  if (short) {
    const evidence = input.variance;
    if (!evidence || evidence.witnessId === scope.actorId)
      throw new PharmacyInventoryError('COAUTH_REQUIRED');
    const witness = await db.user.findFirst({
      where: { id: evidence.witnessId, organizationId: scope.organizationId, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!witness) throw new PharmacyInventoryError('COAUTH_REQUIRED');
  }

  const postedVariances = [];
  for (const step of plan) {
    if (step.receivedUnits > 0) {
      await receiveTransferLine(db, scope, {
        transferId: transfer.id,
        lineId: step.line.id,
        receivedUnits: step.receivedUnits,
        idempotencyKeyPrefix: `${input.idempotencyKeyPrefix}:${step.line.id}`,
      });
    }
    if (step.varianceUnits === 0) continue;
    const evidence = input.variance!;
    // Re-read after the receipt leg posted: the variance takes what this line
    // still owns, breaking one of its own packs when the loss is not whole packs.
    const [transitNow] = await db.$queryRaw<Array<{ sealedPacks: number; looseUnits: number }>>(
      Prisma.sql`SELECT "sealedPacks","looseUnits" FROM "pharmacy_stock_balances" WHERE "organizationId"=${scope.organizationId} AND "branchId"=${transfer.fromBranchId} AND "inventoryLotId"=${step.line.sourceLotId} AND "stockLocationId"=${step.line.sourceStockLocationId} AND disposition='IN_TRANSIT' FOR UPDATE`
    );
    if (!transitNow) throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
    const owned = await lineTransitPackaging(
      db,
      scope,
      transfer.fromBranchId,
      step.line,
      transitNow
    );
    const variance = planRemovalArrangement({
      ...owned,
      unitsPerPack: step.unitsPerPack,
      quantityUnits: step.varianceUnits,
    });
    if (variance.breakPack.packsToBreak > 0) {
      await db.pharmacyStockMovement.create({
        data: {
          organizationId: scope.organizationId,
          branchId: transfer.fromBranchId,
          inventoryLotId: step.line.sourceLotId,
          stockLocationId: step.line.sourceStockLocationId,
          kind: 'BREAK_PACK',
          disposition: 'IN_TRANSIT',
          quantityUnits: 0,
          sealedPackDelta: variance.breakPack.sealedPackDelta,
          looseUnitDelta: variance.breakPack.looseUnitDelta,
          actorId: scope.actorId,
          reason: transferLineTransitReason(step.line.id),
          idempotencyKey: `${input.idempotencyKeyPrefix}:${step.line.id}:variance-break-pack`,
        },
      });
    }
    const movement = await db.pharmacyStockMovement.create({
      data: {
        organizationId: scope.organizationId,
        branchId: transfer.fromBranchId,
        inventoryLotId: step.line.sourceLotId,
        stockLocationId: step.line.sourceStockLocationId,
        kind: 'WRITE_OFF',
        disposition: 'IN_TRANSIT',
        quantityUnits: -step.varianceUnits,
        sealedPackDelta: -variance.sealedPacks,
        looseUnitDelta: -variance.looseUnits,
        actorId: scope.actorId,
        reason: `Transfer ${transfer.id} receipt variance: ${evidence.reason}`,
        idempotencyKey: transferVarianceKey(transfer.id, step.line.id),
      },
    });
    const custody = await db.pharmacyCustodyRecord.create({
      data: {
        organizationId: scope.organizationId,
        branchId: transfer.fromBranchId,
        movementId: movement.id,
        actorId: scope.actorId,
        witnessId: evidence.witnessId,
        reason: evidence.reason,
        evidenceRef: evidence.evidenceRef,
      },
    });
    postedVariances.push({ lineId: step.line.id, units: step.varianceUnits, movement, custody });
  }

  const closed = await db.pharmacyInterbranchTransfer.update({
    where: { id: transfer.id },
    data: { status: 'RECEIVED', receivedAt: new Date() },
  });
  return { transfer: closed, variances: postedVariances };
}
