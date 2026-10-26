import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { readPaymentsReport, exportRestaurantReportCsv } from './reports';
import { readFinancialComparison, restaurantComparisonWindows } from './financial-comparison';

const range = { branchIds: ['b1', 'b2'], from: '2024-03-01', to: '2024-03-01' };
const scope = { organizationId: 'org1' };

function close(id: string, businessDate: string, netSales: string, branchId = 'b1') {
  const value = new Prisma.Decimal(netSales);
  const zero = new Prisma.Decimal('0');
  return {
    id,
    branchId,
    branch: { name: branchId },
    businessDate: new Date(`${businessDate}T00:00:00Z`),
    createdAt: new Date('2024-03-02T12:00:00Z'),
    supersedesCloseId: null as string | null,
    // netSales is the authoritative close value, independent of these other totals.
    grossSales: value.plus('8.80'),
    netSales: value,
    compTotal: new Prisma.Decimal('1.10'),
    discountTotal: new Prisma.Decimal('2.20'),
    refundTotal: new Prisma.Decimal('5.50'),
    taxTotal: new Prisma.Decimal('0.70'),
    serviceChargeTotal: new Prisma.Decimal('0.60'),
    tipTotal: new Prisma.Decimal('0.90'),
    deliveryFeeSales: new Prisma.Decimal('1.20'),
    deliveryFeeRefunds: new Prisma.Decimal('0.50'),
    voidTotal: zero,
    cashExpected: new Prisma.Decimal('20.00'),
    cashCounted: new Prisma.Decimal('19.99'),
    cashVariance: new Prisma.Decimal('-0.01'),
    tenderTotals: [],
  };
}

function fixture(
  current = [close('c1', range.from, '0.30')],
  previous = [close('p1', '2024-02-29', '0.10')]
) {
  const db = {
    organization: { findUnique: vi.fn().mockResolvedValue({ currency: 'PKR' }) },
    restaurantDailyClose: {
      findMany: vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(previous),
    },
    insightDailyRollup: { findMany: vi.fn().mockResolvedValue([]) },
    restaurantDrawerSession: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          ...new Map(
            [...current, ...previous].map((row) => [
              `${row.branchId}:${row.businessDate.toISOString()}`,
              drawer(row),
            ])
          ).values(),
        ]),
    },
  };
  return {
    db,
    read: (requestedRange = range) =>
      readFinancialComparison(db as unknown as ScopedDb, requestedRange, scope),
  };
}

function drawer(
  row: ReturnType<typeof close>,
  countedCash: Prisma.Decimal | null = row.cashCounted
) {
  return {
    branchId: row.branchId,
    businessDate: row.businessDate,
    createdAt: new Date('2024-03-01T00:00:00Z'),
    closedAt: new Date('2024-03-02T11:00:00Z'),
    status: 'CLOSED',
    countedCash,
  };
}

describe('restaurant financial comparison business-date windows', () => {
  it.each([
    ['2024-03-01', '2024-03-02', '2024-02-28', '2024-02-29', 2],
    ['2026-01-01', '2026-01-01', '2025-12-31', '2025-12-31', 1],
    ['2026-03-08', '2026-03-09', '2026-03-06', '2026-03-07', 2],
  ])('derives adjacent equal windows for %s to %s', (from, to, previousFrom, previousTo, days) => {
    expect(restaurantComparisonWindows({ ...range, from, to })).toEqual({
      current: { ...range, from, to },
      previous: { branchIds: range.branchIds, from: previousFrom, to: previousTo },
      days,
    });
  });

  it('accepts 45 days and rejects 46 before any reads', async () => {
    expect(
      restaurantComparisonWindows({ ...range, from: '2026-02-15', to: '2026-03-31' }).days
    ).toBe(45);
    const { db } = fixture();
    await expect(
      readFinancialComparison(
        db as unknown as ScopedDb,
        { ...range, from: '2026-02-14', to: '2026-03-31' },
        scope
      )
    ).rejects.toThrow('90');
    expect(db.organization.findUnique).not.toHaveBeenCalled();
    expect(db.restaurantDailyClose.findMany).not.toHaveBeenCalled();
  });

  it.each([
    { ...range, from: '2026-02-30' },
    { ...range, from: '2024-03-02' },
    { ...range, branchIds: [] },
    { ...range, branchIds: ['b1', 'b1'] },
    { ...range, branchIds: Array.from({ length: 101 }, (_, i) => `b${i}`) },
  ])('rejects invalid combined scope %#', (invalid) => {
    expect(() => restaurantComparisonWindows(invalid)).toThrow();
  });
});

