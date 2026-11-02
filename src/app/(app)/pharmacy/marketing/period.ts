import { wallClockToInstant } from '@/lib/meetings/recurrence';
import { workspaceTimezone, workspaceToday } from '@/lib/timezone';

/**
 * DEV-591: owners pick whole days and local send times in the workspace zone
 * (Asia/Karachi for pharmacy tenants). The server keeps taking instants: a
 * period is `from` (midnight opening the first day) to an exclusive `cutoff`
 * (midnight after the last day). The conversion lives here, once, so the forms
 * never ask for UTC, ISO strings or "exclusive" boundaries.
 */
export const MAX_PERIOD_DAYS = 90;
export const DEFAULT_PERIOD_DAYS = 30;
const DAY_MS = 86_400_000;

type CalendarDay = { year: number; month: number; day: number };

function parseDay(value: string): CalendarDay | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  )
    return null;
  return { year, month, day };
}

const dayNumber = ({ year, month, day }: CalendarDay) => Date.UTC(year, month - 1, day) / DAY_MS;

/** A `YYYY-MM-DD` value moved by whole calendar days. */
export function shiftDay(value: string, days: number): string {
  const day = parseDay(value);
  if (!day) throw new RangeError(`Not a calendar day: ${value}`);
  return new Date(Date.UTC(day.year, day.month - 1, day.day + days)).toISOString().slice(0, 10);
}

function zonedInstant(day: CalendarDay, hour: number, minute: number, timeZone: string): Date {
  return wallClockToInstant(
    { ...day, hour, minute, second: 0, millisecond: 0 },
    workspaceTimezone(timeZone)
  );
}

/** The last `days` days that have ended in the workspace zone, ending yesterday. */
export function defaultDayRange(
  timeZone: string,
  now = new Date(),
  days = DEFAULT_PERIOD_DAYS
): { firstDay: string; lastDay: string } {
  const lastDay = shiftDay(workspaceToday(timeZone, now), -1);
  return { firstDay: shiftDay(lastDay, 1 - days), lastDay };
}

/** Default send time: tomorrow at 10:00 in the workspace zone, outside default quiet hours. */
export function defaultSendTime(timeZone: string, now = new Date()): string {
  return `${shiftDay(workspaceToday(timeZone, now), 1)}T10:00`;
}

export type DayPeriod = { ok: true; from: Date; cutoff: Date } | { ok: false; message: string };

/**
 * Whole days in `timeZone` as the server's period. 1–30 October 2026 in
 * Asia/Karachi (UTC+05:00) is `from` 2026-09-30T19:00:00Z and `cutoff`
 * 2026-10-30T19:00:00Z. The last day must already be over.
 */
export function dayRangeToPeriod(
  firstDay: string,
  lastDay: string,
  timeZone: string,
  now = new Date()
): DayPeriod {
  if (!firstDay.trim() || !lastDay.trim())
    return { ok: false, message: 'Choose a first day and a last day.' };
  const first = parseDay(firstDay);
  const last = parseDay(lastDay);
  if (!first || !last)
    return { ok: false, message: 'Enter each day as a calendar date, for example 2026-10-01.' };
  const days = dayNumber(last) - dayNumber(first) + 1;
  if (days < 1) return { ok: false, message: 'The last day must be on or after the first day.' };
  if (days > MAX_PERIOD_DAYS)
    return { ok: false, message: `Choose ${MAX_PERIOD_DAYS} days or fewer.` };
  const from = zonedInstant(first, 0, 0, timeZone);
  const cutoff = zonedInstant(parseDay(shiftDay(lastDay, 1))!, 0, 0, timeZone);
  if (cutoff > now)
    return {
      ok: false,
      message: 'The last day must already be over. Choose yesterday or an earlier day.',
    };
  return { ok: true, from, cutoff };
}

/** A `datetime-local` value (`YYYY-MM-DDTHH:mm`) read as wall time in `timeZone`. */
export function localDateTimeToInstant(value: string, timeZone: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(value.trim());
  const day = match ? parseDay(match[1]!) : null;
  if (!match || !day) return null;
  const [hour, minute] = [Number(match[2]), Number(match[3])];
  if (hour > 23 || minute > 59) return null;
  return zonedInstant(day, hour, minute, timeZone);
}

/** A saved instant as `YYYY-MM-DD HH:mm` in `timeZone`; an unreadable value is shown as stored. */
export function localTime(value: Date | string, timeZone: string): string {
  const instant = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(instant.getTime())
    ? String(value)
    : instantToLocalDateTime(instant, timeZone).replace('T', ' ');
}

/** The zone as an owner reads it: "Pakistan Standard Time", or the IANA name / "UTC". */
export function zoneLabel(timeZone: string, now = new Date()): string {
  const zone = workspaceTimezone(timeZone);
  if (zone === 'UTC') return 'UTC';
  // The generic name follows the zone's history, so read it for today, not the epoch.
  const name = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'longGeneric' })
    .formatToParts(now)
    .find((part) => part.type === 'timeZoneName')?.value;
  return name && !name.startsWith('GMT') ? name : zone;
}

/** An instant as `YYYY-MM-DDTHH:mm` wall time in `timeZone`, for a `datetime-local` value. */
export function instantToLocalDateTime(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: workspaceTimezone(timeZone),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}
