import { beforeEach, describe, expect, it } from 'vitest';

import {
  SHIFT_SIGN_IN_EARLY_GRACE_MINUTES,
  SHIFT_SIGN_IN_LATE_GRACE_MINUTES,
  ShiftError,
  cancelShift,
  createShift,
  describeShiftDenial,
  listShifts,
  resolveShiftEligibility,
  updateShift,
} from './shifts';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * Completion wave shifts lib — business-date stamping from the branch cutoff,
 * the role-agnostic overlap rule, cancel/edit lifecycle, and the sign-in
 * eligibility windows. The `ScopedDb` fake below stores rows in memory and
 * actually EVALUATES the where-clauses this module builds (interval bounds,
 * status, branch, id-exclusion), so the overlap and grace-window assertions
 * exercise real behaviour rather than a recorded query shape. RLS and branch
 * isolation are exercised against real PostgreSQL by
 * `tests/restaurant-shifts-rls.test.ts`.
 */

type Row = {
  id: string;
  organizationId: string;
  branchId: string;
  staffProfileId: string;
  businessDate: Date;
  startAt: Date;
  endAt: Date;
  role: string | null;
  notes: string | null;
  status: 'SCHEDULED' | 'CANCELLED';
  cancelledAt: Date | null;
  cancelReason: string | null;
  clockedInAt: Date | null;
  clockedOutAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

type Comparator = { lt?: Date; lte?: Date; gt?: Date; gte?: Date };

const branches = new Map<
  string,
  { id: string; timezone: string; businessDayCutoff: string; shiftSignInEnforced: boolean }
>();
const staff = new Map<
  string,
  { id: string; status: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED'; primaryBranchId: string | null }
>();
let shifts: Row[] = [];
let sequence = 0;
let beforeShiftUpdateMany: (() => void) | undefined;

function matchesDate(value: Date, comparator: Comparator): boolean {
  const time = value.getTime();
  if (comparator.lt !== undefined && !(time < comparator.lt.getTime())) return false;
  if (comparator.lte !== undefined && !(time <= comparator.lte.getTime())) return false;
  if (comparator.gt !== undefined && !(time > comparator.gt.getTime())) return false;
  if (comparator.gte !== undefined && !(time >= comparator.gte.getTime())) return false;
  return true;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [field, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (field === 'OR') {
      if (!(condition as Record<string, unknown>[]).some((clause) => matches(row, clause))) {
        return false;
      }
      continue;
    }
    if (field === 'id' && typeof condition === 'object' && condition !== null) {
      if (row.id === (condition as { not: string }).not) return false;
      continue;
    }
    if (field === 'startAt' || field === 'endAt' || field === 'businessDate') {
      if (!matchesDate(row[field], condition as Comparator)) return false;
      continue;
    }
    if (typeof condition === 'object' && condition !== null && 'not' in condition) {
      if (row[field as keyof Row] === (condition as { not: unknown }).not) return false;
      continue;
    }
    if (
      row[field as 'branchId' | 'staffProfileId' | 'status' | 'organizationId' | 'version'] !==
      condition
    )
      return false;
  }
  return true;
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  const clauses = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Array<
    Record<string, 'asc' | 'desc'>
  >;
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      const [field, direction] = Object.entries(clause)[0]!;
      const left = a[field as keyof Row];
      const right = b[field as keyof Row];
      const delta =
        left instanceof Date && right instanceof Date
          ? left.getTime() - right.getTime()
          : String(left).localeCompare(String(right));
      if (delta !== 0) return direction === 'desc' ? -delta : delta;
    }
    return 0;
  });
}

