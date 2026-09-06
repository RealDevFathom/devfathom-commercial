import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  readRepeatPurchasing,
  REPEAT_SCAN_LIMIT,
  summarizeRepeatPurchasing,
  validateRepeatFilters,
  type RepeatReceipt,
} from './repeat-purchasing';

const day = 86_400_000;
const start = new Date('2026-01-01T12:00:00Z');
const at = (days: number) => new Date(start.getTime() + days * day);
const filters = {
  branchIds: ['b1', 'b2'],
  from: '2026-01-01',
  to: '2026-01-31',
  asOf: at(90).toISOString(),
};
function receipt(id: string, days: number, overrides: Partial<RepeatReceipt> = {}): RepeatReceipt {
  return {
    id,
    organizationId: 'org',
    branchId: 'b1',
    status: 'COMPLETED',
    originalSaleId: null,
    customerId: 'commercial-1',
    completedAt: at(days),
    receiptNumber: 1,
    createdAt: at(days),
    lines: [
      {
        id: `${id}-line`,
        quantity: 2,
        unitPriceMinor: 100,
        discountMinor: 0,
        canonicalUnits: 2,
        createdAt: at(days),
        returnLines: [],
      },
    ],
    refunds: [],
    ...overrides,
  };
}
const summarize = (rows: RepeatReceipt[], overrides = {}) =>
  summarizeRepeatPurchasing(rows, 'org', { ...filters, ...overrides }, at(200));

