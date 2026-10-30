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
    includeChainedRemakes?: boolean;
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
          ...(options.includeChainedRemakes
            ? [
                {
                  id: 'coffee-remake-1',
                  course: 1,
                  seatNumber: null,
                  productId: 'product-1',
                  variantId: null,
                  name: 'Coffee remake',
                  unitPrice: D('40.00'),
                  quantity: 1,
                  taxAmount: D('0'),
                  serviceChargeAmount: D('0'),
                  status: 'SENT',
                  remakeOfItemId: 'coffee',
                  voidedPostPrep: false,
                  wastageDisposition: null,
                  voidReason: null,
                  modifiers: [],
                },
                {
                  id: 'coffee-remake-2',
                  course: 1,
                  seatNumber: null,
                  productId: 'product-1',
                  variantId: null,
                  name: 'Coffee second remake',
                  unitPrice: D('400.00'),
                  quantity: 1,
                  taxAmount: D('0'),
                  serviceChargeAmount: D('0'),
                  status: 'SENT',
                  remakeOfItemId: 'coffee-remake-1',
                  voidedPostPrep: false,
                  wastageDisposition: null,
                  voidReason: null,
                  modifiers: [],
                },
              ]
            : []),
        ],
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
      dbFor('DINE_IN', { billedServiceCharges: ['6.00'] }) as unknown as ScopedDb,
      'order-1',
      'branch-1'
    );

    expect(detail?.totals.serviceCharge).toBe('6');
  });

  it('shows the bill pinned service when the published rate changes after bill cut', async () => {
    const detail = await getOrderForBranch(
      dbFor('DINE_IN', {
        serviceChargeRate: '0.200000',
        billedServiceCharges: ['10.00'],
      }) as unknown as ScopedDb,
      'order-1',
      'branch-1'
    );

    expect(detail?.totals.serviceCharge).toBe('10');
  });

  it.each([
    { state: 'before bill cut', bills: [] as string[], service: '0.45' },
    { state: 'after bill cut', bills: ['0.45'], service: '0.45' },
  ])(
    'excludes chained remakes from totals $state while retaining their history',
    async ({ bills, service }) => {
      const detail = await getOrderForBranch(
        dbFor('DINE_IN', {
          billedServiceCharges: bills,
          includeChainedRemakes: true,
        }) as unknown as ScopedDb,
        'order-1',
        'branch-1'
      );

      expect(detail?.items.map(({ id, remakeOfItemId }) => ({ id, remakeOfItemId }))).toEqual([
        { id: 'coffee', remakeOfItemId: null },
        { id: 'coffee-remake-1', remakeOfItemId: 'coffee' },
        { id: 'coffee-remake-2', remakeOfItemId: 'coffee-remake-1' },
      ]);
      expect(detail?.totals).toEqual({
        subtotal: '4.5',
        tax: '0.23',
        serviceCharge: service,
        deliveryFee: '0',
      });
    }
  );
});