const db = {
  restaurantBranch: {
    findUnique: async ({ where }: { where: { id: string } }) => branches.get(where.id) ?? null,
  },
  restaurantStaffProfile: {
    findUnique: async ({ where }: { where: { id: string } }) => staff.get(where.id) ?? null,
  },
  restaurantShift: {
    findFirst: async ({
      where,
      orderBy,
    }: {
      where: Record<string, unknown>;
      orderBy?: unknown;
    }) => {
      const found = sortRows(
        shifts.filter((row) => matches(row, where)),
        orderBy ?? { startAt: 'asc' }
      );
      return found[0] ?? null;
    },
    findMany: async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: unknown }) =>
      sortRows(
        shifts.filter((row) => matches(row, where)),
        orderBy ?? { startAt: 'asc' }
      ),
    findUnique: async ({ where }: { where: { id: string } }) =>
      shifts.find((row) => row.id === where.id) ?? null,
    create: async ({ data }: { data: Partial<Row> }) => {
      const row: Row = {
        id: `shift_${++sequence}`,
        organizationId: 'org_1',
        role: null,
        notes: null,
        status: 'SCHEDULED',
        cancelledAt: null,
        cancelReason: null,
        clockedInAt: null,
        clockedOutAt: null,
        version: 1,
        createdAt: new Date('2026-08-01T00:00:00Z'),
        updatedAt: new Date('2026-08-01T00:00:00Z'),
        ...data,
      } as Row;
      shifts.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = shifts.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error(`No shift ${where.id}`);
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      beforeShiftUpdateMany?.();
      const found = shifts.filter((row) => matches(row, where));
      for (const row of found) {
        const version = data.version as { increment: number } | undefined;
        Object.assign(row, {
          ...data,
          ...(version ? { version: row.version + version.increment } : {}),
        });
      }
      return { count: found.length };
    },
  },
} as unknown as ScopedDb;

const BRANCH = 'branch_1';
const LATE_BRANCH = 'branch_late';
const STAFF = 'staff_1';

/** 2026-08-20, a plain Thursday, with 09:00 → 17:00 UTC as the default shift. */
const START = new Date('2026-08-20T09:00:00Z');
const END = new Date('2026-08-20T17:00:00Z');
const NOON = new Date('2026-08-20T12:00:00Z');
const minutes = (count: number) => count * 60_000;

beforeEach(() => {
  branches.clear();
  staff.clear();
  shifts = [];
  sequence = 0;
  beforeShiftUpdateMany = undefined;
  branches.set(BRANCH, {
    id: BRANCH,
    timezone: 'UTC',
    businessDayCutoff: '00:00',
    shiftSignInEnforced: true,
  });
  // A late-closing branch: everything before 04:00 local belongs to the day
  // that has not finished yet.
  branches.set(LATE_BRANCH, {
    id: LATE_BRANCH,
    timezone: 'Asia/Karachi',
    businessDayCutoff: '04:00',
    shiftSignInEnforced: true,
  });
  staff.set(STAFF, { id: STAFF, status: 'ACTIVE', primaryBranchId: BRANCH });
});

describe('createShift', () => {
  it('stamps the business date from the branch timezone and cutoff', async () => {
    staff.set('staff_late', { id: 'staff_late', status: 'ACTIVE', primaryBranchId: LATE_BRANCH });
    // 2026-08-21T01:30 Asia/Karachi = 2026-08-20T20:30Z. The branch closes at
    // 04:00 local, so this shift belongs to the 2026-08-20 operating day.
    const shift = await createShift(db, {
      branchId: LATE_BRANCH,
      staffProfileId: 'staff_late',
      startAt: new Date('2026-08-20T20:30:00Z'),
      endAt: new Date('2026-08-20T22:30:00Z'),
    });
    expect(shift.businessDate.toISOString()).toBe('2026-08-20T00:00:00.000Z');
  });

  it('stamps the branch-local calendar date when the branch closes at midnight', async () => {
    const shift = await createShift(db, {
      branchId: BRANCH,
      staffProfileId: STAFF,
      startAt: START,
      endAt: END,
    });
    expect(shift.businessDate.toISOString()).toBe('2026-08-20T00:00:00.000Z');
  });

  it('normalises blank role and notes to null and trims real values', async () => {
    const shift = await createShift(db, {
      branchId: BRANCH,
      staffProfileId: STAFF,
      startAt: START,
      endAt: END,
      role: '  Cashier  ',
      notes: '   ',
    });
    expect(shift.role).toBe('Cashier');
    expect(shift.notes).toBeNull();
  });

  it('rejects a window that does not move forward, or runs beyond a day', async () => {
    await expect(
      createShift(db, { branchId: BRANCH, staffProfileId: STAFF, startAt: END, endAt: START })
    ).rejects.toMatchObject({ reason: 'INVALID' });
    await expect(
      createShift(db, { branchId: BRANCH, staffProfileId: STAFF, startAt: START, endAt: START })
    ).rejects.toMatchObject({ reason: 'INVALID' });
    await expect(
      createShift(db, {
        branchId: BRANCH,
        staffProfileId: STAFF,
        startAt: START,
        endAt: new Date('2026-08-21T09:00:01Z'),
      })
    ).rejects.toMatchObject({ reason: 'INVALID' });
  });

  it('refuses an unknown branch, an unknown, inactive, or other-branch operator', async () => {
    await expect(
      createShift(db, { branchId: 'nope', staffProfileId: STAFF, startAt: START, endAt: END })
    ).rejects.toMatchObject({ reason: 'BRANCH_NOT_FOUND' });

    await expect(
      createShift(db, { branchId: BRANCH, staffProfileId: 'ghost', startAt: START, endAt: END })
    ).rejects.toMatchObject({ reason: 'STAFF_NOT_FOUND' });

    staff.set('suspended', { id: 'suspended', status: 'SUSPENDED', primaryBranchId: BRANCH });
    await expect(
      createShift(db, { branchId: BRANCH, staffProfileId: 'suspended', startAt: START, endAt: END })
    ).rejects.toMatchObject({ reason: 'STAFF_INACTIVE' });

    staff.set('elsewhere', { id: 'elsewhere', status: 'ACTIVE', primaryBranchId: LATE_BRANCH });
    await expect(
      createShift(db, { branchId: BRANCH, staffProfileId: 'elsewhere', startAt: START, endAt: END })
    ).rejects.toMatchObject({ reason: 'STAFF_WRONG_BRANCH' });
  });
});

