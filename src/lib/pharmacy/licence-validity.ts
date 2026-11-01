/** Licence dates are calendar dates stored as UTC midnight, inclusive in the org timezone. */
function calendarDate(value: Date | string): string {
  return typeof value === 'string' ? value : value.toISOString().slice(0, 10);
}

function dateInTimezone(at: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function licenceDateStarted(
  validFrom: Date | string,
  at = new Date(),
  timezone = 'Asia/Karachi'
): boolean {
  return calendarDate(validFrom) <= dateInTimezone(at, timezone);
}

export function licenceDateValid(
  validTo: Date | string,
  at = new Date(),
  timezone = 'Asia/Karachi'
): boolean {
  return calendarDate(validTo) >= dateInTimezone(at, timezone);
}

export const LICENCE_EXPIRY_ERROR = 'The licence expiry date must be today or later.';
