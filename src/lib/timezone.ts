import { z } from 'zod';

import { zonedWallTimeToUtc } from '@/lib/restaurant/sop-recurrence';

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

/**
 * An instant as the owner reads it on the workspace's wall clock, with the zone
 * named: "3 Nov 2026, 6:24 PM PKT". Pakistan's zone is named PKT (Intl only
 * offers "GMT+5" for it); any other zone uses Intl's short name.
 */
export function formatWorkspaceDateTime(
  value: Date | string,
  timeZone: string | null | undefined
): string {
  const zone = workspaceTimezone(timeZone);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    })
      .formatToParts(new Date(value))
      .map((part) => [part.type, part.value])
  );
  const label = zone === 'Asia/Karachi' ? 'PKT' : parts.timeZoneName;
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${label}`;
}

/**
 * The instants bounding the inclusive workspace dates `from`..`to`: midnight
 * starting `from` and midnight after `to`, both on the workspace clock
 * ({@link workspaceTimezone}). Filter event timestamps with `>= from` and `< to`.
 */
export function workspaceDateRange(
  from: string,
  to: string,
  timeZone: string | null | undefined
): { from: Date; to: Date } {
  const zone = workspaceTimezone(timeZone);
  const dayAfter = new Date(`${to}T00:00:00.000Z`);
  dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
  return {
    from: zonedWallTimeToUtc(from, 0, zone).instant,
    to: zonedWallTimeToUtc(dayAfter.toISOString().slice(0, 10), 0, zone).instant,
  };
}
