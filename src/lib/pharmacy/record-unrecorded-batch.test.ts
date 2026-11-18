import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const lockStockRowsFrom = vi.hoisted(() => vi.fn());
vi.mock('./stock-lock-order', () => ({ lockStockRowsFrom }));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { recordUnrecordedBatch } from './record-unrecorded-batch';

/**
 * DEV-853 — staff record the real batch and expiry of a legacy lot later. A
 * NULL is filled once; a recorded value is never rewritten here.
 */

const SCOPE = { organizationId: 'org', branchId: 'branch', actorId: 'user' };
const JUNE_2027 = {
  printedExpiry: new Date('2027-06-01T00:00:00.000Z'),
  precision: 'MONTH' as const,
};
const JUNE_2027_END = new Date('2027-06-30T19:00:00.000Z');

type Batch = {
  id: string;
  medicineId: string;
  batchNumber: string | null;
  expiresAt: Date | null;
  expiryPrecision: 'DAY' | 'MONTH';
  state?: 'ACTIVE' | 'RECALLED' | 'QUARANTINED';
};

function makeDb(own: Partial<Batch> = {}, existing: Batch | null = null) {
  const batches = new Map<string, Batch>();
  const ownBatch: Batch = {
    id: 'batch_own',
    medicineId: 'medicine',
    batchNumber: null,
    expiresAt: null,
    expiryPrecision: 'DAY',
    state: 'ACTIVE',
    ...own,
  };
  batches.set(ownBatch.id, ownBatch);
  if (existing) batches.set(existing.id, existing);
  const lot = {
    id: 'lot',
    manufacturingBatchId: ownBatch.id,
    receivedExpiresAt: null as Date | null,
  };
  const db = {
    pharmacyInventoryLot: {
      findFirst: vi
        .fn()
        .mockImplementation(async ({ where }: { where: { branchId: string } }) =>
          where.branchId === SCOPE.branchId
            ? { ...lot, batch: { ...batches.get(lot.manufacturingBatchId)! } }
            : null
        ),
      update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(lot, data);
        return lot;
      }),
    },
    pharmacyManufacturingBatch: {
      findFirst: vi
        .fn()
        .mockImplementation(
          async ({
            where,
          }: {
            where: { id?: string; batchNumber?: string; medicineId?: string };
          }) => {
            if (where.id) return batches.get(where.id) ?? null;
            return (
              [...batches.values()].find(
                (row) =>
                  row.batchNumber === where.batchNumber && row.medicineId === where.medicineId
              ) ?? null
            );
          }
        ),
      update: vi
        .fn()
        .mockImplementation(
          async ({ where, data }: { where: { organizationId_id: { id: string } }; data: object }) =>
            Object.assign(batches.get(where.organizationId_id.id)!, data)
        ),
    },
  };
  return { db: db as unknown as ScopedDb, models: db, lot, batches };
}

beforeEach(() => lockStockRowsFrom.mockReset());

