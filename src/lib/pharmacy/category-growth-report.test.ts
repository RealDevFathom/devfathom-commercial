import { describe, expect, it, vi } from 'vitest';
import { readPharmacyCategoryGrowthReport } from './category-growth-report';

describe('pharmacy OTC and cosmetics category growth report', () => {
  it('matches category fixtures and calculates configured productivity and gaps', async () => {
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          branchId: 'b1',
          category: 'OTC',
          salesMinor: '7500',
          units: '15',
          branchSalesMinor: '20000',
        },
        {
          branchId: 'b1',
          category: 'COSMETICS',
          salesMinor: '2500',
          units: '4',
          branchSalesMinor: '20000',
        },
      ]),
    };
    const [report] = await readPharmacyCategoryGrowthReport(db as never, 'org', {
      branchIds: ['b1'],
      from: '2026-10-01',
      to: '2026-10-08',
      configuration: [
        { category: 'OTC', displaySpaceSquareMetres: 5, targetSalesSharePercent: 70 },
        { category: 'COSMETICS', displaySpaceSquareMetres: 2, targetSalesSharePercent: 35 },
      ],
    });
    expect(report).toEqual({
      branchId: 'b1',
      salesBasis: 'GROSS_COMPLETED_RECEIPTS_WORKSPACE_DAY_COMPLETED_AT',
      totalSalesMinor: 20000,
      categories: [
        {
          category: 'OTC',
          catalogScope: 'OTC_FLAG',
          label: 'OTC medicines',
          salesMinor: 7500,
          units: 15,
          salesSharePercent: 37.5,
          displaySpaceSquareMetres: 5,
          salesMinorPerSquareMetre: 1500,
          targetSalesSharePercent: 70,
          shareGapPercentagePoints: 32.5,
        },
        {
          category: 'COSMETICS',
          catalogScope: 'FRONT_SHOP',
          label: 'Front-shop (cosmetics and other non-drug items)',
          salesMinor: 2500,
          units: 4,
          salesSharePercent: 12.5,
          displaySpaceSquareMetres: 2,
          salesMinorPerSquareMetre: 1250,
          targetSalesSharePercent: 35,
          shareGapPercentagePoints: 22.5,
        },
      ],
    });
  });

  it('leaves estimates unknown when the tenant has not configured them', async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([]) };
    const [report] = await readPharmacyCategoryGrowthReport(db as never, 'org', {
      branchIds: ['b1'],
      from: '2026-10-01',
      to: '2026-10-02',
      configuration: [],
    });
    expect(report.categories[0]).toMatchObject({
      salesMinor: 0,
      salesSharePercent: 0,
      salesMinorPerSquareMetre: null,
      targetSalesSharePercent: null,
      shareGapPercentagePoints: null,
    });
  });

  it.each([
    { from: '2026-02-30' },
    { to: '2026-02-30' },
    { from: '2026-13-01' },
    { from: '2026-2-01' },
    { to: '2026-05-03' }, // 91 days from February 1, exclusive cutoff.
    { to: '2026-02-01' },
    { to: '2026-01-31' },
    { branchIds: [] },
    { branchIds: Array.from({ length: 101 }, (_, i) => `b${i}`) },
  ])('rejects invalid dates or unbounded scope before SQL: %j', async (overrides) => {
    const db = { $queryRaw: vi.fn() };
    await expect(
      readPharmacyCategoryGrowthReport(db as never, 'org', {
        branchIds: ['b1'],
        from: '2026-02-01',
        to: '2026-02-02',
        configuration: [],
        ...overrides,
      })
    ).rejects.toThrow();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('allows exactly 90 days and 100 branches', async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([]) };
    const report = await readPharmacyCategoryGrowthReport(db as never, 'org', {
      branchIds: Array.from({ length: 100 }, (_, i) => `b${i}`),
      from: '2026-02-01',
      to: '2026-05-02',
      configuration: [],
    });
    expect(report).toHaveLength(100);
    expect(db.$queryRaw).toHaveBeenCalledOnce();
  });

  it('sums stored line gross so lines split across batches are not undercounted', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    await readPharmacyCategoryGrowthReport({ $queryRaw: queryRaw } as never, 'org', {
      branchIds: ['b1'],
      from: '2026-10-01',
      to: '2026-10-08',
      configuration: [],
    });
    const sql = (queryRaw.mock.calls[0][0] as { strings: string[] }).strings.join('?');
    expect(sql).toContain('"grossMinor"::bigint - "discountMinor"');
    expect(sql).toContain('l."grossMinor"::bigint - l."discountMinor"');
    expect(sql).not.toContain('"unitPriceMinor"');
  });
});

