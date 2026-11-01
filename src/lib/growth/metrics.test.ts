// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const { scoped } = vi.hoisted(() => ({ scoped: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: scoped }));
import { calculateChurn } from './churn';
import { nextRefillDueAt } from './refill';
import { metricsDue, runCustomerMetrics, type CustomerAggregate } from './metrics';

const now = new Date('2026-10-21T00:00:00Z'); // 05:00 Karachi
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
const fixture: CustomerAggregate[] = [
  {
    customerId: 'never',
    lastPurchaseAt: null,
    totalOrders: 0,
    orders90d: 0,
    spend90dMinor: BigInt(0),
    medianGapDays: null,
    refillSoldAt: null,
    refillQuantity: null,
    directions: null,
  },
  ...[
    ['low', 5, 3],
    ['medium', 40, 3],
    ['high', 55, 3],
    ['lost', 100, 0],
    ['refill', 1, 1],
  ].map(([id, days, orders]) => ({
    customerId: String(id),
    lastPurchaseAt: ago(Number(days)),
    totalOrders: id === 'refill' ? 1 : 3,
    orders90d: Number(orders),
    spend90dMinor: BigInt(orders) * BigInt(1000),
    medianGapDays: id === 'refill' ? null : 30,
    refillSoldAt: id === 'refill' ? ago(1) : null,
    refillQuantity: id === 'refill' ? 60 : null,
    directions: id === 'refill' ? 'one tablet twice daily' : null,
  })),
];
let lastRun: Date | null;
const execute = vi.fn();
const aggregate = vi.fn();
const update = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  lastRun = null;
  aggregate.mockResolvedValue(fixture);
  update.mockImplementation(async ({ data }) => {
    lastRun = data.lastMetricsRunAt;
  });
  scoped.mockImplementation(async (id, run) => {
    expect(id).toBe('org_fixture');
    return run({
      $queryRaw: vi
        .fn()
        .mockImplementation((query) => (Array.isArray(query) ? [] : aggregate(query))),
      $executeRaw: execute,
      organization: {
        findUniqueOrThrow: async () => ({ timezone: 'Asia/Karachi', vertical: 'PHARMACY' }),
      },
      growthSettings: {
        upsert: async () => ({ lastMetricsRunAt: lastRun, churnThreshold: 60 }),
        update,
      },
    });
  });
});

it('six customers cover every band, never purchased, and an Rx refill using existing dose grammar', () => {
  expect(fixture.map((row) => calculateChurn(row, now).churnBand)).toEqual([
    'low',
    'low',
    'medium',
    'high',
    'lost',
    'low',
  ]);
  expect(nextRefillDueAt(fixture[5].refillSoldAt, 60, fixture[5].directions)).toEqual(ago(-29));
  expect(nextRefillDueAt(ago(1), 12, 'as needed')).toEqual(ago(-29));
  expect(nextRefillDueAt(null, null, null)).toBeNull();
});

it('keeps zero recent sales distinct from never purchased and caps a single purchase until twice the default gap', () => {
  expect(calculateChurn(fixture[0], now)).toEqual({ churnScore: 0, churnBand: 'low' });
  expect(calculateChurn(fixture[4], now).churnBand).toBe('lost');
  expect(
    calculateChurn({ ...fixture[4], totalOrders: 1, lastPurchaseAt: ago(60) }, now).churnBand
  ).toBe('medium');
  expect(
    calculateChurn({ ...fixture[4], totalOrders: 1, lastPurchaseAt: ago(61) }, now).churnBand
  ).toBe('lost');
  expect(calculateChurn({ ...fixture[3], medianGapDays: 0 }, now).churnBand).toBe('lost');
  expect(calculateChurn(fixture[3], now, 30, 75).churnBand).toBe('medium');
  expect(
    calculateChurn({ ...fixture[1], lastPurchaseAt: ago(20), medianGapDays: null }, now, 14)
      .churnBand
  ).toBe('medium');
});

it('uses business local day and the 02:00 boundary, including DST', () => {
  expect(metricsDue(new Date('2026-10-20T20:59:00Z'), null, 'Asia/Karachi')).toBe(false);
  expect(metricsDue(new Date('2026-10-20T21:00:00Z'), null, 'Asia/Karachi')).toBe(true);
  expect(metricsDue(now, ago(0.1), 'Asia/Karachi')).toBe(false);
  expect(metricsDue(now, ago(1), 'Asia/Karachi')).toBe(true);
  expect(metricsDue(new Date('2026-11-01T07:00:00Z'), null, 'America/New_York')).toBe(true);
});

it('runs one aggregate and one six-row upsert, then skips a same-day rerun', async () => {
  expect(await runCustomerMetrics('org_fixture', now)).toBe(true);
  expect(await runCustomerMetrics('org_fixture', now)).toBe(false);
  expect(aggregate).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledTimes(1);
  const query = execute.mock.calls[0][0];
  expect(query.sql).toContain('ON CONFLICT ("organizationId", "customerId")');
  expect(query.values.filter((value: unknown) => value === 'org_fixture')).toHaveLength(6);
});

it('writes 501 customers in two batches, and does not mark a failed batch complete', async () => {
  aggregate.mockResolvedValue(
    Array.from({ length: 501 }, (_, i) => ({ ...fixture[0], customerId: `customer_${i}` }))
  );
  expect(await runCustomerMetrics('org_fixture', now)).toBe(true);
  expect(execute).toHaveBeenCalledTimes(2);
  lastRun = null;
  update.mockClear();
  execute.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(runCustomerMetrics('org_fixture', now)).rejects.toThrow('database unavailable');
  expect(update).not.toHaveBeenCalled();
});
