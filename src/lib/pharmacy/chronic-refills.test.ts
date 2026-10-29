import { describe, expect, it, vi } from 'vitest';

vi.mock('./customer-ordering', () => ({ placeCustomerOrder: vi.fn() }));

import { placeCustomerOrder } from './customer-ordering';
import {
  chronicRefillReminderText,
  ChronicRefillError,
  createDueChronicRefillOrder,
} from './chronic-refills';

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'owner-1' };
const subscription = {
  id: 'subscription-1',
  customerId: 'customer-1',
  fulfillment: 'COLLECT' as const,
  paymentMode: 'KHATA' as const,
  addressLine: null,
  city: null,
  deliveryInstructions: null,
  cadenceDays: 30,
  nextDueAt: new Date('2026-10-29T00:00:00.000Z'),
  medicineId: 'medicine-1',
  presentationId: 'presentation-1',
  packLevelId: 'pack-1',
  quantityPacks: 1,
  prescriptionLineId: 'rx-line-1',
  rx: true,
};

function db(rows: unknown[][]) {
  return {
    $queryRaw: vi.fn().mockImplementation(() => Promise.resolve(rows.shift() ?? [])),
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
}

describe('chronic refill cycles', () => {
  it('uses neutral utility copy with no API capable of receiving clinical names', () => {
    expect(
      chronicRefillReminderText({
        pharmacyName: 'Community Pharmacy',
        dueDate: new Date('2026-11-01T00:00:00.000Z'),
        fulfillment: 'COLLECT',
      })
    ).toBe(
      'Community Pharmacy: your monthly order is scheduled for collection on 2026-11-01. Reply YES to confirm or call us to make a change.'
    );
  });

  it('requires a fresh signed pharmacist decision for every Rx cycle', async () => {
    const database = db([[subscription]]);
    await expect(
      createDueChronicRefillOrder(database as never, scope, {
        subscriptionId: subscription.id,
        now: subscription.nextDueAt,
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ChronicRefillError>>({
        reason: 'PHARMACIST_APPROVAL_REQUIRED',
      })
    );
    expect(placeCustomerOrder).not.toHaveBeenCalled();
  });

  it('creates a Khata due order that reserves the monthly pack and records its cycle', async () => {
    const database = db([[subscription], [{ id: 'approval-1' }]]);
    vi.mocked(placeCustomerOrder).mockResolvedValueOnce({ id: 'order-1' } as never);
    const result = await createDueChronicRefillOrder(database as never, scope, {
      subscriptionId: subscription.id,
      pharmacistDecisionId: 'approval-1',
      now: subscription.nextDueAt,
    });
    expect(placeCustomerOrder).toHaveBeenCalledWith(
      database,
      scope,
      expect.objectContaining({
        customerId: 'customer-1',
        intendedPaymentMethod: 'CREDIT',
        reviewedRx: true,
        lines: [expect.objectContaining({ packLevelId: 'pack-1', quantity: 1 })],
      })
    );
    expect(database.$executeRaw).toHaveBeenCalledTimes(2);
    expect(result).toEqual({
      order: { id: 'order-1' },
      nextDueAt: new Date('2026-11-28T00:00:00.000Z'),
    });
  });
});
