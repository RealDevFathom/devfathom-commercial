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
 * The workspace zone as the owner reads it beside a date range: "PKT" for
 * Asia/Karachi, as {@link formatWorkspaceDateTime} names it; any other zone by
 * its IANA name ("UTC", "Europe/London"), which, unlike a seasonal abbreviation
 * such as GMT or BST, is right for every date a range can cover.
 */
export function workspaceZoneLabel(timeZone: string | null | undefined): string {
  const zone = workspaceTimezone(timeZone);
  return zone === 'Asia/Karachi' ? 'PKT' : zone;
}

/**
 * The first instant of the calendar date `day` (given as that date's UTC-midnight
 * milliseconds) on the clock of a valid IANA `zone`: usually local midnight, or
 * the end of a daylight-saving gap that swallows midnight. Every zone's offset
 * lies within ±15 hours, so the local date is still the day before at `day`
 * − 15 h and has reached it by `day` + 15 h; a binary search between them finds
 * the boundary to the millisecond, whatever transitions fall nearby.
 */
function workspaceDayStart(day: number, zone: string): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  // The local calendar date of an instant, as the UTC-midnight milliseconds of that date:
  // numbers compare correctly for every year, where `YYYY-MM-DD` strings stop at 9999.
  const localDay = (instant: number) => {
    const field = Object.fromEntries(
      parts.formatToParts(new Date(instant)).map((part) => [part.type, Number(part.value)])
    );
    const date = new Date(0);
    date.setUTCFullYear(field.year!, field.month! - 1, field.day!);
    return date.getTime();
  };
  let before = day - 15 * 3_600_000;
  let reached = day + 15 * 3_600_000;
  while (reached - before > 1) {
    const middle = before + Math.floor((reached - before) / 2);
    if (localDay(middle) < day) before = middle;
    else reached = middle;
  }
  return new Date(reached);
}

/**
 * The instants bounding the inclusive workspace dates `from`..`to`: the start
 * of `from` and the start of the day after `to`, both on the workspace clock
 * ({@link workspaceTimezone}). Filter event timestamps with `>= from` and `< to`.
 */
export function workspaceDateRange(
  from: string,
  to: string,
  timeZone: string | null | undefined
): { from: Date; to: Date } {
  const zone = workspaceTimezone(timeZone);
  return {
    from: workspaceDayStart(Date.parse(`${from}T00:00:00.000Z`), zone),
    to: workspaceDayStart(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000, zone),
  };
}
