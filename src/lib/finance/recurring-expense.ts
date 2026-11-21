import { workspaceMinuteInput, workspaceInstantFromInput, workspaceToday } from '@/lib/timezone';

const monthsByInterval: Record<string, number> = { monthly: 1, quarterly: 3, yearly: 12 };

/** Advance the stored schedule in civil months, retaining its wall time and anchor day. */
export function recurringExpenseSchedule(firstDue: Date, interval: string, zone?: string | null) {
  const step = monthsByInterval[interval.toLowerCase()] ?? 1;
  const anchorDay = Number(workspaceToday(zone, firstDue).slice(-2));
  return (due: Date) => {
    const seconds = due.toISOString().slice(16);
    const wall = new Date(workspaceMinuteInput(due, zone) + seconds);
    wall.setUTCDate(anchorDay);
    wall.setUTCMonth(wall.getUTCMonth() + step);
    const next = new Date(workspaceInstantFromInput(wall.toISOString().slice(0, 19), zone));
    next.setUTCMilliseconds(due.getUTCMilliseconds());
    return next;
  };
}

export function rollForwardDueDate(due: Date, interval: string, today: Date, zone?: string | null) {
  if (due >= today) return due;
  const advance = recurringExpenseSchedule(due, interval, zone);
  let next = due;
  for (let i = 0; next < today && i < 600; i++) next = advance(next);
  return next;
}
