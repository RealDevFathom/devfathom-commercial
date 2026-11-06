import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { rowsToCsv } from '@/lib/restaurant/reports';

export const DEFAULT_LATE_THRESHOLD_MINUTES = 5;
const MINUTE_MS = 60_000;

export type WorkforceErrorReason =
  'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT' | 'INVALID' | 'IDEMPOTENCY_CONFLICT';

export class WorkforceError extends Error {
  constructor(
    message: string,
    readonly reason: WorkforceErrorReason
  ) {
    super(message);
    this.name = 'WorkforceError';
  }
}

type CommandKind =
  | 'CLOCK_IN'
  | 'CLOCK_OUT'
  | 'BREAK_START'
  | 'BREAK_END'
  | 'SWAP_REQUEST'
  | 'SWAP_APPROVE'
  | 'SWAP_REJECT';

type QueryDb = Prisma.TransactionClient;

function requireIdempotencyKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 200) {
    throw new WorkforceError('A valid idempotency key is required.', 'INVALID');
  }
  return key;
}

function requireReason(value: string): string {
  const reason = value.trim();
  if (!reason) throw new WorkforceError('A correction reason is required.', 'INVALID');
  return reason.slice(0, 500);
}

async function lockShift(tx: QueryDb, shiftId: string) {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "restaurant_shifts" WHERE "id" = ${shiftId} FOR UPDATE`
  );
  if (locked.length === 0) throw new WorkforceError('Shift not found.', 'NOT_FOUND');
}

async function actorProfile(tx: QueryDb, userId: string) {
  const actor = await tx.restaurantStaffProfile.findFirst({
    where: { userId, status: 'ACTIVE' },
    select: { id: true, displayName: true, primaryBranchId: true },
  });
  if (!actor) {
    throw new WorkforceError(
      'No active restaurant staff profile is linked to this account.',
      'FORBIDDEN'
    );
  }
  return actor;
}

async function commandReplay(
  tx: QueryDb,
  input: { idempotencyKey: string; kind: CommandKind; shiftId: string }
) {
  const existing = await tx.restaurantWorkforceCommand.findFirst({
    where: { idempotencyKey: input.idempotencyKey },
    select: { kind: true, shiftId: true, breakId: true, swapRequestId: true },
  });
  if (!existing) return null;
  if (existing.kind !== input.kind || existing.shiftId !== input.shiftId) {
    throw new WorkforceError(
      'This idempotency key was already used for a different workforce command.',
      'IDEMPOTENCY_CONFLICT'
    );
  }
  return existing;
}

async function createCommand(
  tx: QueryDb,
  input: {
    idempotencyKey: string;
    kind: CommandKind;
    shiftId: string;
    breakId?: string;
    swapRequestId?: string;
  }
) {
  return tx.restaurantWorkforceCommand.create({ data: input });
}

export const WORKFORCE_SHIFT_SELECT = {
  id: true,
  version: true,
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
  clockedInAt: true,
  clockedOutAt: true,
  createdAt: true,
  updatedAt: true,
  branch: { select: { id: true, name: true, timezone: true } },
  staffProfile: { select: { id: true, displayName: true } },
  breaks: {
    select: { id: true, startedAt: true, endedAt: true },
    orderBy: { startedAt: 'asc' as const },
  },
  adjustments: {
    select: { id: true, breakId: true, kind: true, correctedAt: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
  },
  swapRequests: {
    select: {
      id: true,
      note: true,
      createdAt: true,
      requestedBy: { select: { id: true, displayName: true } },
      replacement: { select: { id: true, displayName: true } },
      decision: { select: { decision: true, reason: true, decidedAt: true } },
    },
    orderBy: { createdAt: 'desc' as const },
  },
} satisfies Prisma.RestaurantShiftSelect;

type WorkforceShift = Prisma.RestaurantShiftGetPayload<{ select: typeof WORKFORCE_SHIFT_SELECT }>;

function adjustedAt(
  shift: WorkforceShift,
  kind: 'CLOCK_IN' | 'CLOCK_OUT',
  original: Date | null
): Date | null {
  const latest = shift.adjustments
    .filter((row) => row.kind === kind && row.breakId === null)
    .at(-1);
  return latest?.correctedAt ?? original;
}

function adjustedBreakAt(
  shift: WorkforceShift,
  breakId: string,
  kind: 'BREAK_START' | 'BREAK_END',
  original: Date | null
): Date | null {
  const latest = shift.adjustments
    .filter((row) => row.breakId === breakId && row.kind === kind)
    .at(-1);
  return latest?.correctedAt ?? original;
}

export function presentWorkforceShift(shift: WorkforceShift, now = new Date()) {
  const clockedInAt = adjustedAt(shift, 'CLOCK_IN', shift.clockedInAt);
  const clockedOutAt = adjustedAt(shift, 'CLOCK_OUT', shift.clockedOutAt);
  const breaks = shift.breaks.map((row) => ({
    ...row,
    startedAt: adjustedBreakAt(shift, row.id, 'BREAK_START', row.startedAt)!,
    endedAt: adjustedBreakAt(shift, row.id, 'BREAK_END', row.endedAt),
  }));
  const lateMinutes = clockedInAt
    ? Math.max(0, Math.floor((clockedInAt.getTime() - shift.startAt.getTime()) / MINUTE_MS))
    : 0;
  const attendanceStatus =
    shift.status === 'CANCELLED'
      ? 'CANCELLED'
      : clockedOutAt
        ? lateMinutes > DEFAULT_LATE_THRESHOLD_MINUTES
          ? 'COMPLETE_LATE'
          : 'COMPLETE'
        : clockedInAt
          ? lateMinutes > DEFAULT_LATE_THRESHOLD_MINUTES
            ? 'LATE'
            : 'PRESENT'
          : now > shift.endAt
            ? 'ABSENT'
            : 'SCHEDULED';
  return {
    ...shift,
    clockedInAt,
    clockedOutAt,
    breaks,
    lateMinutes,
    lateThresholdMinutes: DEFAULT_LATE_THRESHOLD_MINUTES,
    attendanceStatus,
  };
}

async function loadShift(tx: QueryDb, shiftId: string): Promise<WorkforceShift> {
  const shift = await tx.restaurantShift.findUnique({
    where: { id: shiftId },
    select: WORKFORCE_SHIFT_SELECT,
  });
  if (!shift) throw new WorkforceError('Shift not found.', 'NOT_FOUND');
  return shift;
}

async function requireOwnLiveShift(tx: QueryDb, shiftId: string, userId: string) {
  await lockShift(tx, shiftId);
  const [shift, actor] = await Promise.all([loadShift(tx, shiftId), actorProfile(tx, userId)]);
  if (shift.staffProfileId !== actor.id) {
    throw new WorkforceError('This shift is assigned to another employee.', 'FORBIDDEN');
  }
  if (shift.status === 'CANCELLED') {
    throw new WorkforceError('A cancelled shift cannot record time or swaps.', 'CONFLICT');
  }
  return { shift, actor };
}

export async function readMyWorkforce(db: ScopedDb, userId: string, from: Date, to: Date) {
  const actor = await actorProfile(db, userId);
  const shifts = await db.restaurantShift.findMany({
    where: { staffProfileId: actor.id, startAt: { lte: to }, endAt: { gte: from } },
    select: WORKFORCE_SHIFT_SELECT,
    orderBy: { startAt: 'asc' },
  });
  return { actor, shifts: shifts.map((shift) => presentWorkforceShift(shift)) };
}

export async function clockIn(
  db: ScopedDb,
  input: { shiftId: string; userId: string; idempotencyKey: string; now?: Date }
) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  return db.$transaction(async (tx) => {
    const { shift } = await requireOwnLiveShift(tx, input.shiftId, input.userId);
    const replay = await commandReplay(tx, { idempotencyKey, kind: 'CLOCK_IN', shiftId: shift.id });
    if (replay) return presentWorkforceShift(await loadShift(tx, shift.id));
    const effective = presentWorkforceShift(shift);
    if (effective.clockedInAt || effective.clockedOutAt)
      throw new WorkforceError('This shift is already clocked in.', 'CONFLICT');
    const now = input.now ?? new Date();
    if (now.getTime() < shift.startAt.getTime() - 30 * MINUTE_MS) {
      throw new WorkforceError('Clock-in opens 30 minutes before the scheduled shift.', 'CONFLICT');
    }
    if (now.getTime() > shift.endAt.getTime() + 30 * MINUTE_MS) {
      throw new WorkforceError('This shift has already ended.', 'CONFLICT');
    }
    await tx.restaurantShift.update({ where: { id: shift.id }, data: { clockedInAt: now } });
    await createCommand(tx, { idempotencyKey, kind: 'CLOCK_IN', shiftId: shift.id });
    return presentWorkforceShift(await loadShift(tx, shift.id), now);
  });
}

export async function startBreak(
  db: ScopedDb,
  input: { shiftId: string; userId: string; idempotencyKey: string; now?: Date }
) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  return db.$transaction(async (tx) => {
    const { shift } = await requireOwnLiveShift(tx, input.shiftId, input.userId);
    const replay = await commandReplay(tx, {
      idempotencyKey,
      kind: 'BREAK_START',
      shiftId: shift.id,
    });
    if (replay) return presentWorkforceShift(await loadShift(tx, shift.id));
    const effective = presentWorkforceShift(shift);
    if (!effective.clockedInAt || effective.clockedOutAt) {
      throw new WorkforceError('Breaks require an active clock-in.', 'CONFLICT');
    }
    if (effective.breaks.some((row) => row.endedAt === null)) {
      throw new WorkforceError('A break is already active.', 'CONFLICT');
    }
    const now = input.now ?? new Date();
    if (now < effective.clockedInAt || effective.breaks.some((row) => row.endedAt! > now)) {
      throw new WorkforceError('A break cannot begin before prior attendance.', 'CONFLICT');
    }
    const created = await tx.restaurantShiftBreak.create({
      data: { shiftId: shift.id, startedAt: now },
    });
    await createCommand(tx, {
      idempotencyKey,
      kind: 'BREAK_START',
      shiftId: shift.id,
      breakId: created.id,
    });
    return presentWorkforceShift(await loadShift(tx, shift.id));
  });
}

export async function endBreak(
  db: ScopedDb,
  input: { shiftId: string; userId: string; idempotencyKey: string; now?: Date }
) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  return db.$transaction(async (tx) => {
    const { shift } = await requireOwnLiveShift(tx, input.shiftId, input.userId);
    const replay = await commandReplay(tx, {
      idempotencyKey,
      kind: 'BREAK_END',
      shiftId: shift.id,
    });
    if (replay) return presentWorkforceShift(await loadShift(tx, shift.id));
    const effective = presentWorkforceShift(shift);
    if (!effective.clockedInAt || effective.clockedOutAt) {
      throw new WorkforceError('Breaks require an active clock-in.', 'CONFLICT');
    }
    const open = effective.breaks.find((row) => row.endedAt === null);
    if (!open) throw new WorkforceError('No active break exists.', 'CONFLICT');
    const now = input.now ?? new Date();
    if (now < open.startedAt) {
      throw new WorkforceError('Break end cannot be before break start.', 'CONFLICT');
    }
    await tx.restaurantShiftBreak.update({
      where: { id: open.id },
      data: { endedAt: now },
    });
    await createCommand(tx, {
      idempotencyKey,
      kind: 'BREAK_END',
      shiftId: shift.id,
      breakId: open.id,
    });
    return presentWorkforceShift(await loadShift(tx, shift.id));
  });
}

export async function clockOut(
  db: ScopedDb,
  input: { shiftId: string; userId: string; idempotencyKey: string; now?: Date }
) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  return db.$transaction(async (tx) => {
    const { shift, actor } = await requireOwnLiveShift(tx, input.shiftId, input.userId);
    const replay = await commandReplay(tx, {
      idempotencyKey,
      kind: 'CLOCK_OUT',
      shiftId: shift.id,
    });
    if (replay) return presentWorkforceShift(await loadShift(tx, shift.id));
    const effective = presentWorkforceShift(shift);
    if (!effective.clockedInAt || effective.clockedOutAt) {
      throw new WorkforceError('This shift does not have an active clock-in.', 'CONFLICT');
    }
    if (effective.breaks.some((row) => row.endedAt === null)) {
      throw new WorkforceError('End the active break before clocking out.', 'CONFLICT');
    }
    const now = input.now ?? new Date();
    if (now < effective.clockedInAt || effective.breaks.some((row) => row.endedAt! > now)) {
      throw new WorkforceError('Clock-out cannot be before prior attendance.', 'CONFLICT');
    }
    if (!shift.clockedInAt || now < shift.clockedInAt) {
      // The raw timekeeping CHECK requires a raw clock-in. Preserve its absence
      // and record this server-observed clock-out in the append-only history.
      await tx.restaurantTimeAdjustment.create({
        data: {
          shiftId: shift.id,
          kind: 'CLOCK_OUT',
          originalAt: null,
          correctedAt: now,
          reason: 'Employee clock-out after a clock-in correction.',
          adjustedByUserId: input.userId,
          adjustedByStaffProfileId: actor.id,
        },
      });
    } else {
      await tx.restaurantShift.update({ where: { id: shift.id }, data: { clockedOutAt: now } });
    }
    await createCommand(tx, { idempotencyKey, kind: 'CLOCK_OUT', shiftId: shift.id });
    return presentWorkforceShift(await loadShift(tx, shift.id), now);
  });
}

export async function requestShiftSwap(
  db: ScopedDb,
  input: {
    shiftId: string;
    userId: string;
    replacementStaffProfileId: string;
    note?: string;
    idempotencyKey: string;
  }
) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  return db.$transaction(async (tx) => {
    const replayActor = await actorProfile(tx, input.userId);
    const replayBeforeLock = await commandReplay(tx, {
      idempotencyKey,
      kind: 'SWAP_REQUEST',
      shiftId: input.shiftId,
    });
    if (replayBeforeLock?.swapRequestId) {
      const request = await tx.restaurantShiftSwapRequest.findFirst({
        where: {
          id: replayBeforeLock.swapRequestId,
          requestedByStaffProfileId: replayActor.id,
        },
      });
      if (request) return request;
      throw new WorkforceError('This idempotency key belongs to another request.', 'CONFLICT');
    }

    const { shift, actor } = await requireOwnLiveShift(tx, input.shiftId, input.userId);
    const replay = await commandReplay(tx, {
      idempotencyKey,
      kind: 'SWAP_REQUEST',
      shiftId: shift.id,
    });
    if (replay?.swapRequestId) {
      const request = await tx.restaurantShiftSwapRequest.findFirst({
        where: { id: replay.swapRequestId, requestedByStaffProfileId: actor.id },
      });
      if (request) return request;
      throw new WorkforceError('This idempotency key belongs to another request.', 'CONFLICT');
    }
    if (actor.id === input.replacementStaffProfileId) {
      throw new WorkforceError('Choose another employee as the replacement.', 'INVALID');
    }
    const replacement = await tx.restaurantStaffProfile.findFirst({
      where: {
        id: input.replacementStaffProfileId,
        primaryBranchId: shift.branchId,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    if (!replacement) {
      throw new WorkforceError('The replacement is not active in this branch.', 'INVALID');
    }
    const pending = await tx.restaurantShiftSwapRequest.findFirst({
      where: { shiftId: shift.id, decision: null },
      select: { id: true },
    });
    if (pending) throw new WorkforceError('This shift already has a pending swap.', 'CONFLICT');
    const request = await tx.restaurantShiftSwapRequest.create({
      data: {
        shiftId: shift.id,
        requestedByStaffProfileId: actor.id,
        replacementStaffProfileId: replacement.id,
        note: input.note?.trim().slice(0, 500) || null,
      },
    });
    await tx.restaurantShiftEvent.create({
      data: {
        shiftId: shift.id,
        kind: 'SWAP_REQUESTED',
        actorUserId: input.userId,
        fromStaffProfileId: actor.id,
        toStaffProfileId: replacement.id,
        reason: request.note,
      },
    });
    await createCommand(tx, {
      idempotencyKey,
      kind: 'SWAP_REQUEST',
      shiftId: shift.id,
      swapRequestId: request.id,
    });
    return request;
  });
}

export async function reviewShiftSwap(
  db: ScopedDb,
  input: {
    requestId: string;
    branchId: string;
    decision: 'APPROVED' | 'REJECTED';
    reason?: string;
    actorUserId: string;
    actorStaffProfileId: string | null;
    idempotencyKey: string;
  }
) {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ shiftId: string }>>(
      Prisma.sql`SELECT r."shiftId" FROM "restaurant_shift_swap_requests" r
        JOIN "restaurant_shifts" s ON s."id" = r."shiftId"
        WHERE r."id" = ${input.requestId} AND s."branchId" = ${input.branchId}
        FOR UPDATE OF r, s`
    );
    const row = rows[0];
    if (!row) throw new WorkforceError('Pending swap not found in this branch.', 'NOT_FOUND');
    const kind = input.decision === 'APPROVED' ? 'SWAP_APPROVE' : 'SWAP_REJECT';
    const replay = await commandReplay(tx, { idempotencyKey, kind, shiftId: row.shiftId });
    if (replay) {
      return tx.restaurantShiftSwapDecision.findUnique({ where: { requestId: input.requestId } });
    }
    const request = await tx.restaurantShiftSwapRequest.findUnique({
      where: { id: input.requestId },
      include: {
        decision: true,
        shift: {
          include: {
            breaks: { select: { id: true }, take: 1 },
            adjustments: { select: { id: true }, take: 1 },
          },
        },
        replacement: true,
      },
    });
    if (!request || request.decision) {
      throw new WorkforceError('This swap request has already been decided.', 'CONFLICT');
    }
    if (request.shift.status === 'CANCELLED') {
      throw new WorkforceError('A cancelled shift cannot be reassigned.', 'CONFLICT');
    }
    if (input.decision === 'APPROVED') {
      if (
        request.shift.clockedInAt ||
        request.shift.clockedOutAt ||
        request.shift.breaks.length > 0 ||
        request.shift.adjustments.length > 0
      ) {
        throw new WorkforceError(
          'A shift with recorded attendance cannot be reassigned.',
          'CONFLICT'
        );
      }
      if (
        request.replacement.status !== 'ACTIVE' ||
        request.replacement.primaryBranchId !== input.branchId
      ) {
        throw new WorkforceError('The replacement is no longer active in this branch.', 'CONFLICT');
      }
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`restaurant-roster:${request.replacementStaffProfileId}`}, 0))`
      );
      const overlap = await tx.restaurantShift.findFirst({
        where: {
          id: { not: request.shiftId },
          staffProfileId: request.replacementStaffProfileId,
          status: 'SCHEDULED',
          startAt: { lt: request.shift.endAt },
          endAt: { gt: request.shift.startAt },
        },
        select: { id: true },
      });
      if (overlap) {
        throw new WorkforceError('The replacement has an overlapping shift.', 'CONFLICT');
      }
      await tx.restaurantShift.update({
        where: { id: request.shiftId },
        data: { staffProfileId: request.replacementStaffProfileId },
      });
    }
    const decision = await tx.restaurantShiftSwapDecision.create({
      data: {
        requestId: request.id,
        decision: input.decision,
        decidedByUserId: input.actorUserId,
        decidedByStaffProfileId: input.actorStaffProfileId,
        reason: input.reason?.trim().slice(0, 500) || null,
      },
    });
    await tx.restaurantShiftEvent.create({
      data: {
        shiftId: request.shiftId,
        kind: input.decision === 'APPROVED' ? 'SWAP_APPROVED' : 'SWAP_REJECTED',
        actorUserId: input.actorUserId,
        fromStaffProfileId: request.requestedByStaffProfileId,
        toStaffProfileId: request.replacementStaffProfileId,
        reason: decision.reason,
      },
    });
    await createCommand(tx, {
      idempotencyKey,
      kind,
      shiftId: request.shiftId,
      swapRequestId: request.id,
    });
    return decision;
  });
}