describe('the overlap rule', () => {
  const base = { branchId: BRANCH, staffProfileId: STAFF, startAt: START, endAt: END };

  it('refuses a second live shift that overlaps, whatever the roles are', async () => {
    await createShift(db, { ...base, role: 'Cashier' });
    await expect(
      createShift(db, {
        ...base,
        role: 'Shift Manager',
        startAt: new Date('2026-08-20T16:00:00Z'),
        endAt: new Date('2026-08-20T20:00:00Z'),
      })
    ).rejects.toMatchObject({ reason: 'OVERLAP' });
  });

  it('allows back-to-back shifts in different roles on the same business date', async () => {
    await createShift(db, { ...base, role: 'Kitchen' });
    const second = await createShift(db, {
      ...base,
      role: 'Shift Manager',
      startAt: END,
      endAt: new Date('2026-08-20T21:00:00Z'),
    });
    expect(second.role).toBe('Shift Manager');
    expect(shifts).toHaveLength(2);
  });

  it('spans branches — an operator cannot be rostered in two places at once', async () => {
    // The operator transfers branch mid-week; the earlier branch's shift still
    // occupies the interval, so the new branch cannot double-book them.
    staff.set(STAFF, { id: STAFF, status: 'ACTIVE', primaryBranchId: LATE_BRANCH });
    await createShift(db, { ...base, branchId: LATE_BRANCH });
    staff.set(STAFF, { id: STAFF, status: 'ACTIVE', primaryBranchId: BRANCH });
    await expect(createShift(db, base)).rejects.toMatchObject({ reason: 'OVERLAP' });
  });

  it('ignores a cancelled shift, so a cancelled slot can be re-rostered', async () => {
    const first = await createShift(db, base);
    await cancelShift(db, first.id, { now: NOON, reason: 'Called in sick' });
    const replacement = await createShift(db, base);
    expect(replacement.id).not.toBe(first.id);
    expect(replacement.status).toBe('SCHEDULED');
  });
});

