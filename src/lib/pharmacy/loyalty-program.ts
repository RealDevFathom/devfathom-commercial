import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import {
  assertLoyaltyEarnRule,
  LOYALTY_POINT_VALUE_MINOR,
  type LoyaltyEarnMode,
  type LoyaltyEarnRule,
} from '@/lib/commerce/loyalty-arithmetic';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { lockCustomerConsent } from './consent-writer';

/**
 * DEV-746: the owner's setup options. Each resolves to one immutable program version.
 * Percentages are stored as basis points over LOYALTY_PERCENT_SPEND_MINOR.
 */
export const LOYALTY_EARN_PRESETS = [
  { id: 'percent-1', label: '1% of spend', rule: percentRule(100) },
  { id: 'percent-2', label: '2% of spend', rule: percentRule(200) },
  { id: 'percent-5', label: '5% of spend', rule: percentRule(500) },
  { id: 'step-100', label: '1 point for every PKR 100 spent', rule: stepRule(1, 100) },
  { id: 'step-1000', label: '1 point for every PKR 1,000 spent', rule: stepRule(1, 1_000) },
] as const;
export type LoyaltyEarnPresetId = (typeof LOYALTY_EARN_PRESETS)[number]['id'];

/**
 * A percentage of spend paid back in points. DEV-764: at a redemption value of V minor per
 * point, `basisPoints` per (10,000 x V) minor pays back exactly that percentage; at the
 * original PKR 1 per point this is LOYALTY_PERCENT_SPEND_MINOR, as DEV-746 stored it.
 */
export function percentRule(
  basisPoints: number,
  pointValueMinor = LOYALTY_POINT_VALUE_MINOR
): LoyaltyEarnRule & { earnMode: LoyaltyEarnMode } {
  return {
    earnMode: 'PERCENT_OF_SPEND',
    earnPoints: basisPoints,
    perSpendMinor: 10_000 * pointValueMinor,
  };
}

export function stepRule(
  points: number,
  stepRupees: number
): LoyaltyEarnRule & { earnMode: LoyaltyEarnMode } {
  return { earnMode: 'POINTS_PER_SPEND_STEP', earnPoints: points, perSpendMinor: stepRupees * 100 };
}

/** The rule in effect now: the newest version. Null means the owner has not set a rate. */
export async function currentLoyaltyProgram(db: ScopedDb, organizationId: string) {
  return db.pharmacyLoyaltyProgramVersion.findFirst({
    where: { organizationId },
    orderBy: { version: 'desc' },
  });
}

/**
 * DEV-764: the version in force, read under a shared lock on the program, inside the caller's
 * transaction. A concurrent owner save (which takes the exclusive lock) either commits before
 * this read or waits until the caller's transaction ends, so a redemption value or adjustment
 * ceiling cannot change under a redemption or adjustment that is using it.
 */
export async function lockedLoyaltyProgram(db: ScopedDb, organizationId: string) {
  await db.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`pharmacy-loyalty-program:${organizationId}`}, 0))`
  );
  return currentLoyaltyProgram(db, organizationId);
}

export async function listLoyaltyProgramVersions(db: ScopedDb, organizationId: string) {
  return db.pharmacyLoyaltyProgramVersion.findMany({
    where: { organizationId },
    orderBy: { version: 'desc' },
    take: 20,
  });
}

/**
 * DEV-764: the largest manual adjustment a manager may make before the owner sets one (the
 * column default); the owner can change it in the program settings.
 */
export const DEFAULT_MANAGER_ADJUST_LIMIT_POINTS = 500;
export const LOYALTY_MAX_MANAGER_ADJUST_LIMIT_POINTS = 1_000_000;

/** DEV-764: the most days an owner may let a point last (ten years). */
export const LOYALTY_MAX_EXPIRY_DAYS = 3650;

/** A version's full settings: the earning rule plus DEV-764's program settings. */
export type LoyaltyProgramSettings = LoyaltyEarnRule & {
  expiryDays?: number | null;
  khataEarns?: boolean;
  managerAdjustLimitPoints?: number;
};
type PriorVersion = Awaited<ReturnType<typeof currentLoyaltyProgram>>;

export function assertLoyaltyProgramSettings(settings: LoyaltyProgramSettings) {
  const { expiryDays, managerAdjustLimitPoints: limit } = settings;
  if (
    limit !== undefined &&
    (!Number.isSafeInteger(limit) || limit < 0 || limit > LOYALTY_MAX_MANAGER_ADJUST_LIMIT_POINTS)
  )
    throw new RangeError('INVALID_ADJUST_LIMIT');
  assertLoyaltyEarnRule(settings);
  if (
    expiryDays !== undefined &&
    expiryDays !== null &&
    (!Number.isSafeInteger(expiryDays) || expiryDays < 1 || expiryDays > LOYALTY_MAX_EXPIRY_DAYS)
  )
    throw new RangeError('INVALID_EXPIRY');
}

/**
 * Appends the next program version. Caller is the audited owner procedure, inside its
 * tenant transaction. Earlier versions and every points entry stay as they are. Returns
 * the version it replaced, read under the same lock, so the audit records the real change.
 * DEV-764: `settings` may be built from that version, so a setting the owner did not change
 * is carried forward from what is in force, never from a stale read.
 */
export async function publishLoyaltyProgramVersion(
  db: ScopedDb,
  scope: { organizationId: string; actorId: string },
  settings: LoyaltyProgramSettings | ((prior: PriorVersion) => LoyaltyProgramSettings)
) {
  if (typeof settings !== 'function') assertLoyaltyProgramSettings(settings);
  // Serializes concurrent owner saves so version numbers stay dense and ordered.
  await db.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pharmacy-loyalty-program:${scope.organizationId}`}, 0))`
  );
  const prior = await currentLoyaltyProgram(db, scope.organizationId);
  const rule = typeof settings === 'function' ? settings(prior) : settings;
  assertLoyaltyProgramSettings(rule);
  const version = await db.pharmacyLoyaltyProgramVersion.create({
    data: {
      organizationId: scope.organizationId,
      version: (prior?.version ?? 0) + 1,
      earnMode: rule.earnMode as LoyaltyEarnMode,
      earnPoints: rule.earnPoints,
      perSpendMinor: rule.perSpendMinor,
      redemptionValueMinor: rule.redemptionValueMinor,
      expiryDays: rule.expiryDays,
      khataEarns: rule.khataEarns,
      managerAdjustLimitPoints: rule.managerAdjustLimitPoints,
      actorId: scope.actorId,
    },
  });
  return { prior, version };
}

/**
 * Locks the customer's consent rows, then answers whether LOYALTY consent stands now.
 * Points are only earned while the customer consents at the moment of earning, and (DEV-764)
 * while they are an enrolled member: a deactivated member earns nothing until re-enrolled.
 */
export async function hasLoyaltyEarningConsent(
  db: ScopedDb,
  organizationId: string,
  customerId: string
) {
  await lockCustomerConsent(db, organizationId, customerId);
  const customer = await db.pharmacyCustomer.findFirst({
    where: { id: customerId, organizationId, active: true },
    select: { patientId: true, loyaltyActive: true },
  });
  if (!customer?.patientId || customer.loyaltyActive === false) return false;
  const consent = await db.patientConsent.findFirst({
    where: { organizationId, patientId: customer.patientId, purpose: 'LOYALTY' },
    orderBy: [{ version: 'desc' }, { recordedAt: 'desc' }],
    select: { granted: true, revokedAt: true },
  });
  return Boolean(consent?.granted && !consent.revokedAt);
}
