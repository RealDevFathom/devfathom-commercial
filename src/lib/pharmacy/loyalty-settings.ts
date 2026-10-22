import 'server-only';

import { randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { inPointsTransaction } from './loyalty-points';

export type LoyaltyPointsSettings = {
  medicineEarnPoints: number;
  nonDrugEarnPoints: number;
  earnBlockMinor: number;
  pointValueMinor: number;
  minimumRedemptionPoints: number;
  pointsExpiryMonths: number;
  goldTierEnabled: boolean;
  goldTierThresholdMinor: number;
  goldTierMultiplier: number;
};

/** Every policy field of the tenant's settings row, as the audit records it. */
export type LoyaltySettingsSnapshot = LoyaltyPointsSettings & {
  voucherScope: 'WHOLE_BASKET' | 'NON_DRUG_ONLY';
  voucherValidityDays: number;
  maxIssuedPerCustomerPerPeriod: number;
  maxIssuedPerPhonePerPeriod: number;
  maxRedeemedPerCustomerPerPeriod: number;
  maxRedeemedPerPhonePerPeriod: number;
  abusePeriodDays: number;
  expiryOverrideGraceDays: number;
};

/** What governs a tenant that has no settings row yet: the column defaults. */
export const DEFAULT_LOYALTY_SETTINGS: LoyaltySettingsSnapshot = {
  voucherScope: 'WHOLE_BASKET',
  voucherValidityDays: 30,
  maxIssuedPerCustomerPerPeriod: 5,
  maxIssuedPerPhonePerPeriod: 5,
  maxRedeemedPerCustomerPerPeriod: 5,
  maxRedeemedPerPhonePerPeriod: 5,
  abusePeriodDays: 30,
  expiryOverrideGraceDays: 0,
  medicineEarnPoints: 1,
  nonDrugEarnPoints: 3,
  earnBlockMinor: 10_000,
  pointValueMinor: 100,
  minimumRedemptionPoints: 200,
  pointsExpiryMonths: 6,
  goldTierEnabled: false,
  goldTierThresholdMinor: 5_000_000,
  goldTierMultiplier: 2,
};

/**
 * Hold the tenant's loyalty-settings lock until the transaction ends. A first write has no
 * row for `SELECT ... FOR UPDATE` to lock, so every settings writer serializes on this
 * tenant-keyed advisory lock before it reads: the same key `updateLoyaltySettings` (the
 * voucher settings) takes, because both write the one settings row.
 */
export async function lockLoyaltySettings(tx: ScopedDb, organizationId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 1280266068))`);
}

async function readSnapshot(
  tx: ScopedDb,
  organizationId: string
): Promise<LoyaltySettingsSnapshot | null> {
  const rows = await tx.$queryRaw<LoyaltySettingsSnapshot[]>(Prisma.sql`
    SELECT "voucherScope"::text AS "voucherScope", "voucherValidityDays",
      "maxIssuedPerCustomerPerPeriod", "maxIssuedPerPhonePerPeriod",
      "maxRedeemedPerCustomerPerPeriod", "maxRedeemedPerPhonePerPeriod", "abusePeriodDays",
      "expiryOverrideGraceDays", "medicineEarnPoints", "nonDrugEarnPoints", "earnBlockMinor",
      "pointValueMinor", "minimumRedemptionPoints", "pointsExpiryMonths", "goldTierEnabled",
      "goldTierThresholdMinor", "goldTierMultiplier"
    FROM pharmacy_loyalty_settings WHERE "organizationId" = ${organizationId}`);
  return rows[0] ?? null;
}

/**
 * Write the tenant's points policy and its audit in one transaction, under the settings
 * lock: two writers, first-time or not, run one after the other, the second reads the
 * first's committed result, and each audit row's old value is exactly the previous
 * row's new value (the column defaults for the very first write).
 */
export async function writeLoyaltyPointsSettings(
  db: ScopedDb,
  input: { organizationId: string; actorId: string; settings: LoyaltyPointsSettings }
): Promise<LoyaltySettingsSnapshot> {
  const { organizationId, actorId, settings } = input;
  return inPointsTransaction(db, async (tx) => {
    await lockLoyaltySettings(tx, organizationId);
    const oldValue = (await readSnapshot(tx, organizationId)) ?? DEFAULT_LOYALTY_SETTINGS;
    await tx.$executeRaw(Prisma.sql`INSERT INTO pharmacy_loyalty_settings
      (id, "organizationId", "medicineEarnPoints", "nonDrugEarnPoints", "earnBlockMinor",
       "pointValueMinor", "minimumRedemptionPoints", "pointsExpiryMonths", "goldTierEnabled",
       "goldTierThresholdMinor", "goldTierMultiplier", "createdAt", "updatedAt")
      VALUES (${randomUUID()}, ${organizationId}, ${settings.medicineEarnPoints},
        ${settings.nonDrugEarnPoints}, ${settings.earnBlockMinor}, ${settings.pointValueMinor},
        ${settings.minimumRedemptionPoints}, ${settings.pointsExpiryMonths},
        ${settings.goldTierEnabled}, ${settings.goldTierThresholdMinor},
        ${settings.goldTierMultiplier}, now(), now())
      ON CONFLICT ("organizationId") DO UPDATE SET
        "medicineEarnPoints" = EXCLUDED."medicineEarnPoints",
        "nonDrugEarnPoints" = EXCLUDED."nonDrugEarnPoints",
        "earnBlockMinor" = EXCLUDED."earnBlockMinor",
        "pointValueMinor" = EXCLUDED."pointValueMinor",
        "minimumRedemptionPoints" = EXCLUDED."minimumRedemptionPoints",
        "pointsExpiryMonths" = EXCLUDED."pointsExpiryMonths",
        "goldTierEnabled" = EXCLUDED."goldTierEnabled",
        "goldTierThresholdMinor" = EXCLUDED."goldTierThresholdMinor",
        "goldTierMultiplier" = EXCLUDED."goldTierMultiplier",
        "updatedAt" = now()`);
    const newValue = (await readSnapshot(tx, organizationId))!;
    await tx.$executeRaw(Prisma.sql`INSERT INTO pharmacy_loyalty_settings_audits
      (id, "organizationId", "actorId", "oldValue", "newValue", "occurredAt")
      VALUES (${randomUUID()}, ${organizationId}, ${actorId},
        ${JSON.stringify(oldValue)}::jsonb, ${JSON.stringify(newValue)}::jsonb, now())`);
    return newValue;
  });
}
