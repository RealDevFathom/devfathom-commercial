import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { loadSettlementContext } from './tenders';

const at = new Date('2026-10-21T00:00:00.000Z');
const D = (value: string) => new Prisma.Decimal(value);

/** A branch with one published, no-tax profile (so merchandise is untouched) and a
 * live DINE_IN service-charge policy whose rate deliberately disagrees with the
 * snapshot the bill already froze. */
function dbFor(policyRate: string) {
  const serviceChargePolicy = {
    findFirst: vi.fn(async () => ({ rate: { toString: () => policyRate } })),
  };
  return {
    serviceChargePolicy,
    db: {
      restaurantTaxProfileVersion: {
        findMany: vi.fn(async () => [
          {
            id: 'profile-1',
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
            effectiveTo: null,
            status: 'PUBLISHED',
            approvalReference: 'TAX-1',
            approvedAt: new Date('2025-12-01T00:00:00.000Z'),
            rules: (['CASH', 'CARD', 'OTHER'] as const).map((category) => ({
              id: `rule-${category.toLowerCase()}`,
              profileVersionId: 'profile-1',
              paymentCategory: category,
              priceMode: 'EXCLUSIVE',
              rate: D('0'),
              effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
              effectiveTo: null,
              status: 'PUBLISHED',
              approvalReference: 'TAX-1',
              approvedAt: new Date('2025-12-01T00:00:00.000Z'),
              officialSource: { expiresAt: new Date('2027-01-01T00:00:00.000Z') },
            })),
          },
        ]),
      },
      organization: { findUnique: vi.fn(async () => ({ currency: 'USD' })) },
      restaurantBillLine: {
        findMany: vi.fn(async () => [
          {
            id: 'line-1',
            orderItemId: 'item-1',
            quantity: 1,
            unitPrice: D('100.00'),
            compAmount: D('0.00'),
            orderItem: { modifiers: [] },
          },
        ]),
      },
      restaurantPromotionBillApplicationSnapshot: { findMany: vi.fn(async () => []) },
      // Present so a regression that re-adds policy recompute would be caught by the
      // never-called assertion below, not by a missing-mock crash.
      restaurantServiceChargePolicyVersion: serviceChargePolicy,
      restaurantOrder: {
        findFirst: vi.fn(async () => ({ channel: 'DINE_IN' })),
      },
    },
  };
}

function billWith(serviceChargeTotal: string) {
  return {
    id: 'bill-1',
    organizationId: 'org-1',
    orderId: 'order-1',
    status: 'OPEN',
    grandTotal: D('0.00'),
    subtotal: D('100.00'),
    compTotal: D('0.00'),
    discountTotal: D('0.00'),
    serviceChargeTotal: D(serviceChargeTotal),
    deliveryFeeTotal: D('0.00'),
    roundingAdjustment: D('0.00'),
    branchId: 'branch-1',
    businessDate: at,
    splitKind: 'NONE',
    fractionNumerator: null,
    fractionDenominator: null,
  };
}

describe('settlement service charge is the bill snapshot, not the current policy', () => {
  it('uses bill.serviceChargeTotal and never reprices from the live policy', async () => {
    // The bill froze a 10.00 service charge at cut time. The branch policy has since
    // changed to 50% (would be 50.00 on this 100.00 basis) — settlement must ignore it.
    const { db, serviceChargePolicy } = dbFor('0.500000');
    const settlement = await loadSettlementContext(
      db as unknown as ScopedDb,
      billWith('10.00') as never,
      [],
      'CASH',
      at
    );

    expect(settlement.quote.serviceChargePayable.toFixed(2)).toBe('10.00');
    expect(settlement.quote.grandTotal.toFixed(2)).toBe('110.00');
    // The live service-charge policy is never consulted at settlement.
    expect(serviceChargePolicy.findFirst).not.toHaveBeenCalled();
  });

  it('tracks the snapshot when it changes, independent of any policy rate', async () => {
    const { db } = dbFor('0.999999');
    const settlement = await loadSettlementContext(
      db as unknown as ScopedDb,
      billWith('7.25') as never,
      [],
      'CASH',
      at
    );
    expect(settlement.quote.serviceChargePayable.toFixed(2)).toBe('7.25');
  });
});