describe('restaurant financial comparison from the existing payment reader', () => {
  it('keeps exact major Decimal values, drivers and refund semantics', async () => {
    const { read } = fixture();
    const report = await read();
    expect(report.drivers.netSales).toMatchObject({
      current: '0.30',
      previous: '0.10',
      absoluteChange: '0.20',
      percentageChange: '200.00',
    });
    expect(report.drivers.netSales.definition).toContain('refunded pre-tax sales principal');
    expect(report.drivers.refundTotal.current).toBe('5.50');
    expect(report.drivers.deliveryFeeRefunds.current).toBe('0.50');
    expect(report.drivers.deliveryFeeRefunds.definition).toContain(
      'reported separately from refundTotal'
    );
    expect(report.drivers.refundTotal.definition).toContain(
      'only its pre-tax sales principal is deducted from netSales'
    );
    expect(report.drivers.grossSales.current).toBe('9.10');
    expect(report.drivers.discountTotal.current).toBe('2.20');
    expect(report.drivers.compTotal.current).toBe('1.10');
    expect(report.drivers.taxTotal.current).toBe('0.70');
    expect(report.drivers.taxTotal.definition).toContain('minus refunded tax');
    expect(report.drivers.serviceChargeTotal.current).toBe('0.60');
    expect(report.drivers.serviceChargeTotal.definition).toContain(
      'minus refunded service charges'
    );
    expect(report.drivers.tipTotal.current).toBe('0.90');
    expect(report.drivers.cashExpected.current).toBe('20.00');
    expect(report.drivers.cashCounted.current).toBe('19.99');
    expect(report.drivers.cashVariance.current).toBe('-0.01');
    expect(report.refundAdjustedNetSales).toBeNull();
    expect(report.currency).toBe('PKR');
    expect(report.moneyUnit).toBe('DECIMAL_MAJOR');
    expect(report.periodBasis).toBe('BUSINESS_DATE');
  });

  it('returns null percentages for observed zero baselines', async () => {
    const { read } = fixture([close('c', range.from, '3.00')], [close('p', '2024-02-29', '0')]);
    expect((await read()).drivers.netSales).toMatchObject({
      current: '3.00',
      previous: '0.00',
      absoluteChange: '3.00',
      percentageChange: null,
    });
  });

  it('does not turn missing closed days into zero sales', async () => {
    const { db, read } = fixture([], []);
    const report = await read();
    expect(report.drivers.netSales).toMatchObject({
      current: null,
      previous: null,
      absoluteChange: null,
      percentageChange: null,
    });
    expect(report.coverage.current).toMatchObject({
      status: 'NO_CLOSED_DAYS',
      closedDayCount: 0,
      expectedDayCount: 2,
    });
    expect(report.cashCountCoverage.current.status).toBe('NO_CLOSED_DAYS');
    expect(report.discountRate).toMatchObject({
      current: null,
      previous: null,
      percentagePointChange: null,
    });
    expect(report.discountRate.unavailableReason.current).toContain('No observed');
    expect(db.restaurantDrawerSession.findMany).not.toHaveBeenCalled();
  });

  it('does not invent a baseline when only the previous period is missing', async () => {
    const { read } = fixture([close('c', range.from, '5')], []);
    expect((await read()).drivers.netSales).toMatchObject({
      current: '5.00',
      previous: null,
      absoluteChange: null,
      percentageChange: null,
    });
  });

  it('uses corrected chain tips once and preserves stale/missing coverage across two branches', async () => {
    const old = close('old', range.from, '999');
    const tip = { ...close('tip', range.from, '10'), supersedesCloseId: 'old' };
    const second = close('second', range.from, '20', 'b2');
    const { db, read } = fixture([old, tip, second]);
    db.insightDailyRollup.findMany.mockResolvedValueOnce([
      {
        id: 'r',
        branchId: 'b1',
        businessDate: old.businessDate,
        sourceDailyCloseId: 'old',
        orderCount: 9,
        coverCount: 9,
      },
    ]);
    const report = await read();
    expect(report.drivers.netSales.current).toBe('30.00');
    expect(report.coverage.current).toMatchObject({
      status: 'STALE',
      closedDayCount: 2,
      staleDayCount: 1,
      correctedDayCount: 1,
      unprojectedDayCount: 1,
    });
    expect(report.coverage.previous).toMatchObject({ status: 'PARTIAL', missingClosedDayCount: 1 });
  });

  it('binds both windows to identical server asOf filters without claiming a snapshot', async () => {
    const { db, read } = fixture();
    const report = await read();
    expect(db.organization.findUnique).toHaveBeenCalledWith({
      where: { id: 'org1' },
      select: { currency: true },
    });
    for (const [index, dates] of [
      [0, ['2024-03-01', '2024-03-01']],
      [1, ['2024-02-29', '2024-02-29']],
    ] as const) {
      expect(db.restaurantDailyClose.findMany.mock.calls[index]?.[0]).toMatchObject({
        where: {
          branchId: { in: ['b1', 'b2'] },
          businessDate: { gte: new Date(dates[0]), lte: new Date(dates[1]) },
          createdAt: { lte: new Date(report.asOf) },
        },
      });
      expect(db.insightDailyRollup.findMany.mock.calls[index]?.[0]).toMatchObject({
        where: { computedAt: { lte: new Date(report.asOf) } },
      });
    }
    expect(report.consistency.snapshotGuaranteed).toBe(false);
    expect(report.observedThrough >= report.asOf).toBe(true);
  });

  it('keeps unavailable currency explicit', async () => {
    const { db, read } = fixture();
    db.organization.findUnique.mockResolvedValue(null);
    expect((await read()).currency).toBeNull();
  });

  it('handles negative drawer baselines with signed change and absolute denominator', async () => {
    const current = { ...close('c', range.from, '3'), cashVariance: new Prisma.Decimal('-2') };
    const previous = { ...close('p', '2024-02-29', '3'), cashVariance: new Prisma.Decimal('-4') };
    const { read } = fixture([current], [previous]);
    expect((await read()).drivers.cashVariance).toMatchObject({
      absoluteChange: '2.00',
      percentageChange: '50.00',
    });
  });

  it.each([null, '0'])(
    'distinguishes a null drawer count from explicit zero with CURRENT closed-day coverage (%s)',
    async (counted) => {
      const current = {
        ...close('c', range.from, '3'),
        cashExpected: new Prisma.Decimal(100),
        cashCounted: new Prisma.Decimal(0),
        cashVariance: new Prisma.Decimal(-100),
      };
      const previous = {
        ...close('p', '2024-02-29', '3'),
        cashExpected: new Prisma.Decimal(100),
        cashCounted: new Prisma.Decimal(100),
        cashVariance: new Prisma.Decimal(0),
      };
      const { db, read } = fixture([current], [previous]);
      db.restaurantDrawerSession.findMany
        .mockResolvedValueOnce([
          drawer(current, counted === null ? null : new Prisma.Decimal(counted)),
        ])
        .mockResolvedValueOnce([drawer(previous)]);
      for (const row of [current, previous]) {
        db.insightDailyRollup.findMany.mockResolvedValueOnce([
          {
            branchId: row.branchId,
            businessDate: row.businessDate,
            sourceDailyCloseId: row.id,
            orderCount: 1,
          },
        ]);
      }
      const report = await read({ ...range, branchIds: ['b1'] });
      expect(report.coverage.current.status).toBe('CURRENT');
      expect(report.coverage.previous.status).toBe('CURRENT');
      expect(report.cashCountCoverage.current).toMatchObject({
        status: counted === null ? 'INCOMPLETE' : 'COMPLETE',
        drawerSessionCount: 1,
        missingCountSessionCount: counted === null ? 1 : 0,
      });
      expect(report.drivers.cashCounted).toMatchObject({
        current: counted === null ? null : '0.00',
        previous: '100.00',
        absoluteChange: counted === null ? null : '-100.00',
        percentageChange: counted === null ? null : '-100.00',
      });
      expect(report.drivers.cashVariance).toMatchObject({
        current: counted === null ? null : '-100.00',
        previous: '0.00',
        absoluteChange: counted === null ? null : '-100.00',
        percentageChange: null,
      });
      expect(report.drivers.cashExpected.current).toBe('100.00');
      expect(report.drivers.netSales.current).toBe('3.00');
    }
  );

  it('withholds an incomplete previous count and every dependent change', async () => {
    const current = close('c', range.from, '3');
    const previous = close('p', '2024-02-29', '3');
    const { db, read } = fixture([current], [previous]);
    db.restaurantDrawerSession.findMany
      .mockResolvedValueOnce([drawer(current)])
      .mockResolvedValueOnce([drawer(previous, null)]);
    const report = await read();
    for (const key of ['cashCounted', 'cashVariance'] as const) {
      expect(report.drivers[key]).toMatchObject({
        previous: null,
        absoluteChange: null,
        percentageChange: null,
      });
      expect(report.drivers[key].current).not.toBeNull();
    }
  });

  it('withholds all counted cash for a mixed complete/incomplete two-branch period', async () => {
    const one = close('one', range.from, '10');
    const two = { ...close('two', range.from, '20', 'b2'), cashCounted: new Prisma.Decimal(0) };
    const { db, read } = fixture([one, two]);
    db.restaurantDrawerSession.findMany.mockResolvedValueOnce([drawer(one), drawer(two, null)]);
    const report = await read();
    expect(report.cashCountCoverage.current).toMatchObject({
      status: 'INCOMPLETE',
      drawerSessionCount: 2,
      missingCountSessionCount: 1,
    });
    expect(report.drivers.cashCounted.current).toBeNull();
    expect(report.drivers.cashVariance.absoluteChange).toBeNull();
    expect(report.drivers.cashExpected.current).toBe('40.00');
    expect(report.drivers.netSales.current).toBe('30.00');
  });

  it.each(['OPEN', 'late-close', 'missing-close-time', 'mismatched-total'])(
    'withholds unverified source-close counts (%s)',
    async (reason) => {
      const current = close('c', range.from, '3');
      const session = drawer(current);
      if (reason === 'OPEN') session.status = 'OPEN';
      const { db, read } = fixture([current]);
      db.restaurantDrawerSession.findMany.mockResolvedValueOnce([
        {
          ...session,
          closedAt:
            reason === 'late-close'
              ? new Date('2024-03-03T00:00:00Z')
              : reason === 'missing-close-time'
                ? null
                : session.closedAt,
          countedCash: reason === 'mismatched-total' ? new Prisma.Decimal(0) : session.countedCash,
        },
      ]);
      const report = await read();
      expect(report.cashCountCoverage.current.status).toBe('INCOMPLETE');
      expect(report.drivers.cashCounted.current).toBeNull();
      expect(report.drivers.cashVariance.percentageChange).toBeNull();
    }
  );

  it('ignores drawer sessions outside authoritative closed days and created after the source close', async () => {
    const current = close('c', range.from, '3');
    const { db, read } = fixture([current]);
    db.restaurantDrawerSession.findMany.mockResolvedValueOnce([
      drawer(current),
      { ...drawer(current, null), branchId: 'b2' },
      { ...drawer(current, null), createdAt: new Date('2024-03-03T00:00:00Z') },
    ]);
    const report = await read();
    expect(report.cashCountCoverage.current).toMatchObject({
      status: 'COMPLETE',
      drawerSessionCount: 1,
    });
    expect(report.drivers.cashCounted.current).toBe('19.99');
    expect(db.restaurantDrawerSession.findMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        branchId: { in: ['b1', 'b2'] },
        businessDate: { gte: new Date(range.from), lte: new Date(range.to) },
      },
    });
  });

  it('calculates discount rate from aggregate gross basis, excluding comps and refund drivers', async () => {
    const one = {
      ...close('one', range.from, '1'),
      grossSales: new Prisma.Decimal('3'),
      discountTotal: new Prisma.Decimal('1'),
    };
    const two = {
      ...close('two', range.from, '1', 'b2'),
      grossSales: new Prisma.Decimal('7'),
      discountTotal: new Prisma.Decimal('1'),
    };
    const previous = {
      ...close('p', '2024-02-29', '1'),
      grossSales: new Prisma.Decimal('8'),
      discountTotal: new Prisma.Decimal('1'),
    };
    const { read } = fixture([one, two], [previous]);
    const report = await read();
    expect(report.discountRate).toMatchObject({
      unit: 'PERCENT',
      current: '20.00',
      previous: '12.50',
      percentagePointChange: '7.50',
      unavailableReason: { current: null, previous: null },
    });
    expect(report.discountRate.definition).toContain('before comps and discounts');
    expect(report.discountRate.definition).toContain('Partial coverage');
  });

  it('rounds discount ratios HALF_UP and changes from unrounded Decimal ratios', async () => {
    const current = {
      ...close('c', range.from, '1'),
      grossSales: new Prisma.Decimal('32'),
      discountTotal: new Prisma.Decimal('1'),
    };
    const previous = {
      ...close('p', '2024-02-29', '1'),
      grossSales: new Prisma.Decimal('3'),
      discountTotal: new Prisma.Decimal('0.1'),
    };
    const { read } = fixture([current], [previous]);
    expect((await read()).discountRate).toMatchObject({
      current: '3.13',
      previous: '3.33',
      percentagePointChange: '-0.21',
    });
  });

  it.each(['0', '-1'])(
    'reports discount rate unavailable for non-positive gross basis (%s)',
    async (grossSales) => {
      const { read } = fixture([
        { ...close('c', range.from, '0'), grossSales: new Prisma.Decimal(grossSales) },
      ]);
      expect((await read()).discountRate).toMatchObject({
        current: null,
        percentagePointChange: null,
        unavailableReason: {
          current: 'Settled gross sales must be positive to define the discount rate.',
        },
      });
    }
  );

  it('preserves an observed zero discount rate', async () => {
    const { read } = fixture([
      { ...close('c', range.from, '1'), discountTotal: new Prisma.Decimal(0) },
    ]);
    expect((await read()).discountRate).toMatchObject({
      current: '0.00',
      unavailableReason: { current: null },
    });
  });
});