export async function appendTimeAdjustment(
  db: ScopedDb,
  input: {
    shiftId: string;
    kind: 'CLOCK_IN' | 'CLOCK_OUT' | 'BREAK_START' | 'BREAK_END';
    breakId?: string;
    correctedAt: Date;
    reason: string;
    actorUserId: string;
    actorStaffProfileId: string | null;
  }
) {
  return db.$transaction(async (tx) => {
    const isBreakAdjustment = input.kind === 'BREAK_START' || input.kind === 'BREAK_END';
    if (isBreakAdjustment !== Boolean(input.breakId)) {
      throw new WorkforceError(
        isBreakAdjustment
          ? 'Break corrections require a break identifier.'
          : 'Clock corrections cannot target a break.',
        'INVALID'
      );
    }
    await lockShift(tx, input.shiftId);
    const shift = await loadShift(tx, input.shiftId);
    const breakRow = input.breakId
      ? (shift.breaks.find((row) => row.id === input.breakId) ?? null)
      : null;
    if (isBreakAdjustment && !breakRow) {
      throw new WorkforceError('Break not found in this shift.', 'NOT_FOUND');
    }
    const originalAt =
      input.kind === 'CLOCK_IN'
        ? adjustedAt(shift, 'CLOCK_IN', shift.clockedInAt)
        : input.kind === 'CLOCK_OUT'
          ? adjustedAt(shift, 'CLOCK_OUT', shift.clockedOutAt)
          : input.kind === 'BREAK_START' && breakRow
            ? adjustedBreakAt(shift, breakRow.id, 'BREAK_START', breakRow.startedAt)
            : input.kind === 'BREAK_END' && breakRow
              ? adjustedBreakAt(shift, breakRow.id, 'BREAK_END', breakRow.endedAt)
              : null;
    if (Number.isNaN(input.correctedAt.getTime())) {
      throw new WorkforceError('A valid corrected timestamp is required.', 'INVALID');
    }
    const projectedClockIn =
      input.kind === 'CLOCK_IN'
        ? input.correctedAt
        : adjustedAt(shift, 'CLOCK_IN', shift.clockedInAt);
    const projectedClockOut =
      input.kind === 'CLOCK_OUT'
        ? input.correctedAt
        : adjustedAt(shift, 'CLOCK_OUT', shift.clockedOutAt);
    if (projectedClockOut && !projectedClockIn) {
      throw new WorkforceError('Add the missing clock-in before clock-out.', 'INVALID');
    }
    if (projectedClockIn && projectedClockOut && projectedClockOut < projectedClockIn) {
      throw new WorkforceError('Clock-out cannot be before clock-in.', 'INVALID');
    }
    for (const item of shift.breaks) {
      const projectedStart =
        input.breakId === item.id && input.kind === 'BREAK_START'
          ? input.correctedAt
          : adjustedBreakAt(shift, item.id, 'BREAK_START', item.startedAt)!;
      const projectedEnd =
        input.breakId === item.id && input.kind === 'BREAK_END'
          ? input.correctedAt
          : adjustedBreakAt(shift, item.id, 'BREAK_END', item.endedAt);
      if (projectedEnd && projectedEnd < projectedStart) {
        throw new WorkforceError('Break end cannot be before break start.', 'INVALID');
      }
      if (projectedClockIn && projectedStart < projectedClockIn) {
        throw new WorkforceError('A break cannot begin before clock-in.', 'INVALID');
      }
      if (projectedClockOut && projectedEnd && projectedEnd > projectedClockOut) {
        throw new WorkforceError('A break cannot end after clock-out.', 'INVALID');
      }
      if (projectedClockOut && !projectedEnd) {
        throw new WorkforceError('Add the missing break end before clock-out.', 'INVALID');
      }
    }
    return tx.restaurantTimeAdjustment.create({
      data: {
        shiftId: shift.id,
        breakId: breakRow?.id,
        kind: input.kind,
        originalAt,
        correctedAt: input.correctedAt,
        reason: requireReason(input.reason),
        adjustedByUserId: input.actorUserId,
        adjustedByStaffProfileId: input.actorStaffProfileId,
      },
    });
  });
}

