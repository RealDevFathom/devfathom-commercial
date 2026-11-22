/**
 * DEV-77 — true profit by item, category, hour and staff, from posted landed
 * cost. The roll-up is pure, so the fixtures below are the whole contract.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  grossMarginQuery,
  rollUpTrueProfit,
  trueProfit,
  trueProfitFactsQuery,
  TRUE_PROFIT_TIMEZONE,
  type TrueProfitFact,
} from './finance-reports';

const fact = (overrides: Partial<TrueProfitFact>): TrueProfitFact => ({
  productId: 'med_a',
  category: 'PHARMACEUTICAL',
  hour: 9,
  staffUserId: 'user_ali',
  revenueMinor: 0,
  discountMinor: 0,
  cogsMinor: 0,
  ...overrides,
});

// Two items, two categories, two hours, two sellers, one return.
const FACTS: TrueProfitFact[] = [
  // med_a: 10+1 lot landed at 100.00 per unit; 3 units sold at 150.00 by Ali at 09:xx.
  fact({ revenueMinor: 45_000, discountMinor: 1_500, cogsMinor: 30_000 }),
  // med_a: 2 units sold by Sara at 21:xx.
  fact({ hour: 21, staffUserId: 'user_sara', revenueMinor: 30_000, cogsMinor: 20_000 }),
  // med_a: one of Ali's 09:xx units returned — it nets against Ali and 09:00.
  fact({ revenueMinor: -15_000, discountMinor: -500, cogsMinor: -10_000 }),
  // med_b (front shop): Sara at 09:xx.
  fact({
    productId: 'med_b',
    category: 'FRONT_SHOP',
    staffUserId: 'user_sara',
    revenueMinor: 8_000,
    cogsMinor: 5_000,
  }),
  // An unattributed leg is kept, never dropped.
  fact({
    productId: null,
    category: null,
    hour: null,
    staffUserId: null,
    revenueMinor: 1_000,
    cogsMinor: 400,
  }),
];

const row = (key: string | null, revenue: number, discount: number, cogs: number) => ({
  key,
  revenueMinor: revenue,
  discountMinor: discount,
  cogsMinor: cogs,
  grossMarginMinor: revenue - discount - cogs,
});

describe('DEV-77 — true profit roll-up', () => {
  it('reports true profit by item', () => {
    expect(rollUpTrueProfit(FACTS, 'item')).toEqual([
      row('med_a', 60_000, 1_000, 40_000),
      row('med_b', 8_000, 0, 5_000),
      row(null, 1_000, 0, 400),
    ]);
  });

  it('reports true profit by category', () => {
    expect(rollUpTrueProfit(FACTS, 'category')).toEqual([
      row('FRONT_SHOP', 8_000, 0, 5_000),
      row('PHARMACEUTICAL', 60_000, 1_000, 40_000),
      row(null, 1_000, 0, 400),
    ]);
  });

  it('reports true profit by sale hour, zero-padded so hours sort in clock order', () => {
    expect(rollUpTrueProfit(FACTS, 'hour')).toEqual([
      row('09:00', 38_000, 1_000, 25_000),
      row('21:00', 30_000, 0, 20_000),
      row(null, 1_000, 0, 400),
    ]);
  });

  it('reports true profit by staff, with a return netted against the original seller', () => {
    expect(rollUpTrueProfit(FACTS, 'staff')).toEqual([
      row('user_ali', 30_000, 1_000, 20_000),
      row('user_sara', 38_000, 0, 25_000),
      row(null, 1_000, 0, 400),
    ]);
  });

  it('reconciles to the same total under every dimension', () => {
    const totals = (['item', 'category', 'hour', 'staff'] as const).map((by) =>
      rollUpTrueProfit(FACTS, by).reduce((sum, group) => sum + group.grossMarginMinor, 0)
    );
    expect(new Set(totals)).toEqual(new Set([22_600]));
  });

  it('returns nothing for no posted facts', () => {
    expect(rollUpTrueProfit([], 'item')).toEqual([]);
  });

  it.each([NaN, 0.5, Number.MAX_SAFE_INTEGER + 1])('refuses invalid money %s', (value) => {
    expect(() => rollUpTrueProfit([fact({ revenueMinor: value })], 'item')).toThrow(RangeError);
  });

  it('refuses an hour outside the clock', () => {
    expect(() => rollUpTrueProfit([fact({ hour: 24 })], 'hour')).toThrow(RangeError);
  });

  it('refuses a total that would lose integer precision instead of rounding', () => {
    expect(() =>
      rollUpTrueProfit(
        [
          fact({ revenueMinor: Number.MAX_SAFE_INTEGER }),
          fact({ revenueMinor: Number.MAX_SAFE_INTEGER }),
        ],
        'item'
      )
    ).toThrow(RangeError);
  });
});

describe('DEV-77 — true profit ledger read', () => {
  const scope = { organizationId: 'org_1', branchId: 'branch_1' };
  const period = { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-11-08T00:00:00Z') };

  it('reads the same accounts, window and branch as the shipped margin report', () => {
    const facts = trueProfitFactsQuery(scope, period);
    const margin = grossMarginQuery(scope, { ...period, by: 'branch' });
    for (const account of ['SALES_REVENUE', 'SALES_DISCOUNT', 'COST_OF_GOODS_SOLD']) {
      expect(facts.sql).toContain(`'${account}'`);
    }
    expect(facts.sql).toContain('entry."occurredAt" >= ?');
    expect(facts.sql).toContain('entry."occurredAt" < ?');
    expect(facts.sql).toContain('line."branchId" = ?');
    expect(facts.values).toEqual(
      expect.arrayContaining(['org_1', 'branch_1', period.from, period.to])
    );
    expect(margin.values).toEqual(
      expect.arrayContaining(['org_1', 'branch_1', period.from, period.to])
    );
  });

  it('uses each workspace clock to group the hour containing 00:30 Karachi', () => {
    const at = new Date('2026-11-02T00:30:00+05:00');
    for (const zone of ['Asia/Karachi', 'UTC']) {
      const query = trueProfitFactsQuery(scope, {
        from: at,
        to: new Date(at.getTime() + 3600000),
        timeZone: zone,
      });
      expect(query.values).toContain(zone);
    }
  });

  it('buckets hours on the Asia/Karachi clock and attributes staff to the sale', () => {
    const facts = trueProfitFactsQuery(scope, period);
    expect(TRUE_PROFIT_TIMEZONE).toBe('Asia/Karachi');
    expect(facts.values).toContain('Asia/Karachi');
    expect(facts.sql).toContain(`AT TIME ZONE 'UTC'`);
    // Staff is whoever completed payment, falling back to the bill's creator.
    expect(facts.sql).toContain(
      'COALESCE(completion."actorId", sale."createdByUserId") AS "staffUserId"'
    );
    expect(facts.sql).toContain(`event."kind" = 'COMPLETED'`);
    // Grouped sums are not narrowed to a 32-bit int in SQL.
    expect(facts.sql).not.toMatch(/::int AS "(revenue|discount|cogs)Minor"/);
    expect(facts.sql).toContain('::bigint AS "revenueMinor"');
    expect(facts.sql).toContain('medicine."productFamily"::text AS "category"');
    expect(facts.sql).toContain('sale_line."id" = line."sourceLineId"');
  });

  it('reads grouped totals above the 32-bit integer limit as exact numbers', async () => {
    const $queryRaw = vi.fn().mockResolvedValue([
      {
        ...fact({}),
        revenueMinor: BigInt(3_000_000_000),
        discountMinor: BigInt(0),
        cogsMinor: BigInt(2_500_000_000),
      },
    ]);
    const rows = await trueProfit({ $queryRaw } as unknown as ScopedDb, scope, {
      ...period,
      by: 'item',
    });
    expect(rows).toEqual([row('med_a', 3_000_000_000, 0, 2_500_000_000)]);
  });

  it('refuses a grouped total beyond safe integer money instead of rounding it', async () => {
    const $queryRaw = vi
      .fn()
      .mockResolvedValue([
        { ...fact({}), revenueMinor: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(2) },
      ]);
    await expect(
      trueProfit({ $queryRaw } as unknown as ScopedDb, scope, { ...period, by: 'item' })
    ).rejects.toThrow(RangeError);
  });

  it('rolls the queried facts up by the requested dimension', async () => {
    const $queryRaw = vi.fn().mockResolvedValue(FACTS);
    const rows = await trueProfit({ $queryRaw } as unknown as ScopedDb, scope, {
      ...period,
      by: 'staff',
    });
    expect($queryRaw).toHaveBeenCalledTimes(1);
    expect(rows.map((group) => group.key)).toEqual(['user_ali', 'user_sara', null]);
  });
});
