import 'server-only';

import { randomUUID } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client';
import { requirePlatformSession, type PlatformIdentity } from '@/lib/platform/auth';
import { PlatformSecurityError } from '@/lib/platform/security';
import { withPlatformDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { getAiBudgetMinor } from './budget';

export type AIUsageBreakdown = { provider: string; tier: string; spendMinor: number };
export type MonthlyAIUsage = {
  month: string;
  from: Date;
  to: Date;
  breakdown: AIUsageBreakdown[];
  providerSpendMinor: Record<string, number>;
  tierSpendMinor: Record<string, number>;
  totalSpendMinor: number;
  anthropicSpendMinor: number;
  anthropicBudgetMinor: number;
  percentUsed: number;
};

/** Calendar month boundaries for Pakistan Standard Time (UTC+05, no DST). */
export function karachiMonthRange(now = new Date()) {
  const shifted = new Date(now.getTime() + 5 * 60 * 60_000);
  const year = shifted.getUTCFullYear();
  const monthIndex = shifted.getUTCMonth();
  const from = new Date(Date.UTC(year, monthIndex, 1) - 5 * 60 * 60_000);
  const to = new Date(Date.UTC(year, monthIndex + 1, 1) - 5 * 60 * 60_000);
  return { month: `${year}-${String(monthIndex + 1).padStart(2, '0')}`, from, to };
}

async function aggregate(db: ScopedDb, from: Date, to: Date): Promise<AIUsageBreakdown[]> {
  const rows = await db.$queryRaw<Array<{ provider: string; tier: string; spendMinor: bigint }>>(
    Prisma.sql`SELECT "provider", "tier", ROUND(SUM("costUsd") * 100)::bigint AS "spendMinor"
      FROM "ai_usage" WHERE "createdAt" >= ${from} AND "createdAt" < ${to}
      GROUP BY "provider", "tier" ORDER BY "provider", "tier"`
  );
  return rows.map((row) => ({ ...row, spendMinor: Number(row.spendMinor) }));
}

export async function readMonthlyAIUsage(
  now = new Date(),
  identity?: PlatformIdentity
): Promise<MonthlyAIUsage> {
  const actor = identity ?? (await requirePlatformSession());
  if (actor.role !== 'SUPER_ADMIN') {
    throw new PlatformSecurityError('SuperAdmin access is required.', 403);
  }
  const range = karachiMonthRange(now);
  const [breakdown, anthropicBudgetMinor] = await Promise.all([
    withPlatformDb((db) => aggregate(db, range.from, range.to)),
    getAiBudgetMinor(),
  ]);
  const providerSpendMinor: Record<string, number> = {};
  const tierSpendMinor: Record<string, number> = {};
  for (const row of breakdown) {
    providerSpendMinor[row.provider] = (providerSpendMinor[row.provider] ?? 0) + row.spendMinor;
    tierSpendMinor[row.tier] = (tierSpendMinor[row.tier] ?? 0) + row.spendMinor;
  }
  const totalSpendMinor = breakdown.reduce((sum, row) => sum + row.spendMinor, 0);
  const anthropicSpendMinor = providerSpendMinor.anthropic ?? 0;
  return {
    ...range,
    breakdown,
    providerSpendMinor,
    tierSpendMinor,
    totalSpendMinor,
    anthropicSpendMinor,
    anthropicBudgetMinor,
    percentUsed:
      anthropicBudgetMinor === 0
        ? anthropicSpendMinor > 0
          ? 100
          : 0
        : (anthropicSpendMinor / anthropicBudgetMinor) * 100,
  };
}

/** Claims the month and fans out atomically, so concurrent usage writes cannot duplicate alerts. */
export async function maybeCreateAIBudgetAlert(now = new Date()): Promise<boolean> {
  const { month, from, to } = karachiMonthRange(now);
  const budgetMinor = await getAiBudgetMinor();
  return withPlatformDb(async (db) => {
    const rows = await aggregate(db, from, to);
    const spendMinor = rows
      .filter((row) => row.provider === 'anthropic')
      .reduce((sum, row) => sum + row.spendMinor, 0);
    if ((budgetMinor === 0 && spendMinor === 0) || spendMinor * 100 < budgetMinor * 80) return false;

    const claimed = await db.$executeRaw(Prisma.sql`
      INSERT INTO "ai_budget_alert_months" ("month", "createdAt") VALUES (${month}, ${now})
      ON CONFLICT ("month") DO NOTHING`);
    if (!claimed) return false;
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "platform_notifications" ("id", "platformUserId", "type", "title", "message", "createdAt")
      SELECT gen_random_uuid()::text, "id", 'ai_budget_80', 'Anthropic budget alert',
        ${`Anthropic usage has reached at least 80% of the monthly budget for ${month}.`}, ${now}
      FROM "platform_users" WHERE "role" = 'SUPER_ADMIN' AND "active" = true`);
    return true;
  });
}
