import { resolveBusinessDate } from '@/lib/restaurant/business-date';
import {
  workspaceDateOffset,
  workspaceDateRange,
  workspaceTimezone,
  workspaceToday,
} from '@/lib/timezone';

/**
 * DEV-958A — the one place a pharmacy module decides which business day an instant is on.
 *
 * A pharmacy branch's business day runs on the shop's clock (the organisation zone) and ends at
 * the branch's "day ends at" hour, midnight by default. With an hour of 5, a sale at 00:30 on
 * 2 Nov belongs to the business day of 1 Nov, on the drawer opened that day, and 05:00 starts
 * 2 Nov. Every pharmacy booking, drawer, close, refund, remittance, replay, khata entry and
 * by-day report window uses these functions, so the counter, the close and the reports agree
 * on the same day; `tests/pharmacy-business-day-guard.test.ts` refuses a pharmacy module that
 * works a day out any other way.
 *
 * The hour can change, so a branch keeps a dated history of it (`PharmacyBranch.
 * businessDayEndsAtHistory`): each change names the first business day it applies to. Business
 * day D starts on calendar date D at the hour in force on D, and ends where D + 1 starts. Days
 * therefore always tile, with no gap or overlap; the one day before a change is longer or
 * shorter (see `business-day-settings.ts`), and every other day keeps the boundaries it had,
 * so a past day's report always reads the window its close counted.
 *
 * With no change (midnight throughout) every function returns exactly what the organisation-
 * midnight helpers in `src/lib/timezone.ts` return, so a branch that never sets the hour sees
 * no change at all.
 *
 * A business date names the day; it is never a clock time. A receipt, slip or ledger line
 * still prints the real time it happened ({@link pharmacyCalendarDay} for its calendar date).
 *
 * Pure and client-safe: the counter and the day-close screen use it in the browser with the
 * history the server sends; the server re-checks every date it is given.
 */

/** Midnight: the organisation-zone calendar day, as before DEV-958A. */
export const PHARMACY_DEFAULT_DAY_END_HOUR = 0;
/** The latest hour a day may end at. Later would put a morning's trade on the day before. */
export const PHARMACY_MAX_DAY_END_HOUR = 6;

/** One change of the hour: from business day `from` (`YYYY-MM-DD`) on, days end at `hour`. */
export type PharmacyDayEndChange = { from: string; hour: number };

/**
 * A branch's day-end hours by day: its stored history (a JSON list of changes, as the database
 * holds it), or one hour for every day. Anything else (missing, malformed) reads as midnight.
 */
export type PharmacyDayEnd = unknown;

/** A branch's clock: the shop's zone and the hours its business days end at. */
export type PharmacyDayClock = {
  timeZone?: string | null;
  dayEnd?: PharmacyDayEnd;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `value` is an hour a branch's day may end at. */
export function isPharmacyDayEndHour(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= PHARMACY_DEFAULT_DAY_END_HOUR &&
    value <= PHARMACY_MAX_DAY_END_HOUR
  );
}

/** A stored hour as one the helpers use: a missing or refused value is midnight. */
export function pharmacyDayEndHour(value: unknown): number {
  return isPharmacyDayEndHour(value) ? value : PHARMACY_DEFAULT_DAY_END_HOUR;
}

/** DEV-958A: a stored day-end history that is not a list of valid changes, in order. */
export class PharmacyDayEndHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PharmacyDayEndHistoryError';
  }
}

function isCalendarDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * The changes in `value`, in the order they apply: by first day, and for the same day in the
 * order they were made (the later one wins). One hour reads as a change from the first day; no
 * value (no branch) is midnight. A stored history that is not a list of valid changes in
 * ascending order is refused, never read as midnight: the database refuses to store one
 * (`pharmacy_branch_day_end_history_guard`), so meeting one means something is wrong.
 */
export function pharmacyDayEndSchedule(value: PharmacyDayEnd): PharmacyDayEndChange[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'number') {
    const hour = pharmacyDayEndHour(value);
    return hour === PHARMACY_DEFAULT_DAY_END_HOUR ? [] : [{ from: '0000-01-01', hour }];
  }
  if (!Array.isArray(value))
    throw new PharmacyDayEndHistoryError('A branch day-end history must be a list of changes.');
  const changes: PharmacyDayEndChange[] = [];
  for (const entry of value as unknown[]) {
    const { from, hour } = (entry && typeof entry === 'object' ? entry : {}) as {
      from?: unknown;
      hour?: unknown;
    };
    if (!isCalendarDay(from) || !isPharmacyDayEndHour(hour))
      throw new PharmacyDayEndHistoryError(
        'A branch day-end change needs a calendar day and an hour from midnight to 06:00.'
      );
    const previous = changes.at(-1);
    if (previous && previous.from > from)
      throw new PharmacyDayEndHistoryError('A branch day-end history must be in date order.');
    changes.push({ from, hour });
  }
  return changes;
}

/**
 * DEV-958A: a branch as a screen gets it, its day-end history as `{ from, hour }` only: the
 * stored entries also name who made each change and when, which stays on the server.
 */
