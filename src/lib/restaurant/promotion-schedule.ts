/**
 * WHA-288 / promotions Lane A — §3.2 schedule semantics.
 *
 * A pure, total function from (server instant, rule schedule) to an eligibility
 * verdict PLUS the local facts that get snapshotted. Nothing here reads a device
 * clock, a branch clock, or the host timezone: every wall-clock test runs in the
 * VERSION's IANA timezone, because a branch that later changes timezone must not
 * rewrite the history of what was eligible (§15 "re-read live configuration").
 *
 * The four rules that make this non-obvious, all from §3.2:
 *   - the effective range is half-open: `effectiveFrom <= t < effectiveTo`;
 *   - a null minute window means the WHOLE selected local day, and so do EQUAL
 *     endpoints — `22:00-22:00` is a full day, never an empty interval;
 *   - `startMinute > endMinute` is an OVERNIGHT window that starts on a selected
 *     day and ends the following day, so Friday 22:00-02:00 accepts Saturday
 *     01:30 under FRIDAY's bit — Saturday's bit is irrelevant to it;
 *   - ambiguous fall-back local times are both eligible and nonexistent
 *     spring-forward times simply never occur. Both fall out of asking `Intl`
 *     for the local parts OF THE INSTANT rather than constructing a local time.
 */

import {
  PROMOTION_REASON,
  type PromotionRejectionReason,
  type PromotionRule,
} from '@/lib/restaurant/promotion-contracts';

/** Raised for a schedule the engine cannot interpret — an invalid IANA zone or
 * an out-of-range mask. Publication CHECKs make this unreachable for stored
 * rules; it exists so a hand-built rule fails loudly instead of silently
 * never matching. */
export class PromotionScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromotionScheduleError';
  }
}

const MINUTES_PER_DAY = 1440;

/** The rule fields the schedule depends on — narrower than a full rule so
 * callers (and tests) can ask about a schedule in isolation. */
export type PromotionSchedule = Pick<
  PromotionRule,
  'effectiveFrom' | 'effectiveTo' | 'timezone' | 'dayMask' | 'startMinute' | 'endMinute'
>;

/** §5.1 the resolved local facts recorded on the evaluation snapshot, so an
 * auditor never has to re-derive them from a timezone database. */
export type PromotionScheduleFacts = {
  /** `YYYY-MM-DD` in the version's timezone. */
  localDate: string;
  /** 0..1439 local minutes past midnight. */
  localMinute: number;
  /** The zone's UTC offset AT this instant, in minutes (east positive). */
  utcOffsetMinutes: number;
};

export type PromotionScheduleVerdict = PromotionScheduleFacts & {
  eligible: boolean;
  /** `ACCEPTED` when eligible, otherwise the stable reason it failed. */
  reasonCode: PromotionRejectionReason;
};

type LocalParts = {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  minutesOfDay: number; // 0..1439
};

/**
 * The version-local wall-clock parts of a server instant. Mirrors the
 * `business-date.ts` idiom (`Intl` + `hourCycle: 'h23'`); that module's
 * equivalent helper is private and is keyed to a BRANCH timezone, whereas a
 * promotion is pinned to its own version timezone.
 */
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
    throw new PromotionScheduleError(
      `Invalid promotion timezone "${timeZone}": ${error instanceof Error ? error.message : String(error)}`
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
    throw new PromotionScheduleError(`Could not resolve local time in timezone "${timeZone}".`);
  }
  return { year, month, day, minutesOfDay: hour * 60 + minute };
}

function formatLocalDate(parts: LocalParts): string {
  const year = parts.year.toString().padStart(4, '0');
  const month = parts.month.toString().padStart(2, '0');
  const day = parts.day.toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Bit 0 = Monday .. bit 6 = Sunday (§3.1). `Date.getUTCDay()` is 0 = Sunday,
 * so the local calendar date is anchored in the UTC domain — it is already past
 * timezone conversion — and rotated. */
function dayMaskBit(parts: LocalParts): number {
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return (weekday + 6) % 7;
}

/** The zone's offset at this instant: local wall clock minus UTC, at minute
 * granularity. DST-correct because `parts` came from `Intl` for THIS instant. */
function utcOffsetMinutes(instant: Date, parts: LocalParts): number {
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    Math.floor(parts.minutesOfDay / 60),
    parts.minutesOfDay % 60
  );
  const instantAtMinute = Math.floor(instant.getTime() / 60_000) * 60_000;
  return (localAsUtc - instantAtMinute) / 60_000;
}

function isDaySelected(dayMask: number, bit: number): boolean {
  return (dayMask & (1 << bit)) !== 0;
}

/** The bit for the day BEFORE the given local date — the anchor day of an
 * overnight window that has run past local midnight. */
