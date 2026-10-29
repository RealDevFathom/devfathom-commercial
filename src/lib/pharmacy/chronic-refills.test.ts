import { describe, expect, it, vi } from 'vitest';

vi.mock('./customer-ordering', () => ({ placeCustomerOrder: vi.fn() }));

import { placeCustomerOrder } from './customer-ordering';
import {
  chronicRefillReminderText,
  ChronicRefillError,
  createChronicRefillSubscription,
  createDueChronicRefillOrder,
  updateChronicRefillSubscription,
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

function sqlText(value: unknown) {
  return (value as { strings: string[] }).strings.join('?');
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

  it('rejects an Rx subscription when the prescription does not match the customer and item', async () => {
    const database = db([[]]);
    await expect(
      createChronicRefillSubscription(database as never, scope, {
        customerId: 'customer-1',
        medicineId: 'medicine-2',
        presentationId: 'presentation-2',
        packLevelId: 'pack-2',
        quantityPacks: 1,
        prescriptionLineId: 'rx-line-1',
        fulfillment: 'COLLECT',
        paymentMode: 'PREPAY',
        cadenceDays: 30,
        nextDueAt: subscription.nextDueAt,
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ChronicRefillError>>({ reason: 'SUBSCRIPTION_ITEM_INVALID' })
    );
    const query = sqlText(database.$queryRaw.mock.calls[0]?.[0]);
    expect(query).toContain('prescription."patientId" = customer."patientId"');
    expect(query).toContain('rx_line."medicineId" = medicine."id"');
    expect(query).toContain('rx_line."presentationId" = presentation."id"');
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
    const approvalQuery = sqlText(database.$queryRaw.mock.calls[1]?.[0]);
    expect(approvalQuery).toContain('sale_line."medicineId" = subscription."medicineId"');
    expect(approvalQuery).toContain('sale_line."presentationId" = subscription."presentationId"');
    expect(approvalQuery).toContain('customer."id" = subscription."customerId"');
    expect(approvalQuery).toContain('sale_line."quantity" = subscription."quantityPacks"');
    expect(result).toEqual({
      order: { id: 'order-1' },
      nextDueAt: new Date('2026-11-28T00:00:00.000Z'),
    });
  });

  it('records an immutable lifecycle event when a subscription is paused', async () => {
    const database = db([[{ id: subscription.id, active: true, cancelledAt: null }]]);
    await expect(
      updateChronicRefillSubscription(database as never, scope, {
        subscriptionId: subscription.id,
        action: 'PAUSE',
      })
    ).resolves.toMatchObject({ id: subscription.id, active: false });
    expect(database.$executeRaw).toHaveBeenCalledTimes(2);
    expect(sqlText(database.$executeRaw.mock.calls[1]?.[0])).toContain(
      'pharmacy_chronic_refill_events'
    );
  });
});
