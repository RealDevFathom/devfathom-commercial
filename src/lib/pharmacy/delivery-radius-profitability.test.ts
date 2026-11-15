import { describe, expect, it, vi } from 'vitest';

import {
  DeliveryRadiusAssumptionError,
  deliveryRadiusProfitability,
  loadDeliveryRadiusOrders,
} from './delivery-radius-profitability';

const assumptions = {
  bandEdgesMeters: [2000, 5000],
  costPerKmMinor: 3000,
  fixedCostPerOrderMinor: 5000,
};

describe('DEV-63 delivery radius profitability', () => {
  it('bands delivered orders by recorded distance and nets the estimated delivery cost', () => {
    const report = deliveryRadiusProfitability(
      [
        { orderId: 'a', distanceMeters: 1000, revenueMinor: 50_000, cogsMinor: 30_000 },
        { orderId: 'b', distanceMeters: 1999, revenueMinor: 20_000, cogsMinor: 10_000 },
        { orderId: 'c', distanceMeters: 2000, revenueMinor: 30_000, cogsMinor: 20_000 },
        { orderId: 'd', distanceMeters: 9000, revenueMinor: 30_000, cogsMinor: 20_000 },
        { orderId: 'e', distanceMeters: null, revenueMinor: 10_000, cogsMinor: 4_000 },
      ],
      assumptions
    );
    expect(report.basis).toBe('ESTIMATE');
    expect(report.bands).toEqual([
      expect.objectContaining({
        fromMeters: 0,
        toMeters: 2000,
        orders: 2,
        grossMarginMinor: 30_000,
        // 2 × 5,000 fixed + 3,000/km × (1 + 1.999) km
        estimatedDeliveryCostMinor: 10_000 + 3_000 + 5_997,
        contributionMinor: 30_000 - 18_997,
        profitable: true,
      }),
      expect.objectContaining({
        fromMeters: 2000,
        toMeters: 5000,
        orders: 1,
        estimatedDeliveryCostMinor: 11_000,
        contributionMinor: -1_000,
        contributionPerOrderMinor: -1_000,
        profitable: false,
      }),
      expect.objectContaining({
        fromMeters: 5000,
        toMeters: null,
        orders: 1,
        estimatedDeliveryCostMinor: 32_000,
        contributionMinor: -22_000,
        profitable: false,
      }),
    ]);
    // No recorded distance: reported apart, never guessed into a band.
    expect(report.unknownDistance).toEqual({
      orders: 1,
      revenueMinor: 10_000,
      cogsMinor: 4_000,
      grossMarginMinor: 6_000,
    });
  });

  it('uses only the supplied assumptions', () => {
    const free = deliveryRadiusProfitability(
      [{ orderId: 'a', distanceMeters: 3000, revenueMinor: 100, cogsMinor: 40 }],
      { bandEdgesMeters: [10_000], costPerKmMinor: 0, fixedCostPerOrderMinor: 0 }
    );
    expect(free.bands[0]).toMatchObject({ contributionMinor: 60, profitable: true });
    expect(free.bands[1]).toMatchObject({
      orders: 0,
      contributionPerOrderMinor: null,
      profitable: null,
    });
    for (const bad of [
      { ...assumptions, bandEdgesMeters: [] },
      { ...assumptions, bandEdgesMeters: [5000, 2000] },
      { ...assumptions, costPerKmMinor: -1 },
      { ...assumptions, fixedCostPerOrderMinor: 1.5 },
    ])
      expect(() => deliveryRadiusProfitability([], bad)).toThrow(DeliveryRadiusAssumptionError);
  });

  it('loads completed delivery orders for the branch with revenue and COGS from the sale', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'order-1',
        deliveryDistanceMeters: 1500,
        counterSale: {
          lines: [
            {
              quantity: 2,
              unitPriceMinor: 1000,
              grossMinor: 2000,
              discountMinor: 100,
              unitCostMinor: 600,
              canonicalUnits: 20,
              returnLines: [],
            },
          ],
        },
      },
      { id: 'order-2', deliveryDistanceMeters: null, counterSale: null },
    ]);
    const db = { pharmacyCustomerOrder: { findMany } } as never;
    const period = { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-15T00:00:00Z') };
    await expect(
      loadDeliveryRadiusOrders(db, { organizationId: 'org-a', branchId: 'branch-a' }, period)
    ).resolves.toEqual([
      { orderId: 'order-1', distanceMeters: 1500, revenueMinor: 1900, cogsMinor: 1200 },
      { orderId: 'order-2', distanceMeters: null, revenueMinor: 0, cogsMinor: 0 },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-a',
          branchId: 'branch-a',
          fulfillment: 'DELIVER',
          status: 'COMPLETED',
          completedAt: { gte: period.from, lt: period.to },
        },
      })
    );
  });

  it('nets later returns out of revenue and COGS', async () => {
    const line = {
      quantity: 2,
      unitPriceMinor: 1000,
      grossMinor: 2000,
      discountMinor: 0,
      unitCostMinor: 600,
      canonicalUnits: 20,
    };
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'fully-returned',
        deliveryDistanceMeters: 1000,
        counterSale: {
          lines: [
            {
              ...line,
              returnLines: [{ canonicalUnits: 20, grossMinor: 2000, discountMinor: 0 }],
            },
          ],
        },
      },
      {
        id: 'half-returned-legacy',
        deliveryDistanceMeters: 1000,
        counterSale: {
          lines: [
            {
              ...line,
              returnLines: [{ canonicalUnits: 10, grossMinor: null, discountMinor: null }],
            },
          ],
        },
      },
    ]);
    const db = { pharmacyCustomerOrder: { findMany } } as never;
    const orders = await loadDeliveryRadiusOrders(
      db,
      { organizationId: 'org-a', branchId: 'branch-a' },
      { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-15T00:00:00Z') }
    );
    expect(orders).toEqual([
      { orderId: 'fully-returned', distanceMeters: 1000, revenueMinor: 0, cogsMinor: 0 },
      { orderId: 'half-returned-legacy', distanceMeters: 1000, revenueMinor: 1000, cogsMinor: 600 },
    ]);
  });
});
