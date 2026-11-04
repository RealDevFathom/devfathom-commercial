import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import {
  generateDueSopOccurrences,
  type GenerateResult,
} from '@/lib/restaurant/sop-occurrence-generation';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { PharmacySopSiteRef } from '@/lib/pharmacy/sop-adapter';

/**
 * DEV-751 — per-branch automatic scheduling for pharmacy procedures.
 *
 * Procedures are instructions and proof for the people assigned to them. They
 * never block, gate or change opening, closing or any other pharmacy workflow,
 * and nothing here is read by pharmacy operation code.
 *
 * Automatic scheduling is OFF unless a manager turns it on for a branch. The
 * setting is append-only (`pharmacy_sop_site_settings`): every change is a new
 * row with who changed it and why, and the newest row for a branch wins. No row
 * means OFF. With it off, a manager still creates the day's work explicitly
 * ("Create today's work now"), which is never affected by this setting.
 *
 * `pharmacySopAutoScheduledBranchIds` and `generateAutoPharmacySopBranchOccurrences`
 * are called only by the background jobs in `sop-auto-schedule-job.ts`, which
 * exist only while at least one branch is ON (see that module). Neither is
 * exposed on a route. Both run on the caller's `db` alone: they never open a
 * client or connection of their own.
 */

/** No row for a branch reads as this value. */
export const PHARMACY_SOP_AUTO_SCHEDULE_DEFAULT = false;

export const PHARMACY_SOP_SETTING_REASON_MAX_LENGTH = 500;

export type PharmacySopAutoScheduleSetting = {
  pharmacyBranchId: string;
  autoScheduleEnabled: boolean;
  /** Null when the branch has never been changed (the default applies). */
  changedByUserId: string | null;
  reason: string | null;
  changedAt: Date | null;
};

const SETTING_SELECT = {
  pharmacyBranchId: true,
  autoScheduleEnabled: true,
  changedByUserId: true,
  reason: true,
  createdAt: true,
} as const;

