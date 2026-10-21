/** Pakistan is the product default when an organization has no usable zone. */
export const DEFAULT_BUSINESS_TIME_ZONE = 'Asia/Karachi';

const WARMUP_MS = 14 * 24 * 60 * 60 * 1000;
const WARMUP_CAP = 30;

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function businessTimeZone(timezone: string | null | undefined): string {
  const candidate = timezone?.trim();
  if (!candidate) return DEFAULT_BUSINESS_TIME_ZONE;
  try {
    Intl.DateTimeFormat('en-GB', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return DEFAULT_BUSINESS_TIME_ZONE;
  }
}

export function zonedParts(now: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const bag = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour) % 24,
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return asUtc - instant.getTime();
}

/** UTC instant of local midnight for the calendar day `now` falls on in `timeZone`. */
export function zonedDayStart(now: Date, timeZone: string): Date {
  const parts = zonedParts(now, timeZone);
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  const start = new Date(utcGuess - zoneOffsetMs(new Date(utcGuess), timeZone));
  const check = zonedParts(start, timeZone);
  if (check.day === parts.day && check.hour === 0) return start;
  return new Date(utcGuess - zoneOffsetMs(start, timeZone));
}

/**
 * Quiet hours wrap midnight when start > end (the default 21 → 09).
 * `end` is exclusive, so 09:00 is a legal send hour and 21:00 is not.
 */
export function isQuietHours(
  now: Date,
  timeZone: string,
  startHour: number,
  endHour: number
): boolean {
  const hour = zonedParts(now, timeZone).hour;
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

/** First 14 days after settings creation cap the day at 30, whichever is lower. */
export function effectiveDailyCap(
  settings: { maxMsgsPerDay: number; createdAt: Date | null },
  now: Date
): number {
  const cap = settings.maxMsgsPerDay;
  if (!settings.createdAt) return cap;
  const age = now.getTime() - settings.createdAt.getTime();
  if (age >= 0 && age < WARMUP_MS) return Math.min(cap, WARMUP_CAP);
  return cap;
}
