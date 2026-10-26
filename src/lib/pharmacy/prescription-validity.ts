import { workspaceToday, workspaceTimezone } from '@/lib/timezone';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Prescription dates are persisted as UTC-midnight sentinels for SQL DATE
 * columns. They represent calendar dates, never instants in the viewer's zone.
 */
export function prescriptionCalendarDate(value: string): Date {
  const match = CALENDAR_DATE.exec(value);
  if (!match) throw new RangeError('Expected a YYYY-MM-DD prescription date.');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (prescriptionDateValue(date) !== value) throw new RangeError('Invalid prescription date.');
  return date;
}

export function prescriptionDateValue(value: Date): string {
  return [
    value.getUTCFullYear().toString().padStart(4, '0'),
    (value.getUTCMonth() + 1).toString().padStart(2, '0'),
    value.getUTCDate().toString().padStart(2, '0'),
  ].join('-');
}

/** Product-stable Pakistan date display, independent of the viewing device. */
export function formatPrescriptionDate(value: Date): string {
  return new Intl.DateTimeFormat('en-PK', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

/** Both endpoints are inclusive calendar days in the pharmacy workspace zone. */
export function prescriptionIsValidOn(
  validFrom: Date,
  validUntil: Date,
  now: Date,
  pharmacyTimeZone: string | null | undefined
): boolean {
  const today = workspaceToday(workspaceTimezone(pharmacyTimeZone), now);
  return prescriptionDateValue(validFrom) <= today && today <= prescriptionDateValue(validUntil);
}

/** Applies the organization's calendar to a production dispensing gate. */
export async function prescriptionIsValidForOrganization(
  db: ScopedDb,
  organizationId: string,
  validFrom: Date,
  validUntil: Date,
  now: Date
): Promise<boolean> {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { timezone: true },
  });
  return prescriptionIsValidOn(validFrom, validUntil, now, organization?.timezone);
}
