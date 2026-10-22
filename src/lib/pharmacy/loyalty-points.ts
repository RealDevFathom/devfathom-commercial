import 'server-only';

import { randomUUID } from 'node:crypto';

import { Prisma } from '@/generated/prisma/client';
import {
  categoryEarnPoints,
  DEFAULT_LOYALTY_POINTS_RULES,
  type LoyaltyPointsRules,
} from '@/lib/commerce/loyalty-arithmetic';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import type { LedgerScope } from './stock-ledger';

export type PharmacyPointsPolicy = LoyaltyPointsRules & {
  pointsExpiryMonths: number;
  goldTierEnabled: boolean;
  goldTierThresholdMinor: number;
};

export const DEFAULT_PHARMACY_POINTS_POLICY: PharmacyPointsPolicy = {
  ...DEFAULT_LOYALTY_POINTS_RULES,
  pointsExpiryMonths: 6,
  goldTierEnabled: false,
  goldTierThresholdMinor: 5_000_000,
};

export function expiryDate(earnedAt: Date, months: number) {
  if (!Number.isInteger(months) || months <= 0) throw new RangeError('INVALID_EXPIRY_MONTHS');
  const expiresAt = new Date(earnedAt);
  expiresAt.setUTCMonth(expiresAt.getUTCMonth() + months);
  return expiresAt;
}

export function allocateNetPaid(
  subtotals: { medicineMinor: number; nonDrugMinor: number },
  netPaidMinor: number
) {
  const totalMinor = subtotals.medicineMinor + subtotals.nonDrugMinor;
  if ([subtotals.medicineMinor, subtotals.nonDrugMinor, netPaidMinor, totalMinor]
    .some((value) => !Number.isSafeInteger(value) || value < 0)) throw new RangeError('INVALID_MONEY');
  if (totalMinor === 0 || netPaidMinor === 0) return { medicineMinor: 0, nonDrugMinor: 0 };
  const capped = Math.min(netPaidMinor, totalMinor);
  // BigInt keeps the proportional split integer-only; deterministic remainder goes to non-drug.
  const medicineMinor = Number(BigInt(capped) * BigInt(subtotals.medicineMinor) / BigInt(totalMinor));
  return { medicineMinor, nonDrugMinor: capped - medicineMinor };
}

export function fifoExpiry(entries: Array<{ id: string; points: number; expiresAt: Date }>, consumed: number, at: Date) {
  let remainingConsumed = consumed;
  const expired: Array<{ sourceEntryId: string; points: number }> = [];
  for (const entry of [...entries].sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())) {
    const available = Math.max(0, entry.points - remainingConsumed);
    remainingConsumed = Math.max(0, remainingConsumed - entry.points);
    if (available > 0 && entry.expiresAt <= at)
      expired.push({ sourceEntryId: entry.id, points: -available });
  }
  return expired;
}

export async function readPointsPolicy(db: ScopedDb, organizationId: string) {
  const rows = await db.$queryRaw<PharmacyPointsPolicy[]>(Prisma.sql`
    SELECT "medicineEarnPoints", "nonDrugEarnPoints", "earnBlockMinor", "pointValueMinor",
      "minimumRedemptionPoints", "pointsExpiryMonths", "goldTierEnabled",
      "goldTierThresholdMinor", "goldTierMultiplier"
    FROM pharmacy_loyalty_settings WHERE "organizationId"=${organizationId} LIMIT 1`);
  return rows[0] ?? DEFAULT_PHARMACY_POINTS_POLICY;
}

export async function expireCustomerPoints(
  db: ScopedDb,
  scope: LedgerScope,
  customerId: string,
  at = new Date()
) {
  await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_customers
    WHERE id=${customerId} AND "organizationId"=${scope.organizationId} FOR UPDATE`);
  const earns = await db.$queryRaw<Array<{ id: string; saleId: string; points: number; expiresAt: Date }>>(Prisma.sql`
    SELECT id, "saleId", points, "expiresAt" FROM pharmacy_loyalty_points_entries
    WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId}
      AND "customerId"=${customerId} AND kind='EARN' AND "expiresAt" IS NOT NULL
    ORDER BY "expiresAt", id`);
  const debitRows = await db.$queryRaw<Array<{ points: number }>>(Prisma.sql`
    SELECT COALESCE(SUM(points),0)::integer AS points FROM pharmacy_loyalty_points_entries
    WHERE "organizationId"=${scope.organizationId} AND "branchId"=${scope.branchId}
      AND "customerId"=${customerId} AND kind IN ('REDEEM','EARN_REVERSAL','EXPIRE','REVERSAL')`);
  const plan = fifoExpiry(
    earns, -(debitRows[0]?.points ?? 0), at
  );
  for (const item of plan) {
    const source = earns.find((row) => row.id === item.sourceEntryId)!;
    await db.$executeRaw(Prisma.sql`INSERT INTO pharmacy_loyalty_points_entries
      (id,"organizationId","branchId","customerId","saleId",kind,points,"sourceEntryId","actorId","idempotencyKey","occurredAt")
      VALUES (${randomUUID()},${scope.organizationId},${scope.branchId},${customerId},${source.saleId},
        'EXPIRE',${item.points},${source.id},${scope.actorId},${`loyalty:expire:${source.id}`},${at})
      ON CONFLICT ("organizationId","idempotencyKey") DO NOTHING`);
  }
  return plan;
}

export { categoryEarnPoints };
