import 'server-only';

/**
 * DEV-853 — record the real batch number and/or expiry of a lot that came in
 * without them (legacy opening stock).
 *
 * One-way: a value that is already recorded is never rewritten here (a wrong
 * recorded expiry is a stock correction, not this). A NULL is filled once.
 *
 * - Expiry: written to the lot's manufacturing batch (FEFO, the expiry board
 *   and every sale check read it there) and to the lot's received expiry.
 * - Batch number: if the medicine already has a batch with that number, the
 *   lot moves onto it (one physical batch is one row, so a recall reaches it);
 *   its expiry must agree. Otherwise the lot's own unrecorded batch takes the
 *   number.
 *
 * Recording a known expiry that has already passed is allowed — it is the
 * truth on the pack — and from then on the ordinary expired-stock block applies.
 */
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { expiryInstant, normalizeExpiryBoundary, type LedgerScope } from './stock-ledger';
import { lockStockRowsFrom } from './stock-lock-order';

export class PharmacyUnrecordedBatchError extends Error {
  constructor(
    readonly reason:
      | 'NOT_FOUND'
      | 'NOTHING_TO_RECORD'
      | 'INVALID_BATCH'
      | 'BATCH_ALREADY_RECORDED'
      | 'EXPIRY_ALREADY_RECORDED'
      | 'BATCH_EXPIRY_CONFLICT'
      | 'BATCH_BLOCKED'
  ) {
    super(reason);
    this.name = 'PharmacyUnrecordedBatchError';
  }
}

export const UNRECORDED_BATCH_MESSAGES: Record<PharmacyUnrecordedBatchError['reason'], string> = {
  NOT_FOUND: 'That lot is not in this branch.',
  NOTHING_TO_RECORD: 'Enter the batch number, the expiry, or both.',
  INVALID_BATCH: 'Enter the batch number as printed (up to 160 characters).',
  BATCH_ALREADY_RECORDED: 'This lot already has a batch number recorded.',
  EXPIRY_ALREADY_RECORDED: 'This lot already has an expiry recorded.',
  BATCH_EXPIRY_CONFLICT:
    'A batch with that number is already recorded with a different expiry. Check the pack.',
  BATCH_BLOCKED:
    'This lot is recalled or quarantined. Release it before recording its batch number.',
};

export type RecordUnrecordedBatchInput = {
  inventoryLotId: string;
  batchNumber?: string | null;
  expiry?: { printedExpiry: Date; precision: 'DAY' | 'MONTH' } | null;
};

