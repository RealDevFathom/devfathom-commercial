import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_STAFFING_CONFIG,
  hourlyFootfall,
  readStaffingSuggestions,
  StaffingSuggestionError,
  suggestStaffing,
} from './staffing-suggestions';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

describe('hourlyFootfall', () => {
  it('buckets receipts by local hour on the workspace clock, not UTC', () => {
    // 04:30 UTC is 09:30 PKT; 19:10 UTC on the 1st is 00:10 PKT on the 2nd.
    const rows = hourlyFootfall(
      [
        new Date('2026-09-01T04:30:00Z'),
        new Date('2026-09-01T04:45:00Z'),
        new Date('2026-09-02T04:05:00Z'),
        new Date('2026-09-01T19:10:00Z'),
      ],
      'Asia/Karachi',
      2
    );
    expect(rows).toHaveLength(24);
    expect(rows[9]).toEqual({ hour: 9, receipts: 3, averagePerDay: 1.5, busiestDay: 2 });
    expect(rows[0]).toEqual({ hour: 0, receipts: 1, averagePerDay: 0.5, busiestDay: 1 });
    expect(rows[4]).toEqual({ hour: 4, receipts: 0, averagePerDay: 0, busiestDay: 0 });
  });

  it('rejects an empty window', () => {
    expect(() => hourlyFootfall([], 'UTC', 0)).toThrow(StaffingSuggestionError);
  });
});

describe('suggestStaffing', () => {
  const footfall = [
    { hour: 9, receipts: 70, averagePerDay: 10, busiestDay: 14 },
    { hour: 18, receipts: 210, averagePerDay: 30, busiestDay: 40 },
    { hour: 3, receipts: 0, averagePerDay: 0, busiestDay: 0 },
  ];

  it('rounds capacity up, keeps the minimum and skips quiet hours', () => {
    const rows = suggestStaffing(footfall, { receiptsPerStaffHour: 12, minimumStaff: 1 });
    expect(rows.map((row) => row.suggestedStaff)).toEqual([1, 3, null]);
  });

  it('uses the configured assumptions rather than a fixed figure', () => {
    const rows = suggestStaffing(footfall, { receiptsPerStaffHour: 5, minimumStaff: 2 });
    expect(rows.map((row) => row.suggestedStaff)).toEqual([2, 6, null]);
  });

  it('rejects invalid assumptions', () => {
    for (const config of [
      { receiptsPerStaffHour: 0, minimumStaff: 1 },
      { receiptsPerStaffHour: 1.5, minimumStaff: 1 },
      { receiptsPerStaffHour: 10, minimumStaff: 0 },
    ])
      expect(() => suggestStaffing(footfall, config)).toThrow(StaffingSuggestionError);
  });
});

describe('readStaffingSuggestions', () => {
  function db(rows: Array<{ completedAt: Date | null }>) {
    const findMany = vi.fn().mockResolvedValue(rows);
    return { db: { pharmacySale: { findMany } } as unknown as ScopedDb, findMany };
  }

  it('reads only completed original receipts for the branch inside the local window', async () => {
    const { db: client, findMany } = db([
      { completedAt: new Date('2026-09-01T05:00:00Z') },
      { completedAt: null },
    ]);
    const report = await readStaffingSuggestions(client, 'org_1', {
      branchId: 'branch_1',
      from: '2026-09-01',
      to: '2026-09-07',
      timeZone: 'Asia/Karachi',
      config: DEFAULT_STAFFING_CONFIG,
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_1',
        branchId: 'branch_1',
        status: 'COMPLETED',
        originalSaleId: null,
        completedAt: {
          gte: new Date('2026-08-31T19:00:00.000Z'),
          lt: new Date('2026-09-07T19:00:00.000Z'),
        },
      },
      select: { completedAt: true },
    });
    expect(report.days).toBe(7);
    expect(report.totalReceipts).toBe(1);
    expect(report.label).toBe('Suggestion');
    expect(report.hours[10]).toMatchObject({ receipts: 1, suggestedStaff: 1 });
  });

  it('rejects reversed or oversized windows before reading', async () => {
    const { db: client, findMany } = db([]);
    const base = { branchId: 'b', timeZone: 'UTC', config: DEFAULT_STAFFING_CONFIG };
    await expect(
      readStaffingSuggestions(client, 'org_1', { ...base, from: '2026-09-07', to: '2026-09-01' })
    ).rejects.toThrow(StaffingSuggestionError);
    await expect(
      readStaffingSuggestions(client, 'org_1', { ...base, from: '2026-01-01', to: '2026-12-31' })
    ).rejects.toThrow(StaffingSuggestionError);
    expect(findMany).not.toHaveBeenCalled();
  });
});
