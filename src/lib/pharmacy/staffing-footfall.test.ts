import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { calculateStaffingFootfall, readStaffingFootfall } from './staffing-footfall';

describe('hourly staffing footfall suggestions', () => {
  it('expands database aggregates to all local hours and applies planning assumptions', () => {
    const rows = calculateStaffingFootfall([{ hourLocal: 9, receiptCount: 4 }], 2, {
      receiptsPerStaffHour: 1,
      minimumSuggestedStaff: 1,
    });
    expect(rows).toHaveLength(24);
    expect(rows[9]).toEqual({
      hourLocal: 9,
      receiptCount: 4,
      averageReceipts: 2,
      suggestedStaff: 2,
    });
    expect(rows[8]?.suggestedStaff).toBe(1);
  });

  it('uses the authorized non-UTC workspace timezone for local bounds and aggregation', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ hourLocal: 9, receiptCount: 3 }]);
    const branchFindFirst = vi.fn().mockResolvedValue({ id: 'branch_1' });
    const organizationFindUnique = vi.fn().mockResolvedValue({ timezone: 'Asia/Kolkata' });
    const db = {
      pharmacyBranch: { findFirst: branchFindFirst },
      organization: { findUnique: organizationFindUnique },
      $queryRaw: queryRaw,
    } as never;
    const report = await readStaffingFootfall(db, 'org_1', {
      branchId: 'branch_1',
      from: '2026-10-01',
      to: '2026-10-02',
      receiptsPerStaffHour: 4,
      minimumSuggestedStaff: 0,
    });

    expect(branchFindFirst).toHaveBeenCalledWith({
      where: { id: 'branch_1', organizationId: 'org_1', active: true },
      select: { id: true },
    });
    expect(organizationFindUnique).toHaveBeenCalledWith({
      where: { id: 'org_1' },
      select: { timezone: true },
    });
    const query = queryRaw.mock.calls[0]![0] as { strings: string[]; values: unknown[] };
    expect(query.strings.join('?')).toContain(
      `EXTRACT(HOUR FROM ("completedAt" AT TIME ZONE 'UTC') AT TIME ZONE ?`
    );
    expect(query.strings.join('?')).toContain('::date AT TIME ZONE ?');
    expect(query.values).toEqual([
      'Asia/Kolkata',
      'org_1',
      'branch_1',
      '2026-10-01',
      'Asia/Kolkata',
      '2026-10-02',
      'Asia/Kolkata',
    ]);
    expect(report.period).toEqual({
      from: '2026-10-01',
      to: '2026-10-02',
      timezone: 'Asia/Kolkata',
      days: 2,
    });
    expect(report.hours[9]).toMatchObject({ receiptCount: 3, averageReceipts: 1.5 });
  });

  it('keeps DST-transition date bounds as local midnights for PostgreSQL to resolve', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      { hourLocal: 1, receiptCount: 2 },
      { hourLocal: 3, receiptCount: 1 },
    ]);
    const db = {
      pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'branch_1' }) },
      organization: {
        findUnique: vi.fn().mockResolvedValue({ timezone: 'America/New_York' }),
      },
      $queryRaw: queryRaw,
    } as never;
    const report = await readStaffingFootfall(db, 'org_1', {
      branchId: 'branch_1',
      from: '2026-03-08',
      to: '2026-03-08',
      receiptsPerStaffHour: 2,
      minimumSuggestedStaff: 0,
    });
    const query = queryRaw.mock.calls[0]![0] as { strings: string[]; values: unknown[] };
    expect(query.values).toContain('America/New_York');
    expect(query.values).toContain('2026-03-08');
    expect(report.period.days).toBe(1);
    expect(report.hours[2]?.receiptCount).toBe(0);
  });

  it('rejects a branch that is not active in the entitled organization before reading sales', async () => {
    const queryRaw = vi.fn();
    const db = {
      pharmacyBranch: { findFirst: vi.fn().mockResolvedValue(null) },
      organization: { findUnique: vi.fn() },
      $queryRaw: queryRaw,
    } as never;
    await expect(
      readStaffingFootfall(db, 'org_1', {
        branchId: 'foreign_branch',
        from: '2026-10-01',
        to: '2026-10-01',
        receiptsPerStaffHour: 4,
        minimumSuggestedStaff: 0,
      })
    ).rejects.toThrow('outside your report scope');
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
