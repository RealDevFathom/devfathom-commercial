import { releaseWarehouseReservationsForHold } from './warehouse-outbound';
import { createHash } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { releaseCounterQuotasForSafety } from './counter-stock-holds';
import { PharmacyInventoryError } from './inventory';
import {
  lockRecallAuthority,
  lockRecallBatches,
  quarantinePart,
  releaseRecallBatches,
} from './inventory-operations';
import { confirmPriceChanges } from './pricing';
import { lockStockBalances, lockStockRowsFrom } from './stock-lock-order';

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
  /** Empty when the alert names no registration number: it is queued as NO_MATCH. */
  drapRegistrationNumber: string;
  batchNumbers?: readonly string[];
  reason: string;
  /** Evidence a reviewer reads before confirming (DEV-692 web adapter). */
  productName?: string;
  alertNumber?: string;
  sourceUrl?: string;
  documentUrl?: string;
  publishedAt?: string;
  /**
   * True when the source names batches that could not be read (e.g. a PDF
   * table). Such an alert is never a confirmable medicine-wide recall.
   */
  batchNumbersUnresolved?: boolean;
};

const RECALL_EVIDENCE_FIELDS = [
  'productName',
  'alertNumber',
  'sourceUrl',
  'documentUrl',
  'publishedAt',
] as const;

export type DrapNotice = DrapPriceNotice | DrapRecallNotice;

/**
 * ECO-01 extension seam. DRAP_WEB is the DEV-692 recall-alert page adapter
 * (`drap-recall-feed.ts`); it is off unless operations enable it.
 */