export function withClientPharmacyDayEnd<T extends { businessDayEndsAtHistory: unknown }>(
  branch: T
) {
  return {
    ...branch,
    businessDayEndsAtHistory: pharmacyDayEndSchedule(branch.businessDayEndsAtHistory),
  };
}

/** The hour business day `day` (`YYYY-MM-DD`) starts at, from the changes in force on it. */
function hourOnDay(schedule: readonly PharmacyDayEndChange[], day: string): number {
  let hour = PHARMACY_DEFAULT_DAY_END_HOUR;
  for (const change of schedule) {
    if (change.from > day) break;
    hour = change.hour;
  }
  return hour;
}

function midnightThroughout(schedule: readonly PharmacyDayEndChange[]): boolean {
  return schedule.every((change) => change.hour === PHARMACY_DEFAULT_DAY_END_HOUR);
}

/**
 * The hour in force on business day `day`: the day starts on its calendar date at this hour
 * and ends where the next day starts.
 */
export function pharmacyDayEndHourOn(clock: PharmacyDayClock, day: string): number {
  return hourOnDay(pharmacyDayEndSchedule(clock.dayEnd), day);
}

/** The schedule as written for comparison: midnight throughout is one value whatever its form. */
function scheduleKey(schedule: readonly PharmacyDayEndChange[]): string {
  return midnightThroughout(schedule) ? '[]' : JSON.stringify(schedule);
}

/** Each branch's own day-end history, by branch id. A branch not listed is on midnight. */
export type PharmacyBranchDayEnds = Readonly<Record<string, PharmacyDayEnd>>;

/** The branches that share one window over the picked days, and that window. */
export type PharmacyBranchDayWindow = { branchIds: string[]; from: Date; to: Date };

/**
 * DEV-958A — the windows of the inclusive business days `from`..`to` for each of `branchIds`,
 * each branch on its own day-end history: a report across branches is the sum of each branch's
 * own business days, never one branch's days imposed on another, and never moved by a later
 * change at another branch. Branches whose windows are the same share one entry, in the order
 * first seen; with no history at all (every branch on midnight) this is the one organisation
 * window it always was.
 */
export function pharmacyBranchDayWindows(
  from: string,
  to: string,
  branchIds: readonly string[],
  clock: { timeZone?: string | null; dayEnds?: PharmacyBranchDayEnds }
): PharmacyBranchDayWindow[] {
  const groups: PharmacyBranchDayWindow[] = [];
  for (const branchId of branchIds) {
    const window = pharmacyBusinessDayRange(from, to, {
      timeZone: clock.timeZone,
      dayEnd: clock.dayEnds?.[branchId],
    });
    const same = groups.find(
      (group) =>
        group.from.getTime() === window.from.getTime() && group.to.getTime() === window.to.getTime()
    );
    if (same) same.branchIds.push(branchId);
    else groups.push({ branchIds: [branchId], from: window.from, to: window.to });
  }
  return groups;
}

/**
 * The branches' own day-end histories as a field to spread into a reader's filters: only the
 * branches not on midnight throughout, and none at all when every branch is, so a default
 * organisation passes exactly the filters it passed before DEV-958A.
 */
export function pharmacyBranchDayEndsField(
  branches: readonly { id: string; dayEnd?: PharmacyDayEnd }[]
): { dayEnds?: Record<string, PharmacyDayEndChange[]> } {
  const dayEnds: Record<string, PharmacyDayEndChange[]> = {};
  for (const branch of branches) {
    const schedule = pharmacyDayEndSchedule(branch.dayEnd);
    if (!midnightThroughout(schedule)) dayEnds[branch.id] = schedule;
  }
  return Object.keys(dayEnds).length ? { dayEnds } : {};
}

/** Whether `branchIds` end their days at different hours on any of the picked days. */
export function pharmacyBranchDaysDiffer(
  from: string,
  to: string,
  branchIds: readonly string[],
  clock: { timeZone?: string | null; dayEnds?: PharmacyBranchDayEnds }
): boolean {
  return pharmacyBranchDayWindows(from, to, branchIds, clock).length > 1;
}

/**
 * The day-end hours a window over several branches uses. Branches that share them (every
 * branch, until an owner changes one) use them, so the window agrees with each branch's day
 * close. When the branches' hours differ no one window matches all of them: it falls back to
 * midnight, the organisation's calendar day, and `mixed` says so, for the screen to show. One
 * branch always gives that branch's own days.
 */
export function sharedPharmacyDayEnd(values: readonly PharmacyDayEnd[]): {
  dayEnd: PharmacyDayEndChange[];
  mixed: boolean;
} {
  const schedules = values.map(pharmacyDayEndSchedule);
  const distinct = new Set(schedules.map(scheduleKey));
  if (distinct.size > 1) return { dayEnd: [], mixed: true };
  const [first] = schedules;
  return { dayEnd: first && !midnightThroughout(first) ? first : [], mixed: false };
}

/**
 * The day-end hours as a field to spread into a reader's filters: none at midnight, so a branch
 * on the default passes exactly the filters it passed before DEV-958A.
 */
