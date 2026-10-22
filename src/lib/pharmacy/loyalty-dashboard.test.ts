import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  composeLoyaltyDashboardMetrics,
  customerPointsLiabilityMinor,
  rateBasisPoints,
  readPharmacyLoyaltyDashboard,
} from './loyalty-dashboard';

describe('pharmacy loyalty dashboard metric math', () => {
  it('calculates every rate and paisa metric with integer arithmetic', () => {
    expect(
      composeLoyaltyDashboardMetrics({
        issued: { count: 8n, amountMinor: 80_000n },
        redeemed: { count: 3n, amountMinor: 30_000n },
        visitors: { total: 5n, repeat: 2n },
        churnedCustomersCount: 4n,
        churnDays: 45,
        customerPointBalances: [123n],
        redeemedMarginMinor: 45_000n,
      })
    ).toEqual({
      vouchersIssuedCount: 8,
      vouchersIssuedMinor: 80_000,
      vouchersRedeemedCount: 3,
      vouchersRedeemedMinor: 30_000,
      redemptionRateBasisPoints: 3750,
      repeatVisitRateBasisPoints: 4000,
      churnedCustomersCount: 4,
      churnDays: 45,
      pointsLiabilityMinor: 12_300,
      netMarginImpactMinor: 15_000,
    });
  });

  it('defines empty cohorts as a zero rate and never exposes a negative points liability', () => {
    expect(rateBasisPoints(0n, 0n)).toBe(0);
    expect(
      composeLoyaltyDashboardMetrics({
        issued: { count: 0n, amountMinor: 0n },
        redeemed: { count: 0n, amountMinor: 0n },
        visitors: { total: 0n, repeat: 0n },
        churnedCustomersCount: 0n,
        churnDays: 30,
        customerPointBalances: [-4n],
        redeemedMarginMinor: 0n,
      }).pointsLiabilityMinor
    ).toBe(0);
  });

  it('calculates liability per customer so one negative balance cannot offset another customer', () => {
    expect(customerPointsLiabilityMinor([120n, -100n, 30n])).toBe(15_000);
  });

  it('rejects aggregate money outside JavaScript safe-integer bounds', () => {
    expect(() => customerPointsLiabilityMinor([BigInt(Number.MAX_SAFE_INTEGER)])).toThrow(
      'Points liability exceeds the safe integer range.'
    );
  });

  it('converts bigint database aggregates without losing minor-unit precision', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ count: 8n, amountMinor: 80_000n }])
      .mockResolvedValueOnce([{ count: 3n, amountMinor: 30_000n }])
      .mockResolvedValueOnce([{ total: 5n, repeat: 2n }])
      .mockResolvedValueOnce([{ count: 4n }])
      .mockResolvedValueOnce([{ points: 123n }])
      .mockResolvedValueOnce([{ marginMinor: 45_000n }]);

    await expect(
      readPharmacyLoyaltyDashboard(
        { $queryRaw: queryRaw } as never,
        { branchIds: ['branch-a'], from: '2026-10-01', to: '2026-10-22' },
        45
      )
    ).resolves.toMatchObject({
      vouchersIssuedMinor: 80_000,
      pointsLiabilityMinor: 12_300,
      netMarginImpactMinor: 15_000,
    });
    expect(queryRaw).toHaveBeenCalledTimes(6);
  });
});
