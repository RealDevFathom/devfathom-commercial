import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { calculateStaffingFootfall, readStaffingFootfall } from './staffing-footfall';

describe('hourly staffing footfall suggestions', () => {
  it('computes all UTC hours and applies configurable planning assumptions', () => {
    const rows = calculateStaffingFootfall(
      [
        new Date('2026-10-01T09:10:00Z'),
        new Date('2026-10-01T09:20:00Z'),
        new Date('2026-10-02T09:10:00Z'),
        new Date('2026-10-02T09:20:00Z'),
      ],
      2,
      { receiptsPerStaffHour: 1, minimumSuggestedStaff: 1 }
    );
    expect(rows).toHaveLength(24);
    expect(rows[9]).toEqual({ hourUtc: 9, receiptCount: 4, averageReceipts: 2, suggestedStaff: 2 });
    expect(rows[8]?.suggestedStaff).toBe(1);
  });

  it('reads only completed receipts in the tenant branch and returns suggestions without writes', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { completedAt: new Date('2026-10-01T15:00:00Z') },
        { completedAt: null },
      ]);
    const db = { pharmacySale: { findMany } } as never;
    const report = await readStaffingFootfall(db, 'org_1', {
      branchId: 'branch_1',
      from: '2026-10-01',
      to: '2026-10-02',
      receiptsPerStaffHour: 4,
      minimumSuggestedStaff: 0,
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_1',
        branchId: 'branch_1',
        status: 'COMPLETED',
        receiptNumber: { not: null },
        completedAt: {
          gte: new Date('2026-10-01T00:00:00.000Z'),
          lt: new Date('2026-10-03T00:00:00.000Z'),
        },
      },
      select: { completedAt: true },
    });
    expect(report.hours[15]).toMatchObject({
      receiptCount: 1,
      averageReceipts: 0.5,
      suggestedStaff: 1,
    });
    expect(report.estimated).toBe(true);
  });
});