describe('DEV-853 record batch and expiry for a legacy lot', () => {
  it('fills the unrecorded batch number and expiry once, on the batch and the lot', async () => {
    const { db, lot, batches } = makeDb();

    const result = await recordUnrecordedBatch(db, SCOPE, {
      inventoryLotId: 'lot',
      batchNumber: '  B-42 ',
      expiry: JUNE_2027,
    });

    expect(result).toMatchObject({ batchNumber: 'B-42', expiresAt: JUNE_2027_END });
    expect(batches.get('batch_own')).toMatchObject({
      batchNumber: 'B-42',
      expiresAt: JUNE_2027_END,
      expiryPrecision: 'MONTH',
    });
    expect(lot).toMatchObject({
      receivedExpiresAt: JUNE_2027_END,
      receivedExpiryPrecision: 'MONTH',
    });
    // Locked batch-then-lot before any write.
    expect(lockStockRowsFrom).toHaveBeenCalledWith(db, 'org', expect.anything(), {
      batch: 'update',
      lot: 'update',
    });
  });

  it('records only the expiry when the batch number is already known', async () => {
    const { db, batches } = makeDb({ batchNumber: 'B-1' });
    await recordUnrecordedBatch(db, SCOPE, { inventoryLotId: 'lot', expiry: JUNE_2027 });
    expect(batches.get('batch_own')).toMatchObject({
      batchNumber: 'B-1',
      expiresAt: JUNE_2027_END,
    });
  });

  it('never rewrites a recorded batch number or expiry', async () => {
    const recorded = makeDb({ batchNumber: 'B-1', expiresAt: JUNE_2027_END });
    await expect(
      recordUnrecordedBatch(recorded.db, SCOPE, { inventoryLotId: 'lot', batchNumber: 'B-2' })
    ).rejects.toMatchObject({ reason: 'BATCH_ALREADY_RECORDED' });
    await expect(
      recordUnrecordedBatch(recorded.db, SCOPE, { inventoryLotId: 'lot', expiry: JUNE_2027 })
    ).rejects.toMatchObject({ reason: 'EXPIRY_ALREADY_RECORDED' });
    expect(recorded.models.pharmacyManufacturingBatch.update).not.toHaveBeenCalled();
  });

  it('moves the lot onto the batch already recorded under that number', async () => {
    const existing: Batch = {
      id: 'batch_known',
      medicineId: 'medicine',
      batchNumber: 'B-9',
      expiresAt: JUNE_2027_END,
      expiryPrecision: 'MONTH',
    };
    const { db, lot } = makeDb({}, existing);

    const result = await recordUnrecordedBatch(db, SCOPE, {
      inventoryLotId: 'lot',
      batchNumber: 'B-9',
    });

    expect(lot.manufacturingBatchId).toBe('batch_known');
    expect(result).toMatchObject({ batchNumber: 'B-9', expiresAt: JUNE_2027_END });
  });

  it('refuses to join a recorded batch whose expiry disagrees with the pack', async () => {
    const existing: Batch = {
      id: 'batch_known',
      medicineId: 'medicine',
      batchNumber: 'B-9',
      expiresAt: new Date('2028-01-31T19:00:00.000Z'),
      expiryPrecision: 'MONTH',
    };
    const { db, lot } = makeDb({}, existing);
    await expect(
      recordUnrecordedBatch(db, SCOPE, {
        inventoryLotId: 'lot',
        batchNumber: 'B-9',
        expiry: JUNE_2027,
      })
    ).rejects.toMatchObject({ reason: 'BATCH_EXPIRY_CONFLICT' });
    expect(lot.manufacturingBatchId).toBe('batch_own');
  });

  it('never moves a recalled or quarantined lot onto another batch', async () => {
    const existing: Batch = {
      id: 'batch_known',
      medicineId: 'medicine',
      batchNumber: 'B-9',
      expiresAt: JUNE_2027_END,
      expiryPrecision: 'MONTH',
      state: 'ACTIVE',
    };
    const { db, lot, models } = makeDb({ state: 'RECALLED' }, existing);
    await expect(
      recordUnrecordedBatch(db, SCOPE, { inventoryLotId: 'lot', batchNumber: 'B-9' })
    ).rejects.toMatchObject({ reason: 'BATCH_BLOCKED' });
    expect(lot.manufacturingBatchId).toBe('batch_own');
    expect(models.pharmacyInventoryLot.update).not.toHaveBeenCalled();
  });

  it('refuses an empty request and a lot outside the branch', async () => {
    const { db } = makeDb();
    await expect(
      recordUnrecordedBatch(db, SCOPE, { inventoryLotId: 'lot', batchNumber: '   ' })
    ).rejects.toMatchObject({ reason: 'NOTHING_TO_RECORD' });
    await expect(
      recordUnrecordedBatch(
        db,
        { ...SCOPE, branchId: 'other' },
        {
          inventoryLotId: 'lot',
          batchNumber: 'B-1',
        }
      )
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
  });
});
