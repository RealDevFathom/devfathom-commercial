import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  DEFAULT_BUSINESS_DAY_CUTOFF,
  BusinessDateError,
  businessDateToUtcDate,
  resolveBusinessDate,
} from './business-date';

/**
 * Completion wave — branch-scoped staff shift scheduling and the shift
 * eligibility rule the terminal sign-in boundary consults.
 *
 * This module owns SCHEDULING ONLY. There is no clock-in, attendance, leave,
 * payroll or labour-optimization behaviour here, and none is implied by a shift
 * row: a shift says who is *expected* at a branch and when, nothing about what
 * actually happened. Actual labour cost keeps arriving through the M8 imported
 * `LabourCostFact` seam.
 *
 * Three rules carry the domain:
 *
 * - **Business date is stamped, never recomputed** (§11.1 / M4-L1 C5). It is
 *   resolved once from `startAt` against the branch's timezone and
 *   `businessDayCutoff`, so a 01:30 shift at a branch that closes at 04:00
 *   belongs to the operating day that has not yet closed. Rescheduling re-stamps
 *   it; reading never re-derives it from UTC.
 * - **Overlap is role-agnostic.** A staff profile may hold many shifts with
 *   different `role` labels — the roster is explicitly multi-role — but never
 *   two live shifts whose half-open `[startAt, endAt)` intervals overlap, in any
 *   branch. A person cannot be in two places at once, so the check spans the
 *   whole organization rather than the branch.
 * - **Eligibility is a grace window, not an exact match.** An operator signs in
 *   a little before the shift starts and may still be closing out a little after
 *   it ends, so the active window is `[startAt - EARLY, endAt + LATE)`. A denial
 *   always names WHY (no shift at all, not started yet, already ended) so the
 *   terminal can show a truthful state instead of a generic failure.
 *
 * Every function takes a tenant-scoped `ScopedDb`; `organizationId` is the RLS
 * default on the row and cross-tenant references are invisible (null) here
 * before the composite tenant foreign keys would reject them (C1). `now` and
 * every instant are SERVER timestamps — client time is untrusted (C5).
 */

/** How early, in minutes, an operator may sign in against a shift that has not started. */
export const SHIFT_SIGN_IN_EARLY_GRACE_MINUTES = 30;
/** How late, in minutes, an operator may keep signing in after a shift has ended. */
export const SHIFT_SIGN_IN_LATE_GRACE_MINUTES = 30;
/** Longest schedulable shift. A longer span is a data-entry error, not a roster. */
export const MAX_SHIFT_MINUTES = 24 * 60;

const MINUTE_MS = 60_000;

export type ShiftErrorReason =
  | 'INVALID'
  | 'BRANCH_NOT_FOUND'
  | 'SHIFT_NOT_FOUND'
  | 'STAFF_NOT_FOUND'
  | 'STAFF_INACTIVE'
  | 'STAFF_WRONG_BRANCH'
  | 'OVERLAP'
  | 'VERSION_CONFLICT'
  | 'ACTIVE_ATTENDANCE'
  | 'ALREADY_CANCELLED';

export class ShiftError extends Error {
  constructor(
    message: string,
    readonly reason: ShiftErrorReason
  ) {
    super(message);
    this.name = 'ShiftError';
  }
}

type BranchSchedulingContext = {
  id: string;
  timezone: string;
  businessDayCutoff: string;
  shiftSignInEnforced: boolean;
};

/** Load the branch's scheduling context in scope (or throw). */
async function requireBranch(db: ScopedDb, branchId: string): Promise<BranchSchedulingContext> {
  const branch = await db.restaurantBranch.findUnique({
    where: { id: branchId },
    select: {
      id: true,
      timezone: true,
      businessDayCutoff: true,
      shiftSignInEnforced: true,
    },
  });
  if (!branch) {
    throw new ShiftError('The branch does not exist.', 'BRANCH_NOT_FOUND');
  }
  return branch;
}

