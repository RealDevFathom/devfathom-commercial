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

  it('rejects negative rate inputs instead of turning corrupt counts into a dashboard rate', () => {
    expect(() => rateBasisPoints(-1n, 8n)).toThrow(
      'Rate inputs must be non-negative integers.'
    );
    expect(() => rateBasisPoints(1n, -8n)).toThrow(
      'Rate inputs must be non-negative integers.'
    );
  });

  it('keeps paisa exact above the PostgreSQL 32-bit integer range', () => {
    expect(
      composeLoyaltyDashboardMetrics({
        issued: { count: 3n, amountMinor: 2_147_483_648n },
        redeemed: { count: 1n, amountMinor: 715_827_883n },
        visitors: { total: 3n, repeat: 1n },
        churnedCustomersCount: 0n,
        churnDays: 30,
        customerPointBalances: [21_474_837n],
        redeemedMarginMinor: 715_827_884n,
      })
    ).toMatchObject({
      vouchersIssuedMinor: 2_147_483_648,
      vouchersRedeemedMinor: 715_827_883,
      redemptionRateBasisPoints: 3333,
      pointsLiabilityMinor: 2_147_483_700,
      netMarginImpactMinor: 1,
    });
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

  it('puts an RLS-compatible organization predicate and selected branches in every source query', async () => {
    const queries: Array<{ strings: readonly string[]; values: readonly unknown[] }> = [];
    const siblingSources = {
      $queryRaw: vi.fn(async (query: { strings: readonly string[]; values: readonly unknown[] }) => {
        queries.push(query);
        const sql = query.strings.join(' ');
        if (sql.includes('AS "amountMinor"')) return [{ count: 0n, amountMinor: 0n }];
        if (sql.includes('AS total')) return [{ total: 0n, repeat: 0n }];
        if (sql.includes('churned')) return [{ count: 0n }];
        if (sql.includes('customer_balances')) return [];
        return [{ marginMinor: 0n }];
      }),
    };

    await readPharmacyLoyaltyDashboard(
      siblingSources as never,
      {
        branchIds: ['branch-a', 'branch-b'],
        from: '2026-10-01',
        to: '2026-10-22',
      },
      45
    );

    expect(queries).toHaveLength(6);
    for (const query of queries) {
      expect(query.strings.join(' ')).toContain(
        `current_setting('app.current_organization_id', true)`
      );
      expect(query.values).toEqual(expect.arrayContaining(['branch-a', 'branch-b']));
      expect(query.values).not.toContain('org-from-client');
    }
  });

  it.each([0, 3651, 1.5])('rejects churnDays %s before reading sibling sources', async (churnDays) => {
    const siblingSources = { $queryRaw: vi.fn() };
    await expect(
      readPharmacyLoyaltyDashboard(
        siblingSources as never,
        { branchIds: ['branch-a'], from: '2026-10-01', to: '2026-10-22' },
        churnDays
      )
    ).rejects.toThrow('Churn days must be between 1 and 3650.');
    expect(siblingSources.$queryRaw).not.toHaveBeenCalled();
  });
});
