import 'server-only';

import { z } from 'zod';

import { recordAudit } from '@/server/audit';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';

import {
  PHARMACY_DEFAULT_DAY_END_HOUR,
  PHARMACY_MAX_DAY_END_HOUR,
  pharmacyBusinessDate,
  pharmacyBusinessDay,
  pharmacyDayEndHour,
  pharmacyDayEndLabel,
} from './business-day';
import { lockPharmacyDay } from './settlement';
import type { LedgerScope } from './stock-ledger';

/** DEV-958A: the audit action of a change to a branch's "day ends at" hour. */
export const PHARMACY_DAY_END_HOUR_SET_ACTION = 'pharmacy.branch.day_end_hour.set';

export const pharmacyDayEndHourSchema = z
  .number()
  .int()
  .min(PHARMACY_DEFAULT_DAY_END_HOUR)
  .max(PHARMACY_MAX_DAY_END_HOUR);

export class PharmacyDayEndHourError extends Error {
  constructor(readonly reason: 'BRANCH_NOT_FOUND' | 'DRAWERS_OPEN' | 'REVISION_CONFLICT') {
    super(reason);
    this.name = 'PharmacyDayEndHourError';
  }
}

/** Who changes the hour, as the audit entry names them. */
export type PharmacyDayEndHourActor = {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  isSupportSession?: boolean;
  supportSessionId?: string | null;
  platformUserId?: string | null;
};

async function openDrawerCount(db: ScopedDb, scope: LedgerScope) {
  return db.pharmacyDrawerSession.count({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, status: 'OPEN' },
  });
}

/**
 * DEV-958A — the branch's "day ends at" hour, the business day it gives now, and whether it
 * may be changed now (no drawer of the branch is open).
 */
export async function readPharmacyDayEndHourSetting(
  db: ScopedDb,
  scope: LedgerScope,
  now: Date = new Date()
) {
  const branch = await db.pharmacyBranch.findFirst({
    where: { organizationId: scope.organizationId, id: scope.branchId, active: true },
    select: { id: true, businessDayEndsAtHour: true, businessDayEndsAtRevision: true },
  });
  if (!branch) throw new PharmacyDayEndHourError('BRANCH_NOT_FOUND');
  const organization = await db.organization.findUnique({
    where: { id: scope.organizationId },
    select: { timezone: true },
  });
  const timeZone = workspaceTimezone(organization?.timezone);
  const dayEndsAtHour = pharmacyDayEndHour(branch.businessDayEndsAtHour);
  return {
    branchId: branch.id,
    dayEndsAtHour,
    revision: branch.businessDayEndsAtRevision,
    timeZone,
    currentBusinessDay: pharmacyBusinessDay({ timeZone, dayEndsAtHour }, now),
    openDrawers: await openDrawerCount(db, scope),
  };
}

/**
 * DEV-958A — change when the branch's business day ends. The rule: refused while any drawer
 * of the branch is open, because an open drawer belongs to the business day it was opened on
 * and moving the boundary under it would put its later sales on another day. Close the
 * drawers (day close), change the hour, then open the next day's drawers. Optimistic on the
 * branch's revision, and audited with the before and after hour in the same transaction.
 * Nothing already recorded moves: every business date already stamped on a drawer, sale,
 * tender, refund or close keeps its value; the hour only places new instants.
 *
 * The day locks of today under both the old and the new hour are held while the drawers are
 * counted, so a day close, reopen or drawer open on either day waits for this change.
 */
export async function savePharmacyDayEndHour(
  db: ScopedDb,
  scope: LedgerScope,
  input: { revision: number; dayEndsAtHour: number },
  actor: PharmacyDayEndHourActor,
  now: Date = new Date()
) {
  const next = pharmacyDayEndHourSchema.parse(input.dayEndsAtHour);
  const branch = await db.pharmacyBranch.findFirst({
    where: { organizationId: scope.organizationId, id: scope.branchId, active: true },
    select: { id: true, name: true, businessDayEndsAtHour: true, businessDayEndsAtRevision: true },
  });
  if (!branch) throw new PharmacyDayEndHourError('BRANCH_NOT_FOUND');
  if (branch.businessDayEndsAtRevision !== input.revision)
    throw new PharmacyDayEndHourError('REVISION_CONFLICT');
  const previous = pharmacyDayEndHour(branch.businessDayEndsAtHour);
  if (previous === next)
    return { branchId: branch.id, dayEndsAtHour: next, revision: input.revision };
  const organization = await db.organization.findUnique({
    where: { id: scope.organizationId },
    select: { timezone: true },
  });
  const timeZone = organization?.timezone;
  const days = [
    pharmacyBusinessDate({ timeZone, dayEndsAtHour: previous }, now),
    pharmacyBusinessDate({ timeZone, dayEndsAtHour: next }, now),
  ]
    .map((date) => date.toISOString())
    .sort()
    .filter((day, index, all) => all.indexOf(day) === index);
  // In one order, so two changes cannot deadlock on each other's day.
  for (const day of days) await lockPharmacyDay(db, scope, new Date(day));
  if ((await openDrawerCount(db, scope)) > 0) throw new PharmacyDayEndHourError('DRAWERS_OPEN');
  const updated = await db.pharmacyBranch.updateMany({
    where: {
      organizationId: scope.organizationId,
      id: branch.id,
      active: true,
      businessDayEndsAtRevision: input.revision,
    },
    data: { businessDayEndsAtHour: next, businessDayEndsAtRevision: { increment: 1 } },
  });
  if (updated.count !== 1) throw new PharmacyDayEndHourError('REVISION_CONFLICT');
  const revision = input.revision + 1;
  await recordAudit(
    {
      organizationId: scope.organizationId,
      actorType: 'USER',
      actorId: actor.id,
      actorName: actor.name ?? null,
      actorEmail: actor.email ?? null,
      actorRole: actor.role ?? null,
      source: 'TRPC',
      category: 'PHARMACY',
      operation: 'UPDATE',
      action: PHARMACY_DAY_END_HOUR_SET_ACTION,
      description: `Business day now ends at ${pharmacyDayEndLabel(next)} (was ${pharmacyDayEndLabel(previous)})`,
      targetType: 'PharmacyBranch',
      targetId: branch.id,
      targetLabel: branch.name,
      changes: { businessDayEndsAtHour: { before: previous, after: next } },
      metadata: {
        revision,
        ...(actor.isSupportSession
          ? {
              supportSessionId: actor.supportSessionId ?? null,
              platformUserId: actor.platformUserId ?? null,
              actingAsTenantUserId: actor.id,
            }
          : {}),
      },
      path: 'pharmacySales.saveDayEndHour',
    },
    db
  );
  return { branchId: branch.id, dayEndsAtHour: next, revision };
}
