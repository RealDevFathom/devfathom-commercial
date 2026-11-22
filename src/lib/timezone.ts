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
 * The calendar date of an instant on the workspace's wall clock, as the owner
 * reads it: "1 Nov 2026". 00:30 in Karachi on 1 Nov (19:30 UTC on 31 Oct) is
 * 1 Nov. An invalid value reads as an em dash rather than throwing.
 */
export function formatWorkspaceDate(
  value: Date | string,
  timeZone: string | null | undefined
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: workspaceTimezone(timeZone),
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
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

/** Milliseconds the zone's wall clock is ahead of UTC at `instant`. */
function zoneOffsetMs(instant: number, zone: string): number {
  const field = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, Number(part.value)])
  );
  const wall = new Date(0);
  wall.setUTCFullYear(field.year!, field.month! - 1, field.day!);
  wall.setUTCHours(field.hour!, field.minute!, field.second!, 0);
  return wall.getTime() - Math.floor(instant / 1000) * 1000;
}

const MINUTE_INPUT = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/;

/**
 * A `datetime-local` picker value (`2026-05-01T09:30`, no zone) read on the
 * workspace's wall clock, as an ISO instant. A value that already carries a
 * zone, or is not a picker value, passes through unchanged.
 */
export function workspaceInstantFromInput(
  raw: string,
  timeZone: string | null | undefined
): string {
  const match = MINUTE_INPUT.exec(raw);
  if (!match) return raw;
  const zone = workspaceTimezone(timeZone);
  const naive = Date.parse(`${match[1]}T${match[2]}:${match[3] ?? '00'}.000Z`);
  if (!Number.isFinite(naive)) return raw;
  let instant = naive - zoneOffsetMs(naive, zone);
  instant = naive - zoneOffsetMs(instant, zone);
  return new Date(instant).toISOString().replace('.000Z', 'Z');
}

/** The `datetime-local` value for an instant on the workspace clock; empty when invalid. */
export function workspaceMinuteInput(
  value: Date | string,
  timeZone: string | null | undefined
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const zone = workspaceTimezone(timeZone);
  return new Date(date.getTime() + zoneOffsetMs(date.getTime(), zone)).toISOString().slice(0, 16);
}

/**
 * The workspace's today shifted by whole calendar days, as `YYYY-MM-DD`. Counting
 * calendar days (not 24-hour periods) keeps a default window the same length
 * across a daylight-saving change.
 */
export function workspaceDateOffset(
  timeZone: string | null | undefined,
  days: number,
  now = new Date()
): string {
  const today = Date.parse(`${workspaceToday(timeZone, now)}T00:00:00.000Z`);
  return new Date(today + days * 86_400_000).toISOString().slice(0, 10);
}

/** Resolve a calendar month relative to the workspace's current month, including DST changes. */
export function workspaceMonthRange(timeZone: string | null | undefined, at: Date, offset = 0) {
  const [year, month] = workspaceToday(timeZone, at).split('-').map(Number);
  const first = new Date(Date.UTC(year!, month! - 1 + offset, 1)).toISOString().slice(0, 10);
  const last = new Date(Date.UTC(year!, month! + offset, 0)).toISOString().slice(0, 10);
  return workspaceDateRange(first, last, timeZone);
}
