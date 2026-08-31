import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { Prisma } from '@/generated/prisma/client';

import {
  assessDeliveryDispatch,
  deliveryTransitionBody,
  readDeliveryHandoffQueue,
} from './terminal-delivery-dispatch';

const money = (value: string) => new Prisma.Decimal(value);
const readyItems = [{ status: 'PREPARED' }];

describe('KDS delivery dispatch projection', () => {
  it('derives PREPAID only from exact trusted coverage and COD only from open untendered bills', () => {
    expect(
      assessDeliveryDispatch('PENDING', null, readyItems, [
        { status: 'SETTLED', grandTotal: money('12.00'), tenders: [{ amount: money('12.00') }] },
      ])
    ).toEqual({ paymentMode: 'PREPAID', dispatchable: true, rejection: null });
    expect(
      assessDeliveryDispatch('PENDING', null, readyItems, [
        { status: 'OPEN', grandTotal: money('12.00'), tenders: [] },
      ])
    ).toEqual({ paymentMode: 'COD', dispatchable: true, rejection: null });
  });

  it.each([
    [[], 'Create a live bill'],
    [
      [
        {
          status: 'OPEN' as const,
          grandTotal: money('12.00'),
          tenders: [{ amount: money('2.00') }],
        },
      ],
      'Resolve partial or mixed payment',
    ],
    [
      [
        {
          status: 'SETTLED' as const,
          grandTotal: money('5.00'),
          tenders: [{ amount: money('5.00') }],
        },
        { status: 'OPEN' as const, grandTotal: money('7.00'), tenders: [] },
      ],
      'Resolve partial or mixed payment',
    ],
  ])('returns an actionable rejection for unsafe bill state', (bills, message) => {
    const assessment = assessDeliveryDispatch('PENDING', null, readyItems, bills);
    expect(assessment.dispatchable).toBe(false);
    expect(assessment.paymentMode).toBeNull();
    expect(assessment.rejection).toContain(message);
  });

  it('blocks dispatch before kitchen readiness but permits completion of an existing dispatch', () => {
    const bill = [{ status: 'OPEN' as const, grandTotal: money('12.00'), tenders: [] }];
    expect(assessDeliveryDispatch('PENDING', null, [{ status: 'FIRING' }], bill)).toMatchObject({
      dispatchable: false,
      rejection: expect.stringContaining('Kitchen handoff is not ready'),
    });
    expect(assessDeliveryDispatch('DISPATCHED', 'COD', [{ status: 'FIRING' }], bill)).toEqual({
      paymentMode: 'COD',
      dispatchable: false,
      rejection: null,
    });
  });

  it('rejects zero-live and all-VOIDED orders', () => {
    const bill = [{ status: 'OPEN' as const, grandTotal: money('12.00'), tenders: [] }];
    for (const items of [[], [{ status: 'VOIDED' }]]) {
      expect(assessDeliveryDispatch('PENDING', null, items, bill)).toMatchObject({
        dispatchable: false,
        rejection: expect.stringContaining('Kitchen handoff is not ready'),
      });
    }
  });

  it('rejects caller-supplied paymentMode', () => {
    expect(
      deliveryTransitionBody.safeParse({
        fulfillmentId: 'ful-1',
        status: 'DISPATCHED',
        operatorStaffProfileId: 'staff-1',
        paymentMode: 'COD',
      }).success
    ).toBe(false);
  });
});

describe('readDeliveryHandoffQueue privacy boundary', () => {
  const findMany = vi.fn();

  beforeEach(() => vi.clearAllMocks());

  it('returns only minimized address/locality and server-derived dispatch facts', async () => {
    findMany.mockResolvedValue([
      {
        id: 'ful-1',
        status: 'PENDING',
        paymentMode: null,
        recipientNameSnapshot: 'Amina Rahman',
        localitySnapshot: 'Clifton',
        zoneAreaPostalLabelSnapshot: 'Block 5',
        zoneNameSnapshot: 'Central',
        deliveryFeeSnapshot: money('3.50'),
        promisedAt: new Date('2026-08-31T13:00:00.000Z'),
        updatedAt: new Date('2026-08-31T12:00:00.000Z'),
        order: {
          orderNumber: 42,
          items: [{ status: 'PREPARED' }],
          bills: [{ status: 'OPEN', grandTotal: money('10.00'), tenders: [] }],
        },
      },
    ]);

    const queue = await readDeliveryHandoffQueue(
      { restaurantDeliveryFulfillment: { findMany } } as never,
      'branch-1'
    );

    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { branchId: 'branch-1', status: { in: ['PENDING', 'DISPATCHED'] } },
    });
    expect(queue[0]).toMatchObject({
      fulfillmentId: 'ful-1',
      customerName: 'Amina Rahman',
      addressLabel: 'Block 5',
      locality: 'Clifton',
      paymentMode: 'COD',
      dispatchable: true,
    });
    expect(JSON.stringify(queue)).not.toContain('phone');
    expect(JSON.stringify(queue)).not.toContain('instructions');
    expect(JSON.stringify(queue)).not.toContain('addressLine');
  });
});