describe("DEV-944 category growth on the shop's own days", () => {
  async function windowFor(timeZone: string | null | undefined, from: string, to: string) {
    const queryRaw = vi.fn().mockResolvedValue([]);
    await readPharmacyCategoryGrowthReport({ $queryRaw: queryRaw } as never, 'org', {
      branchIds: ['b1'],
      from,
      to,
      configuration: [],
      timeZone,
    });
    const values = (queryRaw.mock.calls[0][0] as { values: unknown[] }).values;
    return values.filter((value): value is Date => value instanceof Date);
  }

  it('starts and ends a Karachi window at local midnight', async () => {
    // Exclusive cutoff 8 Oct: Karachi days 1..7 Oct, from 30 Sep 19:00 UTC to 7 Oct 19:00 UTC.
    expect(await windowFor('Asia/Karachi', '2026-10-01', '2026-10-08')).toEqual([
      new Date('2026-09-30T19:00:00.000Z'),
      new Date('2026-10-07T19:00:00.000Z'),
    ]);
  });

  it('counts a sale at 19:30 UTC on the next Karachi day and one at 18:59 UTC on this one', async () => {
    const [startsAt, endsBefore] = await windowFor('Asia/Karachi', '2026-10-02', '2026-10-03');
    const inWindow = (at: string) => new Date(at) >= startsAt! && new Date(at) < endsBefore!;
    // 00:30 on 2 Oct in Karachi.
    expect(inWindow('2026-10-01T19:30:00.000Z')).toBe(true);
    // 23:59 on 2 Oct in Karachi.
    expect(inWindow('2026-10-02T18:59:00.000Z')).toBe(true);
    // 00:30 on 3 Oct in Karachi: the next window.
    expect(inWindow('2026-10-02T19:30:00.000Z')).toBe(false);
  });

  it.each([undefined, null, 'UTC', 'PKT'])(
    'keeps the UTC window for an organisation on UTC (zone %s)',
    async (zone) => {
      expect(await windowFor(zone, '2026-10-01', '2026-10-08')).toEqual([
        new Date('2026-10-01T00:00:00.000Z'),
        new Date('2026-10-08T00:00:00.000Z'),
      ]);
    }
  );

  it('keeps period-over-period windows the same length in shop days', async () => {
    const current = await windowFor('Asia/Karachi', '2026-10-08', '2026-10-15');
    const previous = await windowFor('Asia/Karachi', '2026-10-01', '2026-10-08');
    const length = ([from, to]: Date[]) => to!.getTime() - from!.getTime();
    expect(length(current)).toBe(7 * 86_400_000);
    expect(length(previous)).toBe(length(current));
    // The previous window ends exactly where the current one starts.
    expect(previous[1]).toEqual(current[0]);
  });

  it('keeps the 90-day limit on calendar days, in words that do not name UTC', async () => {
    const db = { $queryRaw: vi.fn() };
    const read = readPharmacyCategoryGrowthReport(db as never, 'org', {
      branchIds: ['b1'],
      from: '2026-02-01',
      to: '2026-05-03',
      configuration: [],
      timeZone: 'Asia/Karachi',
    });
    await expect(read).rejects.toThrow(
      'Use valid dates spanning at most 90 days and 1–100 authorized branches.'
    );
    await expect(read).rejects.not.toThrow(/UTC/);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});
