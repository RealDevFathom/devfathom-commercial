import { createHash } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { PharmacyInventoryError } from './inventory';
import { lockRecallAuthority, quarantinePart, releaseRecallBatches } from './inventory-operations';
import { confirmPriceChanges, currentPackPrice, resolveNoticePack } from './pricing';

export type DrapPriceNotice = {
  kind: 'PRICE';
  presentation?: string;
  packLevel?: 'BOX' | 'STRIP' | 'UNIT';
  sourceReference: string;
  drapRegistrationNumber: string;
  notifiedPriceMinor: number;
  effectiveDate: Date;
};

export type DrapRecallNotice = {
  kind: 'RECALL';
  sourceReference: string;
  drapRegistrationNumber: string;
  batchNumbers?: readonly string[];
  reason: string;
};

export type DrapNotice = DrapPriceNotice | DrapRecallNotice;

/** ECO-01 extension seam. Only these two adapters are intentionally shipped. */
export interface DrapNoticeSource {
  readonly adapter: 'FILE' | 'MANUAL';
  read(): Promise<readonly DrapNotice[]>;
}

export class ManualDrapNoticeSource implements DrapNoticeSource {
  readonly adapter = 'MANUAL' as const;
  constructor(private readonly notices: readonly DrapNotice[]) {}
  async read() {
    return this.notices;
  }
}

export class FileDrapNoticeSource implements DrapNoticeSource {
  readonly adapter = 'FILE' as const;
  constructor(private readonly contents: string) {}
  async read(): Promise<readonly DrapNotice[]> {
    const value: unknown = JSON.parse(this.contents);
    if (!Array.isArray(value)) throw new PharmacyInventoryError('INVALID_STATE');
    return value.map(parseNotice);
  }
}

function parseNotice(value: unknown): DrapNotice {
  if (!value || typeof value !== 'object') throw new PharmacyInventoryError('INVALID_STATE');
  const notice = value as Record<string, unknown>;
  if (
    (notice.kind !== 'PRICE' && notice.kind !== 'RECALL') ||
    typeof notice.sourceReference !== 'string' ||
    typeof notice.drapRegistrationNumber !== 'string'
  )
    throw new PharmacyInventoryError('INVALID_STATE');
  if (notice.kind === 'PRICE') {
    if (!Number.isSafeInteger(notice.notifiedPriceMinor) || Number(notice.notifiedPriceMinor) < 0)
      throw new PharmacyInventoryError('INVALID_STATE');
    const effectiveDate = new Date(String(notice.effectiveDate));
    if (Number.isNaN(effectiveDate.getTime())) throw new PharmacyInventoryError('INVALID_STATE');
    if (
      notice.presentation !== undefined &&
      (typeof notice.presentation !== 'string' || !notice.presentation.trim())
    )
      throw new PharmacyInventoryError('INVALID_STATE');
    if (
      notice.packLevel !== undefined &&
      !['BOX', 'STRIP', 'UNIT'].includes(String(notice.packLevel))
    )
      throw new PharmacyInventoryError('INVALID_STATE');
    return {
      kind: 'PRICE',
      ...(notice.presentation !== undefined ? { presentation: notice.presentation as string } : {}),
      ...(notice.packLevel !== undefined
        ? { packLevel: notice.packLevel as 'BOX' | 'STRIP' | 'UNIT' }
        : {}),
      sourceReference: notice.sourceReference,
      drapRegistrationNumber: notice.drapRegistrationNumber,
      notifiedPriceMinor: Number(notice.notifiedPriceMinor),
      effectiveDate,
    };
  }
  if (
    typeof notice.reason !== 'string' ||
    (notice.batchNumbers !== undefined &&
      (!Array.isArray(notice.batchNumbers) ||
        !notice.batchNumbers.every((item) => typeof item === 'string')))
  )
    throw new PharmacyInventoryError('INVALID_STATE');
  return {
    kind: 'RECALL',
    sourceReference: notice.sourceReference,
    drapRegistrationNumber: notice.drapRegistrationNumber,
    batchNumbers: notice.batchNumbers as string[] | undefined,
    reason: notice.reason,
  };
}

const payloadHash = (notice: DrapNotice) =>
  createHash('sha256')
    .update(
      JSON.stringify(notice, (_key, value) => (value instanceof Date ? value.toISOString() : value))
    )
    .digest('hex');

type ActorScope = { organizationId: string; actorId: string };

/** Ingests one source serially so each notice is one isolated database transaction. */
export async function ingestDrapSource(db: ScopedDb, scope: ActorScope, source: DrapNoticeSource) {
  const results = [];
  for (const notice of await source.read())
    results.push(await ingestDrapNotice(db, scope, source.adapter, notice));
  return results;
}