export function pharmacyDayEndField(value: PharmacyDayEnd): { dayEnd?: PharmacyDayEndChange[] } {
  const schedule = pharmacyDayEndSchedule(value);
  return midnightThroughout(schedule) ? {} : { dayEnd: schedule };
}

/** "Midnight" or "5:00 AM": the hour as the owner reads it. */
export function pharmacyDayEndLabel(value: unknown): string {
  const hour = pharmacyDayEndHour(value);
  return hour === 0 ? 'Midnight' : `${hour}:00 AM`;
}

/** `day` (`YYYY-MM-DD`) moved by `days` calendar days. */
export function shiftPharmacyDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * The business day (`YYYY-MM-DD`) the instant `at` belongs to on the branch's clock. On calendar
 * date C, before the hour in force on C, it is still the previous business day.
 */
export function pharmacyBusinessDay(clock: PharmacyDayClock, at: Date = new Date()): string {
  const schedule = pharmacyDayEndSchedule(clock.dayEnd);
  const calendar = workspaceToday(clock.timeZone, at);
  const hour = hourOnDay(schedule, calendar);
  if (hour === PHARMACY_DEFAULT_DAY_END_HOUR) return calendar;
  return resolveBusinessDate(
    at,
    workspaceTimezone(clock.timeZone),
    `${String(hour).padStart(2, '0')}:00`
  );
}

/** {@link pharmacyBusinessDay} as the UTC-midnight `Date` a `@db.Date` business date stores. */
export function pharmacyBusinessDate(clock: PharmacyDayClock, at: Date = new Date()): Date {
  return new Date(`${pharmacyBusinessDay(clock, at)}T00:00:00.000Z`);
}

/**
 * The business day `days` after (or, negative, before) the branch's current business day: a
 * report's default "last 30 days" and "up to tomorrow" bounds.
 */
export function pharmacyBusinessDayOffset(
  clock: PharmacyDayClock,
  days: number,
  now: Date = new Date()
): string {
  return shiftPharmacyDay(pharmacyBusinessDay(clock, now), days);
}

/** Whether a stored business date (`@db.Date`, UTC midnight) is the branch's current day. */
export function isPharmacyCurrentBusinessDate(
  date: Date,
  clock: PharmacyDayClock,
  now: Date = new Date()
): boolean {
  return date.toISOString().slice(0, 10) === pharmacyBusinessDay(clock, now);
}

/**
 * The first instant of business day `day` on the branch's clock: calendar date `day` at the
 * hour in force on it. Found by bisection over {@link pharmacyBusinessDay} itself, so a window
 * and the day an instant is booked on can never disagree, whatever daylight-saving change
 * falls nearby.
 */
function pharmacyBusinessDayStart(day: number, clock: PharmacyDayClock): Date {
  const hour = pharmacyDayEndHourOn(clock, new Date(day).toISOString().slice(0, 10));
  const dayOf = (instant: number) =>
    Date.parse(`${pharmacyBusinessDay(clock, new Date(instant))}T00:00:00.000Z`);
  let before = day + (hour - 15) * 3_600_000;
  let reached = day + (hour + 15) * 3_600_000;
  while (reached - before > 1) {
    const middle = before + Math.floor((reached - before) / 2);
    if (dayOf(middle) < day) before = middle;
    else reached = middle;
  }
  return new Date(reached);
}

/**
 * The instants bounding the inclusive business days `from`..`to` on the branch's clock: the
 * start of `from` and the start of the day after `to`. Filter timestamps with `>= from` and
 * `< to`. Midnight throughout, this is exactly {@link workspaceDateRange}.
 */
export function pharmacyBusinessDayRange(
  from: string,
  to: string,
  clock: PharmacyDayClock
): { from: Date; to: Date } {
  if (midnightThroughout(pharmacyDayEndSchedule(clock.dayEnd)))
    return workspaceDateRange(from, to, clock.timeZone);
  return {
    from: pharmacyBusinessDayStart(Date.parse(`${from}T00:00:00.000Z`), clock),
    to: pharmacyBusinessDayStart(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000, clock),
  };
}

/**
 * The calendar date (`YYYY-MM-DD`) of an instant on the shop's wall clock, ignoring the day-end
 * hour. For dates that are not a business day: a receipt's or ledger line's printed date, a
 * prescription's or licence's validity, a supplier's due date, a regulator's effective date.
 */
export function pharmacyCalendarDay(
  timeZone: string | null | undefined,
  at: Date = new Date()
): string {
  return workspaceToday(timeZone, at);
}

/** The calendar date `days` after (or before) today's on the shop's wall clock. */
export function pharmacyCalendarDayOffset(
  timeZone: string | null | undefined,
  days: number,
  now: Date = new Date()
): string {
  return workspaceDateOffset(timeZone, days, now);
}

/**
 * The instants bounding the inclusive calendar dates `from`..`to` on the shop's wall clock,
 * ignoring the day-end hour: for windows that are calendar dates, not business days
 * (accounting periods, supplier ageing, validity dates).
 */
export function pharmacyCalendarDayRange(
  from: string,
  to: string,
  timeZone: string | null | undefined
): { from: Date; to: Date } {
  return workspaceDateRange(from, to, timeZone);
}
