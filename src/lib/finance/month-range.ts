import { workspaceTimezone } from '@/lib/timezone';

type CalendarParts = { year: number; month: number };

function calendarParts(at: Date, timeZone: string): CalendarParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(at);
  return {
    year: Number(parts.find((part) => part.type === 'year')?.value),
    month: Number(parts.find((part) => part.type === 'month')?.value),
  };
}

function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const localAsUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour') % 24,
    value('minute'),
    value('second')
  );
  return localAsUtc - at.getTime();
}

function localMidnightUtc(year: number, month: number, timeZone: string): Date {
  const wallClock = Date.UTC(year, month - 1, 1);
  let instant = wallClock - zoneOffsetMs(new Date(wallClock), timeZone);
  // A second pass handles zones whose offset differs at the resulting instant.
  instant = wallClock - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/** UTC half-open interval for the calendar month containing `now` in the tenant zone. */
export function tenantMonthRange(
  now: Date,
  configuredTimeZone: string | null | undefined
): { start: Date; end: Date } {
  const timeZone = workspaceTimezone(configuredTimeZone);
  const { year, month } = calendarParts(now, timeZone);
  const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
  return {
    start: localMidnightUtc(year, month, timeZone),
    end: localMidnightUtc(next.year, next.month, timeZone),
  };
}
