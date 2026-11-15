/**
 * One quiet-hours window for every scheduled utility reminder job (khata and
 * refill): nothing leaves between 22:00 and 09:00 in the workspace's local time
 * (PKT for Pakistan tenants). Policy, not an owner setting. Marketing campaigns
 * carry their own reviewed window on the campaign row.
 */
export const UTILITY_REMINDER_QUIET_HOURS = { startHour: 22, endHour: 9 } as const;

export function isUtilityReminderQuietHour(localHour: number): boolean {
  return (
    !Number.isInteger(localHour) ||
    localHour >= UTILITY_REMINDER_QUIET_HOURS.startHour ||
    localHour < UTILITY_REMINDER_QUIET_HOURS.endHour
  );
}

/** The 0-23 hour at `now` in `timeZone` (an IANA zone Intl accepts). */
export function reminderLocalHour(now: Date, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now)
  );
}
