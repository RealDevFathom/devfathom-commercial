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
 * With the default (0, midnight) every function returns exactly what the organisation-midnight
 * helpers in `src/lib/timezone.ts` return, so a branch that never sets the hour sees no change.
 *
 * A business date names the day; it is never a clock time. A receipt, slip or ledger line
 * still prints the real time it happened ({@link pharmacyCalendarDay} for its calendar date).
 *
 * Pure and client-safe: the counter and the day-close screen use it in the browser with the
 * hour the server sends; the server re-checks every date it is given.
 */

/** Midnight: the organisation-zone calendar day, as before DEV-958A. */
export const PHARMACY_DEFAULT_DAY_END_HOUR = 0;
/** The latest hour a day may end at. Later would put a morning's trade on the day before. */
export const PHARMACY_MAX_DAY_END_HOUR = 6;

/** A branch's clock: the shop's zone and the hour its business day ends at. */
export type PharmacyDayClock = {
  timeZone?: string | null;
  /** 0 (midnight) to {@link PHARMACY_MAX_DAY_END_HOUR}; missing or out of range reads as 0. */
  dayEndsAtHour?: number | null;
};

/** Whether `value` is an hour a branch's day may end at. */
export function isPharmacyDayEndHour(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= PHARMACY_DEFAULT_DAY_END_HOUR &&
    value <= PHARMACY_MAX_DAY_END_HOUR
  );
}

/** The stored hour as one the helpers use: a missing or refused value is midnight. */
export function pharmacyDayEndHour(value: number | null | undefined): number {
  return isPharmacyDayEndHour(value) ? value : PHARMACY_DEFAULT_DAY_END_HOUR;
}

/**
 * The day-end hour a window over several branches uses. Branches that share an hour (every
 * branch, until an owner sets one) use it, so the window agrees with each branch's day close.
 * When they end their days at different hours no one window matches all of them: it falls back
 * to midnight, the organisation's calendar day, and `mixed` says so. One branch always gives
 * that branch's own days.
 */
export function sharedPharmacyDayEndHour(hours: readonly (number | null | undefined)[]): {
  dayEndsAtHour: number;
  mixed: boolean;
} {
  const distinct = new Set(hours.map(pharmacyDayEndHour));
  if (distinct.size > 1) return { dayEndsAtHour: PHARMACY_DEFAULT_DAY_END_HOUR, mixed: true };
  return { dayEndsAtHour: [...distinct][0] ?? PHARMACY_DEFAULT_DAY_END_HOUR, mixed: false };
}

/**
 * The hour as a field to spread into a reader's filters: none at midnight, so a branch on the
 * default passes exactly the filters it passed before DEV-958A.
 */
export function pharmacyDayEndHourField(value: number | null | undefined): {
  dayEndsAtHour?: number;
} {
  const hour = pharmacyDayEndHour(value);
  return hour === PHARMACY_DEFAULT_DAY_END_HOUR ? {} : { dayEndsAtHour: hour };
}

/** "Midnight" or "5:00 AM": the hour as the owner reads it. */
export function pharmacyDayEndLabel(value: number | null | undefined): string {
  const hour = pharmacyDayEndHour(value);
  return hour === 0 ? 'Midnight' : `${hour}:00 AM`;
}

/**
 * The business day (`YYYY-MM-DD`) the instant `at` belongs to on the branch's clock. Before the
 * day-end hour on the shop's clock it is still the previous calendar day.
 */
export function pharmacyBusinessDay(clock: PharmacyDayClock, at: Date = new Date()): string {
  const hour = pharmacyDayEndHour(clock.dayEndsAtHour);
  if (hour === PHARMACY_DEFAULT_DAY_END_HOUR) return workspaceToday(clock.timeZone, at);
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
 * report's default "last 30 days" and "up to tomorrow" bounds. Plain calendar arithmetic on
 * the day's name, so it is the same whatever the hour.
 */
export function pharmacyBusinessDayOffset(
  clock: PharmacyDayClock,
  days: number,
  now: Date = new Date()
): string {
  const today = Date.parse(`${pharmacyBusinessDay(clock, now)}T00:00:00.000Z`);
  return new Date(today + days * 86_400_000).toISOString().slice(0, 10);
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
 * The first instant of business day `day` on the branch's clock: shop midnight by default, or
 * the day-end hour of that calendar date. Found by bisection over {@link pharmacyBusinessDay}
 * itself, so a window and the day an instant is booked on can never disagree, whatever
 * daylight-saving change falls nearby.
 */
function pharmacyBusinessDayStart(day: number, clock: PharmacyDayClock): Date {
  const hour = pharmacyDayEndHour(clock.dayEndsAtHour);
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
 * `< to`. With the default hour this is exactly {@link workspaceDateRange}.
 */
export function pharmacyBusinessDayRange(
  from: string,
  to: string,
  clock: PharmacyDayClock
): { from: Date; to: Date } {
  if (pharmacyDayEndHour(clock.dayEndsAtHour) === PHARMACY_DEFAULT_DAY_END_HOUR)
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
