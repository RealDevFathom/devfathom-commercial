// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { deliveryRadiusProfitabilityReport } from './delivery-radius-profitability';

describe('delivery-radius profitability estimate', () => {
  it('computes sorted radius scenarios only from configurable inputs', () => {
    expect(
      deliveryRadiusProfitabilityReport({
        estimatedOrderRevenueMinor: 2_000,
        estimatedOrderCogsMinor: 1_200,
        baseDeliveryCostMinor: 100,
        deliveryCostPerKmMinor: 150,
        radiiKm: [5, 1, 3],
      })
    ).toEqual([
      expect.objectContaining({
        radiusKm: 1,
        estimatedContributionMinor: 550,
        profitableEstimate: true,
      }),
      expect.objectContaining({
        radiusKm: 3,
        estimatedContributionMinor: 250,
        profitableEstimate: true,
      }),
      expect.objectContaining({
        radiusKm: 5,
        estimatedContributionMinor: -50,
        profitableEstimate: false,
      }),
    ]);
  });

  it('rejects invalid planning values instead of presenting them as facts', () => {
    expect(() =>
      deliveryRadiusProfitabilityReport({
        estimatedOrderRevenueMinor: 1_000,
        estimatedOrderCogsMinor: 500,
        baseDeliveryCostMinor: 0,
        deliveryCostPerKmMinor: 10,
        radiiKm: [0],
      })
    ).toThrow('INVALID_DELIVERY_RADIUS');
  });

  it('deduplicates fractional radii and preserves a negative gross margin', () => {
    expect(
      deliveryRadiusProfitabilityReport({
        estimatedOrderRevenueMinor: 500,
        estimatedOrderCogsMinor: 700,
        baseDeliveryCostMinor: 25,
        deliveryCostPerKmMinor: 10,
        radiiKm: [2.5, 1, 2.5],
      })
    ).toEqual([
      expect.objectContaining({ radiusKm: 1, estimatedGrossMarginMinor: -200 }),
      expect.objectContaining({
        radiusKm: 2.5,
        estimatedDeliveryCostMinor: 50,
        estimatedContributionMinor: -250,
        profitableEstimate: false,
      }),
    ]);
  });

  it('rejects derived minor-unit overflow at the public radius upper bound', () => {
    expect(() =>
      deliveryRadiusProfitabilityReport({
        estimatedOrderRevenueMinor: Number.MAX_SAFE_INTEGER,
        estimatedOrderCogsMinor: 0,
        baseDeliveryCostMinor: Number.MAX_SAFE_INTEGER,
        deliveryCostPerKmMinor: Number.MAX_SAFE_INTEGER,
        radiiKm: [1_000],
      })
    ).toThrow('DELIVERY_PROFITABILITY_OVERFLOW');
  });
});