export async function exportWorkforceAttendanceCsv(
  db: ScopedDb,
  input: { branchId: string; fromBusinessDate: Date; toBusinessDate: Date }
) {
  const shifts = await db.restaurantShift.findMany({
    where: {
      branchId: input.branchId,
      businessDate: { gte: input.fromBusinessDate, lte: input.toBusinessDate },
    },
    select: WORKFORCE_SHIFT_SELECT,
    orderBy: [{ businessDate: 'asc' }, { startAt: 'asc' }],
  });
  const rows = shifts.map((row) => {
    const shift = presentWorkforceShift(row);
    const breakMinutes = shift.breaks.reduce((total, item) => {
      if (!item.endedAt) return total;
      return (
        total +
        Math.max(0, Math.round((item.endedAt.getTime() - item.startedAt.getTime()) / MINUTE_MS))
      );
    }, 0);
    const workedMinutes =
      shift.clockedInAt && shift.clockedOutAt && shift.breaks.every((item) => item.endedAt)
        ? Math.max(
            0,
            Math.round((shift.clockedOutAt.getTime() - shift.clockedInAt.getTime()) / MINUTE_MS) -
              breakMinutes
          )
        : null;
    return {
      branch: shift.branch.name,
      employee: shift.staffProfile.displayName,
      businessDate: shift.businessDate.toISOString().slice(0, 10),
      scheduledStart: shift.startAt.toISOString(),
      scheduledEnd: shift.endAt.toISOString(),
      clockIn: shift.clockedInAt?.toISOString() ?? '',
      clockOut: shift.clockedOutAt?.toISOString() ?? '',
      breakMinutes,
      workedMinutes: workedMinutes ?? '',
      workedHours: workedMinutes === null ? '' : (workedMinutes / 60).toFixed(2),
      attendanceStatus: shift.attendanceStatus,
      lateMinutes: shift.lateMinutes,
    };
  });
  return {
    filename: `restaurant-workforce-${input.fromBusinessDate.toISOString().slice(0, 10)}-${input.toBusinessDate.toISOString().slice(0, 10)}.csv`,
    csv: rowsToCsv(rows, [
      'branch',
      'employee',
      'businessDate',
      'scheduledStart',
      'scheduledEnd',
      'clockIn',
      'clockOut',
      'breakMinutes',
      'workedMinutes',
      'workedHours',
      'attendanceStatus',
      'lateMinutes',
    ]),
  };
}