describe('authoritative close net sales', () => {
  it.each([['7'], ['4'], ['7', '4']])(
    'uses stored values %j without mutating closes',
    async (...stored) => {
      const rows = stored.map((net, i) => ({
        ...close(`legacy-${i}`, i === 0 ? range.from : '2024-03-02', net),
        grossSales: new Prisma.Decimal('10'),
        compTotal: new Prisma.Decimal('2'),
        discountTotal: new Prisma.Decimal('1'),
        refundTotal: new Prisma.Decimal('3'),
      }));
      const before = rows.map((row) => row.netSales.toString());
      const period = { ...range, to: stored.length === 2 ? '2024-03-02' : range.to };
      const { read } = fixture(rows);
      const paymentDb = fixture(rows).db;
      const payments = await readPaymentsReport(paymentDb as unknown as ScopedDb, period);
      const expected = stored.reduce((total, value) => total.plus(value), new Prisma.Decimal(0));
      expect(payments.netSales).toBe(expected.toString());
      const csv = await exportRestaurantReportCsv(
        fixture(rows).db as unknown as ScopedDb,
        'payments',
        period,
        { includeLabourCosts: false }
      );
      const [header, line] = csv.content.split('\n');
      expect(line!.split(',')[header!.split(',').indexOf('netSales')]).toBe(payments.netSales);
      const report = await read(period);
      expect(report.drivers.netSales.current).toBe(expected.toFixed(2));
      expect(report.drivers.netSales.definition).toContain('Authoritative daily-close sales');
      expect(report.drivers.refundTotal.definition).toContain(
        'only its pre-tax sales principal is deducted from netSales'
      );
      expect(rows.map((row) => row.netSales.toString())).toEqual(before);
    }
  );
});
