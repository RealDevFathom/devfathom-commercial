/**
 * M3-L3 / C5 — server-side menu availability evaluator.
 *
 * Availability windows are stored as branch-local wall-clock values
 * (`startMinutes`/`endMinutes`, minutes-of-day) plus a day-of-week set, and are
 * evaluated here against the branch's IANA timezone — client-supplied time is
 * untrusted (C5). All timezone math goes through `Intl.DateTimeFormat`, so DST
 * transitions (spring-forward gaps and fall-back repeats) and historical offset
 * rules fall out of the platform tz database rather than being re-derived.
 *
 * The module performs no I/O: the caller loads a publication's windows and
 * exceptions and passes them in, so the whole daypart/exception/channel decision
 * lives in one pure, unit-testable place (the same discipline as
 * `effective-dating.ts`). Local shapes mirror the Prisma rows but stay
 * independent of the generated client.
 *
 * Non-obvious semantics (documented once, tested):
 * - An empty `daysOfWeek` means "every day" (an unrestricted daypart).
 * - A window layer with NO windows imposes no restriction (open); a layer with
 *   windows is open only inside one of them. Item-level and publication-level
 *   window layers are ANDed (an item is available only when both layers are open).
 * - A window is half-open `[startMinutes, endMinutes)`; a cross-midnight window
 *   has `endMinutes <= startMinutes` and its early-morning tail belongs to the
 *   PREVIOUS calendar day for the day-of-week test.
 * - An availability exception overrides the whole publication for its branch-local
 *   date: `isClosed` forces closed, `!isClosed` forces open (regardless of windows).
 * - An empty publication `channels` set means "published on every operational channel".
 */

import { isOperationalOrderChannel, type OrderChannel } from './order-channels';

export type { OrderChannel } from './order-channels';

/** A publication- or item-scoped availability window (branch-local wall clock). */
export type AvailabilityWindow = {
  /** 0=Sunday .. 6=Saturday; empty = every day. */
  daysOfWeek: readonly number[];
  /** Inclusive start, minutes since local midnight [0, 1440). */
  startMinutes: number;
  /** Exclusive end; a value `<= startMinutes` marks a cross-midnight window. */
  endMinutes: number;
  /** null/absent = whole-publication window; otherwise scoped to this menu item. */
  menuItemId?: string | null;
};

/** A publication-owned exception for a single branch-local calendar date. */
export type AvailabilityException = {
  /** The branch-local calendar date (a Prisma `@db.Date`, i.e. UTC-midnight). */
  date: Date;
  /** true closes an otherwise-open date; false opens an otherwise-closed one. */
  isClosed: boolean;
};

/** The branch-local wall-clock resolution of a UTC instant. */
export type LocalWallClock = {
  /** `YYYY-MM-DD` in the branch timezone. */
  dateKey: string;
  /** 0=Sunday .. 6=Saturday for the local calendar date. */
  dayOfWeek: number;
  /** Minutes since local midnight [0, 1440). */
  minutes: number;
};

export const MINUTES_PER_DAY = 24 * 60;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Resolve a UTC `at` instant to branch-local wall-clock fields via `Intl`. Using
 * `hourCycle: 'h23'` yields hours 0..23 (never a locale-dependent "24"), and the
 * day-of-week is derived from the extracted Y-M-D through a UTC-midnight Date so
 * it never depends on locale weekday strings. Because the offset comes from the
 * tz database, a nonexistent spring-forward wall time is simply never produced,
 * and a repeated fall-back wall time is produced for both underlying instants.
 */
export function resolveLocalWallClock(timezone: string, at: Date): LocalWallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);

  const field: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') field[part.type] = part.value;
  }

  const year = Number(field.year);
  const month = Number(field.month);
  const day = Number(field.day);
  // `h23` can still surface "24" for local midnight on some ICU builds; fold it.
  const hour = Number(field.hour) % 24;
  const minute = Number(field.minute);

  return {
    dateKey: `${year}-${pad2(month)}-${pad2(day)}`,
    dayOfWeek: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    minutes: hour * 60 + minute,
  };
}

