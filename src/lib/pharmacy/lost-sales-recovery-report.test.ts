import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { readLostSalesRecovery } from './lost-sales-recovery-report';

const salts = (...names: string[]) => ({
  strengths: names.map((name) => ({ ingredient: { name } })),
});

function fixtureDb() {
  return {
    pharmacyBranch: {
      findMany: async () => [
        { id: 'b1', name: 'Main' },
        { id: 'b2', name: 'Gulberg' },
      ],
    },
    unfulfilledDemandEvent: {
      findMany: async () => [
        {
          id: 'e1',
          branchId: 'b1',
          requestedMedicineId: 'med-pcm',
          estimatedValueMinor: 50_000,
          recoveredSaleLineId: 'line-1',
          medicine: salts('Paracetamol'),
        },
        {
          id: 'e2',
          branchId: 'b1',
          requestedMedicineId: 'med-pcm',
          estimatedValueMinor: 30_000,
          recoveredSaleLineId: null,
          medicine: salts('Paracetamol'),
        },
        {
          id: 'e3',
          branchId: 'b2',
          requestedMedicineId: 'med-amx',
          estimatedValueMinor: 120_000,
          recoveredSaleLineId: 'line-2',
          medicine: salts('Amoxicillin'),
        },
        {
          id: 'e4',
          branchId: 'b2',
          requestedMedicineId: null,
          estimatedValueMinor: null,
          recoveredSaleLineId: null,
          medicine: null,
        },
      ],
    },
    pharmacySaleLine: {
      findMany: async () => [
        { id: 'line-1', grossMinor: 48_000, discountMinor: 3_000 },
        { id: 'line-2', grossMinor: 20_000, discountMinor: 0 },
      ],
    },
    pharmacyGoodsReceiptLine: {
      findMany: async () => [
        {
          branchId: 'b1',
          medicineId: 'med-pcm',
          goodsReceipt: { postedAt: new Date('2026-10-01'), supplier: { name: 'Old Distributor' } },
        },
        {
          branchId: 'b1',
          medicineId: 'med-pcm',
          goodsReceipt: { postedAt: new Date('2026-11-01'), supplier: { name: 'Muller & Phipps' } },
        },
        {
          branchId: 'b2',
          medicineId: 'med-amx',
          goodsReceipt: {
            postedAt: new Date('2026-11-02'),
            supplier: { name: 'United Distributors' },
          },
        },
      ],
    },
  };
}

describe('DEV-79 lost-sales recovery report', () => {
  it('matches the fixture totals by branch, salt and distributor', async () => {
    const report = await readLostSalesRecovery(fixtureDb() as never, 'org-1', {
      branchIds: ['b1', 'b2'],
      from: '2026-11-01',
      to: '2026-11-15',
    });
    expect(report.totals).toEqual({
      estimatedLostMinor: 200_000,
      recoveredMinor: 65_000,
      netMinor: 135_000,
      events: 4,
      recoveredEvents: 2,
    });
    const pick = (rows: typeof report.byBranch) =>
      Object.fromEntries(
        rows.map((row) => [row.label, [row.estimatedLostMinor, row.recoveredMinor, row.netMinor]])
      );
    expect(pick(report.byBranch)).toEqual({
      Main: [80_000, 45_000, 35_000],
      Gulberg: [120_000, 20_000, 100_000],
    });
    expect(pick(report.bySalt)).toEqual({
      Paracetamol: [80_000, 45_000, 35_000],
      Amoxicillin: [120_000, 20_000, 100_000],
      'Unresolved salt': [0, 0, 0],
    });
    // The latest posted receipt names the distributor.
    expect(pick(report.byDistributor)).toEqual({
      'Muller & Phipps': [80_000, 45_000, 35_000],
      'United Distributors': [120_000, 20_000, 100_000],
      'Unknown distributor': [0, 0, 0],
    });
    expect(report).toMatchObject({
      estimated: true,
      truncated: false,
      missingEstimates: 1,
      policy: { requestExpiryDays: 14, recoveryWindowDays: 7 },
    });
  });

  it('refuses a scope wider than 90 days', async () => {
    await expect(
      readLostSalesRecovery(fixtureDb() as never, 'org-1', {
        branchIds: ['b1'],
        from: '2026-01-01',
        to: '2026-11-15',
      })
    ).rejects.toThrow('Use valid UTC dates');
  });
});