describe('updateShift', () => {
  it('atomically increments version and rejects a stale update', async () => {
    const shift = await createShift(db, {
      branchId: BRANCH,
      staffProfileId: STAFF,
      startAt: START,
      endAt: END,
    });
    const updated = await updateShift(
      db,
      shift.id,
      { role: 'Kitchen' },
      {
        organizationId: 'org_1',
        expectedVersion: 1,
      }
    );
    expect(updated.version).toBe(2);
    await expect(
      updateShift(
        db,
        shift.id,
        { role: 'Close' },
        {
          organizationId: 'org_1',
          expectedVersion: 1,
        }
      )
    ).rejects.toMatchObject({ reason: 'VERSION_CONFLICT' });
  });

  it('re-stamps the business date and re-checks overlap against other shifts only', async () => {
    staff.set('staff_late', { id: 'staff_late', status: 'ACTIVE', primaryBranchId: LATE_BRANCH });
    const shift = await createShift(db, {
      branchId: LATE_BRANCH,
      staffProfileId: 'staff_late',
      startAt: new Date('2026-08-20T10:00:00Z'),
      endAt: new Date('2026-08-20T14:00:00Z'),
    });
    expect(shift.businessDate.toISOString()).toBe('2026-08-20T00:00:00.000Z');

    // Move it to 01:00 Karachi on the 22nd: before the 04:00 cutoff, so it
    // belongs to the 21st. Overlapping itself must not count as a clash.
    const moved = await updateShift(db, shift.id, {
      startAt: new Date('2026-08-21T20:00:00Z'),
      endAt: new Date('2026-08-21T23:00:00Z'),
    });
    expect(moved.businessDate.toISOString()).toBe('2026-08-21T00:00:00.000Z');
  });

  it('keeps the business date when only the label changes', async () => {
    const shift = await createShift(db, {
      branchId: BRANCH,
      staffProfileId: STAFF,
      startAt: START,
      endAt: END,
      role: 'Cashier',
    });
    const relabelled = await updateShift(db, shift.id, { role: 'Kitchen', notes: 'Covers prep' });
    expect(relabelled.role).toBe('Kitchen');
    expect(relabelled.notes).toBe('Covers prep');
    expect(relabelled.businessDate).toEqual(shift.businessDate);
  });

  it('refuses to edit a cancelled shift or an unknown one', async () => {
    const shift = await createShift(db, {
      branchId: BRANCH,
      staffProfileId: STAFF,
      startAt: START,
      endAt: END,
    });
    await cancelShift(db, shift.id, { now: NOON });
    await expect(updateShift(db, shift.id, { role: 'Kitchen' })).rejects.toMatchObject({
      reason: 'ALREADY_CANCELLED',
    });
    await expect(updateShift(db, 'ghost', { role: 'Kitchen' })).rejects.toMatchObject({
      reason: 'SHIFT_NOT_FOUND',
    });
  });

  it('refuses a reschedule that collides with another live shift', async () => {
    const first = await createShift(db, {
      branchId: BRANCH,
      staffProfileId: STAFF,
      startAt: START,
      endAt: END,
    });
    await createShift(db, {
      branchId: BRANCH,
      staffProfileId: STAFF,
      startAt: new Date('2026-08-20T18:00:00Z'),
      endAt: new Date('2026-08-20T22:00:00Z'),
    });
    await expect(
      updateShift(db, first.id, { endAt: new Date('2026-08-20T19:00:00Z') })
    ).rejects.toMatchObject({ reason: 'OVERLAP' });
  });
});

