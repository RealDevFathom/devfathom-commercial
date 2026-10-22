import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { composeLoyaltyDashboardMetrics, rateBasisPoints } from './loyalty-dashboard';

describe('pharmacy loyalty dashboard metric math', () => {
  it('calculates every rate and paisa metric with integer arithmetic', () => {
    expect(composeLoyaltyDashboardMetrics({
      issued: { count: 8, amountMinor: 80_000 },
      redeemed: { count: 3, amountMinor: 30_000 },
      visitors: { total: 5, repeat: 2 },
      churnedCustomersCount: 4,
      churnDays: 45,
      pointsBalance: 123,
      redeemedMarginMinor: 45_000,
    })).toEqual({
      vouchersIssuedCount: 8, vouchersIssuedMinor: 80_000,
      vouchersRedeemedCount: 3, vouchersRedeemedMinor: 30_000,
      redemptionRateBasisPoints: 3750, repeatVisitRateBasisPoints: 4000,
      churnedCustomersCount: 4, churnDays: 45,
      pointsLiabilityMinor: 12_300, netMarginImpactMinor: 15_000,
    });
  });

  it('defines empty cohorts as a zero rate and never exposes a negative points liability', () => {
    expect(rateBasisPoints(0, 0)).toBe(0);
    expect(composeLoyaltyDashboardMetrics({
      issued: { count: 0, amountMinor: 0 }, redeemed: { count: 0, amountMinor: 0 },
      visitors: { total: 0, repeat: 0 }, churnedCustomersCount: 0, churnDays: 30,
      pointsBalance: -4, redeemedMarginMinor: 0,
    }).pointsLiabilityMinor).toBe(0);
  });
});
