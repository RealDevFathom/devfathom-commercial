import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { equals } from './money-arithmetic';
import { classifyTenderAmount } from './tenders';
import { getOrderForBranch } from './terminal-orders';

const at = new Date('2026-10-21T00:00:00.000Z');
const D = (value: string) => new Prisma.Decimal(value);

function dbFor(channel: 'DINE_IN' | 'TAKEAWAY') {
  const tax = {
    findMany: vi.fn(async () => [
      {
        id: 'profile-1',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
        status: 'PUBLISHED',
        approvalReference: 'TAX-1',
        approvedAt: new Date('2025-12-01T00:00:00.000Z'),
        rules: [
          {
            id: 'rule-cash',
            profileVersionId: 'profile-1',
            paymentCategory: 'CASH',
            priceMode: 'EXCLUSIVE',
            rate: { toString: () => '0.050000' },
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
            effectiveTo: null,
            status: 'PUBLISHED',
            approvalReference: 'TAX-1',
            approvedAt: new Date('2025-12-01T00:00:00.000Z'),
            officialSource: { expiresAt: new Date('2027-01-01T00:00:00.000Z') },
          },
          {
            id: 'rule-card',
            profileVersionId: 'profile-1',
            paymentCategory: 'CARD',
            priceMode: 'EXCLUSIVE',
            rate: { toString: () => '0.050000' },
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
            effectiveTo: null,
            status: 'PUBLISHED',
            approvalReference: 'TAX-1',
            approvedAt: new Date('2025-12-01T00:00:00.000Z'),
            officialSource: { expiresAt: new Date('2027-01-01T00:00:00.000Z') },
          },
          {
            id: 'rule-other',
            profileVersionId: 'profile-1',
            paymentCategory: 'OTHER',
            priceMode: 'EXCLUSIVE',
            rate: { toString: () => '0.050000' },
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
            effectiveTo: null,
            status: 'PUBLISHED',
            approvalReference: 'TAX-1',
            approvedAt: new Date('2025-12-01T00:00:00.000Z'),
            officialSource: { expiresAt: new Date('2027-01-01T00:00:00.000Z') },
          },
        ],
      },
    ]),
  };
  return {
    restaurantOrder: {
      findFirst: vi.fn(async () => ({
        id: 'order-1',
        branchId: 'branch-1',
        orderNumber: 1,
        businessDate: at,
        status: 'OPEN',
        channel,
        coverCount: 1,
        sectionId: null,
        serverStaffProfileId: null,
        staffProfileId: 'staff-1',
        deviceId: 'device-1',
        publicationId: null,
        openedAt: at,
        closedAt: null,
        cancelledAt: null,
        items: [
          {
            id: 'coffee',
            course: 1,
            seatNumber: null,
            productId: 'product-1',
            variantId: null,
            name: 'Coffee',
            unitPrice: D('4.00'),
            quantity: 1,
            taxAmount: D('99.00'),
            serviceChargeAmount: D('99.00'),
            status: 'SENT',
            remakeOfItemId: null,
            voidedPostPrep: false,
            wastageDisposition: null,
            voidReason: null,
            modifiers: [
              {
                id: 'mod-1',
                modifierOptionId: 'oat',
                name: 'Oat',
                priceDelta: D('0.50'),
              },
            ],
          },
        ],
        bills: [] as { serviceChargeTotal: Prisma.Decimal }[],
        orderTables: [],
        kitchenTickets: [],
        deliveryFulfillment: null,
      })),
    },
    restaurantTaxProfileVersion: tax,
    restaurantServiceChargePolicyVersion: {
      findFirst: vi.fn(async () => ({ rate: { toString: () => '0.100000' } })),
    },
  };
}

describe('order totals ignore stored tax and service', () => {
  it('quotes published dine-in tax and service, so a merchandise-only tender does not settle', async () => {
    const db = dbFor('DINE_IN');
    const detail = await getOrderForBranch(db as unknown as ScopedDb, 'order-1', 'branch-1');
    expect(detail?.items[0]?.taxAmount).toBe(D('99.00').toString());
    expect(detail?.totals.tax).toBe('0.23');
    expect(detail?.totals.serviceCharge).toBe('0.45');
    const due = D(detail!.totals.subtotal)
      .plus(detail!.totals.tax)
      .plus(detail!.totals.serviceCharge)
      .plus(detail!.totals.deliveryFee);
    expect(due.toFixed(2)).toBe('5.18');
    const merchandiseOnly = D('4.50');
    expect(classifyTenderAmount(merchandiseOnly, due)).toBe('OK');
    expect(equals(merchandiseOnly, due)).toBe(false);
  });

  it.each(['0.27', '0.45', '0.00'])(
    'uses live bill service %s after comps or policy changes, including zero',
    async (service) => {
      const db = dbFor('DINE_IN');
      const order = await db.restaurantOrder.findFirst();
      order.bills = [{ serviceChargeTotal: D(service) }];
      db.restaurantOrder.findFirst.mockResolvedValue(order);
      const detail = await getOrderForBranch(db as unknown as ScopedDb, 'order-1', 'branch-1');
      expect(detail?.totals.serviceCharge).toBe(service);
      expect(db.restaurantOrder.findFirst).toHaveBeenLastCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            bills: {
              where: { status: { not: 'VOID' } },
              select: { serviceChargeTotal: true },
            },
          }),
        })
      );
    }
  );

  it('does not add the dine-in service rate to a takeaway order', async () => {
    const detail = await getOrderForBranch(
      dbFor('TAKEAWAY') as unknown as ScopedDb,
      'order-1',
      'branch-1'
    );
    expect(detail?.totals.tax).toBe('0.23');
    expect(detail?.totals.serviceCharge).toBe('0.00');
  });
});