export async function ingestDrapNotice(
  db: ScopedDb,
  scope: ActorScope,
  adapter: DrapNoticeSource['adapter'],
  notice: DrapNotice
) {
  if (notice.kind === 'RECALL') await lockRecallAuthority(db, scope.organizationId);
  const previous = await db.pharmacyDrapIngest.findFirst({
    where: {
      organizationId: scope.organizationId,
      sourceReference: notice.sourceReference,
      kind: notice.kind,
    },
  });
  if (previous) {
    if (previous.payloadHash !== payloadHash(notice))
      throw new PharmacyInventoryError('INVALID_STATE');
    return previous;
  }

  const medicines = await db.medicine.findMany({
    where: {
      organizationId: scope.organizationId,
      drapRegistrationNumber: notice.drapRegistrationNumber,
    },
    select: { id: true },
  });
  if (medicines.length !== 1) {
    return db.pharmacyDrapIngest.create({
      data: {
        organizationId: scope.organizationId,
        sourceReference: notice.sourceReference,
        adapter,
        kind: notice.kind,
        ...(notice.kind === 'PRICE' ? { priceNotice: JSON.parse(JSON.stringify(notice)) } : {}),
        payloadHash: payloadHash(notice),
        matchStatus: medicines.length ? 'AMBIGUOUS' : 'NO_MATCH',
        matchDetails: { candidateMedicineIds: medicines.map(({ id }) => id) },
        ingestedById: scope.actorId,
      },
    });
  }
  const medicineId = medicines[0]!.id;

  if (notice.kind === 'PRICE') {
    const pack = await resolveNoticePack(
      db,
      scope.organizationId,
      medicineId,
      notice.presentation,
      notice.packLevel,
      notice.effectiveDate
    );
    const current = pack ? await currentPackPrice(db, scope.organizationId, pack.id) : null;
    return db.pharmacyDrapIngest.create({
      data: {
        organizationId: scope.organizationId,
        sourceReference: notice.sourceReference,
        adapter,
        kind: 'PRICE',
        priceNotice: JSON.parse(JSON.stringify(notice)),
        payloadHash: payloadHash(notice),
        matchStatus: pack ? 'MATCHED' : 'NO_MATCH',
        matchDetails: { medicineId, packLevelId: pack?.id ?? null },
        ingestedById: scope.actorId,
        priceChanges: {
          create: {
            medicineId,
            // Legacy required column; new consumers use nullable regulatory policy.
            currentPriceMinor: current?.mrpMinor ?? 0,
            previousRegulatoryMrpMinor: current?.mrpMinor ?? null,
            packLevelId: pack?.id ?? null,
            notifiedPriceMinor: notice.notifiedPriceMinor,
            effectiveDate: notice.effectiveDate,
          },
        },
      },
      include: { priceChanges: true },
    });
  }

  const batches = await db.pharmacyManufacturingBatch.findMany({
    where: {
      organizationId: scope.organizationId,
      medicineId,
      ...(notice.batchNumbers?.length ? { batchNumber: { in: [...notice.batchNumbers] } } : {}),
    },
    select: { id: true, batchNumber: true },
  });
  if (
    !batches.length ||
    (notice.batchNumbers?.length && batches.length !== new Set(notice.batchNumbers).size)
  ) {
    return db.pharmacyDrapIngest.create({
      data: {
        organizationId: scope.organizationId,
        sourceReference: notice.sourceReference,
        adapter,
        kind: 'RECALL',
        payloadHash: payloadHash(notice),
        matchStatus: batches.length ? 'AMBIGUOUS' : 'NO_MATCH',
        matchDetails: { medicineId, candidateBatches: batches },
        ingestedById: scope.actorId,
      },
    });
  }
  // Existing recall roots accept one batch or one medicine. A batch list is a
  // medicine-scope recall only when every known batch is named; otherwise it is
  // deliberately surfaced for confirmation instead of broadening silently.
  if (batches.length > 1 && notice.batchNumbers?.length) {
    const allCount = await db.pharmacyManufacturingBatch.count({
      where: { organizationId: scope.organizationId, medicineId },
    });
    if (allCount !== batches.length) {
      return db.pharmacyDrapIngest.create({
        data: {
          organizationId: scope.organizationId,
          sourceReference: notice.sourceReference,
          adapter,
          kind: 'RECALL',
          payloadHash: payloadHash(notice),
          matchStatus: 'AMBIGUOUS',
          matchDetails: { medicineId, candidateBatches: batches },
          ingestedById: scope.actorId,
        },
      });
    }
  }

  const batchId = batches.length === 1 ? batches[0]!.id : undefined;
  const recall = await db.pharmacyRecallNotice.create({
    data: {
      organizationId: scope.organizationId,
      batchId,
      medicineId: batchId ? undefined : medicineId,
      reference: notice.sourceReference,
      reason: notice.reason,
      createdById: scope.actorId,
    },
  });
  const ingest = await db.pharmacyDrapIngest.create({
    data: {
      organizationId: scope.organizationId,
      sourceReference: notice.sourceReference,
      adapter,
      kind: 'RECALL',
      payloadHash: payloadHash(notice),
      matchStatus: 'MATCHED',
      matchDetails: { medicineId, batchIds: batches.map(({ id }) => id) },
      recallNoticeId: recall.id,
      ingestedById: scope.actorId,
    },
  });
  await db.pharmacyManufacturingBatch.updateMany({
    where: { organizationId: scope.organizationId, id: { in: batches.map(({ id }) => id) } },
    data: { state: 'RECALLED', stateReason: notice.reason, stateChangedAt: new Date() },
  });
  const balances = await db.pharmacyStockBalance.findMany({
    where: {
      organizationId: scope.organizationId,
      disposition: 'AVAILABLE',
      onHandUnits: { gt: 0 },
      lot: { manufacturingBatchId: { in: batches.map(({ id }) => id) } },
    },
  });
  for (const balance of balances) {
    const moved = await quarantinePart(
      db,
      { ...scope, branchId: balance.branchId },
      {
        inventoryLotId: balance.inventoryLotId,
        stockLocationId: balance.stockLocationId,
        units: balance.onHandUnits,
        reason: `DRAP recall ${notice.sourceReference}: ${notice.reason}`,
        idempotencyKeyPrefix: `drap:${ingest.id}:${balance.inventoryLotId}:${balance.stockLocationId}`,
      }
    );
    await db.pharmacyRecallQuarantineAction.create({
      data: {
        organizationId: scope.organizationId,
        ingestId: ingest.id,
        recallNoticeId: recall.id,
        branchId: balance.branchId,
        inventoryLotId: balance.inventoryLotId,
        stockLocationId: balance.stockLocationId,
        quantityUnits: balance.onHandUnits,
        removedMovementId: moved.removed.id,
        heldMovementId: moved.held.id,
      },
    });
  }
  return ingest;
}

