import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));

import { csvCell, readOverviewReport, rowsToCsv, validateRestaurantReportRange } from './reports';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

describe('restaurant report range and CSV safety', () => {
  it('accepts 90 days and rejects 91 or reversed dates', () => {
    expect(
      validateRestaurantReportRange({ branchIds: ['b1'], from: '2026-01-01', to: '2026-03-31' })
        .days
    ).toBe(90);
    expect(() =>
      validateRestaurantReportRange({ branchIds: ['b1'], from: '2026-01-01', to: '2026-04-01' })
    ).toThrow('90');
    expect(() =>
      validateRestaurantReportRange({ branchIds: ['b1'], from: '2026-02-01', to: '2026-01-01' })
    ).toThrow('must not be after');
  });

  it('neutralizes spreadsheet formulas before deterministic RFC-style quoting', () => {
    expect(csvCell('=2+2')).toBe("'=2+2");
    expect(csvCell('  @SUM(A1)')).toBe("'  @SUM(A1)");
    expect(rowsToCsv([{ label: '=cmd', value: 'a,b' }], ['label', 'value'])).toBe(
      'label,value\n\'=cmd,"a,b"'
    );
  });
});

describe('restaurant corrected-close backbone', () => {
  it('queries only chain tips and marks a matching projection current without double count', async () => {
    const close = {
      id: 'corrected',
      branchId: 'b1',
      businessDate: new Date('2026-01-01T00:00:00Z'),
      supersedesCloseId: 'original',
      createdAt: new Date(),
      branch: { name: 'One' },
      tenderTotals: [],
    };
    const db = {
      restaurantDailyClose: { findMany: vi.fn(async () => [close]) },
      insightDailyRollup: {
        findMany: vi.fn(async () => [
          {
            id: 'r1',
            branchId: 'b1',
            businessDate: close.businessDate,
            sourceDailyCloseId: 'corrected',
            orderCount: 7,
            coverCount: 9,
            computedAt: new Date(),
          },
        ]),
      },
      insightItemMixRollup: { findMany: vi.fn(async () => []) },
    } as unknown as ScopedDb;
    const report = await readOverviewReport(db, {
      branchIds: ['b1'],
      from: '2026-01-01',
      to: '2026-01-01',
    });
    expect(report.orderCount).toBe(7);
    expect(report.freshness).toMatchObject({
      status: 'CURRENT',
      closedDayCount: 1,
      correctedDayCount: 1,
    });
    expect(db.restaurantDailyClose.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ supersededBy: { none: {} } }) })
    );
  });

  it('marks a corrected close stale when projection still pins original close', async () => {
    const date = new Date('2026-01-01T00:00:00Z');
    const db = {
      restaurantDailyClose: {
        findMany: vi.fn(async () => [
          {
            id: 'corrected',
            branchId: 'b1',
            businessDate: date,
            supersedesCloseId: 'original',
            createdAt: new Date(),
            branch: { name: 'One' },
            tenderTotals: [],
          },
        ]),
      },
      insightDailyRollup: {
        findMany: vi.fn(async () => [
          {
            id: 'r1',
            branchId: 'b1',
            businessDate: date,
            sourceDailyCloseId: 'original',
            orderCount: 7,
            coverCount: 9,
            computedAt: new Date(),
          },
        ]),
      },
      insightItemMixRollup: { findMany: vi.fn(async () => []) },
    } as unknown as ScopedDb;
    const report = await readOverviewReport(db, {
      branchIds: ['b1'],
      from: '2026-01-01',
      to: '2026-01-01',
    });
    expect(report.freshness).toMatchObject({ status: 'STALE', staleDayCount: 1 });
    expect(report.orderCount).toBe(0);
  });
});
