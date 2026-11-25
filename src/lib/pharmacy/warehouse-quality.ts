import { assertControlledWarehouseStorage } from './warehouse-controlled-storage';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { PharmacyInventoryError } from './inventory';
import { quarantinePart, releaseQuarantinedPart, recallTrace } from './inventory-operations';
import {
  assertWarehouseScans,
  lockWarehouseQuality,
  releaseWarehouseReservationsForHold,
} from './warehouse-outbound';
import type { LedgerScope } from './stock-ledger';
import { lockStockBalances, lockStockRowsFrom } from './stock-lock-order';
import { hasKnownExpiryPassed } from './unrecorded-batch';

export type TransportEvidence = {
  minimumC?: number | null;
  maximumC?: number | null;
  evidenceRef: string;
};
type MedicineConditions = {
  coldChain: boolean;
  minimumStorageTemperatureC: number | null;
  maximumStorageTemperatureC: number | null;
};
type Zone = {
  active: boolean;
  coldChain: boolean;
  minimumTemperatureC: number | null;
  maximumTemperatureC: number | null;
  expectedTemperatureReadingIntervalMinutes: number;
};
const conditions = {
  productFamily: true,
  controlled: true,
  coldChain: true,
  minimumStorageTemperatureC: true,
  maximumStorageTemperatureC: true,
} as const;
const monitored = (medicine: MedicineConditions) =>
  medicine.coldChain || medicine.minimumStorageTemperatureC !== null;

function warehouseExpiryBlocked(
  batch: { expiresAt: Date | null; medicine: { productFamily: string } },
  at = new Date()
) {
  return (
    (!batch.expiresAt && batch.medicine.productFamily !== 'FRONT_SHOP') ||
    hasKnownExpiryPassed(batch.expiresAt, at)
  );
}

function assertEnvelope(input: TransportEvidence) {
  const { minimumC, maximumC } = input;
  if (
    !input.evidenceRef.trim() ||
    (minimumC == null) !== (maximumC == null) ||
    (minimumC != null &&
      maximumC != null &&
      (!Number.isFinite(minimumC) ||
        !Number.isFinite(maximumC) ||
        minimumC < -100 ||
        maximumC > 100 ||
        minimumC > maximumC))
  ) {
    throw new PharmacyInventoryError('INVALID_STATE');
  }
}

export function warehouseTransportReason(
  medicine: MedicineConditions,
  evidence?: Pick<TransportEvidence, 'minimumC' | 'maximumC'> | null
) {
  if (!monitored(medicine)) return null;
  if (medicine.minimumStorageTemperatureC == null || medicine.maximumStorageTemperatureC == null)
    return 'Product label temperature range is missing.';
  if (evidence?.minimumC == null || evidence.maximumC == null)
    return 'Required temperature evidence is missing.';
  return evidence.minimumC < medicine.minimumStorageTemperatureC ||
    evidence.maximumC > medicine.maximumStorageTemperatureC
    ? 'Temperature exceeded the labelled product range.'
    : null;
}

export function warehouseZoneReason(
  medicine: MedicineConditions,
  zone: Zone,
  reading?: { recordedAt: Date; temperatureC: number } | null,
  at = new Date()
) {
  if (!zone.active) return 'The stock location is inactive.';
  if (!monitored(medicine)) return null;
  if (
    (medicine.coldChain && !zone.coldChain) ||
    zone.minimumTemperatureC == null ||
    zone.maximumTemperatureC == null
  )
    return 'The zone is not validated for this product.';
  const rangeReason = warehouseTransportReason(medicine, {
    minimumC: zone.minimumTemperatureC,
    maximumC: zone.maximumTemperatureC,
  });
  if (rangeReason) return 'The zone limits do not meet the labelled product range.';
  if (
    !reading ||
    +reading.recordedAt > +at ||
    +at - +reading.recordedAt > zone.expectedTemperatureReadingIntervalMinutes * 60_000
  )
    return 'A current zone temperature reading is missing.';
  return warehouseTransportReason(medicine, {
    minimumC: reading.temperatureC,
    maximumC: reading.temperatureC,
  });
}

async function zoneReason(
  db: ScopedDb,
  scope: LedgerScope,
  medicine: MedicineConditions,
  id: string,
  at = new Date()
) {
  const zone = await db.pharmacyStockLocation.findFirst({
    where: { id, organizationId: scope.organizationId, branchId: scope.branchId },
  });
  if (!zone) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  const reading = monitored(medicine)
    ? await db.pharmacyTemperatureLog.findFirst({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          stockLocationId: id,
          recordedAt: { lte: at },
        },
        orderBy: { recordedAt: 'desc' },
      })
    : null;
  return warehouseZoneReason(medicine, zone, reading, at);
}

async function scopedLot(db: ScopedDb, scope: LedgerScope, id: string) {
  const lot = await db.pharmacyInventoryLot.findFirst({
    where: { id, organizationId: scope.organizationId, branchId: scope.branchId },
    include: {
      batch: { include: { medicine: { select: conditions } } },
      packLevel: { select: { presentationId: true } },
    },
  });
  if (!lot) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  return lot;
}