/**
 * A rostered operator must be an ACTIVE profile pinned to the shift's branch —
 * the same rule the M4 section assignment and the terminal branch gate use, so
 * the roster can never promise a person the terminal would refuse anyway.
 */
async function assertRosterableStaff(
  db: ScopedDb,
  staffProfileId: string,
  branchId: string
): Promise<void> {
  const staff = await db.restaurantStaffProfile.findUnique({
    where: { id: staffProfileId },
    select: { id: true, status: true, primaryBranchId: true },
  });
  if (!staff) {
    throw new ShiftError('Staff profile not found.', 'STAFF_NOT_FOUND');
  }
  if (staff.status !== 'ACTIVE') {
    throw new ShiftError('Only an active staff profile can be rostered.', 'STAFF_INACTIVE');
  }
  if (staff.primaryBranchId !== branchId) {
    throw new ShiftError('The staff profile is not assigned to this branch.', 'STAFF_WRONG_BRANCH');
  }
}

function requireInstant(value: Date, label: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ShiftError(`A valid ${label} is required.`, 'INVALID');
  }
  return value;
}

/** Validate the shift window and return it, normalised. */
function requireWindow(startAt: Date, endAt: Date): { startAt: Date; endAt: Date } {
  requireInstant(startAt, 'shift start');
  requireInstant(endAt, 'shift end');
  if (endAt.getTime() <= startAt.getTime()) {
    throw new ShiftError('A shift must end after it starts.', 'INVALID');
  }
  if (endAt.getTime() - startAt.getTime() > MAX_SHIFT_MINUTES * MINUTE_MS) {
    throw new ShiftError(
      `A shift cannot be longer than ${MAX_SHIFT_MINUTES / 60} hours.`,
      'INVALID'
    );
  }
  return { startAt, endAt };
}

function normalizeOptionalText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, max);
}

/**
 * Stamp the business date for a shift window. Wraps `BusinessDateError` (a bad
 * branch timezone or cutoff is a configuration problem, surfaced as INVALID
 * rather than escaping as an unrelated error class).
 */
function stampBusinessDate(branch: BranchSchedulingContext, startAt: Date): Date {
  try {
    return businessDateToUtcDate(
      resolveBusinessDate(
        startAt,
        branch.timezone,
        branch.businessDayCutoff || DEFAULT_BUSINESS_DAY_CUTOFF
      )
    );
  } catch (error) {
    if (error instanceof BusinessDateError) {
      throw new ShiftError(error.message, 'INVALID');
    }
    throw error;
  }
}

/**
 * Refuse a shift that would overlap another LIVE shift for the same operator.
 * Half-open intervals: a shift ending exactly when the next begins is a legal
 * back-to-back pair, not an overlap. Cancelled shifts never block, so a
 * cancelled row can always be replaced.
 */
async function assertNoOverlap(
  db: ScopedDb,
  staffProfileId: string,
  startAt: Date,
  endAt: Date,
  excludeShiftId: string | null
): Promise<void> {
  const clash = await db.restaurantShift.findFirst({
    where: {
      staffProfileId,
      status: 'SCHEDULED',
      startAt: { lt: endAt },
      endAt: { gt: startAt },
      ...(excludeShiftId ? { id: { not: excludeShiftId } } : {}),
    },
    select: { id: true, startAt: true, endAt: true, branchId: true },
  });
  if (clash) {
    throw new ShiftError(
      'This operator already has an overlapping shift on the roster.',
      'OVERLAP'
    );
  }
}

