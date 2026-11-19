import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { withPlatformDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { pharmacyCalendarDay } from '@/lib/pharmacy/business-day';
import { computeChurnScore, CHURN_SCORING_POLICY } from './churn-score';

const DAY = 86_400_000;
const WRITE_CHUNK = 1_000;
// A tender's business date can precede its sale's completion (prepaid orders).
const TENDER_DATE_MARGIN_DAYS = 30;
const SCORING_ORGANIZATION_STATUSES = ['ONBOARDING', 'ACTIVE', 'GRACE'] as const;

type ChurnFactsRow = {
  branchId: string;
  customerId: string;
  lastCompletedAt: Date;
  receiptCount: number;
  monetaryMinor: bigint | number;
};

/**
 * Recomputes every churn score for one organization. Only commercial receipt
 * facts are read: completion time, receipt count and tendered value of
 * completed receipts without returns. No line, medicine or clinical data.
 */
export async function refreshOrganizationChurnScores(
  db: ScopedDb,
  organizationId: string,
  now: Date,
  businessDate: string
) {
  const windowStart = new Date(now.getTime() - CHURN_SCORING_POLICY.windowDays * DAY);
  const rows = await db.$queryRaw<ChurnFactsRow[]>(Prisma.sql`
    SELECT s."branchId", s."customerId",
      MAX(s."completedAt") AS "lastCompletedAt",
      (COUNT(*) FILTER (WHERE s."completedAt" >= ${windowStart}))::int AS "receiptCount",
      COALESCE(SUM(GREATEST(t."amountMinor", 0)) FILTER (WHERE s."completedAt" >= ${windowStart}), 0)::bigint AS "monetaryMinor"
    FROM pharmacy_sales s
    -- Tenders have no saleId index: aggregate the window's tenders once and
    -- hash-join, instead of a per-sale lookup that grows quadratically.
    LEFT JOIN (
      SELECT pt."branchId", pt."saleId", SUM(pt."amountMinor") AS "amountMinor"
      FROM pharmacy_tenders pt
      WHERE pt."organizationId" = ${organizationId}
        AND pt."businessDate" >= ${new Date(windowStart.getTime() - TENDER_DATE_MARGIN_DAYS * DAY)}
      GROUP BY pt."branchId", pt."saleId"
    ) t ON t."branchId" = s."branchId" AND t."saleId" = s.id
    WHERE s."organizationId" = ${organizationId}
      AND s.status = 'COMPLETED'
      AND s."customerId" IS NOT NULL
      AND s."completedAt" IS NOT NULL
      AND s."completedAt" <= ${now}
      AND NOT EXISTS (
        SELECT 1 FROM pharmacy_sale_returns r
        WHERE r."organizationId" = s."organizationId"
          AND r."branchId" = s."branchId"
          AND r."originalSaleId" = s.id
      )
    GROUP BY s."branchId", s."customerId"
    ORDER BY s."branchId", s."customerId"
  `);
  const date = new Date(`${businessDate}T00:00:00.000Z`);
  const data = rows.map((row) => {
    const daysSinceLastReceipt = Math.max(
      0,
      Math.floor((now.getTime() - row.lastCompletedAt.getTime()) / DAY)
    );
    const receiptCount = Number(row.receiptCount);
    const monetaryMinor = BigInt(row.monetaryMinor);
    return {
      organizationId,
      branchId: row.branchId,
      customerId: row.customerId,
      ...computeChurnScore({
        daysSinceLastReceipt,
        receiptCount,
        monetaryMinor: Number(monetaryMinor),
      }),
      daysSinceLastReceipt,
      receiptCount,
      monetaryMinor,
      businessDate: date,
      computedAt: now,
    };
  });
  // Full replacement: a customer whose only receipts were returned drops out.
  await db.pharmacyCustomerChurnScore.deleteMany({ where: { organizationId } });
  for (let index = 0; index < data.length; index += WRITE_CHUNK)
    await db.pharmacyCustomerChurnScore.createMany({
      data: data.slice(index, index + WRITE_CHUNK),
    });
  return data.length;
}

/**
 * Nightly job: scores each pharmacy organization once per workspace business
 * day. The run row is claimed first, so overlapping cron invocations serialize
 * on its unique key and only one of them writes that day's scores.
 */
export async function processDueChurnScoring(now = new Date(), limit = 25) {
  const candidates = await withPlatformDb(async (db) => {
    const branches = await db.pharmacyBranch.findMany({
      distinct: ['organizationId'],
      select: { organizationId: true },
    });
    if (!branches.length) return [];
    const [organizations, runs] = await Promise.all([
      db.organization.findMany({
        where: {
          id: { in: branches.map((branch) => branch.organizationId) },
          status: { in: [...SCORING_ORGANIZATION_STATUSES] },
        },
        select: { id: true, timezone: true },
        orderBy: { id: 'asc' },
      }),
      db.pharmacyChurnScoringRun.findMany({
        where: { businessDate: { gte: new Date(now.getTime() - 2 * DAY) } },
        select: { organizationId: true, businessDate: true },
      }),
    ]);
    const done = new Set(
      runs.map((run) => `${run.organizationId}:${run.businessDate.toISOString().slice(0, 10)}`)
    );
    return organizations
      .map((organization) => ({
        organizationId: organization.id,
        businessDate: pharmacyCalendarDay(organization.timezone, now),
      }))
      .filter((item) => !done.has(`${item.organizationId}:${item.businessDate}`))
      .slice(0, Math.max(1, Math.min(100, Math.floor(limit))));
  });
  let scored = 0;
  let customers = 0;
  let failed = 0;
  for (const item of candidates) {
    try {
      const result = await withTenantDb(
        item.organizationId,
        async (db) => {
          const date = new Date(`${item.businessDate}T00:00:00.000Z`);
          const claim = await db.pharmacyChurnScoringRun.createMany({
            data: [
              {
                organizationId: item.organizationId,
                businessDate: date,
                customersScored: 0,
                completedAt: now,
              },
            ],
            skipDuplicates: true,
          });
          if (claim.count !== 1) return null;
          const count = await refreshOrganizationChurnScores(
            db,
            item.organizationId,
            now,
            item.businessDate
          );
          await db.pharmacyChurnScoringRun.updateMany({
            where: { organizationId: item.organizationId, businessDate: date },
            data: { customersScored: count, completedAt: new Date() },
          });
          return count;
        },
        { timeout: 120_000 }
      );
      if (result === null) continue;
      scored += 1;
      customers += result;
    } catch (error) {
      failed += 1;
      console.error('[churn-scoring] organization scoring failed', {
        organizationId: item.organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { organizations: scored, customers, failed };
}
