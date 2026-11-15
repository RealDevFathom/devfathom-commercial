/**
 * UTC instants for owner screens: entered with a native `datetime-local`
 * picker (minute precision, read as UTC) and shown in words, never as raw ISO.
 */
const MINUTE_INPUT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

const utcFormat = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

const asDate = (value: Date | string) => (value instanceof Date ? value : new Date(value));

/** A picker value with no zone (`2026-05-01T09:30`) is UTC; anything else passes through. */
export function utcInstantFromInput(raw: string): string {
  return MINUTE_INPUT.test(raw) ? `${raw.length === 16 ? `${raw}:00` : raw}Z` : raw;
}

/** The `datetime-local` value for an instant, in UTC; empty when it is not a valid date. */
export function toUtcMinuteInput(value: Date | string): string {
  const date = asDate(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 16) : '';
}

/** `1 May 2026, 09:30 UTC`; the input is returned unchanged when it is not a valid date. */
export function formatUtcInstant(value: Date | string): string {
  const date = asDate(value);
  return Number.isFinite(date.getTime()) ? `${utcFormat.format(date)} UTC` : String(value);
}
