import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { calculateChurn } from './churn';
import { nextRefillDueAt } from './refill';

export type CustomerAggregate = {
  customerId: string;
  lastPurchaseAt: Date | null;
  orders90d: number;
  totalOrders: number;
  spend90dMinor: bigint;
  medianGapDays: number | null;
  refillSoldAt: Date | null;
  refillQuantity: number | null;
  directions: string | null;
};

// One aggregate query for the entire tenant. Rank sales before joining lines so
// neither frequency nor gaps are multiplied by basket size. History is unbounded
// for recency, but only the latest twelve purchase dates contribute to the median.
export function customerMetricsQuery(organizationId: string, now: Date) {
  return Prisma.sql`
    WITH sales AS (
      SELECT s.*, row_number() OVER (PARTITION BY s."customerId" ORDER BY s."completedAt" DESC, s.id DESC) AS rn
      FROM pharmacy_sales s WHERE s."organizationId" = ${organizationId}
        AND s.status = 'COMPLETED' AND s."completedAt" <= ${now} AND s."customerId" IS NOT NULL
    ), gaps AS (
      SELECT "customerId", EXTRACT(EPOCH FROM ("completedAt" - lag("completedAt") OVER
        (PARTITION BY "customerId" ORDER BY "completedAt", id))) / 86400 AS gap
      FROM sales WHERE rn <= 12
    ), medians AS (
      SELECT "customerId", CASE WHEN count(gap) >= 2 THEN
        round((percentile_cont(0.5) WITHIN GROUP (ORDER BY gap))::numeric)::int END AS median
      FROM gaps GROUP BY "customerId"
    ), baskets AS (
      SELECT l."saleId", sum(l.quantity::bigint * l."unitPriceMinor" - l."discountMinor") AS spend
      FROM pharmacy_sale_lines l WHERE l."organizationId" = ${organizationId} GROUP BY l."saleId"
    ), refills AS (
      SELECT DISTINCT ON (s."customerId") s."customerId", s."completedAt", l."canonicalUnits", p.directions
      FROM sales s JOIN pharmacy_sale_lines l ON l."saleId" = s.id AND l."organizationId" = ${organizationId}
      JOIN pharmacy_medicines m ON m.id = l."medicineId" AND m.rx = true
      LEFT JOIN pharmacy_pharmacist_review_items r ON r."saleLineId" = l.id AND r."organizationId" = ${organizationId}
      LEFT JOIN pharmacy_prescription_lines p ON p.id = r."prescriptionLineId" AND p."organizationId" = ${organizationId}
      ORDER BY s."customerId", s."completedAt" DESC, s.id DESC, l.id DESC
    )
    SELECT c.id AS "customerId", max(s."completedAt") AS "lastPurchaseAt",
      count(s.id)::int AS "totalOrders",
      (count(s.id) FILTER (WHERE s."completedAt" >= ${now}::timestamp - interval '90 days'))::int AS "orders90d",
      coalesce(sum(b.spend) FILTER (WHERE s."completedAt" >= ${now}::timestamp - interval '90 days'), 0)::bigint AS "spend90dMinor",
      m.median AS "medianGapDays", r."completedAt" AS "refillSoldAt", r."canonicalUnits" AS "refillQuantity", r.directions
    FROM pharmacy_customers c
    LEFT JOIN sales s ON s."customerId" = c.id
    LEFT JOIN baskets b ON b."saleId" = s.id
    LEFT JOIN medians m ON m."customerId" = c.id
    LEFT JOIN refills r ON r."customerId" = c.id
    WHERE c."organizationId" = ${organizationId}
    GROUP BY c.id, m.median, r."completedAt", r."canonicalUnits", r.directions
    ORDER BY c.id`;
}

export function metricsDue(now: Date, lastRun: Date | null, timezone: string) {
  const parts = (date: Date) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
  const today = parts(now);
  const dateKey = (values: Intl.DateTimeFormatPart[]) =>
    values
      .filter((p) => ['year', 'month', 'day'].includes(p.type))
      .map((p) => p.value)
      .join('-');
  return (
    Number(today.find((p) => p.type === 'hour')?.value) >= 2 &&
    (!lastRun || (lastRun <= now && dateKey(parts(lastRun)) !== dateKey(today)))
  );
}

export async function runCustomerMetrics(organizationId: string, now = new Date()) {
  return withTenantDb(
    organizationId,
    async (db) => {
      // Transaction lock serializes overlapping ticks; failures roll back both rows and timestamp.
      await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${organizationId}, 2))`;
      const organization = await db.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { timezone: true, vertical: true },
      });
      if (organization.vertical !== 'PHARMACY') return false;
      const settings = await db.growthSettings.upsert({
        where: { organizationId },
        create: { organizationId },
        update: {},
      });
      if (!metricsDue(now, settings.lastMetricsRunAt, organization.timezone)) return false;
      const rows = await db.$queryRaw<CustomerAggregate[]>(
        customerMetricsQuery(organizationId, now)
      );
      for (let offset = 0; offset < rows.length; offset += 500) {
        const values = rows.slice(offset, offset + 500).map((row) => {
          const churn = calculateChurn(row, now, 30, settings.churnThreshold);
          return Prisma.sql`(${row.customerId}, ${organizationId}, ${row.lastPurchaseAt}, ${row.orders90d},
          ${row.spend90dMinor}, ${row.medianGapDays}, ${churn.churnScore}, ${churn.churnBand},
          ${nextRefillDueAt(row.refillSoldAt, row.refillQuantity, row.directions)}, ${now}, ${now}, ${now})`;
        });
        await db.$executeRaw(Prisma.sql`INSERT INTO customer_metrics
        ("customerId", "organizationId", "lastPurchaseAt", "orders90d", "spend90dMinor", "medianGapDays",
         "churnScore", "churnBand", "nextRefillDueAt", "computedAt", "createdAt", "updatedAt")
        VALUES ${Prisma.join(values)} ON CONFLICT ("organizationId", "customerId") DO UPDATE SET
        "lastPurchaseAt" = EXCLUDED."lastPurchaseAt", "orders90d" = EXCLUDED."orders90d",
        "spend90dMinor" = EXCLUDED."spend90dMinor", "medianGapDays" = EXCLUDED."medianGapDays",
        "churnScore" = EXCLUDED."churnScore", "churnBand" = EXCLUDED."churnBand",
        "nextRefillDueAt" = EXCLUDED."nextRefillDueAt", "computedAt" = EXCLUDED."computedAt", "updatedAt" = EXCLUDED."updatedAt"`);
      }
      await db.growthSettings.update({
        where: { organizationId },
        data: { lastMetricsRunAt: now },
      });
      return true;
    },
    { timeout: 120_000 }
  );
}
