/**
 * M4-L1 / C5 — business-date resolution.
 *
 * The restaurant "business date" is the operating day an order belongs to. It is
 * NOT the UTC calendar date and it is NOT recomputed later from a UTC timestamp
 * (§11.1): it is stamped ONCE, at order creation, from the branch's timezone and
 * its `businessDayCutoff` wall-clock time. A branch that closes at 02:00 wants a
 * 01:30 order to count against the day that just ended, not the new calendar day.
 *
 * This module is pure and `Intl`-based. It converts a server instant to the
 * branch-local wall clock using the IANA timezone (so DST spring-forward and
 * fall-back are handled by the platform's tz database, not by manual offset
 * math), then rolls the local calendar date back by one day when the local time
 * of day is before the cutoff. The result is a canonical `YYYY-MM-DD` string; a
 * companion helper turns it into the UTC-midnight `Date` that Prisma stores in a
 * `@db.Date` column.
 *
 * Client time is untrusted (C5/C6): callers pass the SERVER instant.
 */

/** Raised when a cutoff string is not a valid 24h `HH:MM` wall-clock time. */
export class BusinessDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BusinessDateError';
  }
}

const CUTOFF_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The conservative default cutoff — midnight, i.e. the business date equals the
 * branch-local calendar date (mirrors the `RestaurantBranch.businessDayCutoff`
 * column default of "00:00"). */
export const DEFAULT_BUSINESS_DAY_CUTOFF = '00:00';

/** Parse a `HH:MM` cutoff into minutes-of-day (0..1439). Throws on a malformed
 * value rather than guessing. */
export function parseCutoffMinutes(cutoff: string): number {
  const match = CUTOFF_PATTERN.exec(cutoff);
  if (!match) {
    throw new BusinessDateError(
      `Invalid businessDayCutoff "${cutoff}"; expected a 24-hour "HH:MM" wall-clock time.`
    );
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

/** The branch-local wall-clock parts of a server instant, evaluated in the
 * branch's IANA timezone (DST-correct). */
type LocalParts = {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  minutesOfDay: number; // 0..1439
};

function localPartsInTimeZone(instant: Date, timeZone: string): LocalParts {
  let parts: Intl.DateTimeFormatPart[];
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    parts = formatter.formatToParts(instant);
  } catch (error) {
    throw new BusinessDateError(
      `Invalid branch timezone "${timeZone}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const lookup = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value === undefined ? Number.NaN : Number(value);
  };
  const year = lookup('year');
  const month = lookup('month');
  const day = lookup('day');
  // hourCycle 'h23' renders midnight as 00; guard the historical '24' quirk.
  const hour = lookup('hour') % 24;
  const minute = lookup('minute');
  if ([year, month, day, hour, minute].some((value) => Number.isNaN(value))) {
    throw new BusinessDateError(`Could not resolve branch-local time in timezone "${timeZone}".`);
  }
  return { year, month, day, minutesOfDay: hour * 60 + minute };
}

/** Format a `Date` as a UTC `YYYY-MM-DD` string. Used to name the calendar date
 * after any day-rollback arithmetic (done in the UTC domain to stay DST-agnostic
 * once we already hold local calendar parts). */
function formatUtcDate(date: Date): string {
  const year = date.getUTCFullYear().toString().padStart(4, '0');
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Resolve the business date (`YYYY-MM-DD`) for a server instant, given the
 * branch's IANA `timeZone` and `HH:MM` `businessDayCutoff`.
 *
 * The instant is projected to the branch-local wall clock; if the local time of
 * day is at or after the cutoff the business date is the local calendar date,
 * otherwise it is the previous calendar day (the day that has not yet "closed").
 * A "00:00" cutoff therefore makes the business date equal the local calendar
 * date. DST transitions are handled by `Intl` — the local parts already reflect
 * the correct offset at the instant, so a spring-forward gap or a fall-back
 * repeat never shifts the resolved date.
 */
export function resolveBusinessDate(
  instant: Date,
  timeZone: string,
  businessDayCutoff: string = DEFAULT_BUSINESS_DAY_CUTOFF
): string {
  if (Number.isNaN(instant.getTime())) {
    throw new BusinessDateError('resolveBusinessDate requires a valid server instant.');
  }
  const cutoffMinutes = parseCutoffMinutes(businessDayCutoff);
  const local = localPartsInTimeZone(instant, timeZone);
  // Anchor the local calendar date in the UTC domain so date arithmetic (the
  // day rollback) is plain and DST-free — we are past timezone conversion now.
  const anchor = new Date(Date.UTC(local.year, local.month - 1, local.day));
  if (local.minutesOfDay < cutoffMinutes) {
    anchor.setUTCDate(anchor.getUTCDate() - 1);
  }
  return formatUtcDate(anchor);
}

/**
 * Convert a `YYYY-MM-DD` business-date string to the UTC-midnight `Date` that
 * Prisma persists into a `@db.Date` column. Round-trips with
 * {@link resolveBusinessDate}.
 */
export function businessDateToUtcDate(businessDate: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate);
  if (!match) {
    throw new BusinessDateError(`Invalid business date "${businessDate}"; expected "YYYY-MM-DD".`);
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  // Reject impossible calendar dates (e.g. 2026-02-30 normalises to March).
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new BusinessDateError(`Invalid calendar date "${businessDate}".`);
  }
  return date;
}
