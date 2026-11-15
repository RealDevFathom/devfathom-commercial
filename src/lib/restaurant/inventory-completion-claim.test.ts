import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('server-only', () => ({}));

import { completeStockTransfer, InventoryError, postStockCount } from './inventory';

/**
 * DEV-181 — two overlapping completions of the same count/transfer must not
 * both append movements. Both requests read the eligible aggregate before
 * either commits; only the conditional status claim decides which one posts.
 */

type Status = string;

function makeDb() {
  const state = { countStatus: 'SUBMITTED' as Status, transferStatus: 'DRAFT' as Status };
  const movements: Array<Record<string, unknown>> = [];

  // Both readers resolve together, so each sees the pre-commit eligible state.
  let releaseReads!: () => void;
  const readsGate = new Promise<void>((resolve) => (releaseReads = resolve));
  let pendingReads = 0;
  const gatedRead = async <T>(value: () => T): Promise<T> => {
    const snapshot = value();
    pendingReads += 1;
    if (pendingReads === 2) releaseReads();
    await readsGate;
    return snapshot;
  };

  // Postgres re-evaluates the WHERE of a conditional UPDATE after the row lock,
  // so exactly one claimant matches; model that atomically here.
  const claim =
    (key: 'countStatus' | 'transferStatus') =>
    async ({ where, data }: { where: { status: Status }; data: { status: Status } }) => {
      if (state[key] !== where.status) return { count: 0 };
      state[key] = data.status;
      return { count: 1 };
    };

  const db: Record<string, unknown> = {
    restaurantStockCount: {
      findUnique: vi.fn(() =>
        gatedRead(() => ({
          id: 'count_1',
          status: state.countStatus,
          locationId: 'loc_a',
          lines: [
            { stockItemId: 'item_1', varianceQuantity: new Prisma.Decimal(-2) },
            { stockItemId: 'item_2', varianceQuantity: new Prisma.Decimal(0) },
          ],
        }))
      ),
      updateMany: vi.fn(claim('countStatus')),
      update: vi.fn(async ({ data }: { data: { status: Status } }) => {
        state.countStatus = data.status;
        return {};
      }),
    },
    restaurantStockTransfer: {
      findUnique: vi.fn(() =>
        gatedRead(() => ({
          id: 'transfer_1',
          status: state.transferStatus,
          sourceLocationId: 'loc_a',
          destinationLocationId: 'loc_b',
          lines: [{ stockItemId: 'item_1', quantity: new Prisma.Decimal(3) }],
        }))
      ),
      updateMany: vi.fn(claim('transferStatus')),
      update: vi.fn(async ({ data }: { data: { status: Status } }) => {
        state.transferStatus = data.status;
        return {};
      }),
    },
    restaurantStockItem: {
      findMany: vi.fn(async () => [
        { id: 'item_1', canonicalUnitId: 'unit_kg' },
        { id: 'item_2', canonicalUnitId: 'unit_kg' },
      ]),
    },
    restaurantUnitConversion: { findUnique: vi.fn(async () => null) },
    restaurantStockMovement: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        movements.push(data);
        return {
          id: `mv_${movements.length}`,
          stockItemId: data.stockItemId,
          locationId: data.locationId,
          reason: data.reason,
          quantity: data.quantity,
          unitCost: data.unitCost ?? null,
          batchId: data.batchId ?? null,
        };
      }),
    },
  };
  db.$transaction = vi.fn(async (work: (tx: ScopedDb) => Promise<unknown>) =>
    work(db as unknown as ScopedDb)
  );
  return { db: db as unknown as ScopedDb, state, movements };
}

describe('inventory completion claim (DEV-181)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts a SUBMITTED count once when two posts overlap', async () => {
    const { db, state, movements } = makeDb();

    const results = await Promise.allSettled([
      postStockCount(db, { stockCountId: 'count_1' }),
      postStockCount(db, { stockCountId: 'count_1' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(InventoryError);
    expect(rejected[0].reason).toMatchObject({ reason: 'COUNT_NOT_SUBMITTED' });

    expect(state.countStatus).toBe('POSTED');
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      reason: 'PHYSICAL_COUNT_ADJUSTMENT',
      stockItemId: 'item_1',
      countId: 'count_1',
    });
  });

  it('completes a DRAFT transfer once when two completions overlap', async () => {
    const { db, state, movements } = makeDb();

    const results = await Promise.allSettled([
      completeStockTransfer(db, { stockTransferId: 'transfer_1' }),
      completeStockTransfer(db, { stockTransferId: 'transfer_1' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(InventoryError);
    expect(rejected[0].reason).toMatchObject({ reason: 'TRANSFER_ALREADY_COMPLETE' });

    expect(state.transferStatus).toBe('RECEIVED');
    // One source OUT leg + one destination IN leg — never a second pair.
    expect(movements).toHaveLength(2);
    expect(movements.map((m) => [m.locationId, String(m.quantity)])).toEqual([
      ['loc_a', '-3'],
      ['loc_b', '3'],
    ]);
  });
});
