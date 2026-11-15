import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  appendTimeAdjustment,
  exportWorkforceAttendanceCsv,
  presentWorkforceShift,
  requestShiftSwap,
  reviewShiftSwap,
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

const unclockedShift = { ...baseShift, clockedInAt: null };
const clockInRepair = {
  id: 'adj_1',
  breakId: null,
  kind: 'CLOCK_IN' as const,
  correctedAt: new Date('2026-08-20T09:02:00Z'),
  createdAt: new Date('2026-08-20T18:00:00Z'),
};

function swapRequestDb(shift: object) {
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: 'shift_1' }]),
    restaurantStaffProfile: {
      findFirst: vi.fn(async (args: { where: { id?: string } }) => ({
        id: args.where.id ?? 'staff_1',
        displayName: 'Employee',
        primaryBranchId: 'branch_1',
      })),
    },
    restaurantWorkforceCommand: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
    },
    restaurantShift: { findUnique: vi.fn(async () => shift) },
    restaurantShiftSwapRequest: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'swap_1', note: null })),
    },
    restaurantShiftEvent: { create: vi.fn(async () => ({})) },
  };
  const db = { $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)) };
  return { db: db as unknown as ScopedDb, tx };
}

function swapReviewDb(shift: object) {
  const tx = {
    $queryRaw: vi.fn(async () => [{ shiftId: 'shift_1' }]),
    restaurantWorkforceCommand: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
    },
    restaurantShiftSwapRequest: {
      findUnique: vi.fn(async () => ({
        id: 'swap_1',
        shiftId: 'shift_1',
        requestedByStaffProfileId: 'staff_1',
        replacementStaffProfileId: 'staff_2',
        decision: null,
        shift,
        replacement: { id: 'staff_2', status: 'ACTIVE', primaryBranchId: 'branch_1' },
      })),
    },
    restaurantShift: {
      findFirst: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
    },
    restaurantShiftSwapDecision: {
      create: vi.fn(async () => ({ id: 'decision_1', reason: null })),
    },
    restaurantShiftEvent: { create: vi.fn(async () => ({})) },
  };
  const db = { $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)) };
  return { db: db as unknown as ScopedDb, tx };
}

const approve = {
  requestId: 'swap_1',
  branchId: 'branch_1',
  decision: 'APPROVED' as const,
  actorUserId: 'manager_1',
  actorStaffProfileId: null,
  idempotencyKey: 'approve-1',
};

describe('restaurant shift swaps keep recorded attendance with its employee', () => {
  it.each([
    ['a raw clock-in', baseShift],
    ['only a manager clock-in repair', { ...unclockedShift, adjustments: [clockInRepair] }],
  ])('refuses to request a swap for a shift with %s', async (_label, shift) => {
    const { db, tx } = swapRequestDb(shift);
    await expect(
      requestShiftSwap(db, {
        shiftId: 'shift_1',
        userId: 'user_1',
        replacementStaffProfileId: 'staff_2',
        idempotencyKey: 'swap-1',
      })
    ).rejects.toMatchObject({ reason: 'CONFLICT' });
    expect(tx.restaurantShiftSwapRequest.create).not.toHaveBeenCalled();
  });

  it('still lets an employee request a swap before any attendance exists', async () => {
    const { db, tx } = swapRequestDb(unclockedShift);
    await expect(
      requestShiftSwap(db, {
        shiftId: 'shift_1',
        userId: 'user_1',
        replacementStaffProfileId: 'staff_2',
        idempotencyKey: 'swap-1',
      })
    ).resolves.toMatchObject({ id: 'swap_1' });
    expect(tx.restaurantShiftSwapRequest.create).toHaveBeenCalledTimes(1);
  });

  it('refuses to approve a swap once attendance exists only as a time repair', async () => {
    const { db, tx } = swapReviewDb({
      ...unclockedShift,
      breaks: [],
      adjustments: [{ id: 'adj_1' }],
    });
    await expect(reviewShiftSwap(db, approve)).rejects.toMatchObject({
      reason: 'CONFLICT',
      message: 'A shift with recorded attendance cannot be reassigned.',
    });
    expect(tx.restaurantShift.update).not.toHaveBeenCalled();
    expect(tx.restaurantShiftSwapDecision.create).not.toHaveBeenCalled();
  });

  it('reassigns a shift that has no recorded attendance', async () => {
    const { db, tx } = swapReviewDb({ ...unclockedShift, breaks: [], adjustments: [] });
    await expect(reviewShiftSwap(db, approve)).resolves.toMatchObject({ id: 'decision_1' });
    expect(tx.restaurantShift.update).toHaveBeenCalledWith({
      where: { id: 'shift_1' },
      data: { staffProfileId: 'staff_2' },
    });
  });
});
