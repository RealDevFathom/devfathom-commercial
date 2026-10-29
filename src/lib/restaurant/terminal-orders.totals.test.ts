import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { equals } from './money-arithmetic';
import { classifyTenderAmount } from './tenders';
import { getOrderForBranch } from './terminal-orders';

const at = new Date('2026-10-21T00:00:00.000Z');
const D = (value: string) => new Prisma.Decimal(value);

function dbFor(
  channel: 'DINE_IN' | 'TAKEAWAY',
  options: {
    serviceChargeRate?: string;
    billedServiceCharges?: string[];
    linePrices?: string[];
  } = {}
) {
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
        items: (options.linePrices ?? ['4.00']).map((unitPrice, index) => ({
          id: `item-${index + 1}`,
          course: 1,
          seatNumber: null,
          productId: 'product-1',
          variantId: null,
          name: 'Coffee',
          unitPrice: D(unitPrice),
          quantity: 1,
          taxAmount: D('99.00'),
          serviceChargeAmount: D('99.00'),
          status: 'SENT',
          remakeOfItemId: null,
          voidedPostPrep: false,
          wastageDisposition: null,
          voidReason: null,
          modifiers:
            index === 0 && options.linePrices === undefined
              ? [
                  {
                    id: 'mod-1',
                    modifierOptionId: 'oat',
                    name: 'Oat',
                    priceDelta: D('0.50'),
                  },
                ]
              : [],
        })),
        orderTables: [],
        kitchenTickets: [],
        bills: (options.billedServiceCharges ?? []).map((serviceChargeTotal) => ({
          serviceChargeTotal: D(serviceChargeTotal),
        })),
        deliveryFulfillment: null,
      })),
    },
    restaurantTaxProfileVersion: tax,
    restaurantServiceChargePolicyVersion: {
      findFirst: vi.fn(async () => ({
        rate: { toString: () => options.serviceChargeRate ?? '0.100000' },
      })),
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

  it('does not add the dine-in service rate to a takeaway order', async () => {
    const detail = await getOrderForBranch(
      dbFor('TAKEAWAY') as unknown as ScopedDb,
      'order-1',
      'branch-1'
    );
    expect(detail?.totals.tax).toBe('0.23');
    expect(detail?.totals.serviceCharge).toBe('0.00');
  });

  it('shows the live bills pinned service after a line comp instead of gross draft service', async () => {
    const detail = await getOrderForBranch(
      dbFor('DINE_IN', {
        linePrices: ['40.00', '60.00'],
        billedServiceCharges: ['6.00'],
      }) as unknown as ScopedDb,
      'order-1',
      'branch-1'
    );

    expect(detail?.totals.serviceCharge).toBe('6');
  });

  it('shows the bill pinned service when the published rate changes after bill cut', async () => {
    const detail = await getOrderForBranch(
      dbFor('DINE_IN', {
        linePrices: ['100.00'],
        serviceChargeRate: '0.200000',
        billedServiceCharges: ['10.00'],
      }) as unknown as ScopedDb,
      'order-1',
      'branch-1'
    );

    expect(detail?.totals.serviceCharge).toBe('10');
  });

  it('sums pinned service across the order live bills', async () => {
    const detail = await getOrderForBranch(
      dbFor('DINE_IN', {
        linePrices: ['100.00'],
        serviceChargeRate: '0.200000',
        billedServiceCharges: ['4.00', '6.00'],
      }) as unknown as ScopedDb,
      'order-1',
      'branch-1'
    );

    expect(detail?.totals.serviceCharge).toBe('10');
  });
});
