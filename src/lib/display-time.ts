import { workspaceTimezone } from '@/lib/timezone';

/**
 * A stored instant as a readable date and time for people (e.g. "01-Nov-2026, 7:59 pm"),
 * in the workspace's time zone. Raw ISO strings are for machines, exports and `dateTime`
 * attributes only, never for on-screen copy.
 */
export function formatDisplayDateTime(
  value: string | Date | null | undefined,
  timeZone?: string | null
): string {
  if (value == null || value === '') return 'Not available';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Not available';
  const zone = workspaceTimezone(timeZone);
  const text = new Intl.DateTimeFormat('en-PK', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: zone,
  }).format(date);
  // Without a workspace zone the time is UTC; say so rather than let it pass as local time.
  return zone === 'UTC' ? `${text} UTC` : text;
}
