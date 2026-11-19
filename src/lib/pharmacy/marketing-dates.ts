import { wallClockToInstant } from '@/lib/meetings/recurrence';
import { workspaceTimezone } from '@/lib/timezone';
import { pharmacyCalendarDay } from '@/lib/pharmacy/business-day';

/**
 * Marketing forms ask owners for calendar days and local times in the workspace zone, never
 * UTC instants. These helpers turn those plain-language inputs into the UTC instants the
 * server-side period and schedule checks already validate. A value that already carries an
 * explicit offset (`…Z`, `+05:00`) is read as that instant, unchanged.
 */
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function wall(match: RegExpExecArray | null, timeZone: string, dayOffset = 0): Date | null {
  if (!match) return null;
  const [year, month, day, hour = 0, minute = 0, second = 0] = match
    .slice(1)
    .map((part) => (part === undefined ? undefined : Number(part)));
  // Reject impossible calendar values (2026-02-31) instead of letting Date roll them over.
  const exact = new Date(Date.UTC(year!, month! - 1, day!));
  if (exact.getUTCMonth() + 1 !== month || exact.getUTCDate() !== day) return new Date(Number.NaN);
  if (hour > 23 || minute > 59 || second > 59) return new Date(Number.NaN);
  const probe = new Date(Date.UTC(year!, month! - 1, day! + dayOffset));
  return wallClockToInstant(
    {
      year: probe.getUTCFullYear(),
      month: probe.getUTCMonth() + 1,
      day: probe.getUTCDate(),
      hour,
      minute,
      second,
      millisecond: 0,
    },
    workspaceTimezone(timeZone)
  );
}

/** Start of a `YYYY-MM-DD` calendar day in the workspace zone. */
export function localDayStart(value: string, timeZone: string): Date {
  return wall(DAY.exec(value.trim()), timeZone) ?? new Date(value);
}

/** Start of the day after an inclusive `YYYY-MM-DD` last day: the exclusive cutoff. */
export function localDayAfter(value: string, timeZone: string): Date {
  return wall(DAY.exec(value.trim()), timeZone, 1) ?? new Date(Number.NaN);
}

/** A `datetime-local` value (`YYYY-MM-DDTHH:mm`) read as wall-clock time in the workspace zone. */
export function localDateTime(value: string, timeZone: string): Date {
  return wall(LOCAL.exec(value.trim()), timeZone) ?? new Date(value);
}

/** Whether an instant is the start of its calendar day in the workspace zone. */
export function isLocalMidnight(value: Date, timeZone: string): boolean {
  if (!Number.isFinite(value.getTime())) return false;
  return (
    localDayStart(pharmacyCalendarDay(timeZone, value), timeZone).getTime() === value.getTime()
  );
}

/**
 * Whole calendar days between two local-midnight bounds in the workspace zone, so a range that
 * crosses a daylight-saving change still counts as the days the owner chose. `null` when either
 * bound is not a local midnight; callers then keep their elapsed-time rules.
 */
export function localCalendarDays(from: Date, cutoff: Date, timeZone: string): number | null {
  if (!isLocalMidnight(from, timeZone) || !isLocalMidnight(cutoff, timeZone)) return null;
  const day = (value: Date) => Date.parse(`${pharmacyCalendarDay(timeZone, value)}T00:00:00Z`);
  return Math.round((day(cutoff) - day(from)) / 86_400_000);
}

/** Calendar arithmetic on `YYYY-MM-DD` strings. */
export function shiftDay(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, date! + days)).toISOString().slice(0, 10);
}

/** The latest `days` completed calendar days in the workspace zone, ending yesterday. */
export function recentCompletedDays(timeZone: string, days: number, now = new Date()) {
  const lastDay = shiftDay(pharmacyCalendarDay(timeZone, now), -1);
  return { firstDay: shiftDay(lastDay, -(days - 1)), lastDay };
}

/** A short, owner-readable name for the workspace zone. */
export function timeZoneLabel(timeZone: string): string {
  const zone = workspaceTimezone(timeZone);
  if (zone === 'Asia/Karachi') return 'Pakistan time (PKT)';
  return zone === 'UTC' ? 'UTC' : zone.replaceAll('_', ' ');
}

function localParts(value: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: workspaceTimezone(timeZone),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(value)
      .map((part) => [part.type, part.value])
  );
  return parts as Record<'year' | 'month' | 'day' | 'hour' | 'minute', string>;
}

/** A saved instant as a `datetime-local` value in the workspace zone; empty when unknown. */
export function localInputValue(value: Date | string | null | undefined, timeZone: string) {
  if (!value) return '';
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return '';
  const p = localParts(instant, timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** A saved instant as an owner-readable local date and time, e.g. `7 Oct 2026, 12:00`. */
export function localDateTimeLabel(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: workspaceTimezone(timeZone),
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(value);
}
