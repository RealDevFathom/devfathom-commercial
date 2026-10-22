import { workspaceToday, workspaceTimezone } from '@/lib/timezone';

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Store a calendar date as a UTC-midnight token, never as the browser's local midnight. */
export function parsePrescriptionCalendarDate(value: string): Date {
  const match = CALENDAR_DATE.exec(value);
  if (!match) throw new RangeError('Expected a YYYY-MM-DD prescription date.');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== value) {
    throw new RangeError('Expected a real prescription calendar date.');
  }
  return date;
}

/** Whether a Date is the canonical database token for a prescription calendar date. */
export function isPrescriptionCalendarDate(value: Date): boolean {
  return (
    !Number.isNaN(value.getTime()) &&
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0
  );
}

/** Product-stable rendering of a stored calendar-date token. */
export function formatPrescriptionCalendarDate(value: Date): string {
  return new Intl.DateTimeFormat('en-PK', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(value);
}

/** Both entered endpoints are inclusive calendar days in the workspace timezone. */
export function prescriptionIsValidOn(
  validFrom: Date,
  validUntil: Date,
  timeZone: string | null | undefined,
  now = new Date()
): boolean {
  const today = workspaceToday(workspaceTimezone(timeZone), now);
  const from = validFrom.toISOString().slice(0, 10);
  const until = validUntil.toISOString().slice(0, 10);
  return from <= today && today <= until;
}
