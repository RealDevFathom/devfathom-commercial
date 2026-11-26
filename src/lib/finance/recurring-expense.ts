import { z } from 'zod';
import { workspaceMinuteInput, workspaceInstantFromInput, workspaceToday } from '@/lib/timezone';

export const recurringInterval = z.enum(['monthly', 'quarterly', 'yearly'], {
  error: 'Choose monthly, quarterly or yearly for the billing interval.',
});

const monthsByInterval = { monthly: 1, quarterly: 3, yearly: 12 };

// Older date pickers encoded a civil billing date as exactly midnight UTC.
function isLegacyBillingDate(due: Date) {
  return due.getTime() % 86_400_000 === 0;
}

export function billingCalendarDate(due: Date, zone?: string | null) {
  return isLegacyBillingDate(due) ? due.toISOString().slice(0, 10) : workspaceToday(zone, due);
}

export function recurringBillingDay(due: Date, zone?: string | null) {
  return Number(billingCalendarDate(due, zone).slice(-2));
}

/** Clamp each occurrence to its target month while keeping the original billing day. */
export function recurringExpenseSchedule(
  firstDue: Date,
  interval: string,
  zone: string | null | undefined,
  billingDay: number
) {
  const step = monthsByInterval[recurringInterval.parse(interval.toLowerCase())];
  const scheduleZone = isLegacyBillingDate(firstDue) ? 'UTC' : zone;
  return (due: Date) => {
    const seconds = due.toISOString().slice(16);
    const wall = new Date(workspaceMinuteInput(due, scheduleZone) + seconds);
    // Day zero of the following month is the last day of the target month.
    wall.setUTCMonth(wall.getUTCMonth() + step + 1, 0);
    wall.setUTCDate(Math.min(billingDay, wall.getUTCDate()));
    const next = new Date(workspaceInstantFromInput(wall.toISOString().slice(0, 19), scheduleZone));
    next.setUTCMilliseconds(due.getUTCMilliseconds());
    return next;
  };
}

export function rollForwardDueDate(
  due: Date,
  interval: string,
  today: Date,
  zone: string | null | undefined,
  billingDay: number
) {
  const cutoff = isLegacyBillingDate(due) ? new Date(workspaceToday(zone, today)) : today;
  if (due >= cutoff) return due;
  const advance = recurringExpenseSchedule(due, interval, zone, billingDay);
  let next = due;
  for (let i = 0; next < cutoff && i < 600; i++) next = advance(next);
  return next;
}