describe('first-observed repeat-purchase cohorts', () => {
  it('uses complete elapsed horizons; exact 30-day boundary is eligible', () => {
    const rows = [receipt('a', 0), receipt('b', 30)];
    const mature = summarize(rows, { asOf: at(30).toISOString() });
    expect(mature.horizons).toEqual([
      { days: 30, eligible: 1, repeated: 1, immature: 0, ratePercent: 100 },
      { days: 60, eligible: 0, repeated: 0, immature: 1, ratePercent: null },
      { days: 90, eligible: 0, repeated: 0, immature: 1, ratePercent: null },
    ]);
    expect(
      summarize(rows, { asOf: new Date(at(30).getTime() - 1).toISOString(), to: '2026-01-30' })
        .horizons[0].eligible
    ).toBe(0);
  });
  it.each([30, 60, 90])('includes exact %i-day repeat, excludes one millisecond later', (days) => {
    expect(
      summarize([receipt('a', 0), receipt('b', days)]).horizons.find((h) => h.days === days)
        ?.repeated
    ).toBe(1);
    expect(
      summarize([receipt('a', 0), receipt('b', days + 1 / day)]).horizons.find(
        (h) => h.days === days
      )?.repeated
    ).toBe(0);
  });
  it('requires strictly later distinct receipts, not replayed rows, lines or tenders', () => {
    const a = receipt('a', 0);
    a.lines.push(a.lines[0]);
    const report = summarize([a, a, receipt('b', 0)]);
    expect(report.completedReceipts).toBe(2);
    expect(report.horizons[0].repeated).toBe(0);
    expect(report.enrolledCustomers).toBe(1);
  });
  it('includes anonymous and blank identities in receipt coverage, not cohorts', () => {
    const report = summarize([
      receipt('a', 0, { customerId: null }),
      receipt('b', 1, { customerId: '' }),
      receipt('c', 2),
    ]);
    expect(report.completedReceipts).toBe(3);
    expect(report.anonymousReceipts).toBe(2);
    expect(report.enrolledCustomers).toBe(1);
    expect(report.identificationCoveragePercent).toBeCloseTo(100 / 3);
    expect(summarize([]).horizons.every((h) => h.ratePercent === null)).toBe(true);
    expect(summarize([]).identificationCoveragePercent).toBeNull();
  });
  it('uses first observation before enrollment, including another selected branch', () => {
    const rows = [receipt('old', -1, { branchId: 'b2' }), receipt('a', 0), receipt('b', 20)];
    expect(summarize(rows).firstObservedBeforeEnrollment).toBe(1);
    expect(summarize(rows).enrolledCustomers).toBe(0);
    expect(summarize(rows, { branchIds: ['b1'] }).horizons[0].repeated).toBe(1);
  });
  it('counts repeat across selected branches but never omitted branches or tenants', () => {
    const rows = [
      receipt('a', 0),
      receipt('b', 20, { branchId: 'b2' }),
      receipt('foreign', 15, { organizationId: 'other' }),
    ];
    expect(summarize(rows).horizons[0].repeated).toBe(1);
    expect(summarize(rows, { branchIds: ['b1'] }).horizons[0].repeated).toBe(0);
    expect(summarize(rows).completedReceipts).toBe(2);
  });
  it('excludes missing timestamps and receipt numbers, reports gaps explicitly', () => {
    const report = summarize([
      receipt('a', 0, { completedAt: null }),
      receipt('b', 1, { receiptNumber: null }),
    ]);
    expect(report.missingTimestamp).toBe(1);
    expect(report.missingReceipt).toBe(1);
    expect(report.completedReceipts).toBe(1);
    expect(report.enrolledCustomers).toBe(0);
  });
  it.each(['VOID', 'OPEN', 'HELD', 'QUOTATION'])(
    'excludes %s sales and derived refund-only events',
    (status) => {
      expect(
        summarize([receipt('a', 0, { status }), receipt('b', 1, { originalSaleId: 'a' })])
          .enrolledCustomers
      ).toBe(0);
    }
  );
  it('keeps partial returns, excludes full returns, ignores returns after cutoff', () => {
    const a = receipt('a', 0);
    const returned = {
      id: 'return',
      canonicalUnits: 1,
      createdAt: at(10),
      saleReturn: { createdAt: at(10) },
    };
    a.lines[0].returnLines = [returned];
    expect(summarize([a]).enrolledCustomers).toBe(1);
    returned.canonicalUnits = 2;
    expect(summarize([a]).excludedPurchases).toBe(1);
    returned.createdAt = at(91);
    expect(summarize([a]).enrolledCustomers).toBe(1);
  });
  it('keeps partial refunds, excludes full refunds without counting refund timestamps', () => {
    const a = receipt('a', 0);
    a.refunds = [{ id: 'refund', amountMinor: 100, createdAt: at(10) }];
    expect(summarize([a]).horizons[0].repeated).toBe(0);
    expect(summarize([a]).enrolledCustomers).toBe(1);
    a.refunds[0].amountMinor = 200;
    expect(summarize([a]).enrolledCustomers).toBe(0);
    a.refunds[0].createdAt = at(91);
    expect(summarize([a]).enrolledCustomers).toBe(1);
  });
  it('does not double-subtract a partial return with its partial refund', () => {
    const a = receipt('a', 0);
    a.lines[0].returnLines = [
      { id: 'r', canonicalUnits: 1, createdAt: at(10), saleReturn: { createdAt: at(10) } },
    ];
    a.refunds = [{ id: 'f', amountMinor: 100, createdAt: at(10) }];
    expect(summarize([a, receipt('b', 20)]).horizons[0].repeated).toBe(1);
  });
  it('fails closed instead of reporting a capped denominator', () => {
    expect(() => summarize(Array(REPEAT_SCAN_LIMIT + 1).fill(receipt('a', 0)))).toThrow(
      'scan limit exceeded'
    );
    const a = receipt('a', 0);
    a.lines = Array(1001).fill(a.lines[0]);
    expect(() => summarize([a])).toThrow('detail limit exceeded');
  });
  it.each([
    { from: '2026-02-30' },
    { to: '2026-04-30' },
    { asOf: at(201).toISOString() },
    { from: '2026-02-01' },
    { branchIds: [] },
    { asOf: 'invalid' },
  ])('rejects invalid or future inputs: %j', (overrides) => {
    expect(() => validateRepeatFilters({ ...filters, ...overrides }, at(200))).toThrow();
  });
  it('returns only aggregate data', () => {
    const report = JSON.stringify(summarize([receipt('secret-sale', 0)]));
    for (const value of [
      'secret-sale',
      'commercial-1',
      'customerId',
      'patient',
      'phone',
      'medicineId',
    ])
      expect(report).not.toContain(value);
  });
  it('reads only tenant-selected originals without an enrollment lower bound or tenders/clinical joins', async () => {
    const findMany = vi.fn().mockResolvedValue([receipt('a', 0)]);
    await readRepeatPurchasing(
      { pharmacySale: { findMany } } as unknown as ScopedDb,
      'org',
      filters
    );
    const args = findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({
      organizationId: 'org',
      branchId: { in: ['b1', 'b2'] },
      status: 'COMPLETED',
      originalSaleId: null,
    });
    expect(args.where.completedAt).toBeUndefined();
    expect(args.take).toBe(REPEAT_SCAN_LIMIT + 1);
    expect(JSON.stringify(args.select)).not.toMatch(/patient|medicine|tenders|phone|displayName/);
  });
});