/** A `@db.Date` comes back as a UTC-midnight Date; key it by its UTC calendar fields. */
function exceptionDateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function dayIncluded(daysOfWeek: readonly number[], dayOfWeek: number): boolean {
  return daysOfWeek.length === 0 || daysOfWeek.includes(dayOfWeek);
}

/**
 * Does `window` cover the given branch-local instant? Same-day windows match the
 * half-open range `[start, end)` on a day in `daysOfWeek`. A cross-midnight
 * window (`end <= start`) matches its late-night tail `[start, 1440)` on today's
 * day-of-week and its early-morning tail `[0, end)` against the PREVIOUS day —
 * so a "Fri 22:00–02:00" window is open at Sat 01:00 iff Friday is selected.
 */
export function windowMatches(window: AvailabilityWindow, local: LocalWallClock): boolean {
  const { startMinutes, endMinutes, daysOfWeek } = window;
  const crossesMidnight = endMinutes <= startMinutes;

  if (!crossesMidnight) {
    if (local.minutes < startMinutes || local.minutes >= endMinutes) return false;
    return dayIncluded(daysOfWeek, local.dayOfWeek);
  }

  if (local.minutes >= startMinutes) {
    return dayIncluded(daysOfWeek, local.dayOfWeek);
  }
  if (local.minutes < endMinutes) {
    const previousDay = (local.dayOfWeek + 6) % 7;
    return dayIncluded(daysOfWeek, previousDay);
  }
  return false;
}

/** A window layer is open when it has no windows, or when any window matches. */
function layerOpen(windows: readonly AvailabilityWindow[], local: LocalWallClock): boolean {
  if (windows.length === 0) return true;
  return windows.some((window) => windowMatches(window, local));
}

export type AvailabilityInput = {
  timezone: string;
  at: Date;
  /** Whole-publication windows (menuItemId == null). */
  publicationWindows: readonly AvailabilityWindow[];
  /** Windows scoped to the item being evaluated. */
  itemWindows: readonly AvailabilityWindow[];
  exceptions: readonly AvailabilityException[];
};

/**
 * Evaluate whether a menu item is available at `at`, in the branch timezone.
 * Exceptions win first (a closed date closes everything; an open date opens
 * everything). Otherwise the publication-level and item-level window layers must
 * both be open. Time is derived server-side from the branch timezone (C5).
 */
export function isItemAvailableAt(input: AvailabilityInput): boolean {
  const local = resolveLocalWallClock(input.timezone, input.at);

  const exception = input.exceptions.find((e) => exceptionDateKey(e.date) === local.dateKey);
  if (exception) return !exception.isClosed;

  return layerOpen(input.publicationWindows, local) && layerOpen(input.itemWindows, local);
}

/**
 * Channel filter (D06). DELIVERY always fails closed. An empty `channels` set
 * means every operational channel; otherwise the requested channel must be listed.
 */
export function channelPublished(
  channels: readonly OrderChannel[],
  channel: OrderChannel
): boolean {
  if (!isOperationalOrderChannel(channel)) return false;
  return channels.length === 0 || channels.includes(channel);
}

/** Split a publication's windows into the publication-level and item-level layers. */
export function partitionWindows(
  windows: readonly AvailabilityWindow[],
  menuItemId: string
): { publicationWindows: AvailabilityWindow[]; itemWindows: AvailabilityWindow[] } {
  const publicationWindows: AvailabilityWindow[] = [];
  const itemWindows: AvailabilityWindow[] = [];
  for (const window of windows) {
    if (window.menuItemId == null) publicationWindows.push(window);
    else if (window.menuItemId === menuItemId) itemWindows.push(window);
  }
  return { publicationWindows, itemWindows };
}
