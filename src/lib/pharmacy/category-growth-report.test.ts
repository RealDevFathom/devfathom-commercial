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
      salesBasis: 'GROSS_COMPLETED_RECEIPTS_UTC_COMPLETED_AT',
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
});
