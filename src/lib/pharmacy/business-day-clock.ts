import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  pharmacyBusinessDate,
  pharmacyDayEndHour,
  PHARMACY_DEFAULT_DAY_END_HOUR,
  sharedPharmacyDayEndHour,
  type PharmacyDayClock,
} from './business-day';

/**
 * DEV-958A — the server's read of a branch's clock: the organisation zone and the branch's
 * "day ends at" hour. Every server path that places a new instant on a business day reads it
 * here, then asks `business-day.ts`. A branch that is missing, or another tenant's, reads as
 * midnight, the day used before DEV-958A; the caller's own branch checks still refuse it.
 */
export async function readPharmacyDayClock(
  db: ScopedDb,
  scope: { organizationId: string; branchId?: string | null }
): Promise<PharmacyDayClock> {
  const organization = await db.organization.findUnique({
    where: { id: scope.organizationId },
    select: { timezone: true },
  });
  return {
    timeZone: organization?.timezone,
    dayEndsAtHour: scope.branchId
      ? await readPharmacyBranchDayEndHour(db, scope.organizationId, scope.branchId)
      : PHARMACY_DEFAULT_DAY_END_HOUR,
  };
}

/** The stored day-end hour of one branch of the organisation (midnight when there is none). */
export async function readPharmacyBranchDayEndHour(
  db: ScopedDb,
  organizationId: string,
  branchId: string
): Promise<number> {
  const branch = await db.pharmacyBranch.findFirst({
    where: { organizationId, id: branchId },
    select: { businessDayEndsAtHour: true },
  });
  return pharmacyDayEndHour(branch?.businessDayEndsAtHour);
}

/** The day-end hour a report window over `branchIds` uses ({@link sharedPharmacyDayEndHour}). */
export async function readPharmacyReportDayEndHour(
  db: ScopedDb,
  organizationId: string,
  branchIds: readonly string[]
): Promise<{ dayEndsAtHour: number; mixed: boolean }> {
  if (!branchIds.length) return { dayEndsAtHour: PHARMACY_DEFAULT_DAY_END_HOUR, mixed: false };
  const branches = await db.pharmacyBranch.findMany({
    where: { organizationId, id: { in: [...branchIds] } },
    select: { businessDayEndsAtHour: true },
  });
  return sharedPharmacyDayEndHour(branches.map((branch) => branch.businessDayEndsAtHour));
}

/**
 * The clock a by-day report window over `branchIds` uses: the caller organisation's zone (the
 * reader's `timeZone`, loaded on the server) and the branches' shared day-end hour
 * ({@link readPharmacyReportDayEndHour}).
 */
export async function readPharmacyReportDayClock(
  db: ScopedDb,
  organizationId: string,
  branchIds: readonly string[],
  timeZone: string | null | undefined
): Promise<PharmacyDayClock & { mixed: boolean }> {
  const { dayEndsAtHour, mixed } = await readPharmacyReportDayEndHour(
    db,
    organizationId,
    branchIds
  );
  return { timeZone, dayEndsAtHour, mixed };
}

/** The branch's current business date, as the UTC-midnight `Date` a `@db.Date` column stores. */
export async function currentPharmacyBusinessDate(
  db: ScopedDb,
  scope: { organizationId: string; branchId?: string | null },
  now: Date = new Date()
): Promise<Date> {
  return pharmacyBusinessDate(await readPharmacyDayClock(db, scope), now);
}
