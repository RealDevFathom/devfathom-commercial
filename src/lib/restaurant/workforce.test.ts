import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  appendTimeAdjustment,
  exportWorkforceAttendanceCsv,
  presentWorkforceShift,
} from './workforce';

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

  it('preserves lateness after a late employee clocks out', () => {
    const completed = {
      ...baseShift,
      clockedOutAt: new Date('2026-08-20T17:00:00Z'),
    };
    expect(presentWorkforceShift(completed, new Date('2026-08-20T18:00:00Z'))).toMatchObject({
      attendanceStatus: 'COMPLETE_LATE',
      lateMinutes: 7,
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

  it('exports net worked time only for completed attendance', async () => {
    const completed = {
      ...baseShift,
      clockedOutAt: new Date('2026-08-20T17:07:00Z'),
      breaks: [
        {
          id: 'break_1',
          startedAt: new Date('2026-08-20T12:00:00Z'),
          endedAt: new Date('2026-08-20T12:30:00Z'),
        },
      ],
    };
    const db = {
      restaurantShift: { findMany: vi.fn(async () => [completed, baseShift]) },
    } as unknown as ScopedDb;
    const result = await exportWorkforceAttendanceCsv(db, {
      branchId: 'branch_1',
      fromBusinessDate: new Date('2026-08-20T00:00:00Z'),
      toBusinessDate: new Date('2026-08-20T00:00:00Z'),
    });
    const [header, completedRow, openRow] = result.csv.split('\n');
    expect(header).toContain('breakMinutes,workedMinutes,workedHours,attendanceStatus');
    expect(completedRow).toContain(',30,450,7.50,COMPLETE_LATE,7');
    expect(openRow).toContain(',0,,,LATE,7');
  });

  it('leaves worked time blank until a missing break end is repaired', async () => {
    const incomplete = {
      ...baseShift,
      clockedOutAt: new Date('2026-08-20T17:07:00Z'),
      breaks: [{ id: 'break_1', startedAt: new Date('2026-08-20T12:00:00Z'), endedAt: null }],
    };
    const repaired = {
      ...incomplete,
      adjustments: [
        {
          id: 'a1',
          breakId: 'break_1',
          kind: 'BREAK_END' as const,
          correctedAt: new Date('2026-08-20T12:30:00Z'),
          createdAt: new Date('2026-08-21T09:00:00Z'),
        },
      ],
    };
    const db = {
      restaurantShift: { findMany: vi.fn(async () => [incomplete, repaired]) },
    } as unknown as ScopedDb;
    const result = await exportWorkforceAttendanceCsv(db, {
      branchId: 'branch_1',
      fromBusinessDate: baseShift.businessDate,
      toBusinessDate: baseShift.businessDate,
    });
    const [, openRow, repairedRow] = result.csv.split('\n');
    expect(openRow).toContain(',0,,,COMPLETE_LATE,7');
    expect(repairedRow).toContain(',30,450,7.50,COMPLETE_LATE,7');
  });
});

describe('restaurant workforce corrections on cancelled shifts', () => {
  function correctionDb(shift: object) {
    const create = vi.fn(async ({ data }: { data: object }) => ({ id: 'adj_1', ...data }));
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: 'shift_1' }]),
      restaurantShift: { findUnique: vi.fn(async () => shift) },
      restaurantTimeAdjustment: { create },
    };
    const db = {
      $transaction: async (run: (client: typeof tx) => unknown) => run(tx),
    } as unknown as ScopedDb;
    return { db, create };
  }

  const correction = {
    shiftId: 'shift_1',
    reason: 'Employee forgot to punch in',
    actorUserId: 'user_manager',
    actorStaffProfileId: 'staff_manager',
  };

  it('refuses a clock-in correction that would leave a cancelled shift on the clock', async () => {
    const { db, create } = correctionDb({
      ...baseShift,
      status: 'CANCELLED',
      cancelledAt: new Date('2026-08-20T08:00:00Z'),
      clockedInAt: null,
    });
    await expect(
      appendTimeAdjustment(db, {
        ...correction,
        kind: 'CLOCK_IN',
        correctedAt: new Date('2026-08-20T09:00:00Z'),
      })
    ).rejects.toMatchObject({ reason: 'CONFLICT' });
    expect(create).not.toHaveBeenCalled();
  });

  it('still corrects closed attendance on a cancelled shift', async () => {
    const { db, create } = correctionDb({
      ...baseShift,
      status: 'CANCELLED',
      cancelledAt: new Date('2026-08-20T18:00:00Z'),
      clockedOutAt: new Date('2026-08-20T17:00:00Z'),
    });
    await expect(
      appendTimeAdjustment(db, {
        ...correction,
        kind: 'CLOCK_IN',
        correctedAt: new Date('2026-08-20T09:00:00Z'),
      })
    ).resolves.toMatchObject({ kind: 'CLOCK_IN' });
    expect(create).toHaveBeenCalledOnce();
  });

  it('still records a clock-in correction on a live shift', async () => {
    const { db, create } = correctionDb({ ...baseShift, clockedInAt: null });
    await expect(
      appendTimeAdjustment(db, {
        ...correction,
        kind: 'CLOCK_IN',
        correctedAt: new Date('2026-08-20T09:00:00Z'),
      })
    ).resolves.toMatchObject({ kind: 'CLOCK_IN' });
    expect(create).toHaveBeenCalledOnce();
  });
});