describe('cancelShift', () => {
  it('rejects a stale cancellation version', async () => {
    const shift = await createShift(db, {
      branchId: BRANCH,
      staffProfileId: STAFF,
      startAt: START,
      endAt: END,
    });
    await updateShift(
      db,
      shift.id,
      { role: 'Kitchen' },
      {
        organizationId: 'org_1',
        expectedVersion: 1,
      }
    );
    await expect(
      cancelShift(
        db,
        shift.id,
        { now: NOON },
        {
          organizationId: 'org_1',
          expectedVersion: 1,
        }
      )
    ).rejects.toMatchObject({ reason: 'VERSION_CONFLICT' });
  });

  it('records the cancellation state, timestamp and reason without deleting the row', async () => {
    const shift = await createShift(db, {
      branchId: BRANCH,
      staffProfileId: STAFF,
      startAt: START,
      endAt: END,
    });
    const cancelled = await cancelShift(db, shift.id, { now: NOON, reason: '  Storm closure  ' });
    expect(cancelled).toMatchObject({
      id: shift.id,
      status: 'CANCELLED',
      cancelledAt: NOON,
      cancelReason: 'Storm closure',
    });
    expect(shifts).toHaveLength(1);
  });

  it('rejects cancellation while the employee has active attendance', async () => {
    const shift = await createShift(db, {
      branchId: BRANCH,
      staffProfileId: STAFF,
      startAt: START,
      endAt: END,
    });
    await db.restaurantShift.update({
      where: { id: shift.id },
      data: { clockedInAt: new Date('2026-08-20T09:05:00Z') },
    });

    await expect(cancelShift(db, shift.id, { now: NOON })).rejects.toMatchObject({
      reason: 'ACTIVE_ATTENDANCE',
    });
    expect(shifts[0]).toMatchObject({ status: 'SCHEDULED', cancelledAt: null });
  });

  it.each([
    ['without CAS', undefined],
    ['with CAS', { organizationId: 'org_1', expectedVersion: 1 }],
  ] as const)('atomically rejects a clock-in racing with cancellation %s', async (_label, cas) => {
    const shift = await createShift(db, {
      branchId: BRANCH,
      staffProfileId: STAFF,
      startAt: START,
      endAt: END,
    });
    const clockedInAt = new Date('2026-08-20T09:05:00Z');

    // Simulate clock-in committing after cancellation's initial read but before
    // its conditional write is evaluated by PostgreSQL.
    beforeShiftUpdateMany = () => {
      shifts[0]!.clockedInAt = clockedInAt;
      beforeShiftUpdateMany = undefined;
    };

    await expect(cancelShift(db, shift.id, { now: NOON }, cas)).rejects.toMatchObject({
      reason: 'ACTIVE_ATTENDANCE',
    });
    expect(shifts[0]).toMatchObject({
      status: 'SCHEDULED',
      cancelledAt: null,
      clockedInAt,
      clockedOutAt: null,
    });
  });

  it('does not overwrite a cancellation that commits after the initial read', async () => {
    const shift = await createShift(db, {
      branchId: BRANCH,
      staffProfileId: STAFF,
      startAt: START,
      endAt: END,
    });
    const firstCancelledAt = new Date('2026-08-20T11:55:00Z');

    beforeShiftUpdateMany = () => {
      Object.assign(shifts[0]!, {
        status: 'CANCELLED',
        cancelledAt: firstCancelledAt,
        cancelReason: 'Manager cancellation',
      });
      beforeShiftUpdateMany = undefined;
    };

    await expect(
      cancelShift(db, shift.id, { now: NOON, reason: 'Stale cancellation' })
    ).rejects.toMatchObject({ reason: 'ALREADY_CANCELLED' });
    expect(shifts[0]).toMatchObject({
      status: 'CANCELLED',
      cancelledAt: firstCancelledAt,
      cancelReason: 'Manager cancellation',
    });
  });

  it('refuses a second cancellation and an unknown shift', async () => {
    const shift = await createShift(db, {
      branchId: BRANCH,
      staffProfileId: STAFF,
      startAt: START,
      endAt: END,
    });
    await cancelShift(db, shift.id, { now: NOON });
    await expect(cancelShift(db, shift.id, { now: NOON })).rejects.toMatchObject({
      reason: 'ALREADY_CANCELLED',
    });
    await expect(cancelShift(db, 'ghost', { now: NOON })).rejects.toMatchObject({
      reason: 'SHIFT_NOT_FOUND',
    });
  });
});

describe('listShifts', () => {
  it('returns the branch roster for the business-date range, cancelled hidden by default', async () => {
    const live = await createShift(db, {
      branchId: BRANCH,
      staffProfileId: STAFF,
      startAt: START,
      endAt: END,
    });
    const dropped = await createShift(db, {
      branchId: BRANCH,
      staffProfileId: STAFF,
      startAt: new Date('2026-08-21T09:00:00Z'),
      endAt: new Date('2026-08-21T17:00:00Z'),
    });
    await cancelShift(db, dropped.id, { now: NOON });

    const visible = await listShifts(db, {
      branchId: BRANCH,
      fromBusinessDate: '2026-08-20',
      toBusinessDate: '2026-08-21',
    });
    expect(visible.map((row) => row.id)).toEqual([live.id]);

    const all = await listShifts(db, {
      branchId: BRANCH,
      fromBusinessDate: '2026-08-20',
      toBusinessDate: '2026-08-21',
      includeCancelled: true,
    });
    expect(all.map((row) => row.id)).toEqual([live.id, dropped.id]);
  });

  it('rejects a malformed or inverted business-date range', async () => {
    await expect(
      listShifts(db, {
        branchId: BRANCH,
        fromBusinessDate: '20-08-2026',
        toBusinessDate: '2026-08-21',
      })
    ).rejects.toBeInstanceOf(ShiftError);
    await expect(
      listShifts(db, {
        branchId: BRANCH,
        fromBusinessDate: '2026-08-22',
        toBusinessDate: '2026-08-21',
      })
    ).rejects.toMatchObject({ reason: 'INVALID' });
  });
});