export async function warehouseStockQualityReason(
  db: ScopedDb,
  scope: LedgerScope,
  inventoryLotId: string,
  stockLocationIds: readonly string[],
  at = new Date(),
  transferId?: string
) {
  const lot = await scopedLot(db, scope, inventoryLotId);
  if (lot.batch.state !== 'ACTIVE') return 'The manufacturing batch is on hold or recalled.';
  if (warehouseExpiryBlocked(lot.batch, at)) return 'The batch expiry is missing or has passed.';
  const ids = [...new Set(stockLocationIds)];
  const incident = await db.pharmacyWarehouseQualityIncident.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId,
      stockLocationId: { in: ids },
      // Physically segregated quantity is already excluded from sale and picking by the ledger.
      // A still-reserved transport lot follows its own shipment, not other orders sharing this bin.
      quarantineUnits: 0,
      NOT: { sourceKey: { startsWith: 'damage:' } },
      OR: transferId ? [{ transferId: null }, { transferId }] : [{ transferId: null }],
      status: { not: 'RELEASE' },
    },
  });
  if (incident) return incident.reason;
  for (const id of ids) {
    const reason = await zoneReason(db, scope, lot.batch.medicine, id, at);
    if (reason) return reason;
  }
  return null;
}

type IncidentInput = {
  inventoryLotId: string;
  stockLocationId: string;
  transferId?: string;
  quantityUnits: number;
  quarantineUnits?: number;
  reason: string;
  sourceKey: string;
};
export async function openWarehouseIncident(
  db: ScopedDb,
  scope: LedgerScope,
  input: IncidentInput
) {
  return db.pharmacyWarehouseQualityIncident.upsert({
    where: {
      organizationId_inventoryLotId_stockLocationId_sourceKey: {
        organizationId: scope.organizationId,
        inventoryLotId: input.inventoryLotId,
        stockLocationId: input.stockLocationId,
        sourceKey: input.sourceKey,
      },
    },
    update: {},
    create: {
      ...input,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      createdById: scope.actorId,
    },
  });
}

async function latestDispatchEvidence(db: ScopedDb, organizationId: string, transferId: string) {
  return db.pharmacyWarehouseTransportEvidence.findFirst({
    where: { organizationId, transferId, phase: 'DISPATCH' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
}

export async function warehouseDispatchQualityReason(
  db: ScopedDb,
  scope: LedgerScope,
  transferId: string,
  inventoryLotId: string,
  stockLocationId: string
) {
  const lot = await scopedLot(db, scope, inventoryLotId);
  return (
    (await warehouseStockQualityReason(
      db,
      scope,
      inventoryLotId,
      [stockLocationId],
      new Date(),
      transferId
    )) ||
    warehouseTransportReason(
      lot.batch.medicine,
      await latestDispatchEvidence(db, scope.organizationId, transferId)
    )
  );
}

async function dispatchIncidents(
  db: ScopedDb,
  scope: LedgerScope,
  transferId: string,
  evidence: TransportEvidence | null,
  sourceKey: string
) {
  const reservations = await db.pharmacyWarehouseReservation.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      transferId,
      state: { in: ['RESERVED', 'PICKED', 'PACKED'] },
    },
  });
  let blocked = false;
  for (const reservation of reservations) {
    const lot = await scopedLot(db, scope, reservation.inventoryLotId);
    const reason = warehouseTransportReason(lot.batch.medicine, evidence);
    if (!reason) continue;
    blocked = true;
    const incident = await openWarehouseIncident(db, scope, {
      inventoryLotId: lot.id,
      stockLocationId: reservation.stagingStockLocationId ?? reservation.sourceStockLocationId,
      transferId,
      quantityUnits: reservation.quantityUnits,
      reason,
      sourceKey: sourceKey + ':' + reservation.id,
    });
    const quantity = await releaseWarehouseReservationsForHold(db, scope, {
      inventoryLotId: lot.id,
      stockLocationId: incident.stockLocationId,
      transferId,
      reservationId: reservation.id,
      reason,
      sourceKey: incident.sourceKey,
      qualityIncidentId: incident.id,
    });
    if (quantity)
      await db.pharmacyWarehouseQualityIncident.update({
        where: { id: incident.id },
        data: { quarantineUnits: quantity },
      });
  }
  return blocked;
}

export async function noteMissingWarehouseDispatchEvidence(
  db: ScopedDb,
  scope: LedgerScope,
  transferId: string
) {
  await lockWarehouseQuality(db, scope.organizationId, true);
  if (await latestDispatchEvidence(db, scope.organizationId, transferId)) return false;
  return dispatchIncidents(db, scope, transferId, null, 'missing-dispatch:' + transferId);
}

