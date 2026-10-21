/** Licence dates are calendar dates stored as UTC midnight, inclusive in the org timezone. */
export function licenceDateValid(
  validTo: Date | string,
  at = new Date(),
  timezone = 'Asia/Karachi'
): boolean {
  const expiry = typeof validTo === 'string' ? validTo : validTo.toISOString().slice(0, 10);
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return expiry >= `${part('year')}-${part('month')}-${part('day')}`;
}

export const LICENCE_EXPIRY_ERROR = 'The licence expiry date must be today or later.';
