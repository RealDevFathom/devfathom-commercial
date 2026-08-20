/**
 * M7-L3 / §SOP — structured SOP recurrence evaluated in the branch timezone.
 *
 * There is NO RRULE library. A recurrence is a small structured rule
 * (DAILY / WEEKLY / MONTHLY / ONCE + an interval + weekday / month-day selectors
 * + a local wall-clock due time) anchored on a `startDate`. Selection happens in
 * the branch-local calendar; the due *instant* is the local wall clock projected
 * to UTC through the branch's IANA timezone, so daylight-saving transitions are
 * handled by the platform tz database rather than manual offset math.
 *
 * This module is PURE and `Intl`-based — no DB, no `server-only`, no dependence
 * on the process's local timezone (every projection passes an explicit IANA
 * `timeZone`; date arithmetic is done in the UTC domain via `Date.UTC`). That is
 * what lets the occurrence generator, the schedule-preview endpoint, and the unit
 * tests all agree on exact UTC instants.
 *
 * DST policy (§SOP): wall-clock is preserved. When the requested local time does
 * not exist (spring-forward gap) the due instant is the NEXT valid instant — the
 * transition boundary where the skipped interval ends. When the requested local
 * time exists twice (fall-back ambiguity) the due instant is the FIRST (earlier)
 * of the two.
 */

/** Mirrors the `RestaurantSopRecurrenceFrequency` Prisma enum. */
export type RecurrenceFrequency = 'ONCE' | 'DAILY' | 'WEEKLY' | 'MONTHLY';

/** How the branch-local due time landed relative to a DST transition. */
export type DstAdjustment = 'none' | 'spring-forward' | 'fall-back';

/**
 * A structured recurrence rule. Dates are branch-local calendar dates
 * (`YYYY-MM-DD`); `dueTimeMinutes` is a branch-local wall-clock minutes-of-day
 * (0..1439). `daysOfWeek` uses 0=Sunday..6=Saturday (matching `Date#getUTCDay`).
 */
export type RecurrenceRule = {
  frequency: RecurrenceFrequency;
  /** Every Nth day/week/month. Integer >= 1. */
  interval: number;
  /** WEEKLY selector; 0=Sun..6=Sat. Empty → the weekday of `startDate`. */
  daysOfWeek: number[];
  /** MONTHLY selector, 1..31 (clamped to the month's last day). Null → the day of `startDate`. */
  monthDay: number | null;
  /** Inclusive branch-local start date, `YYYY-MM-DD`. */
  startDate: string;
  /** Inclusive branch-local end date, `YYYY-MM-DD`, or null for open-ended. */
  endDate: string | null;
  /** Branch-local wall-clock due time, minutes-of-day 0..1439. */
  dueTimeMinutes: number;
  /** Completion-window length in minutes (>= 0); `windowEndsAt = dueAt + this`. */
  windowMinutes: number;
};

/** One materialised occurrence instant produced by the recurrence. */
export type RecurrenceOccurrence = {
  /** The branch-local calendar date the occurrence belongs to, `YYYY-MM-DD`. */
  businessDate: string;
  /** The UTC instant the SOP is due (branch-local `dueTimeMinutes`, DST-resolved). */
  dueAt: Date;
  /** `dueAt + windowMinutes`. */
  windowEndsAt: Date;
  /** Whether a DST transition shifted `dueAt` off the naive wall clock. */
  adjustment: DstAdjustment;
};

export class RecurrenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecurrenceError';
  }
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A safety bound on how many local days a single enumeration may scan, so an
 * open-ended rule with a huge caller range can never loop unbounded. ~10 years.
 */
export const MAX_ENUMERATION_DAYS = 3_700;

type YmD = { year: number; month: number; day: number };

