import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { closeOrder } from './orders';

const actor = {
  staffProfileId: 'staff-1',
  deviceId: 'device-1',
  idempotencyKey: 'close-1',
};
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

function makeDb() {
  type IdempotencyRecord = {
    commandType: string;
    canonicalPayloadHash: string;
    resultRef: string | null;
  };
  let idempotency: IdempotencyRecord | null = null;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    restaurantOrder: {
      findUnique: vi.fn(async () => order),
      update: vi.fn(async () => order),
    },
    restaurantOrderTable: { updateMany: vi.fn() },
    restaurantOrderIdempotencyKey: {
      findUnique: vi.fn(async () => idempotency),
      create: vi.fn(async ({ data }: { data: Omit<IdempotencyRecord, 'resultRef'> }) => {
        idempotency = { ...data, resultRef: null };
        return idempotency;
      }),
      update: vi.fn(async ({ data }: { data: { resultRef: string } }) => {
        if (!idempotency) throw new Error('Cannot update a missing idempotency key');
        idempotency = { ...idempotency, ...data };
        return idempotency;
      }),
    },
  };
  const transaction = vi.fn((work: (scoped: ScopedDb) => Promise<unknown>) =>
    work(tx as unknown as ScopedDb)
  );
  return { db: { $transaction: transaction } as unknown as ScopedDb, transaction, tx };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.evaluateOrderSettlement.mockResolvedValue({ settled: true });
});

afterEach(() => vi.useRealTimers());

describe('closeOrder close time', () => {
  it('uses the supplied historical time once across persistence and close hooks', async () => {
    const historical = new Date('2026-08-15T19:42:00.000Z');
    const { db, tx } = makeDb();

    await expect(closeOrder(db, { orderId: order.id, actor, now: historical })).resolves.toEqual({
      orderId: order.id,
      replayed: false,
    });
    await expect(
      closeOrder(db, { orderId: order.id, actor, now: new Date(historical.getTime() + 1_000) })
    ).resolves.toEqual({
      orderId: order.id,
      replayed: true,
    });

    expect(tx.restaurantOrder.update).toHaveBeenCalledTimes(1);
    expect(tx.restaurantOrder.update).toHaveBeenCalledWith({
      where: { id: order.id },
      data: { status: 'CLOSED', closedAt: historical },
    });
    expect(tx.restaurantOrderTable.updateMany).toHaveBeenCalledWith({
      where: { orderId: order.id, active: true },
      data: { active: false, unlinkedAt: historical },
    });
    expect(mocks.earnLoyaltyForClosedOrder).toHaveBeenCalledTimes(1);
    expect(mocks.earnLoyaltyForClosedOrder).toHaveBeenCalledWith(tx, order.id, historical);
    expect(mocks.postOrderRecipeConsumption).toHaveBeenCalledTimes(1);
    expect(mocks.postOrderRecipeConsumption).toHaveBeenCalledWith(
      tx,
      order.id,
      order.branchId,
      order.items,
      { staffProfileId: actor.staffProfileId, deviceId: actor.deviceId },
      historical
    );
  });

  it.each([
    { orderId: 'order-2', actor },
    { orderId: order.id, actor: { ...actor, staffProfileId: 'staff-2' } },
  ])('rejects a replay with changed command data: %j', async (changedInput) => {
    const { db, tx } = makeDb();
    await closeOrder(db, { orderId: order.id, actor });

    await expect(closeOrder(db, changedInput)).rejects.toMatchObject({
      reason: 'IDEMPOTENCY_CONFLICT',
    });

    expect(tx.restaurantOrder.findUnique).toHaveBeenCalledTimes(1);
    expect(tx.restaurantOrder.update).toHaveBeenCalledTimes(1);
    expect(mocks.earnLoyaltyForClosedOrder).toHaveBeenCalledTimes(1);
    expect(mocks.postOrderRecipeConsumption).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid time before opening a transaction', async () => {
    const { db, transaction } = makeDb();

    await expect(
      closeOrder(db, { orderId: order.id, actor, now: new Date(Number.NaN) })
    ).rejects.toMatchObject({ reason: 'INVALID' });

    expect(transaction).not.toHaveBeenCalled();
  });

  it('uses the current clock when now is omitted', async () => {
    const current = new Date('2026-09-04T08:30:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(current);
    const { db, tx } = makeDb();

    await closeOrder(db, { orderId: order.id, actor });

    expect(tx.restaurantOrder.update).toHaveBeenCalledWith({
      where: { id: order.id },
      data: { status: 'CLOSED', closedAt: current },
    });
    expect(mocks.earnLoyaltyForClosedOrder).toHaveBeenCalledWith(tx, order.id, current);
    expect(mocks.postOrderRecipeConsumption).toHaveBeenCalledWith(
      tx,
      order.id,
      order.branchId,
      order.items,
      { staffProfileId: actor.staffProfileId, deviceId: actor.deviceId },
      current
    );
  });
});
