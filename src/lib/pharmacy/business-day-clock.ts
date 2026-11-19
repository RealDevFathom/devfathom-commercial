import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { pharmacyBusinessDate, type PharmacyDayClock, type PharmacyDayEnd } from './business-day';

/**
 * DEV-958A — the server's read of a branch's clock: the organisation zone and the branch's
 * dated "day ends at" history. Every server path that places a new instant on a business day
 * reads it here, then asks `business-day.ts`. A branch that is missing, or another tenant's,
 * reads as midnight, the day used before DEV-958A; the caller's own branch checks still refuse
 * it.
 */
export async function readPharmacyDayClock(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string }
): Promise<PharmacyDayClock> {
  const organization = await db.organization.findUnique({
    where: { id: scope.organizationId },
    select: { timezone: true },
  });
  return {
    timeZone: organization?.timezone,
    dayEnd: await readPharmacyBranchDayEnd(db, scope.organizationId, scope.branchId),
  };
}

/** The stored day-end history of one branch of the organisation (none reads as midnight). */
export async function readPharmacyBranchDayEnd(
  db: ScopedDb,
  organizationId: string,
  branchId: string
): Promise<PharmacyDayEnd> {
  const branch = await db.pharmacyBranch.findFirst({
    where: { organizationId, id: branchId },
    select: { businessDayEndsAtHistory: true },
  });
  return branch?.businessDayEndsAtHistory ?? [];
}

/** The branch's current business date, as the UTC-midnight `Date` a `@db.Date` column stores. */
export async function currentPharmacyBusinessDate(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  now: Date = new Date()
): Promise<Date> {
  return pharmacyBusinessDate(await readPharmacyDayClock(db, scope), now);
}
