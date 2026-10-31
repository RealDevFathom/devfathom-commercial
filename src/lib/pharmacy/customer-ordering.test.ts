import { describe, expect, it, vi } from 'vitest';

import {
  cancelMyCustomerOrder,
  isCustomerOrderableMedicine,
  isCustomerOrderReleaseEligible,
  isCustomerOrderReservationDeadlineEnforced,
  PharmacyCustomerOrderError,
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
  it('keeps a ready collection order recoverable after its proposal deadline', () => {
    expect(isCustomerOrderReleaseEligible('READY_FOR_COLLECTION')).toBe(true);
    expect(isCustomerOrderReservationDeadlineEnforced('READY_FOR_COLLECTION')).toBe(false);
  });

  it.each(['cancel', 'expire'] as const)(
    'releases and audits a ready collection order on %s',
    async (action) => {
      const order = {
        id: 'order-1',
        status: 'READY_FOR_COLLECTION',
        counterSaleId: null,
        reservationExpiresAt: new Date(Date.now() + (action === 'cancel' ? 60_000 : -60_000)),
      };
      const db = {
        $queryRaw: async () => [],
        pharmacyCustomerOrder: {
          findFirst: async () => ({ ...order }),
          update: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
            Object.assign(order, data)
          ),
        },
        pharmacyRestockInterest: {
          findMany: async () => [{ id: 'interest-1', demandEventId: 'demand-1' }],
          updateMany: vi.fn(),
        },
        pharmacyRestockReservation: { updateMany: vi.fn() },
        unfulfilledDemandEvent: { updateMany: vi.fn() },
        pharmacyCustomerOrderEvent: { create: vi.fn() },
      };
      const toStatus = action === 'cancel' ? 'CANCELLED' : 'EXPIRED';

      await expect(
        transitionCustomerOrder(
          db as never,
          { organizationId: 'org-1', branchId: 'branch-1', actorId: 'user-1' },
          { orderId: 'order-1', action }
        )
      ).resolves.toMatchObject({ status: toStatus });
      expect(db.pharmacyRestockReservation.updateMany).toHaveBeenCalledWith({
        where: {
          organizationId: 'org-1',
          branchId: 'branch-1',
          interestId: { in: ['interest-1'] },
          status: 'RESERVED',
        },
        data: { status: 'RELEASED', settledAt: expect.any(Date) },
      });
      expect(db.pharmacyRestockInterest.updateMany).toHaveBeenCalledWith({
        where: { organizationId: 'org-1', id: { in: ['interest-1'] } },
        data: { status: 'OPTED_OUT' },
      });
      expect(db.unfulfilledDemandEvent.updateMany).toHaveBeenCalledWith({
        where: { organizationId: 'org-1', id: { in: ['demand-1'] }, status: 'OPEN' },
        data: { status: 'CLOSED', closedAt: expect.any(Date) },
      });
      expect(db.pharmacyCustomerOrder.update).toHaveBeenCalledWith({
        where: { organizationId_id: { organizationId: 'org-1', id: 'order-1' } },
        data: {
          status: toStatus,
          [action === 'cancel' ? 'cancelledAt' : 'expiredAt']: expect.any(Date),
        },
      });
      expect(db.pharmacyCustomerOrderEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          organizationId: 'org-1',
          branchId: 'branch-1',
          orderId: 'order-1',
          actorUserId: 'user-1',
          kind: toStatus,
          fromStatus: 'READY_FOR_COLLECTION',
          toStatus,
        }),
      });
    }
  );

  it.each([
    ['READY_FOR_COLLECTION', null, 60_000, 'expire'],
    ['READY_FOR_COLLECTION', 'sale-1', -60_000, 'cancel'],
    ['READY_FOR_COLLECTION', 'sale-1', -60_000, 'expire'],
    ['OUT_FOR_DELIVERY', null, -60_000, 'cancel'],
    ['OUT_FOR_DELIVERY', null, -60_000, 'expire'],
    ['COMPLETED', null, -60_000, 'cancel'],
    ['CANCELLED', null, -60_000, 'expire'],
    ['EXPIRED', null, -60_000, 'cancel'],
    ['RETURNED', null, -60_000, 'expire'],
  ] as const)(
    'refuses release for %s with sale %s, deadline offset %i and action %s',
    async (status, counterSaleId, deadlineOffset, action) => {
      const releaseReservations = vi.fn();
      const db = {
        $queryRaw: async () => [],
        pharmacyCustomerOrder: {
          findFirst: async () => ({
            id: 'order-1',
            status,
            counterSaleId,
            reservationExpiresAt: new Date(Date.now() + deadlineOffset),
          }),
          update: vi.fn(),
        },
        pharmacyRestockReservation: { updateMany: releaseReservations },
        pharmacyCustomerOrderEvent: { create: vi.fn() },
      };

      await expect(
        transitionCustomerOrder(
          db as never,
          { organizationId: 'org-1', branchId: 'branch-1', actorId: 'user-1' },
          { orderId: 'order-1', action }
        )
      ).rejects.toMatchObject({
        reason: 'INVALID_STATE',
      } satisfies Partial<PharmacyCustomerOrderError>);
      expect(releaseReservations).not.toHaveBeenCalled();
      expect(db.pharmacyCustomerOrder.update).not.toHaveBeenCalled();
      expect(db.pharmacyCustomerOrderEvent.create).not.toHaveBeenCalled();
    }
  );

  it('allows checkout after delivery handoff without making dispatched stock releasable', () => {
    expect(isCustomerOrderReleaseEligible('OUT_FOR_DELIVERY')).toBe(false);
    expect(isCustomerOrderReservationDeadlineEnforced('OUT_FOR_DELIVERY')).toBe(false);
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
