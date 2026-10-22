import { z } from 'zod';

/**
 * Whether this runtime's Intl accepts `value` as a time zone: an IANA name such
 * as "Asia/Karachi", or "UTC". Intl refuses an abbreviation or a loose offset
 * ("PKT", "UTC+5"), and so does this.
 */
export function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

/** A time zone a form or a platform command may store: the platform's and the workspace profile's check. */
export const ianaTimezone = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => isIanaTimezone(value), 'Choose a valid IANA timezone.');

/**
 * A stored workspace zone as one Intl can format in: UTC when it is missing or
 * when this runtime refuses it (a value saved before the profile checked it, or
 * a zone an older browser does not know), so a screen that shows times or picks
 * a day in it never throws. Server and browser both apply it.
 */
export function workspaceTimezone(value: string | null | undefined): string {
  return value && isIanaTimezone(value) ? value : 'UTC';
}

/**
 * Today in the workspace's zone ({@link workspaceTimezone}), as a date input's
 * `YYYY-MM-DD` value: the business day the counter stamps and the day close
 * opens on.
 */
export function workspaceToday(timeZone: string | null | undefined, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: workspaceTimezone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** UTC instants bounding the calendar month that contains `now` in the workspace zone. */
export function workspaceMonthRange(
  timeZone: string | null | undefined,
  now = new Date()
): { start: Date; end: Date } {
  const zone = workspaceTimezone(timeZone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(now);
  const value = (type: 'year' | 'month') =>
    Number(parts.find((part) => part.type === type)?.value);
  const year = value('year');
  const month = value('month');

  const midnightUtc = (wallYear: number, wallMonth: number) => {
    const wall = Date.UTC(wallYear, wallMonth - 1, 1);
    let instant = wall;
    // Two passes resolve the zone offset at the target instant (including DST zones).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const targetParts = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
        hourCycle: 'h23',
      }).formatToParts(new Date(instant));
      const number = (type: Intl.DateTimeFormatPartTypes) =>
        Number(targetParts.find((part) => part.type === type)?.value);
      const displayedAsUtc = Date.UTC(
        number('year'),
        number('month') - 1,
        number('day'),
        number('hour'),
        number('minute'),
        number('second')
      );
      instant = wall - (displayedAsUtc - instant);
    }
    return new Date(instant);
  };

  return {
    start: midnightUtc(year, month),
    end: month === 12 ? midnightUtc(year + 1, 1) : midnightUtc(year, month + 1),
  };
}
