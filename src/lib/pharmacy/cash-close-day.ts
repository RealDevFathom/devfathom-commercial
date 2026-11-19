import {
  pharmacyBusinessDayRange,
  pharmacyDayEndHour,
  PHARMACY_DEFAULT_DAY_END_HOUR,
} from './business-day';

const DAY_MS = 86_400_000;

/** UTC bounds of the workspace calendar day used by cash-close void evidence. */
export function pharmacyCashCloseDayBounds(
  businessDate: Date,
  timeZone: string,
  /** DEV-958A: the hour the branch's business day ends at; midnight (the default) as before. */
  dayEndsAtHour?: number | null
): { start: Date; end: Date } {
  const day = businessDate.toISOString().slice(0, 10);
  if (pharmacyDayEndHour(dayEndsAtHour) !== PHARMACY_DEFAULT_DAY_END_HOUR) {
    const range = pharmacyBusinessDayRange(day, day, { timeZone, dayEndsAtHour });
    return { start: range.from, end: range.to };
  }
  const anchor = Date.parse(`${day}T00:00:00.000Z`);
  const nextDay = new Date(anchor + DAY_MS).toISOString().slice(0, 10);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dateAt = (instant: number): string => {
    const parts = formatter.formatToParts(new Date(instant));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((value) => value.type === type)!.value;
    return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
  };
  const boundary = (date: string, utcMidnight: number): Date => {
    // Bracket every IANA offset. Locate the first instant of the calendar date
    // instead of assuming midnight exists or that a local day lasts 24 hours.
    // A skipped date has the same boundary as its following date (empty range).
    let before = utcMidnight - 2 * DAY_MS;
    let after = utcMidnight + 2 * DAY_MS;
    while (after - before > 1) {
      const middle = before + Math.floor((after - before) / 2);
      if (dateAt(middle) < date) before = middle;
      else after = middle;
    }
    return new Date(after);
  };
  return { start: boundary(day, anchor), end: boundary(nextDay, anchor + DAY_MS) };
}