/** Must run inside the caller's transaction. */
export async function recordUnrecordedBatch(
  db: ScopedDb,
  scope: LedgerScope,
  input: RecordUnrecordedBatchInput
) {
  const batchNumber = input.batchNumber?.trim() || null;
  if (batchNumber !== null && batchNumber.length > 160) {
    throw new PharmacyUnrecordedBatchError('INVALID_BATCH');
  }
  const expiry = input.expiry ?? null;
  if (batchNumber === null && expiry === null) {
    throw new PharmacyUnrecordedBatchError('NOTHING_TO_RECORD');
  }

  // Global stock lock order (stock-lock-order.ts): every batch first — the
  // lot's own and, when a number is being recorded, the one already carrying
  // that number — then the lot. A first unlocked read names them.
  const target = await db.pharmacyInventoryLot.findFirst({
    where: {
      id: input.inventoryLotId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
    select: { batch: { select: { medicineId: true } } },
  });
  if (!target) throw new PharmacyUnrecordedBatchError('NOT_FOUND');
  const findExisting = () =>
    batchNumber === null
      ? Promise.resolve(null)
      : db.pharmacyManufacturingBatch.findFirst({
          where: {
            organizationId: scope.organizationId,
            medicineId: target.batch.medicineId,
            batchNumber,
          },
          select: { id: true, expiresAt: true, expiryPrecision: true },
        });
  const named = await findExisting();
  await lockStockRowsFrom(
    db,
    scope.organizationId,
    Prisma.sql`
    SELECT lot."id" AS "inventoryLotId", lot."manufacturingBatchId" AS "batchId"
    FROM "pharmacy_inventory_lots" lot
    WHERE lot."organizationId" = ${scope.organizationId}
      AND lot."branchId" = ${scope.branchId}
      AND lot."id" = ${input.inventoryLotId}
    UNION ALL
    SELECT NULL::text AS "inventoryLotId", ${named?.id ?? null}::text AS "batchId"`,
    { batch: 'update', lot: 'update' }
  );

  const lot = await db.pharmacyInventoryLot.findFirst({
    where: {
      id: input.inventoryLotId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
    select: {
      id: true,
      manufacturingBatchId: true,
      receivedExpiresAt: true,
      batch: {
        select: {
          id: true,
          medicineId: true,
          batchNumber: true,
          expiresAt: true,
          expiryPrecision: true,
          state: true,
        },
      },
    },
  });
  if (!lot) throw new PharmacyUnrecordedBatchError('NOT_FOUND');
  if (batchNumber !== null && lot.batch.batchNumber !== null) {
    throw new PharmacyUnrecordedBatchError('BATCH_ALREADY_RECORDED');
  }
  if (expiry !== null && lot.batch.expiresAt !== null) {
    throw new PharmacyUnrecordedBatchError('EXPIRY_ALREADY_RECORDED');
  }

  const expiresAt = expiry === null ? null : expiryInstant(expiry.printedExpiry, expiry.precision);
  let batchId = lot.batch.id;
  let batchExpiresAt = lot.batch.expiresAt;
  let batchPrecision = lot.batch.expiryPrecision;

  if (batchNumber !== null) {
    const existing = await findExisting();
    if (existing && existing.id !== named?.id) {
      // Another request recorded this number between the read and the lock.
      throw new PharmacyUnrecordedBatchError('BATCH_EXPIRY_CONFLICT');
    }
    if (existing) {
      // A recall or quarantine lives on the batch. Moving a blocked lot onto
      // another batch would silently drop that block, so it is refused.
      if (lot.batch.state !== 'ACTIVE') throw new PharmacyUnrecordedBatchError('BATCH_BLOCKED');
      // The lot is unrecorded on at least the batch number, so its own expiry
      // (if any) must agree with the recorded batch it joins.
      const ownExpiry = expiresAt ?? lot.batch.expiresAt;
      if (
        ownExpiry !== null &&
        existing.expiresAt !== null &&
        normalizeExpiryBoundary(existing.expiresAt).getTime() !==
          normalizeExpiryBoundary(ownExpiry).getTime()
      ) {
        throw new PharmacyUnrecordedBatchError('BATCH_EXPIRY_CONFLICT');
      }
      await db.pharmacyInventoryLot.update({
        where: { organizationId_id: { organizationId: scope.organizationId, id: lot.id } },
        data: { manufacturingBatchId: existing.id },
      });
      batchId = existing.id;
      batchExpiresAt = existing.expiresAt;
      batchPrecision = existing.expiryPrecision;
      if (batchExpiresAt === null && ownExpiry !== null) {
        const precision = expiry?.precision ?? lot.batch.expiryPrecision;
        await db.pharmacyManufacturingBatch.update({
          where: { organizationId_id: { organizationId: scope.organizationId, id: existing.id } },
          data: { expiresAt: ownExpiry, expiryPrecision: precision },
        });
        batchExpiresAt = ownExpiry;
        batchPrecision = precision;
      }
    } else {
      await db.pharmacyManufacturingBatch.update({
        where: { organizationId_id: { organizationId: scope.organizationId, id: lot.batch.id } },
        data: { batchNumber },
      });
    }
  }

  if (expiresAt !== null && expiry !== null && batchExpiresAt === null) {
    await db.pharmacyManufacturingBatch.update({
      where: { organizationId_id: { organizationId: scope.organizationId, id: batchId } },
      data: { expiresAt, expiryPrecision: expiry.precision },
    });
    batchExpiresAt = expiresAt;
    batchPrecision = expiry.precision;
  }
  if (expiresAt !== null && expiry !== null && lot.receivedExpiresAt === null) {
    await db.pharmacyInventoryLot.update({
      where: { organizationId_id: { organizationId: scope.organizationId, id: lot.id } },
      data: { receivedExpiresAt: expiresAt, receivedExpiryPrecision: expiry.precision },
    });
  }

  const batch = await db.pharmacyManufacturingBatch.findFirst({
    where: { organizationId: scope.organizationId, id: batchId },
    select: { batchNumber: true, expiresAt: true },
  });
  return {
    inventoryLotId: lot.id,
    batchNumber: batch?.batchNumber ?? null,
    expiresAt: batch?.expiresAt ?? batchExpiresAt,
    expiryPrecision: batchPrecision,
  };
}