describe('resolveShiftEligibility', () => {
  const roster = async () =>
    createShift(db, { branchId: BRANCH, staffProfileId: STAFF, startAt: START, endAt: END });

  it('admits an operator inside the shift', async () => {
    const shift = await roster();
    const verdict = await resolveShiftEligibility(db, {
      staffProfileId: STAFF,
      branchId: BRANCH,
      now: NOON,
    });
    expect(verdict).toMatchObject({ eligible: true, shift: { id: shift.id, role: null } });
  });

  it('admits an operator inside the early and late grace windows', async () => {
    await roster();
    const justEarly = new Date(START.getTime() - minutes(SHIFT_SIGN_IN_EARLY_GRACE_MINUTES));
    const justLate = new Date(END.getTime() + minutes(SHIFT_SIGN_IN_LATE_GRACE_MINUTES) - 1);
    for (const now of [justEarly, justLate]) {
      expect(
        await resolveShiftEligibility(db, { staffProfileId: STAFF, branchId: BRANCH, now })
      ).toMatchObject({ eligible: true });
    }
  });

  it('refuses too early with NOT_STARTED and names the next start', async () => {
    await roster();
    const tooEarly = new Date(START.getTime() - minutes(SHIFT_SIGN_IN_EARLY_GRACE_MINUTES + 1));
    expect(
      await resolveShiftEligibility(db, { staffProfileId: STAFF, branchId: BRANCH, now: tooEarly })
    ).toEqual({ eligible: false, reason: 'NOT_STARTED', nextShiftStartsAt: START });
  });

  it('refuses after the late grace window with ENDED', async () => {
    await roster();
    const tooLate = new Date(END.getTime() + minutes(SHIFT_SIGN_IN_LATE_GRACE_MINUTES));
    expect(
      await resolveShiftEligibility(db, { staffProfileId: STAFF, branchId: BRANCH, now: tooLate })
    ).toEqual({ eligible: false, reason: 'ENDED', nextShiftStartsAt: null });
  });

  it('reports NO_SHIFT when nothing is rostered, and treats a cancelled shift as nothing', async () => {
    expect(
      await resolveShiftEligibility(db, { staffProfileId: STAFF, branchId: BRANCH, now: NOON })
    ).toEqual({ eligible: false, reason: 'NO_SHIFT', nextShiftStartsAt: null });

    const shift = await roster();
    await cancelShift(db, shift.id, { now: START });
    expect(
      await resolveShiftEligibility(db, { staffProfileId: STAFF, branchId: BRANCH, now: NOON })
    ).toEqual({ eligible: false, reason: 'NO_SHIFT', nextShiftStartsAt: null });
  });

  it('does not let a shift at another branch open this terminal', async () => {
    await roster();
    expect(
      await resolveShiftEligibility(db, {
        staffProfileId: STAFF,
        branchId: LATE_BRANCH,
        now: NOON,
      })
    ).toEqual({ eligible: false, reason: 'NO_SHIFT', nextShiftStartsAt: null });
  });

  it('picks the most recently started shift when a handover overlaps two grace windows', async () => {
    await roster();
    const evening = await createShift(db, {
      branchId: BRANCH,
      staffProfileId: STAFF,
      startAt: END,
      endAt: new Date('2026-08-20T22:00:00Z'),
      role: 'Close',
    });
    const handover = new Date(END.getTime() - minutes(5));
    const verdict = await resolveShiftEligibility(db, {
      staffProfileId: STAFF,
      branchId: BRANCH,
      now: handover,
    });
    expect(verdict).toMatchObject({ eligible: true, shift: { id: evening.id, role: 'Close' } });
  });
});

describe('describeShiftDenial', () => {
  it('gives every denial a distinct, timezone-free operator sentence', () => {
    const sentences = (['NO_SHIFT', 'NOT_STARTED', 'ENDED'] as const).map(describeShiftDenial);
    expect(new Set(sentences).size).toBe(3);
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/\d{4}-\d{2}-\d{2}|Z$|UTC/);
    }
  });
});
