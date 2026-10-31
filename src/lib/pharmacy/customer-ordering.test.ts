import { describe, expect, it } from 'vitest';

import { cancelMyCustomerOrder, isCustomerOrderableMedicine, transitionCustomerOrder } from './customer-ordering';

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

  it('permits reviewed Rx while retaining saleability, restricted and controlled guards', () => {
    const rx = { ...otc, otc: false, rx: true };
    expect(isCustomerOrderableMedicine(rx, true)).toBe(true);
    expect(isCustomerOrderableMedicine(rx)).toBe(false);
    expect(isCustomerOrderableMedicine({ ...rx, saleable: false }, true)).toBe(false);
    expect(isCustomerOrderableMedicine({ ...rx, restricted: true }, true)).toBe(false);
    expect(isCustomerOrderableMedicine({ ...rx, controlled: true }, true)).toBe(false);
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


describe('chronic refill PREPAY dispatch', () => {
  it.each(['missing-sale', 'partial', 'credit', 'refunded'])(
    'refuses %s payment evidence before releasing a delivery', async (scenario) => {
      const db = {
        $queryRaw: async () => [{ id: 'cycle-1' }],
        pharmacyCustomerOrder: { findFirst: async () => ({
          id: 'order-1', status: 'PACKING', fulfillment: 'DELIVER',
          intendedPaymentMethod: 'BANK_TRANSFER',
          counterSaleId: scenario === 'missing-sale' ? null : 'sale-1',
        }) },
        user: { findFirst: async () => ({ id: 'runner-1' }) },
        pharmacySale: { findFirst: async () => ({
          status: 'COMPLETED',
          lines: [{ unitPriceMinor: 2000, quantity: 1, discountMinor: 0 }],
          tenders: [{ type: scenario === 'credit' ? 'CREDIT' : 'BANK_TRANSFER',
            amountMinor: scenario === 'partial' ? 1000 : 2000 }],
          refunds: scenario === 'refunded' ? [{ amountMinor: 1000 }] : [],
        }) },
      };
      await expect(transitionCustomerOrder(db as never, {
        organizationId: 'org-1', branchId: 'branch-1', actorId: 'owner-1',
      }, { orderId: 'order-1', action: 'dispatch', runnerUserId: 'runner-1' }))
        .rejects.toMatchObject({ reason: 'PREPAY_REQUIRED' });
    }
  );
});
