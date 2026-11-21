import { workspaceMinuteInput, workspaceInstantFromInput, workspaceToday } from '@/lib/timezone';

const monthsByInterval: Record<string, number> = { monthly: 1, quarterly: 3, yearly: 12 };

// Older date pickers encoded a civil billing date as exactly midnight UTC.
function isLegacyBillingDate(due: Date) {
  return due.getTime() % 86_400_000 === 0;
}

/** Advance the stored schedule in civil months, retaining its wall time and anchor day. */
export function recurringExpenseSchedule(firstDue: Date, interval: string, zone?: string | null) {
  const step = monthsByInterval[interval.toLowerCase()] ?? 1;
  const scheduleZone = isLegacyBillingDate(firstDue) ? 'UTC' : zone;
  const anchorDay = Number(workspaceToday(scheduleZone, firstDue).slice(-2));
  return (due: Date) => {
    const seconds = due.toISOString().slice(16);
    const wall = new Date(workspaceMinuteInput(due, scheduleZone) + seconds);
    // Retain develop's month overflow and its anchor for this posting run.
    wall.setUTCDate(anchorDay);
    wall.setUTCMonth(wall.getUTCMonth() + step);
    const next = new Date(workspaceInstantFromInput(wall.toISOString().slice(0, 19), scheduleZone));
    next.setUTCMilliseconds(due.getUTCMilliseconds());
    return next;
  };
}

export function rollForwardDueDate(due: Date, interval: string, today: Date, zone?: string | null) {
  const cutoff = isLegacyBillingDate(due) ? new Date(workspaceToday(zone, today)) : today;
  if (due >= cutoff) return due;
  const advance = recurringExpenseSchedule(due, interval, zone);
  let next = due;
  for (let i = 0; next < cutoff && i < 600; i++) next = advance(next);
  return next;
}
