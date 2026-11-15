import { workspaceToday } from '@/lib/timezone';

/**
 * DEV-298. Profile, licence and qualified-person start dates are stored as the
 * UTC midnight of their calendar date. A date starts on the workspace's own
 * calendar day, so a workspace ahead of UTC (PKT is UTC+05:00) must not wait
 * until 05:00 local time. Returns the instant to compare those start dates
 * (and a profile's `effectiveTo`, the next version's start) against: `at`, or
 * the stored encoding of the workspace's current date when that is later.
 * Expiry (`licenceValidTo`, `qualifiedPersonValidTo`) stays compared with `at`.
 */
export function regulatoryStartInstant(at: Date, timeZone?: string | null): Date {
  const workspaceDay = new Date(`${workspaceToday(timeZone, at)}T00:00:00.000Z`);
  return workspaceDay > at ? workspaceDay : at;
}

/**
 * The Prisma filter for the branch regulatory profile version in force at `at`
 * on the workspace's calendar day ({@link regulatoryStartInstant}). Every
 * "current profile" lookup uses it so the guard, the receipt, the dispensing
 * label and the reminders never disagree about which version applies.
 */
export function regulatoryProfileInForceWhere(at: Date, timeZone?: string | null) {
  const startedAt = regulatoryStartInstant(at, timeZone);
  return {
    effectiveFrom: { lte: startedAt },
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: startedAt } }],
  };
}
