import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const mocks = vi.hoisted(() => ({ appendOrderEvent: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('./outbox', () => ({ appendOrderEvent: mocks.appendOrderEvent }));

import { moveTable } from './orders';

const actor = {
  staffProfileId: 'staff-1',
  deviceId: 'device-1',
  idempotencyKey: 'move-1',
};

function makeDb() {
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: 'order-1' }]),
    restaurantOrder: {
      findUnique: vi.fn(async () => ({
        id: 'order-1',
        organizationId: 'organization-1',
        branchId: 'branch-1',
        orderNumber: 1,
        status: 'OPEN',
        channel: 'DINE_IN',
        businessDate: new Date('2026-10-22T00:00:00.000Z'),
        publicationId: 'publication-1',
        items: [],
      })),
    },
    restaurantTable: {
      findMany: vi.fn(async () => [{ id: 'table-2', floor: { branchId: 'branch-1' } }]),
    },
    restaurantOrderTable: {
      findFirst: vi.fn(async () => ({ id: 'link-1' })),
      update: vi.fn(async () => ({ id: 'link-1' })),
      create: vi.fn(async () => ({ id: 'link-2' })),
    },
    restaurantOrderIdempotencyKey: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
  };
  const transaction = vi.fn((work: (scoped: ScopedDb) => Promise<unknown>) =>
    work(tx as unknown as ScopedDb)
  );
  return { db: { $transaction: transaction } as unknown as ScopedDb, tx };
}

beforeEach(() => vi.clearAllMocks());

describe('moveTable concurrency guard', () => {
  it('locks the order before loading it or reading its active source link', async () => {
    const { db, tx } = makeDb();

    await expect(
      moveTable(db, {
        orderId: 'order-1',
        fromTableId: 'table-1',
        toTableId: 'table-2',
        actor,
      })
    ).resolves.toEqual({ orderId: 'order-1', replayed: false });

    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.restaurantOrder.findUnique.mock.invocationCallOrder[0]
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.restaurantOrderTable.findFirst.mock.invocationCallOrder[0]
    );
  });
});
