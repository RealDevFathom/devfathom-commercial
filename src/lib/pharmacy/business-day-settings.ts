import 'server-only';

import { z } from 'zod';

import type { Prisma } from '@/generated/prisma/client';
import { recordAudit } from '@/server/audit';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';

import {
  PHARMACY_DEFAULT_DAY_END_HOUR,
  PHARMACY_MAX_DAY_END_HOUR,
  pharmacyBusinessDay,
  pharmacyDayEndHourOn,
  pharmacyDayEndLabel,
  pharmacyDayEndSchedule,
  shiftPharmacyDay,
} from './business-day';
import type { LedgerScope } from './stock-ledger';

/** DEV-958A: the audit action of a change to a branch's "day ends at" hour. */
export const PHARMACY_DAY_END_HOUR_SET_ACTION = 'pharmacy.branch.day_end_hour.set';

export const pharmacyDayEndHourSchema = z
  .number()
  .int()
  .min(PHARMACY_DEFAULT_DAY_END_HOUR)
  .max(PHARMACY_MAX_DAY_END_HOUR);

export class PharmacyDayEndHourError extends Error {
  constructor(readonly reason: 'BRANCH_NOT_FOUND' | 'REVISION_CONFLICT') {
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

/**
 * DEV-958A — the first business day a change made at `now` applies to: the day after the next
 * business day. Today, every earlier day and the next day all keep the start they had; the next
 * day runs from its usual start to the new hour on the day after, so it is the one day that is
 * longer (a later hour) or shorter (an earlier one). A day already closed is never reopened by a
 * change, and a day being traded on keeps its end.
 */
export function pharmacyDayEndChangeFrom(currentBusinessDay: string): string {
  return shiftPharmacyDay(currentBusinessDay, 2);
}

function readState(branch: { businessDayEndsAtHistory: unknown }, timeZone: string, now: Date) {
  const clock = { timeZone, dayEnd: branch.businessDayEndsAtHistory };
  const currentBusinessDay = pharmacyBusinessDay(clock, now);
  const nextBusinessDay = shiftPharmacyDay(currentBusinessDay, 1);
  const nextChangeDay = pharmacyDayEndChangeFrom(currentBusinessDay);
  // A day ends where the next one starts: today ends at the hour in force on tomorrow, and
  // tomorrow at the hour in force on the day after, which is what a change made now replaces.
  const today = pharmacyDayEndHourOn(clock, nextBusinessDay);
  const scheduled = pharmacyDayEndHourOn(clock, nextChangeDay);
  // Every change still ahead, as the first business day that ends at its hour: changes for the
  // same day collapse to the last one made, and one that keeps the hour is not a change.
  const ahead: { fromBusinessDay: string; hour: number }[] = [];
  for (const change of pharmacyDayEndSchedule(branch.businessDayEndsAtHistory)) {
    if (change.from <= nextBusinessDay) continue;
    const fromBusinessDay = shiftPharmacyDay(change.from, -1);
    const last = ahead.at(-1);
    if (last?.fromBusinessDay === fromBusinessDay) last.hour = change.hour;
    else ahead.push({ fromBusinessDay, hour: change.hour });
  }
  const pending: typeof ahead = [];
  let previous = today;
  for (const change of ahead) {
    if (change.hour !== previous) pending.push(change);
    previous = change.hour;
  }
  return {
    currentBusinessDay,
    nextBusinessDay,
    nextChangeDay,
    today,
    scheduled,
    pending,
  };
}

/**
 * DEV-958A — the hour this branch's business day ends at today, every change already set for a
 * later day (as the first business day that ends at its hour), today's business day, and the
 * first business day a change made now would end at its new hour (tomorrow).
 */
export async function readPharmacyDayEndHourSetting(
  db: ScopedDb,
  scope: LedgerScope,
  now: Date = new Date()
) {
  const branch = await db.pharmacyBranch.findFirst({
    where: { organizationId: scope.organizationId, id: scope.branchId, active: true },
    select: { id: true, businessDayEndsAtHistory: true, businessDayEndsAtRevision: true },
  });
  if (!branch) throw new PharmacyDayEndHourError('BRANCH_NOT_FOUND');
  const organization = await db.organization.findUnique({
    where: { id: scope.organizationId },
    select: { timezone: true },
  });
  const timeZone = workspaceTimezone(organization?.timezone);
  const state = readState(branch, timeZone, now);
  return {
    branchId: branch.id,
    dayEndsAtHour: state.today,
    scheduledHour: state.scheduled,
    pendingChanges: state.pending,
    revision: branch.businessDayEndsAtRevision,
    timeZone,
    currentBusinessDay: state.currentBusinessDay,
    nextBusinessDay: state.nextBusinessDay,
  };
}

/**
 * DEV-958A — change when the branch's business day ends. The change is appended to the
 * branch's dated history (never rewritten) and applies from the day after the next business
 * day ({@link pharmacyDayEndChangeFrom}), so it never moves a boundary of today or any earlier
 * day: every past day's close and report keep exactly the window they had, and nothing already
 * recorded changes. Because no day that has begun is touched, a change needs no drawer to be
 * closed and can be made at any time. Optimistic on the branch's revision, and audited with the
 * before and after hour and the first day it applies to, in the same transaction.
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
    select: {
      id: true,
      name: true,
      businessDayEndsAtHistory: true,
      businessDayEndsAtRevision: true,
    },
  });
  if (!branch) throw new PharmacyDayEndHourError('BRANCH_NOT_FOUND');
  if (branch.businessDayEndsAtRevision !== input.revision)
    throw new PharmacyDayEndHourError('REVISION_CONFLICT');
  const organization = await db.organization.findUnique({
    where: { id: scope.organizationId },
    select: { timezone: true },
  });
  const state = readState(branch, workspaceTimezone(organization?.timezone), now);
  if (state.scheduled === next)
    return {
      branchId: branch.id,
      dayEndsAtHour: next,
      fromBusinessDay: null,
      revision: input.revision,
    };
  const stored = Array.isArray(branch.businessDayEndsAtHistory)
    ? (branch.businessDayEndsAtHistory as Prisma.JsonArray)
    : [];
  const change = {
    from: state.nextChangeDay,
    hour: next,
    actorId: actor.id,
    at: now.toISOString(),
  };
  const updated = await db.pharmacyBranch.updateMany({
    where: {
      organizationId: scope.organizationId,
      id: branch.id,
      active: true,
      businessDayEndsAtRevision: input.revision,
    },
    data: {
      businessDayEndsAtHistory: [...stored, change],
      businessDayEndsAtRevision: { increment: 1 },
    },
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
      description: `From the business day of ${state.nextBusinessDay}, the day ends at ${pharmacyDayEndLabel(next)} (was ${pharmacyDayEndLabel(state.scheduled)})`,
      targetType: 'PharmacyBranch',
      targetId: branch.id,
      targetLabel: branch.name,
      changes: {
        businessDayEndsAtHour: { before: state.scheduled, after: next },
        // The first business day that ends at the new hour, and the first that starts at it.
        endsFromBusinessDay: state.nextBusinessDay,
        startsFromBusinessDay: state.nextChangeDay,
      },
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
  return {
    branchId: branch.id,
    dayEndsAtHour: next,
    fromBusinessDay: state.nextBusinessDay,
    revision,
  };
}
