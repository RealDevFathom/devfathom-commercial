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

describe('DEV-63 dispatch distance', () => {
  function orderDb() {
    const updates: unknown[] = [];
    const db = {
      $queryRaw: async () => [],
      pharmacyCustomerOrder: {
        findFirst: async () => ({
          id: 'order-1',
          status: 'PACKING',
          fulfillment: 'DELIVER',
          counterSaleId: null,
          reservationExpiresAt: new Date(Date.now() + 60_000),
        }),
        update: async (input: unknown) => {
          updates.push(input);
          return input;
        },
      },
    };
    return { db: db as never, updates };
  }
  const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'staff-1' };

  it('records a distance only on dispatch and only within the stored range', async () => {
    for (const input of [
      { action: 'pack' as const, deliveryDistanceMeters: 1200 },
      { action: 'dispatch' as const, runnerUserId: 'runner-1', deliveryDistanceMeters: -1 },
      { action: 'dispatch' as const, runnerUserId: 'runner-1', deliveryDistanceMeters: 200_001 },
      { action: 'dispatch' as const, runnerUserId: 'runner-1', deliveryDistanceMeters: 1.5 },
    ]) {
      const { db, updates } = orderDb();
      await expect(
        transitionCustomerOrder(db, scope, { orderId: 'order-1', ...input })
      ).rejects.toMatchObject({ reason: 'INVALID_DELIVERY_DISTANCE' });
      expect(updates).toEqual([]);
    }
  });
});

describe('DEV-631 customer-order checkout on a closed business day', () => {
  function checkoutDb(dayClose: { id: string; reopen: { id: string } | null } | null) {
    const writes: string[] = [];
    const record = (name: string) => async () => {
      writes.push(name);
      return { id: `${name}-1`, count: 1 };
    };
    const db = {
      $queryRaw: vi.fn(async () => []),
      organization: { findUnique: async () => ({ timezone: 'UTC' }) },
      // DEV-958A: the branch's "day ends at" hour; none stored reads as midnight.
      pharmacyBranch: { findFirst: async () => null },
      pharmacyDailyClose: { findFirst: vi.fn(async () => dayClose) },
      pharmacyCustomerOrder: {
        findFirst: async () => ({
          id: 'order-1',
          status: 'READY_FOR_COLLECTION',
          counterSaleId: null,
          reservationExpiresAt: new Date(Date.now() + 60_000),
          lines: [],
          deliveryEvidence: [],
        }),
        update: record('order.update'),
      },
      pharmacyRestockReservation: {
        findMany: async () => [],
        updateMany: record('reservation.updateMany'),
      },
      pharmacyRestockInterest: { updateMany: record('interest.updateMany') },
      pharmacySale: { create: record('sale.create') },
    };
    return { db, writes };
  }

  it("refuses checkout while today's business day is closed, before any hold is released", async () => {
    const { db, writes } = checkoutDb({ id: 'close-1', reopen: null });
    const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'cashier-1' };
    await expect(startCustomerOrderCheckout(db as never, scope, 'order-1')).rejects.toMatchObject({
      reason: 'DAY_CLOSED',
    });
    expect(db.pharmacyDailyClose.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-1', branchId: 'branch-1' }),
      })
    );
    expect(writes).toEqual([]);
  });
});