export interface DrapNoticeSource {
  readonly adapter: 'FILE' | 'MANUAL' | 'DRAP_WEB';
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
  const evidence: Partial<Record<(typeof RECALL_EVIDENCE_FIELDS)[number], string>> = {};
  for (const field of RECALL_EVIDENCE_FIELDS) {
    if (notice[field] === undefined) continue;
    if (typeof notice[field] !== 'string') throw new PharmacyInventoryError('INVALID_STATE');
    evidence[field] = notice[field];
  }
  if (
    notice.batchNumbersUnresolved !== undefined &&
    typeof notice.batchNumbersUnresolved !== 'boolean'
  )
    throw new PharmacyInventoryError('INVALID_STATE');
  return {
    kind: 'RECALL',
    sourceReference: notice.sourceReference,
    drapRegistrationNumber: notice.drapRegistrationNumber,
    batchNumbers: notice.batchNumbers as string[] | undefined,
    reason: notice.reason,
    ...evidence,
    ...(notice.batchNumbersUnresolved ? { batchNumbersUnresolved: true } : {}),
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

  const registration = notice.drapRegistrationNumber.trim();
  const medicines = registration
    ? await db.medicine.findMany({
        where: { organizationId: scope.organizationId, drapRegistrationNumber: registration },
        select: { id: true },
      })
    : [];
  if (medicines.length !== 1) {
    return db.pharmacyDrapIngest.create({
      data: {
        organizationId: scope.organizationId,
        sourceReference: notice.sourceReference,
        adapter,
        kind: notice.kind,
        ...(notice.kind === 'PRICE'
          ? { priceNotice: JSON.parse(JSON.stringify(notice)) }
          : recallDraft(notice)),
        payloadHash: payloadHash(notice),
        matchStatus: medicines.length ? 'AMBIGUOUS' : 'NO_MATCH',
        matchDetails: { candidateMedicineIds: medicines.map(({ id }) => id) },
        ingestedById: scope.actorId,
      },
    });
  }
  const medicineId = medicines[0]!.id;

  if (notice.kind === 'PRICE') {
    // DEV-693 owner decision: the price printed on the pack and the owner's own
    // price stay authoritative, because shelf stock can predate a DRAP price
    // order. A matching notice is information only: it raises an alert and never
    // writes a pack price or drafts a price-change proposal.
    return db.pharmacyDrapIngest.create({
      data: {
        organizationId: scope.organizationId,
        sourceReference: notice.sourceReference,
        adapter,
        kind: 'PRICE',
        priceNotice: JSON.parse(JSON.stringify(notice)),
        payloadHash: payloadHash(notice),
        matchStatus: 'MATCHED',
        matchDetails: { medicineId },
        ingestedById: scope.actorId,
        priceAlerts: {
          create: {
            medicineId,
            notifiedPriceMinor: notice.notifiedPriceMinor,
            effectiveDate: notice.effectiveDate,
          },
        },
      },
      include: { priceAlerts: true },
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
  const draft = (matchStatus: 'MATCHED' | 'AMBIGUOUS' | 'NO_MATCH', matchDetails: object) =>
    db.pharmacyDrapIngest.create({
      data: {
        organizationId: scope.organizationId,
        sourceReference: notice.sourceReference,
        adapter,
        kind: 'RECALL',
        ...recallDraft(notice),
        payloadHash: payloadHash(notice),
        matchStatus,
        matchDetails,
        ingestedById: scope.actorId,
      },
    });
  // Batches the alert names but the parser could not read: a person resolves
  // it (manual recall), it never becomes a confirmable medicine-wide draft.
  if (notice.batchNumbersUnresolved && !notice.batchNumbers?.length)
    return draft('AMBIGUOUS', {
      medicineId,
      candidateBatches: batches,
      batchNumbersUnresolved: true,
    });
  if (
    !batches.length ||
    (notice.batchNumbers?.length && batches.length !== new Set(notice.batchNumbers).size)
  ) {
    return draft(batches.length ? 'AMBIGUOUS' : 'NO_MATCH', {
      medicineId,
      candidateBatches: batches,
    });
  }
  // Existing recall roots accept one batch or one medicine. A batch list is a
  // medicine-scope recall only when every known batch is named; otherwise it is
  // deliberately surfaced for confirmation instead of broadening silently.
  if (batches.length > 1 && notice.batchNumbers?.length) {
    const allCount = await db.pharmacyManufacturingBatch.count({
      where: { organizationId: scope.organizationId, medicineId },
    });
    if (allCount !== batches.length)
      return draft('AMBIGUOUS', { medicineId, candidateBatches: batches });
  }
  // DEV-692: a match is only a draft. Nothing is recalled or quarantined until
  // a person confirms it with `confirmDrapRecall`.
  return draft('MATCHED', {
    medicineId,
    batchIds: batches.map(({ id }) => id),
    batches,
    recallScope: batches.length === 1 ? 'BATCH' : 'MEDICINE',
    batchesNamed: !!notice.batchNumbers?.length,
  });
}

function recallDraft(notice: DrapRecallNotice) {
  return {
    recallPayload: JSON.parse(JSON.stringify(notice)),
    reviewStatus: 'PENDING_REVIEW' as const,
  };
}

function matchedBatchIds(matchDetails: unknown): {
  medicineId: string;
  batchIds: string[];
  batchesNamed: boolean;
} {
  const details = (matchDetails ?? {}) as {
    medicineId?: unknown;
    batchIds?: unknown;
    batchesNamed?: unknown;
  };
  if (
    typeof details.medicineId !== 'string' ||
    !Array.isArray(details.batchIds) ||
    !details.batchIds.length ||
    !details.batchIds.every((id) => typeof id === 'string')
  )
    throw new PharmacyInventoryError('INVALID_STATE');
  return {
    medicineId: details.medicineId,
    batchIds: details.batchIds as string[],
    // Absent on drafts filed before this flag: treat them as naming batches, the narrower reading.
    batchesNamed: details.batchesNamed !== false,
  };
}

async function pendingRecallDraft(db: ScopedDb, organizationId: string, ingestId: string) {
  const ingest = await db.pharmacyDrapIngest.findFirst({
    where: { organizationId, id: ingestId, kind: 'RECALL' },
  });
  if (!ingest) throw new PharmacyInventoryError('NOT_FOUND');
  if (ingest.reviewStatus !== 'PENDING_REVIEW') throw new PharmacyInventoryError('INVALID_STATE');
  return ingest;
}

/**
 * DEV-692: a person confirms a MATCHED recall draft. Only now is the recall
 * notice opened, the matched batches marked RECALLED and their available stock
 * moved to quarantine. Every step is in the caller's transaction and is
 * serialized by the recall-authority lock.
 */
export async function confirmDrapRecall(
  db: ScopedDb,
  scope: ActorScope,
  ingestId: string,
  note?: string
) {
  await lockRecallAuthority(db, scope.organizationId);
  const ingest = await pendingRecallDraft(db, scope.organizationId, ingestId);
  if (ingest.matchStatus !== 'MATCHED') throw new PharmacyInventoryError('INVALID_STATE');
  const { medicineId, batchIds, batchesNamed } = matchedBatchIds(ingest.matchDetails);
  const payload = (ingest.recallPayload ?? {}) as { reason?: unknown };
  const reason =
    typeof payload.reason === 'string' && payload.reason.trim()
      ? payload.reason
      : `DRAP recall ${ingest.sourceReference}`;
  // Re-read the medicine's batches now. An alert that names no batch recalls
  // every batch, including stock received after the alert. An alert that names
  // batches is medicine-scope only while those are still all the batches: if
  // another batch has arrived, confirming would broaden it, so it is refused.
  const medicineScope = batchIds.length > 1;
  const current = await db.pharmacyManufacturingBatch.findMany({
    where: { organizationId: scope.organizationId, medicineId },
    select: { id: true },
  });
  const currentIds = new Set(current.map(({ id }) => id));
  if (!batchIds.every((id) => currentIds.has(id)))
    throw new PharmacyInventoryError('INVALID_STATE');
  if (medicineScope && batchesNamed && current.length !== batchIds.length)
    throw new PharmacyInventoryError('INVALID_STATE');
  const batches = medicineScope ? current : current.filter(({ id }) => id === batchIds[0]);

  const batchId = medicineScope ? undefined : batches[0]!.id;
  const recall = await db.pharmacyRecallNotice.create({
    data: {
      organizationId: scope.organizationId,
      batchId,
      medicineId: batchId ? undefined : medicineId,
      reference: ingest.sourceReference,
      reason,
      createdById: scope.actorId,
    },
  });
  const claimed = await db.pharmacyDrapIngest.updateMany({
    where: { organizationId: scope.organizationId, id: ingest.id, reviewStatus: 'PENDING_REVIEW' },
    data: {
      recallNoticeId: recall.id,
      reviewStatus: 'CONFIRMED',
      reviewedById: scope.actorId,
      reviewedAt: new Date(),
      reviewNote: note?.trim() || null,
    },
  });
  if (claimed.count !== 1) throw new PharmacyInventoryError('INVALID_STATE');
  // DEV-825: the batches, then every balance the quarantine moves write, each in
  // the global key order (stock-lock-order.ts), before the first write.
  const recalledIds = batches.map(({ id }) => id);
  await lockStockRowsFrom(
    db,
    scope.organizationId,
    Prisma.sql`SELECT unnest(${recalledIds}::text[]) AS "batchId"`,
    { batch: 'update' }
  );
  await db.pharmacyManufacturingBatch.updateMany({
    where: { organizationId: scope.organizationId, id: { in: recalledIds } },
    data: { state: 'RECALLED', stateReason: reason, stateChangedAt: new Date() },
  });
  const balances = await db.pharmacyStockBalance.findMany({
    where: {
      organizationId: scope.organizationId,
      disposition: { in: ['AVAILABLE', 'WAREHOUSE_RESERVED'] },
      onHandUnits: { gt: 0 },
      lot: { manufacturingBatchId: { in: recalledIds } },
    },
  });
  // Balances span branches; every balance of a lot is in the lot's branch, so
  // the organization-wide key order is still one total order.
  await lockStockBalances(
    db,
    { organizationId: scope.organizationId },
    balances.flatMap((balance) =>
      ([balance.disposition, 'QUARANTINE'] as const).map((disposition) => ({
        inventoryLotId: balance.inventoryLotId,
        stockLocationId: balance.stockLocationId,
        disposition,
      }))
    )
  );
  await releaseWarehouseReservationsForHold(db, scope, {
    batchIds: recalledIds,
    reason,
    sourceKey: 'drap:' + ingest.id,
  });
  for (const balance of balances.filter((b) => b.disposition === 'AVAILABLE')) {
    const moved = await quarantinePart(
      db,
      { ...scope, branchId: balance.branchId },
      {
        inventoryLotId: balance.inventoryLotId,
        stockLocationId: balance.stockLocationId,
        units: balance.onHandUnits,
        reason: `DRAP recall ${ingest.sourceReference}: ${reason}`,
        idempotencyKeyPrefix: `drap:${ingest.id}:${balance.inventoryLotId}:${balance.stockLocationId}`,
        cause: 'RECALL',
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
  // DEV-957: every counter quota left on the recalled batches goes too, so no counter
  // keeps selling them offline (the quarantine above released the ones it emptied).
  await releaseCounterQuotasForSafety(db, scope, { batchIds: recalledIds }, 'RECALL');
  return db.pharmacyDrapIngest.findFirstOrThrow({
    where: { organizationId: scope.organizationId, id: ingest.id },
  });
}

/** DEV-692: a person closes a recall draft without touching stock, with a reason. */
export async function dismissDrapRecall(
  db: ScopedDb,
  scope: ActorScope,
  ingestId: string,
  reason: string
) {
  if (!reason.trim()) throw new PharmacyInventoryError('INVALID_STATE');
  await lockRecallAuthority(db, scope.organizationId);
  const ingest = await pendingRecallDraft(db, scope.organizationId, ingestId);
  const claimed = await db.pharmacyDrapIngest.updateMany({
    where: { organizationId: scope.organizationId, id: ingest.id, reviewStatus: 'PENDING_REVIEW' },
    data: {
      reviewStatus: 'DISMISSED',
      reviewedById: scope.actorId,
      reviewedAt: new Date(),
      reviewNote: reason.trim(),
    },
  });
  if (claimed.count !== 1) throw new PharmacyInventoryError('INVALID_STATE');
  return db.pharmacyDrapIngest.findFirstOrThrow({
    where: { organizationId: scope.organizationId, id: ingest.id },
  });
}

/**
 * DEV-692 review queue: pending recall drafts first, then the most recent
 * decisions. Counts (stock units) come from the database, not the parser.
 */
export async function drapRecallReviewQueue(db: ScopedDb, scope: ActorScope) {
  const [pending, decided] = await Promise.all([
    db.pharmacyDrapIngest.findMany({
      where: {
        organizationId: scope.organizationId,
        kind: 'RECALL',
        reviewStatus: 'PENDING_REVIEW',
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    db.pharmacyDrapIngest.findMany({
      where: {
        organizationId: scope.organizationId,
        kind: 'RECALL',
        reviewStatus: { in: ['CONFIRMED', 'DISMISSED'] },
      },
      orderBy: { reviewedAt: 'desc' },
      take: 20,
    }),
  ]);
  const medicineIds = new Set<string>();
  const batchIds = new Set<string>();
  for (const row of pending) {
    const details = (row.matchDetails ?? {}) as {
      medicineId?: unknown;
      batchIds?: unknown;
      candidateMedicineIds?: unknown;
    };
    if (typeof details.medicineId === 'string') medicineIds.add(details.medicineId);
    if (Array.isArray(details.candidateMedicineIds))
      for (const id of details.candidateMedicineIds)
        if (typeof id === 'string') medicineIds.add(id);
    if (row.matchStatus === 'MATCHED' && Array.isArray(details.batchIds))
      for (const id of details.batchIds) if (typeof id === 'string') batchIds.add(id);
  }
  const [medicines, stock] = await Promise.all([
    medicineIds.size
      ? db.medicine.findMany({
          where: { organizationId: scope.organizationId, id: { in: [...medicineIds] } },
          select: { id: true, productName: true, brandName: true, drapRegistrationNumber: true },
        })
      : [],
    batchIds.size
      ? db.$queryRaw<Array<{ batchId: string; units: number }>>(
          Prisma.sql`SELECT l."manufacturingBatchId" AS "batchId", COALESCE(SUM(b."onHandUnits"),0)::int AS units FROM "pharmacy_stock_balances" b JOIN "pharmacy_inventory_lots" l ON l."organizationId"=b."organizationId" AND l.id=b."inventoryLotId" WHERE b."organizationId"=${scope.organizationId} AND b.disposition='AVAILABLE' AND b."onHandUnits">0 AND l."manufacturingBatchId" IN (${Prisma.join([...batchIds])}) GROUP BY l."manufacturingBatchId"`
        )
      : [],
  ]);
  const medicineById = new Map(medicines.map((m) => [m.id, m]));
  const unitsByBatch = new Map(stock.map((row) => [row.batchId, Number(row.units)]));
  const view = (row: (typeof pending)[number]) => {
    const payload = (row.recallPayload ?? {}) as Partial<DrapRecallNotice>;
    const details = (row.matchDetails ?? {}) as {
      medicineId?: string;
      batchIds?: string[];
      batches?: Array<{ id: string; batchNumber: string }>;
      candidateMedicineIds?: string[];
      candidateBatches?: Array<{ id: string; batchNumber: string }>;
    };
    const matchedBatches = row.matchStatus === 'MATCHED' ? (details.batches ?? []) : [];
    return {
      id: row.id,
      sourceReference: row.sourceReference,
      adapter: row.adapter,
      matchStatus: row.matchStatus,
      reviewStatus: row.reviewStatus,
      reviewNote: row.reviewNote,
      reviewedAt: row.reviewedAt,
      recallNoticeId: row.recallNoticeId,
      createdAt: row.createdAt,
      alert: {
        registrationNumber: payload.drapRegistrationNumber ?? '',
        batchNumbers: payload.batchNumbers ?? [],
        batchNumbersUnresolved: payload.batchNumbersUnresolved === true,
        reason: payload.reason ?? '',
        productName: payload.productName ?? null,
        alertNumber: payload.alertNumber ?? null,
        sourceUrl: payload.sourceUrl ?? null,
        documentUrl: payload.documentUrl ?? null,
        publishedAt: payload.publishedAt ?? null,
      },
      medicine: details.medicineId ? (medicineById.get(details.medicineId) ?? null) : null,
      candidateMedicines: (details.candidateMedicineIds ?? []).flatMap((id) =>
        medicineById.has(id) ? [medicineById.get(id)!] : []
      ),
      batches: matchedBatches.map((batch) => ({
        ...batch,
        availableUnits: unitsByBatch.get(batch.id) ?? 0,
      })),
      candidateBatches: details.candidateBatches ?? [],
      recallScope:
        row.matchStatus === 'MATCHED' ? (matchedBatches.length === 1 ? 'BATCH' : 'MEDICINE') : null,
    };
  };
  return { pending: pending.map(view), decided: decided.map(view) };
}

/** DEV-693: refused like every DRAP confirmation; kept so old callers get the reason. */
export async function confirmPriceChange(db: ScopedDb, scope: ActorScope, proposalId: string) {
  return confirmPriceChanges(db, scope, [proposalId]);
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
  const recall = await db.pharmacyRecallNotice.findFirstOrThrow({
    where: { organizationId: scope.organizationId, id: recallNoticeId },
  });
  const originalsByAction = new Map<
    string,
    Awaited<ReturnType<typeof db.pharmacyStockMovement.findMany>>
  >();
  for (const action of actions) {
    const originals = await db.pharmacyStockMovement.findMany({
      where: {
        organizationId: scope.organizationId,
        id: { in: [action.removedMovementId, action.heldMovementId] },
      },
    });
    if (originals.length !== 2) throw new PharmacyInventoryError('INVALID_STATE');
    originalsByAction.set(action.id, originals);
  }
  // DEV-825: the recalled batches (released below), then every balance the
  // reversals write, each in the global key order, before the first write.
  await lockRecallBatches(db, scope.organizationId, recall);
  await lockStockBalances(
    db,
    { organizationId: scope.organizationId },
    [...originalsByAction.values()].flat()
  );
  for (const action of actions) {
    const originals = originalsByAction.get(action.id)!;
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
  await releaseRecallBatches(db, scope.organizationId, recall);
  return db.pharmacyRecallNotice.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: recall.id } },
    data: { status: 'CLOSED', closedById: scope.actorId, closedAt: new Date() },
  });
}

/**
 * DEV-693: open (undismissed) official-price alerts for the organization,
 * newest first. Optionally narrowed to the medicines on a goods-in screen.
 */
export async function listDrapPriceAlerts(
  db: ScopedDb,
  scope: ActorScope,
  medicineIds?: readonly string[]
) {
  const alerts = await db.pharmacyDrapPriceAlert.findMany({
    where: {
      organizationId: scope.organizationId,
      dismissedAt: null,
      ...(medicineIds ? { medicineId: { in: [...medicineIds] } } : {}),
    },
    include: {
      medicine: { select: { productName: true } },
      ingest: { select: { sourceReference: true, priceNotice: true } },
    },
    orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    take: 500,
  });
  return alerts.map((alert) => {
    const notice = alert.ingest.priceNotice as { presentation?: string; packLevel?: string } | null;
    return {
      id: alert.id,
      medicineId: alert.medicineId,
      medicine: alert.medicine.productName,
      sourceReference: alert.ingest.sourceReference,
      presentation: notice?.presentation ?? null,
      packLevel: notice?.packLevel ?? null,
      notifiedPriceMinor: alert.notifiedPriceMinor,
      effectiveDate: alert.effectiveDate,
      createdAt: alert.createdAt,
    };
  });
}

/** Dismissal records who read the alert and when. It changes nothing else. */
export async function dismissDrapPriceAlert(db: ScopedDb, scope: ActorScope, alertId: string) {
  const { count } = await db.pharmacyDrapPriceAlert.updateMany({
    where: { organizationId: scope.organizationId, id: alertId, dismissedAt: null },
    data: { dismissedById: scope.actorId, dismissedAt: new Date() },
  });
  if (count !== 1) throw new PharmacyInventoryError('NOT_FOUND');
  return { id: alertId };
}