function previousDayBit(parts: LocalParts): number {
  return (dayMaskBit(parts) + 6) % 7;
}

/**
 * Decide whether `instant` falls inside `schedule`, and return the local facts
 * to snapshot either way. Total: it never throws for a well-formed schedule and
 * always yields a stable reason code.
 */
export function resolvePromotionSchedule(
  instant: Date,
  schedule: PromotionSchedule
): PromotionScheduleVerdict {
  if (Number.isNaN(instant.getTime())) {
    throw new PromotionScheduleError('resolvePromotionSchedule requires a valid server instant.');
  }
  if (!Number.isInteger(schedule.dayMask) || schedule.dayMask < 0 || schedule.dayMask > 127) {
    throw new PromotionScheduleError(`dayMask must be a 7-bit integer; got ${schedule.dayMask}.`);
  }
  const { startMinute, endMinute } = schedule;
  if ((startMinute === null) !== (endMinute === null)) {
    throw new PromotionScheduleError('startMinute and endMinute must be set or omitted together.');
  }
  for (const minute of [startMinute, endMinute]) {
    if (minute !== null && (!Number.isInteger(minute) || minute < 0 || minute >= MINUTES_PER_DAY)) {
      throw new PromotionScheduleError(`Minute window bounds must be 0..1439; got ${minute}.`);
    }
  }

  const parts = localPartsInTimeZone(instant, schedule.timezone);
  const facts: PromotionScheduleFacts = {
    localDate: formatLocalDate(parts),
    localMinute: parts.minutesOfDay,
    utcOffsetMinutes: utcOffsetMinutes(instant, parts),
  };
  const reject = (reasonCode: PromotionRejectionReason): PromotionScheduleVerdict => ({
    ...facts,
    eligible: false,
    reasonCode,
  });

  // The half-open effective range, tested in UTC (§3.2 "all instants are UTC").
  if (instant.getTime() < schedule.effectiveFrom.getTime()) {
    return reject(PROMOTION_REASON.OUTSIDE_EFFECTIVE_RANGE);
  }
  if (schedule.effectiveTo !== null && instant.getTime() >= schedule.effectiveTo.getTime()) {
    return reject(PROMOTION_REASON.OUTSIDE_EFFECTIVE_RANGE);
  }

  const todayBit = dayMaskBit(parts);
  const todaySelected = isDaySelected(schedule.dayMask, todayBit);

  // No window, or equal endpoints: the whole selected local day is valid.
  if (startMinute === null || endMinute === null || startMinute === endMinute) {
    return todaySelected
      ? { ...facts, eligible: true, reasonCode: PROMOTION_REASON.ACCEPTED }
      : reject(PROMOTION_REASON.DAY_MASK_EXCLUDED);
  }

  if (startMinute < endMinute) {
    // Same-day window, half-open: start <= minute < end.
    if (!todaySelected) return reject(PROMOTION_REASON.DAY_MASK_EXCLUDED);
    const inWindow = parts.minutesOfDay >= startMinute && parts.minutesOfDay < endMinute;
    return inWindow
      ? { ...facts, eligible: true, reasonCode: PROMOTION_REASON.ACCEPTED }
      : reject(PROMOTION_REASON.TIME_WINDOW_EXCLUDED);
  }

  // Overnight: the interval is anchored on the SELECTED day and runs past local
  // midnight into the next calendar day. Two disjoint ways to be inside it.
  const startedToday = todaySelected && parts.minutesOfDay >= startMinute;
  const startedYesterday =
    isDaySelected(schedule.dayMask, previousDayBit(parts)) && parts.minutesOfDay < endMinute;
  if (startedToday || startedYesterday) {
    return { ...facts, eligible: true, reasonCode: PROMOTION_REASON.ACCEPTED };
  }
  // Distinguish "your day was never selected" from "your day was selected but
  // the clock is outside the window" — an auditor needs to tell those apart.
  return reject(
    todaySelected || isDaySelected(schedule.dayMask, previousDayBit(parts))
      ? PROMOTION_REASON.TIME_WINDOW_EXCLUDED
      : PROMOTION_REASON.DAY_MASK_EXCLUDED
  );
}

/** The local facts alone, for callers that must snapshot them regardless of the
 * verdict (§5.1 records them on every evaluation). */
export function resolvePromotionLocalFacts(
  instant: Date,
  timeZone: string
): PromotionScheduleFacts {
  const parts = localPartsInTimeZone(instant, timeZone);
  return {
    localDate: formatLocalDate(parts),
    localMinute: parts.minutesOfDay,
    utcOffsetMinutes: utcOffsetMinutes(instant, parts),
  };
}
