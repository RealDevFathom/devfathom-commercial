/**
 * Near-expiry alerts at 30, 60 and 90 days.
 *
 * A printed expiry is a calendar date in Asia/Karachi (UTC+5, no DST). The band
 * and the day count both use that civil date, so a millisecond past an elapsed
 * 30×86400000 boundary cannot rename a lot that is still inside 30 Karachi days.
 */

const DAY_MS = 86_400_000;
const KARACHI_TIME_ZONE = 'Asia/Karachi';

export const NEAR_EXPIRY_ALERT_DAYS = [30, 60, 90] as const;
export type NearExpiryAlertDays = (typeof NEAR_EXPIRY_ALERT_DAYS)[number];

function karachiCivilDay(instant: Date): number {
  if (!Number.isFinite(instant.getTime())) return Number.NaN;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: KARACHI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const year = value('year');
  const month = value('month');
  const day = value('day');
  if (!year || !month || !day) return Number.NaN;
  return Date.UTC(year, month - 1, day);
}

/**
 * Whole Karachi calendar days from `at` until `expiresAt`.
 *
 * A later instant on the same civil date still counts as one day. An expiry
 * instant that has already passed returns zero or a negative count.
 */
export function daysUntilExpiry(expiresAt: Date, at: Date): number {
  const remainingMs = expiresAt.getTime() - at.getTime();
  if (!Number.isFinite(remainingMs)) return Number.NaN;
  const days = Math.round((karachiCivilDay(expiresAt) - karachiCivilDay(at)) / DAY_MS);
  if (!Number.isFinite(days)) return Number.NaN;
  if (remainingMs > 0 && days <= 0) return 1;
  return days;
}

/** The tightest alert whose window still contains this expiry. Null once it has passed or is beyond 90 days. */
export function nearExpiryAlertBand(expiresAt: Date, at: Date): NearExpiryAlertDays | null {
  const days = daysUntilExpiry(expiresAt, at);
  if (!Number.isFinite(days) || days <= 0) return null;
  for (const window of NEAR_EXPIRY_ALERT_DAYS) {
    if (days <= window) return window;
  }
  return null;
}
