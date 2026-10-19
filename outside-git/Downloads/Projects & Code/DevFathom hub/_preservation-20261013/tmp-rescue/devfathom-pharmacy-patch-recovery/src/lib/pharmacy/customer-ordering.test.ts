import { describe, expect, it, vi } from 'vitest';

import {
  cancelMyCustomerOrder,
  isCustomerOrderableMedicine,
  startCustomerOrderCheckout,
  transitionCustomerOrder,
} from './customer-ordering';

const otc = {
  saleable: true,
  otc: true,
  rx: false,
  restricted: false,
  controlled: false,
};

describe('reserved-lot handoff revalidation', () => {
  const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'staff-1' };
  const safe = {
    ...otc,
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    orderLineId: 'line-1',
    inventoryLotId: 'lot-1',
    stockLocationId: 'location-1',
    batchState: 'ACTIVE',
    disposition: 'AVAILABLE',
    receivedAt: new Date('2020-01-01'),
    expiresAt: new Date('2100-01-01'),
    availableUnits: 3,
    reservedUnits: 3,
  };

  function fixture(action: 'ready' | 'dispatch', reservations = [safe]) {
    const order = {
      id: 'order-1',
      status: 'PACKING',
      fulfillment: action === 'ready' ? 'COLLECT' : 'DELIVER',
      reservationExpiresAt: new Date('2100-01-01'),
    };
    const db = {
      $queryRaw: vi.fn(async (query: { strings: string[] }) =>
        query.strings.join('').includes('handoff_reservations') ? reservations : []
      ),
      pharmacyCustomerOrder: { findFirst: vi.fn(async () => order), update: vi.fn() },
      pharmacyCustomerOrderLine: {
        findMany: vi.fn(async () => [{ id: 'line-1', canonicalUnits: 3 }]),
      },
      pharmacyCustomerOrderEvent: { create: vi.fn() },
      user: { findFirst: vi.fn(async () => ({ id: 'runner-1' })) },
    };
    const run = () =>
      transitionCustomerOrder(db as never, scope, {
        orderId: order.id,
        action,
        runnerUserId: 'runner-1',
      });
    return { db, order, run };
  }

  for (const action of ['ready', 'dispatch'] as const) {
    it.each([
      ['recalled', { batchState: 'RECALLED' }],
      ['batch quarantined', { batchState: 'QUARANTINED' }],
      ['stock quarantined', { disposition: 'QUARANTINE' }],
      ['expired', { expiresAt: new Date('2020-01-01') }],
      ['unreceived', { receivedAt: null }],
      ['revoked saleability', { saleable: false }],
      ['revoked OTC', { otc: false }],
      ['prescription only', { rx: true }],
      ['restricted', { restricted: true }],
      ['controlled', { controlled: true }],
      ['understocked', { availableUnits: 2 }],
      ['wrong tenant', { organizationId: 'org-2' }],
      ['wrong branch', { branchId: 'branch-2' }],
    ])(`${action} rejects %s before any state/event write`, async (_reason, change) => {
      const f = fixture(action, [{ ...safe, ...change } as typeof safe]);
      await expect(f.run()).rejects.toThrow('RESERVATION_UNAVAILABLE');
      expect(f.db.pharmacyCustomerOrder.update).not.toHaveBeenCalled();
      expect(f.db.pharmacyCustomerOrderEvent.create).not.toHaveBeenCalled();
    });

    it.each([
      { rows: [] },
      { rows: [{ ...safe, reservedUnits: 2 }] },
      { rows: [{ ...safe, reservedUnits: 4 }] },
    ])(`${action} rejects missing or mismatched reservation coverage`, async ({ rows }) => {
      const f = fixture(action, rows);
      await expect(f.run()).rejects.toThrow('RESERVATION_UNAVAILABLE');
      expect(f.db.pharmacyCustomerOrder.update).not.toHaveBeenCalled();
      expect(f.db.pharmacyCustomerOrderEvent.create).not.toHaveBeenCalled();
    });

    it(`${action} rejects expired reservation before writes`, async () => {
      const f = fixture(action);
      f.order.reservationExpiresAt = new Date('2020-01-01');
      await expect(f.run()).rejects.toThrow('RESERVATION_UNAVAILABLE');
      expect(f.db.pharmacyCustomerOrder.update).not.toHaveBeenCalled();
      expect(f.db.pharmacyCustomerOrderEvent.create).not.toHaveBeenCalled();
    });

    it(`${action} rejects reservation expiry during awaited lot lock with zero writes`, async () => {
      const f = fixture(action);
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2099-12-31T23:59:59Z'));
        f.db.$queryRaw.mockImplementation(async (query) => {
          if (query.strings.join('').includes('handoff_reservations')) {
            await Promise.resolve();
            vi.setSystemTime(f.order.reservationExpiresAt);
            return [{ ...safe, expiresAt: new Date('2101-01-01') }];
          }
          return [];
        });
        await expect(f.run()).rejects.toThrow('RESERVATION_UNAVAILABLE');
        expect(f.db.pharmacyCustomerOrder.update).not.toHaveBeenCalled();
        expect(f.db.pharmacyCustomerOrderEvent.create).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it(`${action} accepts exact safe split-lot coverage`, async () => {
      const f = fixture(action, [
        { ...safe, reservedUnits: 1 },
        { ...safe, inventoryLotId: 'lot-2', reservedUnits: 2 },
      ]);
      await f.run();
      expect(f.db.pharmacyCustomerOrder.update).toHaveBeenCalledOnce();
      expect(f.db.pharmacyCustomerOrderEvent.create).toHaveBeenCalledOnce();
    });
  }

  it('rejects fresh checkout after reservation expiry before any writes', async () => {
    const f = fixture('ready');
    f.order.status = 'READY_FOR_COLLECTION';
    f.order.reservationExpiresAt = new Date('2020-01-01');
    await expect(startCustomerOrderCheckout(f.db as never, scope, f.order.id)).rejects.toThrow(
      'RESERVATION_UNAVAILABLE'
    );
    expect(f.db.pharmacyCustomerOrder.update).not.toHaveBeenCalled();
    expect(f.db.pharmacyCustomerOrderEvent.create).not.toHaveBeenCalled();
  });

  it('replays an already started checkout after reservation expiry without stock access', async () => {
    const f = fixture('ready');
    Object.assign(f.order, {
      status: 'READY_FOR_COLLECTION',
      counterSaleId: 'sale-1',
      reservationExpiresAt: new Date('2020-01-01'),
    });
    await expect(startCustomerOrderCheckout(f.db as never, scope, f.order.id)).resolves.toEqual({
      saleId: 'sale-1',
      replayed: true,
    });
    expect(f.db.pharmacyCustomerOrderLine.findMany).not.toHaveBeenCalled();
    expect(f.db.pharmacyCustomerOrder.update).not.toHaveBeenCalled();
  });

  it('revalidates at checkout before releasing held stock', async () => {
    const f = fixture('dispatch', [{ ...safe, batchState: 'RECALLED' }]);
    f.order.status = 'OUT_FOR_DELIVERY';
    await expect(startCustomerOrderCheckout(f.db as never, scope, f.order.id)).rejects.toThrow(
      'RESERVATION_UNAVAILABLE'
    );
    expect(f.db.pharmacyCustomerOrder.update).not.toHaveBeenCalled();
    expect(f.db.pharmacyCustomerOrderEvent.create).not.toHaveBeenCalled();
  });
});

describe('MKT-03 customer-order catalogue eligibility', () => {
  it('allows only saleable non-prescription OTC medicine', () => {
    expect(isCustomerOrderableMedicine(otc)).toBe(true);
    expect(isCustomerOrderableMedicine({ ...otc, saleable: false })).toBe(false);
    expect(isCustomerOrderableMedicine({ ...otc, otc: false })).toBe(false);
  });

  it('never permits prescription-only or controlled medicine', () => {
    expect(isCustomerOrderableMedicine({ ...otc, rx: true })).toBe(false);
    expect(isCustomerOrderableMedicine({ ...otc, restricted: true })).toBe(false);
    expect(isCustomerOrderableMedicine({ ...otc, controlled: true })).toBe(false);
  });
});

describe('MKT-03/MKT-05 reservation lifecycle', () => {
  it('fails closed when customer identity is absent instead of omitting the owner filter', async () => {
    const db = {
      $queryRaw: vi.fn(async () => []),
      pharmacyCustomer: { findFirst: vi.fn(async () => null) },
      pharmacyCustomerOrder: { findFirst: vi.fn() },
    };
    await expect(
      cancelMyCustomerOrder(
        db as never,
        {
          organizationId: 'org-1',
          branchId: 'branch-1',
          actorId: 'not-a-customer',
        },
        'someone-elses-order'
      )
    ).rejects.toThrow('CUSTOMER_NOT_FOUND');
    expect(db.pharmacyCustomerOrder.findFirst).not.toHaveBeenCalled();
  });
  it('releases the linked DEM-03 reservation and audits customer cancellation', async () => {
    const calls: Array<[string, unknown]> = [];
    const db = {
      $queryRaw: async () => [],
      pharmacyCustomer: { findFirst: async () => ({ id: 'customer-1' }) },
      pharmacyCustomerOrder: {
        findFirst: async () => ({
          id: 'order-1',
          status: 'PROPOSED',
          counterSaleId: null,
        }),
        update: async (input: unknown) => {
          calls.push(['order.update', input]);
          return {};
        },
      },
      pharmacyRestockInterest: {
        findMany: async () => [{ id: 'interest-1', demandEventId: 'demand-1' }],
        updateMany: async (input: unknown) => {
          calls.push(['interest.updateMany', input]);
          return { count: 1 };
        },
      },
      pharmacyRestockReservation: {
        updateMany: async (input: unknown) => {
          calls.push(['reservation.updateMany', input]);
          return { count: 1 };
        },
      },
      unfulfilledDemandEvent: {
        updateMany: async (input: unknown) => {
          calls.push(['demand.updateMany', input]);
          return { count: 1 };
        },
      },
      pharmacyCustomerOrderEvent: {
        create: async (input: unknown) => {
          calls.push(['event.create', input]);
          return {};
        },
      },
    };

    await cancelMyCustomerOrder(
      db as never,
      { organizationId: 'org-1', branchId: 'branch-1', actorId: 'user-1' },
      'order-1'
    );

    expect(calls).toEqual(
      expect.arrayContaining([
        [
          'reservation.updateMany',
          expect.objectContaining({ data: expect.objectContaining({ status: 'RELEASED' }) }),
        ],
        ['interest.updateMany', expect.objectContaining({ data: { status: 'OPTED_OUT' } })],
        [
          'demand.updateMany',
          expect.objectContaining({ data: expect.objectContaining({ status: 'CLOSED' }) }),
        ],
        [
          'event.create',
          expect.objectContaining({
            data: expect.objectContaining({
              kind: 'CANCELLED',
              fromStatus: 'PROPOSED',
              toStatus: 'CANCELLED',
              actorUserId: 'user-1',
            }),
          }),
        ],
      ])
    );
  });
});