const SHIFT_SELECT = {
  id: true,
  branchId: true,
  staffProfileId: true,
  businessDate: true,
  startAt: true,
  endAt: true,
  role: true,
  notes: true,
  status: true,
  cancelledAt: true,
  cancelReason: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const;

// ── Commands ────────────────────────────────────────────────────────────────

export type CreateShiftInput = {
  branchId: string;
  staffProfileId: string;
  startAt: Date;
  endAt: Date;
  role?: string | null;
  notes?: string | null;
};

export async function createShift(db: ScopedDb, input: CreateShiftInput) {
  const { startAt, endAt } = requireWindow(input.startAt, input.endAt);
  const branch = await requireBranch(db, input.branchId);
  await assertRosterableStaff(db, input.staffProfileId, branch.id);
  await assertNoOverlap(db, input.staffProfileId, startAt, endAt, null);

  return db.restaurantShift.create({
    data: {
      branchId: branch.id,
      staffProfileId: input.staffProfileId,
      businessDate: stampBusinessDate(branch, startAt),
      startAt,
      endAt,
      role: normalizeOptionalText(input.role, 120),
      notes: normalizeOptionalText(input.notes, 1000),
    },
    select: SHIFT_SELECT,
  });
}

export type UpdateShiftInput = {
  startAt?: Date;
  endAt?: Date;
  role?: string | null;
  notes?: string | null;
};

export type ShiftCas = { organizationId: string; expectedVersion: number };

/**
 * Edit a live shift. Rescheduling re-stamps the business date from the NEW start
 * against the branch's cutoff and re-runs the overlap rule against every other
 * live shift. A cancelled shift is terminal: it is replaced, not edited.
 */
export async function updateShift(
  db: ScopedDb,
  id: string,
  patch: UpdateShiftInput,
  cas?: ShiftCas
) {
  const existing = await db.restaurantShift.findUnique({
    where: { id },
    select: {
      id: true,
      branchId: true,
      staffProfileId: true,
      startAt: true,
      endAt: true,
      status: true,
    },
  });
  if (!existing) {
    throw new ShiftError('Shift not found.', 'SHIFT_NOT_FOUND');
  }
  if (existing.status === 'CANCELLED') {
    throw new ShiftError(
      'A cancelled shift cannot be edited; schedule a replacement instead.',
      'ALREADY_CANCELLED'
    );
  }

  const reschedules = patch.startAt !== undefined || patch.endAt !== undefined;
  const { startAt, endAt } = requireWindow(
    patch.startAt ?? existing.startAt,
    patch.endAt ?? existing.endAt
  );

  let reschedule: { startAt: Date; endAt: Date; businessDate: Date } | null = null;
  if (reschedules) {
    await assertNoOverlap(db, existing.staffProfileId, startAt, endAt, existing.id);
    const branch = await requireBranch(db, existing.branchId);
    reschedule = { startAt, endAt, businessDate: stampBusinessDate(branch, startAt) };
  }

  const data = {
    ...(reschedule ?? {}),
    ...(patch.role !== undefined ? { role: normalizeOptionalText(patch.role, 120) } : {}),
    ...(patch.notes !== undefined ? { notes: normalizeOptionalText(patch.notes, 1000) } : {}),
  };
  if (!cas) {
    return db.restaurantShift.update({ where: { id: existing.id }, data, select: SHIFT_SELECT });
  }
  const won = await db.restaurantShift.updateMany({
    where: { id: existing.id, organizationId: cas.organizationId, version: cas.expectedVersion },
    data: { ...data, version: { increment: 1 } },
  });
  if (won.count !== 1) {
    throw new ShiftError(
      'This shift changed since it was loaded. Refresh the roster and try again.',
      'VERSION_CONFLICT'
    );
  }
  return (await db.restaurantShift.findUnique({
    where: { id: existing.id },
    select: SHIFT_SELECT,
  }))!;
}

/**
 * Withdraw a shift from the roster. Cancellation is a soft state, not a delete:
 * a published roster keeps the row (and its reason) while the shift stops
 * granting sign-in and stops blocking a replacement. Cancelling twice is an
 * error rather than a silent no-op, so a stale console cannot overwrite the
 * original reason and timestamp.
 */
export async function cancelShift(
  db: ScopedDb,
  id: string,
  options: { now: Date; reason?: string | null },
  cas?: ShiftCas
) {
  const existing = await db.restaurantShift.findUnique({
    where: { id },
    select: { id: true, status: true, clockedInAt: true, clockedOutAt: true },
  });
  if (!existing) {
    throw new ShiftError('Shift not found.', 'SHIFT_NOT_FOUND');
  }
  if (existing.status === 'CANCELLED') {
    throw new ShiftError('This shift is already cancelled.', 'ALREADY_CANCELLED');
  }
  if (existing.clockedInAt && !existing.clockedOutAt) {
    throw new ShiftError(
      'This shift cannot be cancelled while the employee is clocked in.',
      'ACTIVE_ATTENDANCE'
    );
  }
  const data = {
    status: 'CANCELLED' as const,
    cancelledAt: requireInstant(options.now, 'cancellation time'),
    cancelReason: normalizeOptionalText(options.reason, 500),
  };
  // Keep this predicate on the write itself. Workforce commands lock the shift
  // before clocking in, but a cancellation may have read the row just before
  // that transaction commits. A conditional update prevents that interleaving
  // from producing a cancelled shift with open attendance.
  const won = await db.restaurantShift.updateMany({
    where: {
      id: existing.id,
      ...(cas ? { organizationId: cas.organizationId, version: cas.expectedVersion } : {}),
      OR: [{ clockedInAt: null }, { clockedOutAt: { not: null } }],
    },
    data: cas ? { ...data, version: { increment: 1 } } : data,
  });
  if (won.count !== 1) {
    const current = await db.restaurantShift.findUnique({
      where: { id: existing.id },
      select: { status: true, clockedInAt: true, clockedOutAt: true },
    });
    if (current?.status === 'CANCELLED') {
      throw new ShiftError('This shift is already cancelled.', 'ALREADY_CANCELLED');
    }
    if (current?.clockedInAt && !current.clockedOutAt) {
      throw new ShiftError(
        'This shift cannot be cancelled while the employee is clocked in.',
        'ACTIVE_ATTENDANCE'
      );
    }
    throw new ShiftError(
      'This shift changed since it was loaded. Refresh the roster and try again.',
      'VERSION_CONFLICT'
    );
  }
  return (await db.restaurantShift.findUnique({
    where: { id: existing.id },
    select: SHIFT_SELECT,
  }))!;
}

// ── Reads ───────────────────────────────────────────────────────────────────

export type ListShiftsInput = {
  branchId: string;
  /** Inclusive business-date bounds as canonical `YYYY-MM-DD` strings. */
  fromBusinessDate: string;
  toBusinessDate: string;
  staffProfileId?: string;
  /** Cancelled shifts are hidden by default; the roster can opt into showing them. */
  includeCancelled?: boolean;
};

/**
 * The roster read model: one branch, one inclusive business-date range, ordered
 * the way a roster is read (day, then start time, then operator).
 */
export async function listShifts(db: ScopedDb, input: ListShiftsInput) {
  const from = businessDateToUtcDateChecked(input.fromBusinessDate, 'from');
  const to = businessDateToUtcDateChecked(input.toBusinessDate, 'to');
  if (to.getTime() < from.getTime()) {
    throw new ShiftError('The roster range ends before it starts.', 'INVALID');
  }
  return db.restaurantShift.findMany({
    where: {
      branchId: input.branchId,
      businessDate: { gte: from, lte: to },
      ...(input.staffProfileId ? { staffProfileId: input.staffProfileId } : {}),
      ...(input.includeCancelled ? {} : { status: 'SCHEDULED' }),
    },
    select: {
      ...SHIFT_SELECT,
      staffProfile: { select: { id: true, displayName: true, status: true } },
    },
    orderBy: [{ businessDate: 'asc' }, { startAt: 'asc' }, { staffProfileId: 'asc' }],
  });
}

function businessDateToUtcDateChecked(value: string, label: string): Date {
  try {
    return businessDateToUtcDate(value);
  } catch (error) {
    if (error instanceof BusinessDateError) {
      throw new ShiftError(`Invalid ${label} business date "${value}".`, 'INVALID');
    }
    throw error;
  }
}

// ── Sign-in eligibility ─────────────────────────────────────────────────────

export type ShiftSummary = {
  id: string;
  branchId: string;
  staffProfileId: string;
  startAt: Date;
  endAt: Date;
  role: string | null;
};

/** Why an operator with a valid credential is nonetheless not on shift. */
export type ShiftDenialReason =
  /** Nothing on the roster for this operator at this branch anywhere near now. */
  | 'NO_SHIFT'
  /** The next shift exists but is still outside the early-sign-in grace window. */
  | 'NOT_STARTED'
  /** The most recent shift ended and its late grace window has passed. */
  | 'ENDED';

export type ShiftEligibility =
  | { eligible: true; shift: ShiftSummary }
  | {
      eligible: false;
      reason: ShiftDenialReason;
      /** The start of the next live shift at this branch, when one is rostered. */
      nextShiftStartsAt: Date | null;
    };

/**
 * Decide whether an operator may sign in at a branch right now.
 *
 * Active window is `[startAt - EARLY_GRACE, endAt + LATE_GRACE)`. The lookup is
 * branch-scoped (a shift at another branch does not open this terminal) and
 * status-scoped (a cancelled shift never grants sign-in). When several shifts
 * qualify — a split roster with a handover — the one that started most recently
 * wins, which is the shift the operator is actually working.
 *
 * A denial distinguishes "not started yet", "already ended" and "nothing
 * rostered" so the terminal can state the real situation and, where one exists,
 * when the operator is next expected.
 */
export async function resolveShiftEligibility(
  db: ScopedDb,
  params: { staffProfileId: string; branchId: string; now: Date }
): Promise<ShiftEligibility> {
  const now = requireInstant(params.now, 'sign-in time');
  const windowStart = new Date(now.getTime() - SHIFT_SIGN_IN_LATE_GRACE_MINUTES * MINUTE_MS);
  const windowEnd = new Date(now.getTime() + SHIFT_SIGN_IN_EARLY_GRACE_MINUTES * MINUTE_MS);

  // A shift is active now iff it started at or before `now + EARLY` and ends
  // after `now - LATE` — the grace windows expressed as bounds on the row so the
  // database, not the caller, does the filtering.
  const active = await db.restaurantShift.findFirst({
    where: {
      staffProfileId: params.staffProfileId,
      branchId: params.branchId,
      status: 'SCHEDULED',
      startAt: { lte: windowEnd },
      endAt: { gt: windowStart },
    },
    select: {
      id: true,
      branchId: true,
      staffProfileId: true,
      startAt: true,
      endAt: true,
      role: true,
    },
    orderBy: { startAt: 'desc' },
  });
  if (active) {
    return { eligible: true, shift: active };
  }

  const upcoming = await db.restaurantShift.findFirst({
    where: {
      staffProfileId: params.staffProfileId,
      branchId: params.branchId,
      status: 'SCHEDULED',
      startAt: { gt: windowEnd },
    },
    select: { startAt: true },
    orderBy: { startAt: 'asc' },
  });
  if (upcoming) {
    return { eligible: false, reason: 'NOT_STARTED', nextShiftStartsAt: upcoming.startAt };
  }

  const past = await db.restaurantShift.findFirst({
    where: {
      staffProfileId: params.staffProfileId,
      branchId: params.branchId,
      status: 'SCHEDULED',
      endAt: { lte: windowStart },
    },
    select: { id: true },
    orderBy: { endAt: 'desc' },
  });
  return {
    eligible: false,
    reason: past ? 'ENDED' : 'NO_SHIFT',
    nextShiftStartsAt: null,
  };
}

/**
 * The operator-facing sentence for a sign-in denial. Deliberately timezone-free:
 * the exact instant travels next to it as `nextShiftStartsAt` so the terminal
 * renders it in the branch's own local time rather than a raw UTC string.
 */
export function describeShiftDenial(reason: ShiftDenialReason): string {
  if (reason === 'NOT_STARTED') {
    return 'Your shift has not started yet.';
  }
  if (reason === 'ENDED') {
    return 'Your shift has ended. Ask a manager to schedule or extend a shift.';
  }
  return 'You are not scheduled at this branch right now.';
}