/** Newest first; `id` breaks a same-instant tie deterministically. */
const NEWEST_FIRST = [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

type SettingRow = {
  pharmacyBranchId: string;
  autoScheduleEnabled: boolean;
  changedByUserId: string;
  reason: string | null;
  createdAt: Date;
};

function toSetting(
  pharmacyBranchId: string,
  row: SettingRow | null
): PharmacySopAutoScheduleSetting {
  if (!row) {
    return {
      pharmacyBranchId,
      autoScheduleEnabled: PHARMACY_SOP_AUTO_SCHEDULE_DEFAULT,
      changedByUserId: null,
      reason: null,
      changedAt: null,
    };
  }
  return {
    pharmacyBranchId: row.pharmacyBranchId,
    autoScheduleEnabled: row.autoScheduleEnabled,
    changedByUserId: row.changedByUserId,
    reason: row.reason,
    changedAt: row.createdAt,
  };
}

/** The branch's current automatic-scheduling setting; OFF when never set. */
export async function pharmacySopAutoSchedule(
  db: ScopedDb,
  input: { pharmacyBranchId: string }
): Promise<PharmacySopAutoScheduleSetting> {
  const row = await db.pharmacySopSiteSetting.findFirst({
    where: { pharmacyBranchId: input.pharmacyBranchId },
    orderBy: NEWEST_FIRST,
    select: SETTING_SELECT,
  });
  return toSetting(input.pharmacyBranchId, row);
}

function normalizeReason(reason: string | null | undefined): string | null {
  const trimmed = (reason ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.length > PHARMACY_SOP_SETTING_REASON_MAX_LENGTH) {
    throw new RangeError(
      `The reason must be ${PHARMACY_SOP_SETTING_REASON_MAX_LENGTH} characters or fewer.`
    );
  }
  return trimmed;
}

/**
 * Turn automatic scheduling on or off for one branch by appending a row.
 * Idempotent: when the current value already matches, nothing is written.
 * The caller has already resolved `site` within the session's branch scope.
 */
export async function setPharmacySopAutoSchedule(
  db: ScopedDb,
  input: {
    site: Pick<PharmacySopSiteRef, 'pharmacyBranchId'>;
    enabled: boolean;
    userId: string;
    reason?: string | null;
  }
): Promise<{ setting: PharmacySopAutoScheduleSetting; changed: boolean }> {
  const { pharmacyBranchId } = input.site;
  const reason = normalizeReason(input.reason);
  return runInTransaction(db, async (tx) => {
    // Serialize changes per branch so two concurrent toggles cannot both read
    // the old value and both append the same change.
    const lockKey = `pharmacy-sop-auto-schedule:${pharmacyBranchId}`;
    await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const current = await pharmacySopAutoSchedule(tx, { pharmacyBranchId });
    if (current.autoScheduleEnabled === input.enabled) {
      return { setting: current, changed: false };
    }
    const row = await tx.pharmacySopSiteSetting.create({
      data: {
        pharmacyBranchId,
        autoScheduleEnabled: input.enabled,
        changedByUserId: input.userId,
        reason,
      },
      select: SETTING_SELECT,
    });
    return { setting: toSetting(pharmacyBranchId, row), changed: true };
  });
}

/**
 * The automatic paths (turning a branch ON and every hourly run) never
 * back-date: they materialise the branch's CURRENT business date and the
 * engine's default horizon (tomorrow) only. The engine's default one-day
 * lookback exists to backfill a missed restaurant run for its late/missed
 * sweep; here it would create yesterday's already-overdue procedures for a day
 * the branch was OFF. The explicit manager action ("Create today's work now")
 * keeps the engine default.
 */
export const PHARMACY_SOP_AUTO_LOOKBACK_DAYS = 0;

/**
 * The pharmacy branches whose latest setting is ON (active SOP sites only), in
 * the `db`'s organization. Reads only. The hourly job enqueues one per-branch
 * job for each of them; an empty list stops the chain.
 */
export async function pharmacySopAutoScheduledBranchIds(db: ScopedDb): Promise<string[]> {
  const sites = await db.pharmacySopSite.findMany({
    where: { pharmacyBranch: { active: true } },
    select: { pharmacyBranchId: true },
    orderBy: { pharmacyBranchId: 'asc' },
  });
  if (sites.length === 0) return [];

  const rows = await db.pharmacySopSiteSetting.findMany({
    where: { pharmacyBranchId: { in: sites.map((site) => site.pharmacyBranchId) } },
    orderBy: NEWEST_FIRST,
    select: { pharmacyBranchId: true, autoScheduleEnabled: true },
  });
  const latest = new Map<string, boolean>();
  for (const row of rows) {
    if (!latest.has(row.pharmacyBranchId)) {
      latest.set(row.pharmacyBranchId, row.autoScheduleEnabled);
    }
  }
  return sites
    .map((site) => site.pharmacyBranchId)
    .filter((id) => latest.get(id) ?? PHARMACY_SOP_AUTO_SCHEDULE_DEFAULT);
}

/**
 * Generate the due occurrences of ONE pharmacy branch for automatic
 * scheduling, on the caller's `db` only (the per-branch job's own transaction).
 * Re-reads the branch's SOP site and latest setting first: when the site is
 * missing (or its pharmacy branch inactive, or it belongs to another
 * organization, which RLS hides) or the setting is now OFF, nothing is
 * generated and `null` is returned. Otherwise the engine runs restricted to the
 * site's engine branch, never back-dated. Errors propagate to the caller.
 */
export async function generateAutoPharmacySopBranchOccurrences(
  db: ScopedDb,
  input: { pharmacyBranchId: string; now: Date }
): Promise<GenerateResult | null> {
  const site = await db.pharmacySopSite.findFirst({
    where: { pharmacyBranchId: input.pharmacyBranchId, pharmacyBranch: { active: true } },
    select: { pharmacyBranchId: true, sopBranchId: true },
  });
  if (!site) return null;
  const setting = await pharmacySopAutoSchedule(db, { pharmacyBranchId: site.pharmacyBranchId });
  if (!setting.autoScheduleEnabled) return null;
  return generateDueSopOccurrences(db, {
    now: input.now,
    branchIds: [site.sopBranchId],
    lookbackDays: PHARMACY_SOP_AUTO_LOOKBACK_DAYS,
  });
}

function runInTransaction<T>(db: ScopedDb, work: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return (db.$transaction as unknown as (fn: (tx: ScopedDb) => Promise<T>) => Promise<T>)(work);
}
