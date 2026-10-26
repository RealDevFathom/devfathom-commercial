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

import { cancelOrder, closeOrder } from './orders';

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
  let idempotency: { resultRef: string | null } | null = null;
  const tx = {
    $queryRaw: vi.fn(async () => []),
    restaurantOrder: {
      findUnique: vi.fn(async () => order),
      update: vi.fn(async () => order),
    },
    restaurantOrderTable: { updateMany: vi.fn() },
    restaurantOrderIdempotencyKey: {
      findUnique: vi.fn(async () => idempotency),
      create: vi.fn(async () => {
        idempotency = { resultRef: null };
        return idempotency;
      }),
      update: vi.fn(async ({ data }: { data: { resultRef: string } }) => {
        idempotency = { resultRef: data.resultRef };
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
    await expect(closeOrder(db, { orderId: order.id, actor, now: historical })).resolves.toEqual({
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

describe('cancelOrder recipe consumption', () => {
  it('posts prepared waste atomically with the persisted cancellation state and only once on replay', async () => {
    const preparedItem = {
      id: 'item-1',
      status: 'PREPARED',
      course: 1,
      quantity: 2,
      productId: 'product-1',
      variantId: null,
      name: 'Prepared meal',
      unitPrice: 10,
      taxAmount: 0,
      serviceChargeAmount: 0,
      seatNumber: null,
      wastageDisposition: null,
      product: { categoryId: null },
    };
    const pendingItem = {
      ...preparedItem,
      id: 'item-2',
      status: 'NEW',
      name: 'Unprepared meal',
    };
    const preparedOrder = { ...order, status: 'READY', items: [preparedItem, pendingItem] };
    let idempotency: { resultRef: string | null } | null = null;
    const tx = {
      $queryRaw: vi.fn(async () => []),
      restaurantOrder: {
        findUnique: vi.fn(async () => preparedOrder),
        update: vi.fn(async () => preparedOrder),
      },
      restaurantOrderItem: {
        update: vi.fn(async ({ where }: { where: { id: string } }) =>
          where.id === preparedItem.id ? preparedItem : pendingItem
        ),
      },
      restaurantOrderTable: { updateMany: vi.fn() },
      restaurantCoAuthorization: { create: vi.fn(async () => ({ id: 'co-auth-1' })) },
      restaurantOrderIdempotencyKey: {
        findUnique: vi.fn(async () => idempotency),
        create: vi.fn(async () => {
          idempotency = { resultRef: null };
          return idempotency;
        }),
        update: vi.fn(async ({ data }: { data: { resultRef: string } }) => {
          idempotency = { resultRef: data.resultRef };
          return idempotency;
        }),
      },
    };
    const db = {
      $transaction: vi.fn((work: (scoped: ScopedDb) => Promise<unknown>) =>
        work(tx as unknown as ScopedDb)
      ),
    } as unknown as ScopedDb;

    await expect(
      cancelOrder(db, {
        orderId: preparedOrder.id,
        reason: 'discarded meal',
        wastageDisposition: 'WASTE',
        approvingStaffProfileId: 'manager-1',
        actor: { ...actor, idempotencyKey: 'cancel-1' },
      })
    ).resolves.toEqual({ orderId: preparedOrder.id, replayed: false });
    await expect(
      cancelOrder(db, {
        orderId: preparedOrder.id,
        reason: 'discarded meal',
        wastageDisposition: 'WASTE',
        approvingStaffProfileId: 'manager-1',
        actor: { ...actor, idempotencyKey: 'cancel-1' },
      })
    ).resolves.toEqual({ orderId: preparedOrder.id, replayed: true });

    expect(mocks.postOrderRecipeConsumption).toHaveBeenCalledTimes(1);
    expect(mocks.postOrderRecipeConsumption).toHaveBeenCalledWith(
      tx,
      preparedOrder.id,
      preparedOrder.branchId,
      [
        expect.objectContaining({
          id: preparedItem.id,
          status: 'VOIDED',
          wastageDisposition: 'WASTE',
        }),
        expect.objectContaining({
          id: pendingItem.id,
          status: 'VOIDED',
          wastageDisposition: 'NONE',
        }),
      ],
      { staffProfileId: actor.staffProfileId, deviceId: actor.deviceId },
      expect.any(Date)
    );
    expect(tx.restaurantOrder.update).toHaveBeenCalledWith({
      where: { id: preparedOrder.id },
      data: { status: 'CANCELLED', cancelledAt: expect.any(Date) },
    });
    expect(tx.restaurantOrderItem.update).toHaveBeenCalledWith({
      where: { id: pendingItem.id },
      data: expect.objectContaining({
        status: 'VOIDED',
        voidedPostPrep: false,
        wastageDisposition: 'NONE',
        voidCoAuthorizationId: null,
      }),
    });
  });
});