/** Parse and validate a `YYYY-MM-DD` string, rejecting impossible calendar dates. */
function parseDate(dateISO: string): YmD {
  const match = DATE_PATTERN.exec(dateISO);
  if (!match) {
    throw new RecurrenceError(`Invalid date "${dateISO}"; expected "YYYY-MM-DD".`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const anchor = new Date(Date.UTC(year, month - 1, day));
  if (
    anchor.getUTCFullYear() !== year ||
    anchor.getUTCMonth() !== month - 1 ||
    anchor.getUTCDate() !== day
  ) {
    throw new RecurrenceError(`Invalid calendar date "${dateISO}".`);
  }
  return { year, month, day };
}

/** Whole UTC-day index for a calendar date (DST-free date arithmetic anchor). */
function dayIndex({ year, month, day }: YmD): number {
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

/** `YYYY-MM-DD` for a whole-day index. */
function isoFromDayIndex(index: number): string {
  const date = new Date(index * DAY_MS);
  const y = date.getUTCFullYear().toString().padStart(4, '0');
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Weekday of a calendar date, 0=Sunday..6=Saturday. */
function weekdayOf({ year, month, day }: YmD): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Days in a given month (1..12), leap-year aware. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The signed offset (ms) of a timezone at a UTC instant, defined so that
 * `localWallClock === utcInstant + offset`. Positive east of UTC. Uses `Intl`,
 * so it is DST-correct and independent of the process's local timezone.
 */
function zoneOffsetMs(utc: Date, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(utc);
  } catch (error) {
    throw new RecurrenceError(
      `Invalid branch timezone "${timeZone}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value === undefined ? Number.NaN : Number(value);
  };
  // Carry the input's sub-second component: `Intl` renders only to the second, so
  // without this a probe instant with milliseconds would yield an offset off by
  // up to 999ms and break the transition binary search. Zone offsets are whole
  // seconds, so the millisecond part is identical in local and UTC and cancels.
  const asUTC =
    Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24, // guard the historical h23 "24" quirk at midnight
      get('minute'),
      get('second')
    ) + utc.getUTCMilliseconds();
  if (Number.isNaN(asUTC)) {
    throw new RecurrenceError(`Could not resolve timezone "${timeZone}".`);
  }
  return asUTC - utc.getTime();
}

/**
 * Binary-search the DST transition instant in `[lo, hi]`, given the offset in
 * effect at `lo` differs from the one at `hi`. Returns the first (smallest) UTC
 * instant carrying the post-transition offset — i.e. the boundary where a
 * spring-forward gap ends. Invariant on entry: `offset(lo) === offBefore` and
 * `offset(hi) !== offBefore`.
 */
function findTransitionBoundary(lo: number, hi: number, timeZone: string, offBefore: number): number {
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (zoneOffsetMs(new Date(mid), timeZone) === offBefore) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return hi;
}

/**
 * Project a branch-local wall clock (a calendar date + minutes-of-day) to the UTC
 * instant it denotes in `timeZone`, resolving DST edges per the module policy.
 *
 * Method: treat the wall clock as if it were UTC (the "naive" instant), then probe
 * the zone offset on each side of any transition inside a ±6h window. With one
 * offset (no transition nearby) the instant is `naive - offset`. With two offsets:
 * the two candidate instants are `naive - offBefore` and `naive - offAfter`; a
 * candidate is real iff the zone's actual offset there equals the offset used to
 * derive it. Two real candidates → ambiguous (fall-back) → the earlier. Zero real
 * candidates → non-existent (spring-forward) → the transition boundary.
 */
export function zonedWallTimeToUtc(
  dateISO: string,
  minutesOfDay: number,
  timeZone: string
): { instant: Date; adjustment: DstAdjustment } {
  const { year, month, day } = parseDate(dateISO);
  if (!Number.isInteger(minutesOfDay) || minutesOfDay < 0 || minutesOfDay > 1439) {
    throw new RecurrenceError(
      `dueTimeMinutes must be an integer in 0..1439 (got ${minutesOfDay}).`
    );
  }
  const hour = Math.floor(minutesOfDay / 60);
  const minute = minutesOfDay % 60;
  const naive = Date.UTC(year, month - 1, day, hour, minute);

  const offBefore = zoneOffsetMs(new Date(naive - 6 * HOUR_MS), timeZone);
  const offAfter = zoneOffsetMs(new Date(naive + 6 * HOUR_MS), timeZone);
  if (offBefore === offAfter) {
    return { instant: new Date(naive - offBefore), adjustment: 'none' };
  }

  const tBefore = naive - offBefore;
  const tAfter = naive - offAfter;
  const okBefore = zoneOffsetMs(new Date(tBefore), timeZone) === offBefore;
  const okAfter = zoneOffsetMs(new Date(tAfter), timeZone) === offAfter;

  if (okBefore && okAfter) {
    return { instant: new Date(Math.min(tBefore, tAfter)), adjustment: 'fall-back' };
  }
  if (okBefore) return { instant: new Date(tBefore), adjustment: 'none' };
  if (okAfter) return { instant: new Date(tAfter), adjustment: 'none' };

  const boundary = findTransitionBoundary(
    naive - 6 * HOUR_MS,
    naive + 6 * HOUR_MS,
    timeZone,
    offBefore
  );
  return { instant: new Date(boundary), adjustment: 'spring-forward' };
}

/** Validate a rule's structural invariants (interval/selectors/time bounds). */
export function assertValidRule(rule: RecurrenceRule): void {
  if (!Number.isInteger(rule.interval) || rule.interval < 1) {
    throw new RecurrenceError(`interval must be an integer >= 1 (got ${rule.interval}).`);
  }
  if (!Number.isInteger(rule.dueTimeMinutes) || rule.dueTimeMinutes < 0 || rule.dueTimeMinutes > 1439) {
    throw new RecurrenceError(
      `dueTimeMinutes must be an integer in 0..1439 (got ${rule.dueTimeMinutes}).`
    );
  }
  if (!Number.isInteger(rule.windowMinutes) || rule.windowMinutes < 0) {
    throw new RecurrenceError(`windowMinutes must be an integer >= 0 (got ${rule.windowMinutes}).`);
  }
  for (const dow of rule.daysOfWeek) {
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) {
      throw new RecurrenceError(`daysOfWeek entries must be integers in 0..6 (got ${dow}).`);
    }
  }
  if (rule.monthDay != null && (!Number.isInteger(rule.monthDay) || rule.monthDay < 1 || rule.monthDay > 31)) {
    throw new RecurrenceError(`monthDay must be an integer in 1..31 (got ${rule.monthDay}).`);
  }
  parseDate(rule.startDate);
  if (rule.endDate != null) {
    parseDate(rule.endDate);
    if (dayIndex(parseDate(rule.endDate)) < dayIndex(parseDate(rule.startDate))) {
      throw new RecurrenceError('endDate must not precede startDate.');
    }
  }
}

/**
 * Does the recurrence fire on the branch-local calendar date `dateISO`?
 * Selection is purely calendar-based (no timezone projection): a match means an
 * occurrence exists on that date; {@link computeOccurrence} resolves its instant.
 */
export function occursOn(rule: RecurrenceRule, dateISO: string): boolean {
  const target = parseDate(dateISO);
  const start = parseDate(rule.startDate);
  const targetIndex = dayIndex(target);
  const startIndex = dayIndex(start);

  if (targetIndex < startIndex) return false;
  if (rule.endDate != null && targetIndex > dayIndex(parseDate(rule.endDate))) return false;

  switch (rule.frequency) {
    case 'ONCE':
      return targetIndex === startIndex;

    case 'DAILY':
      return (targetIndex - startIndex) % rule.interval === 0;

    case 'WEEKLY': {
      const selectedDays = rule.daysOfWeek.length > 0 ? rule.daysOfWeek : [weekdayOf(start)];
      if (!selectedDays.includes(weekdayOf(target))) return false;
      // Align the interval on the Sunday of startDate's week so "every 2 weeks"
      // is stable regardless of which weekday within the week is selected.
      const startWeekStart = startIndex - weekdayOf(start);
      const targetWeekStart = targetIndex - weekdayOf(target);
      const weekDelta = Math.round((targetWeekStart - startWeekStart) / 7);
      return weekDelta % rule.interval === 0;
    }

    case 'MONTHLY': {
      const desiredDay = rule.monthDay ?? start.day;
      const effectiveDay = Math.min(desiredDay, daysInMonth(target.year, target.month));
      if (target.day !== effectiveDay) return false;
      const monthDelta = (target.year - start.year) * 12 + (target.month - start.month);
      return monthDelta >= 0 && monthDelta % rule.interval === 0;
    }

    default:
      return false;
  }
}

/** Resolve the concrete occurrence instant for a matching branch-local date. */
export function computeOccurrence(
  rule: RecurrenceRule,
  dateISO: string,
  timeZone: string
): RecurrenceOccurrence {
  const { instant: dueAt, adjustment } = zonedWallTimeToUtc(dateISO, rule.dueTimeMinutes, timeZone);
  const windowEndsAt = new Date(dueAt.getTime() + rule.windowMinutes * 60_000);
  return { businessDate: dateISO, dueAt, windowEndsAt, adjustment };
}

/**
 * Enumerate every occurrence whose branch-local date falls in the inclusive
 * `[fromISO, toISO]` window (further clamped to the rule's start/end). The scan is
 * bounded by {@link MAX_ENUMERATION_DAYS}; a wider window throws rather than
 * looping unbounded.
 */
export function enumerateOccurrences(
  rule: RecurrenceRule,
  timeZone: string,
  fromISO: string,
  toISO: string
): RecurrenceOccurrence[] {
  assertValidRule(rule);
  const startIndex = dayIndex(parseDate(rule.startDate));
  const endIndex = rule.endDate != null ? dayIndex(parseDate(rule.endDate)) : Number.POSITIVE_INFINITY;
  const lo = Math.max(dayIndex(parseDate(fromISO)), startIndex);
  const hi = Math.min(dayIndex(parseDate(toISO)), endIndex);
  if (hi < lo) return [];
  if (hi - lo + 1 > MAX_ENUMERATION_DAYS) {
    throw new RecurrenceError(
      `Enumeration window spans ${hi - lo + 1} days, exceeding the ${MAX_ENUMERATION_DAYS}-day bound.`
    );
  }

  const occurrences: RecurrenceOccurrence[] = [];
  for (let index = lo; index <= hi; index += 1) {
    const dateISO = isoFromDayIndex(index);
    if (occursOn(rule, dateISO)) {
      occurrences.push(computeOccurrence(rule, dateISO, timeZone));
    }
    if (rule.frequency === 'ONCE') break; // a ONCE rule fires only on startDate
  }
  return occurrences;
}