export async function recordWarehouseDispatchEvidence(
  db: ScopedDb,
  scope: LedgerScope,
  input: TransportEvidence & { transferId: string; requestKey: string }
) {
  assertEnvelope(input);
  await lockWarehouseQuality(db, scope.organizationId, true);
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_interbranch_transfers WHERE "organizationId"=${scope.organizationId} AND "fromBranchId"=${scope.branchId} AND id=${input.transferId} FOR UPDATE`
  );
  const prior = await db.pharmacyWarehouseTransportEvidence.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      phase: 'DISPATCH',
      requestKey: input.requestKey,
    },
  });
  if (prior) {
    if (
      prior.transferId !== input.transferId ||
      prior.minimumC !== (input.minimumC ?? null) ||
      prior.maximumC !== (input.maximumC ?? null) ||
      prior.evidenceRef !== input.evidenceRef.trim()
    )
      throw new PharmacyInventoryError('INVALID_STATE');
    return prior;
  }
  const transfer = await db.pharmacyInterbranchTransfer.findFirst({
    where: {
      id: input.transferId,
      organizationId: scope.organizationId,
      fromBranchId: scope.branchId,
      status: { in: ['APPROVED', 'ALLOCATED'] },
    },
  });
  if (
    !transfer ||
    !(await db.pharmacyWarehouseReservation.count({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        transferId: transfer.id,
      },
    }))
  )
    throw new PharmacyInventoryError('INVALID_STATE');
  const row = await db.pharmacyWarehouseTransportEvidence.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      phase: 'DISPATCH',
      transferId: transfer.id,
      minimumC: input.minimumC,
      maximumC: input.maximumC,
      evidenceRef: input.evidenceRef.trim(),
      actorId: scope.actorId,
      requestKey: input.requestKey,
    },
  });
  await dispatchIncidents(db, scope, transfer.id, input, 'dispatch:' + row.id);
  return row;
}

export async function listWarehouseQuality(db: ScopedDb, scope: LedgerScope) {
  return db.$queryRaw<
    Array<{
      id: string;
      branchId: string;
      inventoryLotId: string;
      stockLocationId: string;
      transferId: string | null;
      quantityUnits: number;
      reason: string;
      status: string;
      createdAt: Date;
      reviewReason: string | null;
      reviewEvidenceRef: string | null;
      productName: string;
      batchNumber: string | null;
      binCode: string;
      requiresReleaseBin: boolean;
    }>
  >(Prisma.sql`
    SELECT q.*,m."productName",b."batchNumber",z.code AS "binCode",
    (q."quarantineUnits" > 0 AND (NOT z.active OR z."warehouseStaging" OR z.kind NOT IN ('STORE','RACK_BIN','FRIDGE','SAFE')
      OR (m.controlled AND z.kind <> 'SAFE') OR (m."coldChain" AND NOT z."coldChain") OR
      (m."minimumStorageTemperatureC" IS NOT NULL AND (z."minimumTemperatureC" IS NULL OR z."maximumTemperatureC" IS NULL
        OR z."minimumTemperatureC"<m."minimumStorageTemperatureC" OR z."maximumTemperatureC">m."maximumStorageTemperatureC")))) AS "requiresReleaseBin" FROM pharmacy_warehouse_quality_incidents q
    JOIN pharmacy_inventory_lots l ON l.id=q."inventoryLotId" AND l."organizationId"=q."organizationId"
    JOIN pharmacy_manufacturing_batches b ON b.id=l."manufacturingBatchId" AND b."organizationId"=q."organizationId"
    JOIN pharmacy_medicines m ON m.id=b."medicineId" AND m."organizationId"=q."organizationId"
    JOIN pharmacy_stock_locations z ON z.id=q."stockLocationId" AND z."organizationId"=q."organizationId"
    WHERE q."organizationId"=${scope.organizationId} AND q."branchId"=${scope.branchId}
    ORDER BY (q.status='OPEN') DESC,q."createdAt" DESC,q.id`);
}

export async function reviewWarehouseQuality(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    incidentId: string;
    decision: 'RELEASE' | 'RETURN' | 'DISPOSE';
    reason: string;
    evidenceRef: string;
    destinationBinCode?: string;
  }
) {
  if (!input.reason.trim() || !input.evidenceRef.trim())
    throw new PharmacyInventoryError('INVALID_STATE');
  await lockWarehouseQuality(db, scope.organizationId, true);
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_warehouse_quality_incidents WHERE id=${input.incidentId} AND "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId} FOR UPDATE`
  );
  const item = await db.pharmacyWarehouseQualityIncident.findFirst({
    where: { id: input.incidentId, organizationId: scope.organizationId, branchId: scope.branchId },
  });
  if (!item) throw new PharmacyInventoryError('NOT_FOUND');
  if (item.status !== 'OPEN') {
    if (
      item.status === input.decision &&
      item.reviewReason === input.reason.trim() &&
      item.reviewEvidenceRef === input.evidenceRef.trim()
    ) {
      if (input.decision === 'RELEASE' && item.quarantineUnits) {
        const posted = await db.pharmacyStockMovement.findFirst({
          where: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            idempotencyKey: 'warehouse-quality-release:' + item.id + ':in',
          },
          select: { stockLocationId: true, location: { select: { code: true } } },
        });
        if (
          !posted ||
          (input.destinationBinCode
            ? posted.location.code !== input.destinationBinCode.trim()
            : posted.stockLocationId !== item.stockLocationId)
        )
          throw new PharmacyInventoryError('INVALID_STATE');
      }
      return item;
    }
    throw new PharmacyInventoryError('INVALID_STATE');
  }
  await lockStockRowsFrom(
    db,
    scope.organizationId,
    Prisma.sql`SELECT "manufacturingBatchId" AS "batchId",id AS "inventoryLotId" FROM pharmacy_inventory_lots WHERE id=${item.inventoryLotId} AND "organizationId"=${scope.organizationId}`,
    { batch: 'share', lot: 'update' }
  );
  const lot = await scopedLot(db, scope, item.inventoryLotId);
  let releaseLocationId = item.stockLocationId;
  if (input.decision === 'RELEASE') {
    if (item.quarantineUnits) {
      const destination = await db.pharmacyStockLocation.findFirst({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          active: true,
          ...(input.destinationBinCode
            ? { code: input.destinationBinCode.trim() }
            : { id: item.stockLocationId }),
        },
      });
      if (
        !destination ||
        destination.warehouseStaging ||
        !['STORE', 'RACK_BIN', 'FRIDGE', 'SAFE'].includes(destination.kind)
      )
        throw new PharmacyInventoryError(
          'BLOCKED_STOCK',
          'Scan an active storage bin for the released stock.'
        );
      if (lot.batch.medicine.controlled) {
        await assertControlledWarehouseStorage(
          db,
          scope,
          destination.kind,
          'warehouse.controlledQualityRelease'
        );
      }
      releaseLocationId = destination.id;
    }
    if (
      item.sourceKey.startsWith('damage:') ||
      lot.batch.state !== 'ACTIVE' ||
      warehouseExpiryBlocked(lot.batch) ||
      (await zoneReason(db, scope, lot.batch.medicine, releaseLocationId))
    )
      throw new PharmacyInventoryError('BLOCKED_STOCK');
    if (
      item.quarantineUnits === 0 &&
      item.sourceKey.includes('dispatch:') &&
      warehouseTransportReason(
        lot.batch.medicine,
        await latestDispatchEvidence(db, scope.organizationId, item.transferId!)
      )
    )
      throw new PharmacyInventoryError('BLOCKED_STOCK');
  }
  let quarantineUnits = item.quarantineUnits;
  if (input.decision !== 'RELEASE' && item.sourceKey.endsWith(':WAREHOUSE_RECEIVING')) {
    const stock = { inventoryLotId: item.inventoryLotId, stockLocationId: item.stockLocationId };
    await lockStockBalances(
      db,
      scope,
      ['WAREHOUSE_RECEIVING', 'QUARANTINE'].map((disposition) => ({ ...stock, disposition }))
    );
    const receiving = await db.pharmacyStockBalance.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        ...stock,
        disposition: 'WAREHOUSE_RECEIVING',
      },
    });
    if (!receiving || receiving.onHandUnits !== item.quantityUnits)
      throw new PharmacyInventoryError('INVALID_STATE');
    const common = {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      actorId: scope.actorId,
      ...stock,
      kind: 'ADJUSTMENT' as const,
      reason: input.reason,
    };
    await db.pharmacyStockMovement.create({
      data: {
        ...common,
        disposition: 'WAREHOUSE_RECEIVING',
        quantityUnits: -receiving.onHandUnits,
        sealedPackDelta: -receiving.sealedPacks,
        looseUnitDelta: -receiving.looseUnits,
        idempotencyKey: 'wh-quality-receiving:' + item.id + ':out',
      },
    });
    await db.pharmacyStockMovement.create({
      data: {
        ...common,
        disposition: 'QUARANTINE',
        quantityUnits: receiving.onHandUnits,
        sealedPackDelta: receiving.sealedPacks,
        looseUnitDelta: receiving.looseUnits,
        idempotencyKey: 'wh-quality-receiving:' + item.id + ':in',
      },
    });
    quarantineUnits = receiving.onHandUnits;
  }
  const updated = await db.pharmacyWarehouseQualityIncident.update({
    where: { id: item.id },
    data: {
      status: input.decision,
      quarantineUnits,
      reviewedAt: new Date(),
      reviewedById: scope.actorId,
      reviewEvidenceRef: input.evidenceRef.trim(),
      reviewReason: input.reason.trim(),
    },
  });
  if (input.decision === 'RELEASE' && item.quarantineUnits) {
    await releaseQuarantinedPart(db, scope, {
      inventoryLotId: item.inventoryLotId,
      stockLocationId: item.stockLocationId,
      destinationStockLocationId: releaseLocationId,
      units: item.quarantineUnits,
      reason: input.reason,
      idempotencyKeyPrefix: 'warehouse-quality-release:' + item.id,
    });
  }
  return updated;
}

