import { workspaceTimezone } from '@/lib/timezone';
import { pharmacyCalendarDay } from '@/lib/pharmacy/business-day';

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Store an HTML date value as a timezone-neutral, UTC-midnight calendar-date carrier. */
export function prescriptionCalendarDate(value: string): Date {
  if (!CALENDAR_DATE.test(value)) throw new Error('Choose a valid prescription date.');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new Error('Choose a valid prescription date.');
  return date;
}

/** Recover the calendar date without allowing the viewer's device timezone to shift it. */
export function prescriptionDateValue(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Product-standard Pakistan date presentation, explicitly independent of the browser zone. */
export function formatPrescriptionDate(value: Date): string {
  return new Intl.DateTimeFormat('en-PK', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

/** The entered end date is inclusive in the pharmacy's configured calendar timezone. */
export function prescriptionIsCurrent(
  validFrom: Date,
  validUntil: Date,
  now: Date,
  timeZone: string | null | undefined
): boolean {
  const today = pharmacyCalendarDay(workspaceTimezone(timeZone), now);
  return prescriptionDateValue(validFrom) <= today && today <= prescriptionDateValue(validUntil);
}
