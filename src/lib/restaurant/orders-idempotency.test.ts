import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const mocks = vi.hoisted(() => ({
  appendOrderEvent: vi.fn(),
  earnLoyaltyForClosedOrder: vi.fn(),
  evaluateOrderSettlement: vi.fn(),
  postOrderRecipeConsumption: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('./bills', () => ({ evaluateOrderSettlement: mocks.evaluateOrderSettlement }));
vi.mock('./inventory', () => ({
  postOrderRecipeConsumption: mocks.postOrderRecipeConsumption,
}));
vi.mock('./loyalty', () => ({
  earnLoyaltyForClosedOrder: mocks.earnLoyaltyForClosedOrder,
}));
vi.mock('./outbox', () => ({ appendOrderEvent: mocks.appendOrderEvent }));

import { cancelOrder, closeOrder, moveTable, openOrder, orderCommandPayloadHash } from './orders';

type KeyRow = { commandType: string; payloadHash: string | null; resultRef: string | null };

const actor = { staffProfileId: 'staff-1', deviceId: 'device-1', idempotencyKey: 'key-1' };
const order = {
  id: 'order-1',
  organizationId: 'organization-1',
  branchId: 'branch-1',
  orderNumber: 1,
  status: 'PAYMENT_PENDING',
  channel: 'TAKEAWAY',
  businessDate: new Date('2026-08-31T00:00:00.000Z'),
  publicationId: 'publication-1',
  items: [{ id: 'item-1', status: 'SERVED' }],
};

function makeDb(seed: KeyRow | null = null) {
  let key: KeyRow | null = seed;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    restaurantOrder: {
      findUnique: vi.fn(async () => order),
      update: vi.fn(async () => order),
    },
    restaurantOrderTable: { updateMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    restaurantOrderIdempotencyKey: {
      findUnique: vi.fn(async () => key),
      create: vi.fn(async ({ data }: { data: Omit<KeyRow, 'resultRef'> }) => {
        key = { commandType: data.commandType, payloadHash: data.payloadHash, resultRef: null };
        return key;
      }),
      update: vi.fn(async ({ data }: { data: { resultRef: string } }) => {
        key = { ...key!, resultRef: data.resultRef };
        return key;
      }),
    },
  };
  const db = {
    $transaction: (work: (scoped: ScopedDb) => Promise<unknown>) => work(tx as unknown as ScopedDb),
  } as unknown as ScopedDb;
  return { db, tx, current: () => key };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.evaluateOrderSettlement.mockResolvedValue({ settled: true });
});

describe('order command idempotency binding', () => {
  it('hashes the command payload independent of key order, actor and server time', () => {
    const a = orderCommandPayloadHash({
      orderId: 'o',
      fromTableId: 'a',
      toTableId: 'b',
      actor,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    const b = orderCommandPayloadHash({
      toTableId: 'b',
      fromTableId: 'a',
      orderId: 'o',
      actor: { ...actor, staffProfileId: 'staff-2' },
      now: new Date('2026-02-02T00:00:00.000Z'),
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(orderCommandPayloadHash({ orderId: 'o', fromTableId: 'a', toTableId: 'c' })).not.toBe(a);
  });

  it('replays a terminal open-order retry after an operator handoff on the device', async () => {
    const request = {
      organizationId: 'organization-1',
      entitlementLimits: {},
      branchId: 'branch-1',
      channel: 'TAKEAWAY' as const,
      tableIds: ['t1'],
    };
    const first = { ...request, serverStaffProfileId: 'staff-1', actor };
    const { db, tx } = makeDb({
      commandType: 'order.open',
      payloadHash: orderCommandPayloadHash(first),
      resultRef: order.id,
    });
    const handoff = { ...actor, staffProfileId: 'staff-2' };

    await expect(
      openOrder(db, { ...request, serverStaffProfileId: 'staff-2', actor: handoff })
    ).resolves.toEqual({
      orderId: order.id,
      orderNumber: order.orderNumber,
      businessDate: order.businessDate,
      replayed: true,
    });
    expect(tx.restaurantOrderIdempotencyKey.create).not.toHaveBeenCalled();

    // An explicit assignment to someone other than the acting operator stays bound.
    await expect(
      openOrder(db, { ...request, serverStaffProfileId: 'staff-3', actor: handoff })
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
  });

  it('stores the command payload hash and replays only the identical command', async () => {
    const { db, tx, current } = makeDb();
    const input = { orderId: order.id, actor };

    await expect(closeOrder(db, input)).resolves.toEqual({ orderId: order.id, replayed: false });
    expect(current()).toEqual({
      commandType: 'order.close',
      payloadHash: orderCommandPayloadHash(input),
      resultRef: order.id,
    });

    await expect(closeOrder(db, { ...input, now: new Date() })).resolves.toEqual({
      orderId: order.id,
      replayed: true,
    });
    expect(tx.restaurantOrder.update).toHaveBeenCalledTimes(1);
  });

  it('rejects a key reused for a different command type instead of reporting a replay', async () => {
    const { db, tx } = makeDb({
      commandType: 'order.close',
      payloadHash: orderCommandPayloadHash({ orderId: 'order-1' }),
      resultRef: 'order-1',
    });

    await expect(
      cancelOrder(db, { orderId: 'order-1', reason: 'guest left', actor })
    ).rejects.toMatchObject({ name: 'OrderCommandError', reason: 'IDEMPOTENCY_CONFLICT' });
    expect(tx.restaurantOrderIdempotencyKey.create).not.toHaveBeenCalled();
  });

  it('rejects a key reused for the same command with a different payload', async () => {
    const { db } = makeDb({
      commandType: 'order.cancel',
      payloadHash: orderCommandPayloadHash({ orderId: 'order-1', reason: 'guest left' }),
      resultRef: 'order-1',
    });

    await expect(
      cancelOrder(db, { orderId: 'order-2', reason: 'guest left', actor })
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      moveTable(db, { orderId: 'order-1', fromTableId: 't1', toTableId: 't2', actor })
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
  });

  it('replays the stored result reference, not the new request ids', async () => {
    const payload = { orderId: 'order-original', fromTableId: 't1', toTableId: 't2' };
    const { db } = makeDb({
      commandType: 'table.move',
      payloadHash: orderCommandPayloadHash(payload),
      resultRef: 'order-original',
    });

    await expect(moveTable(db, { ...payload, actor })).resolves.toEqual({
      orderId: 'order-original',
      replayed: true,
    });

    // A key minted before payload binding replays its stored result for its own
    // command type only.
    const legacy = makeDb({ commandType: 'table.move', payloadHash: null, resultRef: 'order-a' });
    await expect(
      moveTable(legacy.db, { orderId: 'order-b', fromTableId: 't1', toTableId: 't2', actor })
    ).resolves.toEqual({ orderId: 'order-a', replayed: true });
    await expect(
      cancelOrder(legacy.db, { orderId: 'order-a', reason: 'x', actor })
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
  });
});