export type WarehouseReceiptInput = {
  transferId: string;
  lineId: string;
  receivedUnits: number;
  idempotencyKeyPrefix: string;
  damagedUnits?: number;
  productScan?: string;
  lotScan?: string;
  binScan?: string;
  transportEvidence?: TransportEvidence;
};

export async function isWarehouseTransfer(
  db: ScopedDb,
  organizationId: string,
  transferId: string,
  destinationBranchId: string
) {
  const [reservation, destination] = await Promise.all([
    db.pharmacyWarehouseReservation.findFirst({
      where: { organizationId, transferId },
      select: { id: true },
    }),
    db.pharmacyBranch.findFirst({
      where: { organizationId, id: destinationBranchId },
      select: { warehouseEnabled: true },
    }),
  ]);
  return Boolean(reservation || destination?.warehouseEnabled);
}

/** Used only by verified warehouse receipts. Legacy retail transfers keep their own entry path. */
export async function receiveWarehouseTransferLine(
  db: ScopedDb,
  scope: LedgerScope,
  input: WarehouseReceiptInput
) {
  const { postInterbranchTransferReceiptEntry } = await import('./finance-postings');
  const { arrangementFor } = await import('./inventory');
  await lockWarehouseQuality(db, scope.organizationId, false);
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM pharmacy_interbranch_transfers WHERE "organizationId"=${scope.organizationId} AND "toBranchId"=${scope.branchId} AND id=${input.transferId} FOR UPDATE`
  );
  const transfer = await db.pharmacyInterbranchTransfer.findFirst({
    where: {
      organizationId: scope.organizationId,
      id: input.transferId,
      toBranchId: scope.branchId,
    },
    include: { lines: true },
  });
  const reservations = await db.pharmacyWarehouseReservation.findMany({
    where: { organizationId: scope.organizationId, transferId: input.transferId },
    select: { transferLineId: true, state: true },
  });
  const dispatchedIds = new Set(
    reservations.filter((r) => r.state === 'DISPATCHED').map((r) => r.transferLineId)
  );
  const manifest = reservations.length
    ? transfer?.lines.filter((l) => dispatchedIds.has(l.id))
    : transfer?.lines;
  const line = manifest?.find((l) => l.id === input.lineId);
  if (!transfer || !line) throw new PharmacyInventoryError('CROSS_BRANCH_REFERENCE');
  const damaged = input.damagedUnits ?? 0;
  const evidence = input.transportEvidence;
  if (evidence) assertEnvelope(evidence);
  const evidenceData = {
    minimumC: evidence?.minimumC ?? null,
    maximumC: evidence?.maximumC ?? null,
    evidenceRef: evidence?.evidenceRef.trim() ?? null,
    receivedUnits: input.receivedUnits,
    damagedUnits: damaged,
    productScan: input.productScan?.trim() ?? null,
    lotScan: input.lotScan?.trim() ?? null,
    binScan: input.binScan?.trim() ?? null,
  };
  const prior = await db.pharmacyWarehouseTransportEvidence.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      phase: 'RECEIPT',
      requestKey: input.idempotencyKeyPrefix,
    },
  });
  if (prior) {
    if (
      prior.transferId !== transfer.id ||
      prior.transferLineId !== line.id ||
      Object.entries(evidenceData).some(([key, v]) => prior[key as keyof typeof prior] !== v)
    )
      throw new PharmacyInventoryError('INVALID_STATE');
    return transfer;
  }
  const qty = input.receivedUnits;
  if (!['DISPATCHED', 'PARTIALLY_RECEIVED', 'EXCEPTION'].includes(transfer.status))
    throw new PharmacyInventoryError('INVALID_STATE');
  if (
    !Number.isSafeInteger(qty) ||
    qty < 0 ||
    line.receivedUnits === line.quantityUnits ||
    qty > line.quantityUnits - line.receivedUnits ||
    !Number.isSafeInteger(damaged) ||
    damaged < 0 ||
    damaged > qty
  )
    throw new PharmacyInventoryError('INVALID_UNITS');
  const shortage = line.quantityUnits - line.receivedUnits - qty;
  const sourceScope = { ...scope, branchId: transfer.fromBranchId };
  let held = 0;
  let destinationLotId: string | null = null;
  if (qty > 0) {
    await lockStockRowsFrom(
      db,
      scope.organizationId,
      Prisma.sql`
      SELECT "manufacturingBatchId" AS "batchId",id AS "inventoryLotId" FROM pharmacy_inventory_lots WHERE "organizationId"=${scope.organizationId} AND id=${line.sourceLotId}
    `,
      { batch: 'share', lot: 'share' }
    );
    const source = await scopedLot(db, sourceScope, line.sourceLotId);
    const destination = await db.pharmacyStockLocation.findFirst({
      where: {
        id: line.destinationStockLocationId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        active: true,
      },
    });
    if (
      !destination ||
      destination.code !== evidenceData.binScan ||
      !input.productScan ||
      !input.lotScan
    )
      throw new PharmacyInventoryError('INVALID_STATE');
    await assertWarehouseScans(
      db,
      sourceScope,
      source,
      line.sourceStockLocationId,
      input.productScan,
      input.lotScan,
      true
    );
    let reason =
      source.batch.state !== 'ACTIVE'
        ? 'The batch is on hold or recalled.'
        : warehouseExpiryBlocked(source.batch)
          ? 'The batch expiry is missing or has passed.'
          : null;
    reason ??= warehouseTransportReason(
      source.batch.medicine,
      await latestDispatchEvidence(db, scope.organizationId, transfer.id)
    );
    reason ??= warehouseTransportReason(source.batch.medicine, evidence);
    if (
      destination.warehouseStaging ||
      !['STORE', 'RACK_BIN', 'FRIDGE', 'SAFE'].includes(destination.kind)
    ) {
      reason ??= 'Receiving bin requires a confirmed move to storage before release.';
    }
    reason ??= await zoneReason(db, scope, source.batch.medicine, destination.id);
    const outstandingHold = await db.pharmacyWarehouseQualityIncident.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: transfer.fromBranchId,
        transferId: transfer.id,
        inventoryLotId: source.id,
        status: { not: 'RELEASE' },
      },
    });
    reason ??= outstandingHold?.reason ?? null;
    const transit = {
      organizationId: scope.organizationId,
      branchId: transfer.fromBranchId,
      inventoryLotId: source.id,
      stockLocationId: line.sourceStockLocationId,
      disposition: 'IN_TRANSIT' as const,
    };
    await lockStockBalances(db, sourceScope, [transit]);
    const balance = await db.pharmacyStockBalance.findFirst({ where: transit });
    if (!balance || balance.onHandUnits < qty)
      throw new PharmacyInventoryError('INSUFFICIENT_STOCK');
    const packs = Math.min(Math.floor(qty / source.unitsPerPack), balance.sealedPacks);
    const loose = qty - packs * source.unitsPerPack;
    const common = { ...transit, actorId: scope.actorId };
    if (loose > balance.looseUnits) {
      const opened = Math.ceil((loose - balance.looseUnits) / source.unitsPerPack);
      await db.pharmacyStockMovement.create({
        data: {
          ...common,
          kind: 'BREAK_PACK',
          quantityUnits: 0,
          sealedPackDelta: -opened,
          looseUnitDelta: opened * source.unitsPerPack,
          idempotencyKey: input.idempotencyKeyPrefix + ':transit-break',
        },
      });
    }
    await db.pharmacyStockMovement.create({
      data: {
        ...common,
        kind: 'TRANSFER_OUT',
        quantityUnits: -qty,
        sealedPackDelta: -packs,
        looseUnitDelta: -loose,
        idempotencyKey: input.idempotencyKeyPrefix + ':transit-out',
      },
    });
    for (const part of [
      {
        units: qty - damaged,
        disposition: reason ? ('QUARANTINE' as const) : ('AVAILABLE' as const),
        reason,
      },
      {
        units: damaged,
        disposition: 'DAMAGED' as const,
        reason: 'Damage recorded at transfer receipt.',
      },
    ]) {
      if (!part.units) continue;
      const lot = await db.pharmacyInventoryLot.create({
        data: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          manufacturingBatchId: source.manufacturingBatchId,
          packLevelId: source.packLevelId,
          unitsPerPack: source.unitsPerPack,
          supplierName: source.supplierName,
          supplierInvoiceRef:
            source.supplierInvoiceRef +
            ':transfer:' +
            line.id +
            ':' +
            line.receivedUnits +
            ':' +
            part.disposition,
          unitCostMinor: source.unitCostMinor,
          printedMrpMinor: source.printedMrpMinor,
          receivedExpiresAt: source.receivedExpiresAt,
          receivedExpiryPrecision: source.receivedExpiryPrecision,
          receivedAt: new Date(),
        },
      });
      destinationLotId ??= lot.id;
      // Keep any loose units loose. Splitting damaged or held units may open a pack.
      const sealedPacks = Math.min(
        arrangementFor(part.units, source.unitsPerPack).sealedPacks,
        part.disposition === 'DAMAGED'
          ? Math.max(0, packs - Math.floor((qty - damaged) / source.unitsPerPack))
          : packs
      );
      const movement = await db.pharmacyStockMovement.create({
        data: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          inventoryLotId: lot.id,
          stockLocationId: destination.id,
          kind: 'TRANSFER_IN',
          disposition: part.disposition,
          quantityUnits: part.units,
          sealedPackDelta: sealedPacks,
          looseUnitDelta: part.units - sealedPacks * source.unitsPerPack,
          actorId: scope.actorId,
          idempotencyKey: input.idempotencyKeyPrefix + ':received:' + part.disposition,
        },
      });
      await postInterbranchTransferReceiptEntry(db, scope, {
        transferLineId: line.id,
        stockMovementId: movement.id,
        at: movement.occurredAt,
      });
      if (part.reason) {
        held += part.units;
        await openWarehouseIncident(db, scope, {
          inventoryLotId: lot.id,
          stockLocationId: destination.id,
          transferId: transfer.id,
          quantityUnits: part.units,
          quarantineUnits: part.disposition === 'QUARANTINE' ? part.units : 0,
          reason: part.reason,
          sourceKey: (part.disposition === 'DAMAGED' ? 'damage:' : 'receipt:') + movement.id,
        });
      }
    }
    await db.pharmacyInterbranchTransferLine.update({
      where: { id: line.id },
      data: { receivedUnits: { increment: qty } },
    });
  }
  await db.pharmacyWarehouseTransportEvidence.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      phase: 'RECEIPT',
      transferId: transfer.id,
      transferLineId: line.id,
      requestKey: input.idempotencyKeyPrefix,
      actorId: scope.actorId,
      destinationLotId,
      shortageUnits: shortage,
      heldUnits: held,
      ...evidenceData,
    },
  });
  const remaining = manifest!.filter(
    (l) => l.receivedUnits + (l.id === line.id ? qty : 0) < l.quantityUnits
  );
  const openShortage =
    remaining.length &&
    (await db.pharmacyWarehouseTransportEvidence.findFirst({
      where: {
        organizationId: scope.organizationId,
        phase: 'RECEIPT',
        transferId: transfer.id,
        transferLineId: { in: remaining.map((l) => l.id) },
        shortageUnits: { gt: 0 },
      },
      select: { id: true },
    }));
  return db.pharmacyInterbranchTransfer.update({
    where: { id: transfer.id },
    data: {
      status: remaining.length ? (openShortage ? 'EXCEPTION' : 'PARTIALLY_RECEIVED') : 'RECEIVED',
      receivedAt: remaining.length ? null : new Date(),
      receivedById: remaining.length ? null : scope.actorId,
    },
  });
}

export async function warehouseRecallTrace(
  db: ScopedDb,
  organizationId: string,
  noticeId: string,
  branchIds?: readonly string[]
) {
  const notice = await db.pharmacyRecallNotice.findFirst({
    where: { id: noticeId, organizationId },
  });
  if (!notice) throw new PharmacyInventoryError('NOT_FOUND');
  const empty = { bins: [], shipments: [], sales: [], returns: [], receipts: [] };
  if (branchIds?.length === 0) return empty;
  const branches = branchIds ? { in: [...branchIds] } : undefined;
  const lotFilter = notice.batchId
    ? { manufacturingBatchId: notice.batchId }
    : { batch: { medicineId: notice.medicineId! } };
  const [balances, shipments, rows, returned, sourceReceipts] = await Promise.all([
    db.pharmacyStockBalance.findMany({
      where: { organizationId, branchId: branches, onHandUnits: { gt: 0 }, lot: lotFilter },
      select: {
        branchId: true,
        inventoryLotId: true,
        stockLocationId: true,
        disposition: true,
        onHandUnits: true,
        location: { select: { code: true } },
      },
    }),
    db.pharmacyInterbranchTransferLine.findMany({
      where: {
        organizationId,
        sourceLot: lotFilter,
        transfer: {
          dispatchedAt: { not: null },
          ...(branchIds ? { OR: [{ fromBranchId: branches }, { toBranchId: branches }] } : {}),
        },
      },
      select: {
        id: true,
        sourceLotId: true,
        quantityUnits: true,
        receivedUnits: true,
        transfer: {
          select: {
            id: true,
            fromBranchId: true,
            toBranchId: true,
            status: true,
            dispatchedAt: true,
          },
        },
      },
    }),
    recallTrace(db, organizationId, noticeId, branchIds),
    db.pharmacySaleReturnLine.groupBy({
      by: ['branchId', 'inventoryLotId'],
      where: { organizationId, branchId: branches, lot: lotFilter },
      _sum: { canonicalUnits: true },
    }),
    db.pharmacyStockMovement.findMany({
      where: {
        organizationId,
        branchId: branches,
        kind: { in: ['RECEIPT', 'OPENING'] },
        reversal: { none: {} },
        quantityUnits: { gt: 0 },
        lot: lotFilter,
      },
      select: {
        branchId: true,
        inventoryLotId: true,
        quantityUnits: true,
        lot: { select: { supplierName: true, supplierInvoiceRef: true } },
      },
    }),
  ]);
  // The legacy trace repeats gross sold units by disposition. Emit one row per lot.
  const sales = new Map<
    string,
    { branchId: string; inventoryLotId: string; grossSoldUnits: number; netSoldUnits: number }
  >();
  const returns = returned.map((r) => ({
    branchId: r.branchId,
    inventoryLotId: r.inventoryLotId,
    returnedUnits: r._sum.canonicalUnits ?? 0,
  }));
  const returnByLot = new Map(returns.map((r) => [r.inventoryLotId, r.returnedUnits]));
  for (const row of rows)
    if (row.soldUnits)
      sales.set(row.inventoryLotId, {
        branchId: row.branchId,
        inventoryLotId: row.inventoryLotId,
        grossSoldUnits: row.soldUnits,
        netSoldUnits: row.soldUnits - (returnByLot.get(row.inventoryLotId) ?? 0),
      });
  const cancelled = shipments.length
    ? await db.pharmacyWarehouseReservation.findMany({
        where: {
          organizationId,
          transferLineId: { in: shipments.map((l) => l.id) },
          state: 'CANCELLED',
        },
        select: { transferLineId: true },
      })
    : [];
  const cancelledIds = new Set(cancelled.map((r) => r.transferLineId));
  const lines = shipments
    .filter((l) => !cancelledIds.has(l.id))
    .map((l) => ({
      transferLineId: l.id,
      transferId: l.transfer.id,
      fromBranchId: l.transfer.fromBranchId,
      toBranchId: l.transfer.toBranchId,
      inventoryLotId: l.sourceLotId,
      dispatchedUnits: l.quantityUnits,
      receivedUnits: l.receivedUnits,
      inTransitUnits: l.transfer.status === 'RECEIVED' ? 0 : l.quantityUnits - l.receivedUnits,
      shortClosedUnits: l.transfer.status === 'RECEIVED' ? l.quantityUnits - l.receivedUnits : 0,
    }));
  const receipts = new Map<
    string,
    {
      inventoryLotId: string;
      branchId: string;
      supplierName: string;
      receiptReference: string;
      receivedUnits: number;
    }
  >();
  for (const row of sourceReceipts) {
    const prior = receipts.get(row.inventoryLotId);
    if (prior) prior.receivedUnits += row.quantityUnits;
    else
      receipts.set(row.inventoryLotId, {
        inventoryLotId: row.inventoryLotId,
        branchId: row.branchId,
        supplierName: row.lot.supplierName,
        receiptReference: row.lot.supplierInvoiceRef,
        receivedUnits: row.quantityUnits,
      });
  }
  return {
    receipts: [...receipts.values()],
    bins: balances.map(({ location, ...row }) => ({ ...row, binCode: location.code })),
    shipments: lines,
    sales: [...sales.values()],
    returns,
  };
}

type ZoneReading = { recordedAt: Date; temperatureC: number };
/** Persist exposures alongside the original readings. A subsequent normal reading alone cannot clear them. */
export async function holdWarehouseZoneExposure(
  db: ScopedDb,
  scope: LedgerScope,
  zone: Zone & { id: string },
  readings: readonly ZoneReading[]
) {
  const now = new Date();
  const ordered = readings
    .filter((r) => r.recordedAt <= now)
    .toSorted((a, b) => +a.recordedAt - +b.recordedAt);
  if (!ordered.length) return;
  await lockWarehouseQuality(db, scope.organizationId, true);
  // Locks match reserve/pick/dispatch and receipt; calculate exposure from current
  // occupants in a new statement after waiting for stock mutations to commit.
  await lockStockRowsFrom(
    db,
    scope.organizationId,
    Prisma.sql`
    SELECT l."manufacturingBatchId" AS "batchId", l.id AS "inventoryLotId"
    FROM pharmacy_inventory_lots l JOIN pharmacy_stock_balances b ON b."inventoryLotId"=l.id AND b."organizationId"=l."organizationId"
    WHERE l."organizationId"=${scope.organizationId} AND b."branchId"=${scope.branchId} AND b."stockLocationId"=${zone.id}
    AND b."onHandUnits">0 AND b.disposition IN ('AVAILABLE','WAREHOUSE_RESERVED','WAREHOUSE_RECEIVING')
  `,
    { batch: 'update', lot: 'update' }
  );
  const balances = await db.pharmacyStockBalance.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      stockLocationId: zone.id,
      disposition: { in: ['AVAILABLE', 'WAREHOUSE_RESERVED', 'WAREHOUSE_RECEIVING'] },
      onHandUnits: { gt: 0 },
    },
    include: { lot: { include: { batch: { include: { medicine: { select: conditions } } } } } },
  });
  await lockStockBalances(
    db,
    scope,
    balances.flatMap((b) => [b, { ...b, disposition: 'QUARANTINE' }])
  );
  const preceding = await db.pharmacyTemperatureLog.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      stockLocationId: zone.id,
      recordedAt: { lt: ordered[0]!.recordedAt },
    },
    orderBy: { recordedAt: 'desc' },
  });
  const timeline = await db.pharmacyTemperatureLog.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      stockLocationId: zone.id,
      recordedAt: { gte: ordered[0]!.recordedAt, lte: ordered.at(-1)!.recordedAt },
    },
    orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
    select: { recordedAt: true, temperatureC: true },
  });
  for (const b of balances) {
    const medicine = b.lot.batch.medicine;
    if (!monitored(medicine)) continue;
    // A backfilled reading before this lot entered the zone is not an exposure.
    const firstEntry = await db.pharmacyStockMovement.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        inventoryLotId: b.inventoryLotId,
        stockLocationId: zone.id,
        quantityUnits: { gt: 0 },
      },
      orderBy: { occurredAt: 'asc' },
      select: { occurredAt: true },
    });
    if (!firstEntry) continue;
    let previous = preceding?.recordedAt ?? firstEntry.occurredAt;
    const event = timeline.find((r) => {
      const gap =
        +r.recordedAt - Math.max(+previous, +firstEntry.occurredAt) >
        zone.expectedTemperatureReadingIntervalMinutes * 60_000;
      previous = r.recordedAt;
      return (
        r.recordedAt >= firstEntry.occurredAt &&
        (gap ||
          Boolean(
            warehouseTransportReason(medicine, {
              minimumC: r.temperatureC,
              maximumC: r.temperatureC,
            })
          ))
      );
    });
    if (!event) continue;
    const reason =
      warehouseTransportReason(medicine, {
        minimumC: event.temperatureC,
        maximumC: event.temperatureC,
      }) ?? 'Required zone temperature evidence was missing during storage.';
    const existing = await db.pharmacyWarehouseQualityIncident.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        inventoryLotId: b.inventoryLotId,
        stockLocationId: zone.id,
        sourceKey: 'zone:' + event.recordedAt.toISOString() + ':' + b.disposition,
      },
    });
    if (existing) continue;
    const incident = await openWarehouseIncident(db, scope, {
      inventoryLotId: b.inventoryLotId,
      stockLocationId: zone.id,
      quantityUnits: b.onHandUnits,
      quarantineUnits: b.disposition === 'AVAILABLE' ? b.onHandUnits : 0,
      reason,
      sourceKey: 'zone:' + event.recordedAt.toISOString() + ':' + b.disposition,
    });
    if (b.disposition === 'WAREHOUSE_RESERVED') {
      const quantity = await releaseWarehouseReservationsForHold(db, scope, {
        inventoryLotId: b.inventoryLotId,
        stockLocationId: zone.id,
        reason,
        sourceKey: incident.sourceKey,
        qualityIncidentId: incident.id,
      });
      if (quantity)
        await db.pharmacyWarehouseQualityIncident.update({
          where: { id: incident.id },
          data: { quarantineUnits: quantity },
        });
    }
    if (b.disposition === 'AVAILABLE')
      await quarantinePart(db, scope, {
        inventoryLotId: b.inventoryLotId,
        stockLocationId: zone.id,
        units: b.onHandUnits,
        reason,
        idempotencyKeyPrefix: 'warehouse-exposure:' + incident.id,
      });
  }
}

export async function registerWarehouseCancellationHold(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    inventoryLotId: string;
    stockLocationId: string;
    quantityUnits: number;
    reservationId: string;
  }
) {
  return openWarehouseIncident(db, scope, {
    inventoryLotId: input.inventoryLotId,
    stockLocationId: input.stockLocationId,
    quantityUnits: input.quantityUnits,
    quarantineUnits: input.quantityUnits,
    reason: 'Cancelled allocation requires quality review before release.',
    sourceKey: 'reservation-cancel:' + input.reservationId,
  });
}
