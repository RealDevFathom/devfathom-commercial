import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { exportWorkforceAttendanceCsv, presentWorkforceShift } from './workforce';

const baseShift = {
  id: 'shift_1',
  version: 1,
  organizationId: 'org_1',
  branchId: 'branch_1',
  staffProfileId: 'staff_1',
  businessDate: new Date('2026-08-20T00:00:00Z'),
  startAt: new Date('2026-08-20T09:00:00Z'),
  endAt: new Date('2026-08-20T17:00:00Z'),
  role: null,
  notes: null,
  status: 'SCHEDULED' as const,
  cancelledAt: null,
  cancelReason: null,
  clockedInAt: new Date('2026-08-20T09:07:00Z'),
  clockedOutAt: null,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  updatedAt: new Date('2026-08-20T09:07:00Z'),
  branch: { id: 'branch_1', name: '=HYPERLINK("bad")', timezone: 'Asia/Karachi' },
  staffProfile: { id: 'staff_1', displayName: '+SUM(1,1)' },
  breaks: [],
  adjustments: [],
  swapRequests: [],
};

describe('restaurant workforce presentation and export', () => {
  it('uses the named default threshold and reports late attendance', () => {
    expect(presentWorkforceShift(baseShift, new Date('2026-08-20T10:00:00Z'))).toMatchObject({
      attendanceStatus: 'LATE',
      lateMinutes: 7,
      lateThresholdMinutes: 5,
    });
  });

  it('keeps corrected timestamps append-only and applies the latest correction on reads', () => {
    const first = new Date('2026-08-20T09:03:00Z');
    const latest = new Date('2026-08-20T08:59:00Z');
    const shift = {
      ...baseShift,
      adjustments: [
        { id: 'a1', kind: 'CLOCK_IN' as const, breakId: null, correctedAt: first },
        { id: 'a2', kind: 'CLOCK_IN' as const, breakId: null, correctedAt: latest },
      ],
    };
    expect(presentWorkforceShift(shift as never).clockedInAt).toEqual(latest);
    expect(baseShift.clockedInAt).toEqual(new Date('2026-08-20T09:07:00Z'));
  });

  it('neutralizes spreadsheet formulas in authorized attendance exports', async () => {
    const db = {
      restaurantShift: { findMany: vi.fn(async () => [baseShift]) },
    } as unknown as ScopedDb;
    const result = await exportWorkforceAttendanceCsv(db, {
      branchId: 'branch_1',
      fromBusinessDate: new Date('2026-08-20T00:00:00Z'),
      toBusinessDate: new Date('2026-08-20T00:00:00Z'),
    });
    expect(result.csv).toContain("'=HYPERLINK");
    expect(result.csv).toContain("'+SUM(1,1)");
    expect(result.csv).not.toContain('\n=HYPERLINK');
  });
});
