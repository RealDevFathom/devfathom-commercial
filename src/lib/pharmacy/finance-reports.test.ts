import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  explainGrossMargin,
  grossMarginComparison,
  landedProfit,
  marginComparisonPeriods,
} from './finance-reports';

describe('landed profit dimensions', () => {
  it('reports item, category, PKT hour and staff fixtures from one posted-cost read', async () => {
    const fixtures = [
      {
        dimension: 'item',
        key: 'item_1',
        revenueMinor: 1500,
        discountMinor: 100,
        cogsMinor: 900,
        grossMarginMinor: 500,
      },
      {
        dimension: 'category',
        key: 'GENERAL',
        revenueMinor: 1500,
        discountMinor: 100,
        cogsMinor: 900,
        grossMarginMinor: 500,
      },
      {
        dimension: 'hour',
        key: '2026-09-01T18:00:00+05:00',
        revenueMinor: 1500,
        discountMinor: 100,
        cogsMinor: 900,
        grossMarginMinor: 500,
      },
      {
        dimension: 'staff',
        key: 'staff_1',
        revenueMinor: 1500,
        discountMinor: 100,
        cogsMinor: 900,
        grossMarginMinor: 500,
      },
    ];
    const query = vi.fn().mockResolvedValue(fixtures);
    const period = { from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-02T00:00:00Z') };
    await expect(
      landedProfit(
        { $queryRaw: query } as unknown as ScopedDb,
        { organizationId: 'org_1', branchId: 'branch_1' },
        period
      )
    ).resolves.toEqual(fixtures);

    const [statement] = query.mock.calls[0]!;
    expect(statement.sql).toContain(`medicine."productFamily"::text`);
    expect(statement.sql).toContain(
      `date_trunc('hour', entry."occurredAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Karachi')`
    );
    expect(statement.sql).toContain(`sale."createdByUserId"`);
    expect(statement.sql).toContain(`'item'::text`);
    expect(statement.sql).toContain(`'category'`);
    expect(statement.sql).toContain(`'hour'`);
    expect(statement.sql).toContain(`'staff'`);
    expect(statement.sql).toContain(`'SALES_REVENUE', 'SALES_DISCOUNT', 'COST_OF_GOODS_SOLD'`);
    expect(statement.values).toEqual(['org_1', period.from, period.to, 'branch_1']);
  });
});
const row = (revenueMinor: number, discountMinor: number, cogsMinor: number) => ({
  key: 'branch_1',
  revenueMinor,
  discountMinor,
  cogsMinor,
  grossMarginMinor: revenueMinor - discountMinor - cogsMinor,
});

describe('gross-margin accounting comparison', () => {
  it.each([
    [10000, 500, 6000, 12000, 1500, 8000],
    [0, 0, 0, 0, 0, 0],
    [-500, -50, -200, 100, 0, 50],
    [100, 200, 300, -100, -200, -300],
  ])('reconciles signed ledger values %j', (r, d, c, nr, nd, nc) => {
    const result = explainGrossMargin(row(r, d, c), row(nr, nd, nc));
    expect(result.differenceMinor).toBe(nr - nd - nc - (r - d - c));
    expect(result.reconciledMinor).toBe(result.differenceMinor);
    expect(Object.values(result).some((v) => typeof v === 'number' && !Number.isFinite(v))).toBe(
      false
    );
  });
  it('shows sales up, margin down without assigning causality', () => {
    expect(explainGrossMargin(row(10000, 500, 6000), row(12000, 1500, 8000))).toMatchObject({
      revenueDeltaMinor: 2000,
      discountDeltaMinor: 1000,
      cogsDeltaMinor: 2000,
      differenceMinor: -1000,
    });
  });
  it('distinguishes absent groups from posted net zero', () => {
    const result = explainGrossMargin(undefined, row(0, 0, 0));
    expect(result.previous.hasEntries).toBe(false);
    expect(result.current.hasEntries).toBe(true);
    expect(result.differenceMinor).toBe(0);
  });
  it('rejects inconsistent ledger totals', () => {
    expect(() =>
      explainGrossMargin({ ...row(100, 0, 10), grossMarginMinor: 91 }, undefined)
    ).toThrow('does not reconcile');
  });
  it.each([NaN, Infinity, 0.1, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid integer money %s',
    (value) => {
      expect(() => explainGrossMargin(row(value, 0, 0), undefined)).toThrow();
    }
  );
  it('rejects unsafe differences instead of rounding', () => {
    expect(() =>
      explainGrossMargin(row(-Number.MAX_SAFE_INTEGER, 0, 0), row(Number.MAX_SAFE_INTEGER, 0, 0))
    ).toThrow('bounds');
  });
  it('supports differences beyond PostgreSQL int without truncation', () => {
    expect(
      explainGrossMargin(row(-2_000_000_000, 0, 0), row(2_000_000_000, 0, 0)).differenceMinor
    ).toBe(4_000_000_000);
  });
  it('uses adjacent equal UTC durations through a leap day', () => {
    const periods = marginComparisonPeriods(new Date('2024-03-01Z'), new Date('2024-03-03Z'));
    expect(periods.previous.from.toISOString()).toBe('2024-02-28T00:00:00.000Z');
    expect(periods.previous.to).toEqual(periods.current.from);
  });
  it.each([
    ['invalid', '2026-09-01Z'],
    ['2026-09-01Z', '2026-09-01Z'],
    ['2026-09-02Z', '2026-09-01Z'],
    ['2026-01-01Z', '2026-09-01Z'],
  ])('rejects invalid/unbounded periods %s %s', (from, to) => {
    expect(() => marginComparisonPeriods(new Date(from), new Date(to))).toThrow();
  });
  it('reuses tenant/branch-bound half-open journal SQL in one snapshot without writes', async () => {
    const query = vi.fn().mockResolvedValue([{ ...row(100, 10, 50), period: 'previous' }]);
    const result = await grossMarginComparison(
      { $queryRaw: query } as unknown as ScopedDb,
      { organizationId: 'org_1', branchId: 'branch_1' },
      { from: new Date('2026-09-01Z'), to: new Date('2026-09-03Z') }
    );
    expect(query).toHaveBeenCalledTimes(1);
    for (const [sql] of query.mock.calls) {
      expect(sql.sql).toContain('line."organizationId" = ?');
      expect(sql.sql).toContain('line."branchId" = ?');
      expect(sql.sql).toContain('entry."occurredAt" >= ?');
      expect(sql.sql).toContain('entry."occurredAt" < ?');
      expect(sql.sql).toContain("'SALES_REVENUE', 'SALES_DISCOUNT', 'COST_OF_GOODS_SOLD'");
      expect(sql.sql).toContain('UNION ALL');
      expect(sql.values).toEqual([
        'org_1',
        result.periods.previous.from,
        result.periods.previous.to,
        'branch_1',
        'org_1',
        result.periods.current.from,
        result.periods.current.to,
        'branch_1',
      ]);
    }
    expect(result.differenceMinor).toBe(-40);
  });
  it('rejects a wrong branch group', async () => {
    const query = vi
      .fn()
      .mockResolvedValue([{ ...row(1, 0, 0), key: 'foreign', period: 'previous' }]);
    await expect(
      grossMarginComparison(
        { $queryRaw: query } as unknown as ScopedDb,
        { organizationId: 'org_1', branchId: 'branch_1' },
        { from: new Date('2026-09-01Z'), to: new Date('2026-09-02Z') }
      )
    ).rejects.toThrow('branch group');
  });
});

it('handles profit totals above the database Int range without losing minor units', async () => {
  const rows = [
    {
      dimension: 'item',
      key: 'item-a',
      revenueMinor: BigInt('5000000000'),
      discountMinor: BigInt('100000000'),
      cogsMinor: BigInt('3000000000'),
      grossMarginMinor: BigInt('1900000000'),
    },
  ];
  const db = { $queryRaw: vi.fn().mockResolvedValue(rows) };
  await expect(
    landedProfit(
      db as never,
      { organizationId: 'org-a' },
      { from: new Date('2026-11-01'), to: new Date('2026-11-02') }
    )
  ).resolves.toEqual([
    {
      ...rows[0],
      revenueMinor: 5000000000,
      discountMinor: 100000000,
      cogsMinor: 3000000000,
      grossMarginMinor: 1900000000,
    },
  ]);
  rows[0]!.revenueMinor = BigInt('9007199254740992');
  await expect(
    landedProfit(
      db as never,
      { organizationId: 'org-a' },
      { from: new Date('2026-11-01'), to: new Date('2026-11-02') }
    )
  ).rejects.toThrow('numeric range');
});