export async function confirmPriceChange(db: ScopedDb, scope: ActorScope, proposalId: string) {
  return (await confirmPriceChanges(db, scope, [proposalId]))[0]!;
}

export async function recallActionList(db: ScopedDb, scope: ActorScope, recallNoticeId: string) {
  return db.$queryRaw<
    Array<{
      branchId: string;
      inventoryLotId: string;
      quarantinedUnits: number;
      patientName: string | null;
      patientPhone: string | null;
    }>
  >(
    Prisma.sql`SELECT a."branchId",a."inventoryLotId",a."quantityUnits" AS "quarantinedUnits",p."displayName" AS "patientName",p.phone AS "patientPhone" FROM "pharmacy_recall_quarantine_actions" a LEFT JOIN "pharmacy_sale_line_allocations" la ON la."organizationId"=a."organizationId" AND la."inventoryLotId"=a."inventoryLotId" LEFT JOIN "pharmacy_sale_lines" sl ON sl."organizationId"=la."organizationId" AND sl.id=la."saleLineId" LEFT JOIN "pharmacy_sales" s ON s."organizationId"=sl."organizationId" AND s.id=sl."saleId" AND s.status='COMPLETED' LEFT JOIN "pharmacy_customers" c ON c."organizationId"=s."organizationId" AND c.id=s."customerId" LEFT JOIN "pharmacy_patients" p ON p."organizationId"=c."organizationId" AND p.id=c."patientId" WHERE a."organizationId"=${scope.organizationId} AND a."recallNoticeId"=${recallNoticeId} ORDER BY a."branchId",a."inventoryLotId"`
  );
}

export async function reverseRecallQuarantine(
  db: ScopedDb,
  scope: ActorScope,
  recallNoticeId: string,
  reason: string
) {
  if (!reason.trim()) throw new PharmacyInventoryError('INVALID_STATE');
  await lockRecallAuthority(db, scope.organizationId);
  const actions = await db.pharmacyRecallQuarantineAction.findMany({
    where: { organizationId: scope.organizationId, recallNoticeId, reversedAt: null },
  });
  if (!actions.length) throw new PharmacyInventoryError('NOT_FOUND');
  for (const action of actions) {
    const originals = await db.pharmacyStockMovement.findMany({
      where: {
        organizationId: scope.organizationId,
        id: { in: [action.removedMovementId, action.heldMovementId] },
      },
    });
    if (originals.length !== 2) throw new PharmacyInventoryError('INVALID_STATE');
    for (const original of originals) {
      await db.pharmacyStockMovement.create({
        data: {
          organizationId: scope.organizationId,
          branchId: original.branchId,
          inventoryLotId: original.inventoryLotId,
          stockLocationId: original.stockLocationId,
          kind: original.kind,
          disposition: original.disposition,
          quantityUnits: -original.quantityUnits,
          sealedPackDelta: -original.sealedPackDelta,
          looseUnitDelta: -original.looseUnitDelta,
          actorId: scope.actorId,
          reason,
          idempotencyKey: `drap-reverse:${action.id}:${original.id}`,
          reversesMovementId: original.id,
        },
      });
    }
    await db.pharmacyRecallQuarantineAction.update({
      where: { organizationId_id: { organizationId: scope.organizationId, id: action.id } },
      data: { reversedById: scope.actorId, reversedAt: new Date(), reversalReason: reason },
    });
  }
  const recall = await db.pharmacyRecallNotice.findFirstOrThrow({
    where: { organizationId: scope.organizationId, id: recallNoticeId },
  });
  await releaseRecallBatches(db, scope.organizationId, recall);
  return db.pharmacyRecallNotice.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: recall.id } },
    data: { status: 'CLOSED', closedById: scope.actorId, closedAt: new Date() },
  });
}
