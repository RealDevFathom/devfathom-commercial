import 'server-only';

import { withPlatformDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

type EligibleTenant = { organizationId: string; vertical: 'PHARMACY' | 'RESTAURANT' };

export async function collectTenantCustomerMetrics(
  db: ScopedDb,
  tenant: EligibleTenant,
  metricDate = new Date()
): Promise<number> {
  const date = metricDate.toISOString().slice(0, 10);
  const settings = await db.$queryRaw<Array<{ lookbackDays: number }>>`
    SELECT "lookbackDays" FROM "growth_settings"
    WHERE "organizationId" = ${tenant.organizationId}
      AND "enabled" = true AND "nightlyMetricsEnabled" = true`;
  if (!settings[0]) return 0;

  if (tenant.vertical === 'RESTAURANT') {
    return db.$executeRaw`
      INSERT INTO "growth_customer_metrics"
        ("organizationId", "vertical", "customerId", "metricDate", "lastActivityAt", "orderCount", "grossAmount", "updatedAt")
      SELECT ${tenant.organizationId}, 'RESTAURANT', o."customerId", ${date}::date,
        max(o."closedAt"), count(DISTINCT o.id)::integer, coalesce(sum(b."grandTotal"), 0), now()
      FROM "restaurant_orders" o
      LEFT JOIN "restaurant_bills" b ON b."organizationId" = o."organizationId"
        AND b."orderId" = o.id AND b."settledAt" IS NOT NULL
      WHERE o."organizationId" = ${tenant.organizationId} AND o."customerId" IS NOT NULL
        AND o.status = 'CLOSED' AND o."closedAt" >= now() - (${settings[0].lookbackDays} * interval '1 day')
      GROUP BY o."customerId"
      ON CONFLICT ("organizationId", "vertical", "customerId", "metricDate") DO UPDATE SET
        "lastActivityAt" = EXCLUDED."lastActivityAt", "orderCount" = EXCLUDED."orderCount",
        "grossAmount" = EXCLUDED."grossAmount", "updatedAt" = now()`;
  }

  return db.$executeRaw`
    INSERT INTO "growth_customer_metrics"
      ("organizationId", "vertical", "customerId", "metricDate", "lastActivityAt", "orderCount", "grossAmount", "updatedAt")
    SELECT ${tenant.organizationId}, 'PHARMACY', s."customerId", ${date}::date,
      max(s."completedAt"), count(DISTINCT s.id)::integer,
      coalesce(sum(t."amountMinor")::numeric / 100, 0), now()
    FROM "pharmacy_sales" s
    LEFT JOIN "pharmacy_tenders" t ON t."organizationId" = s."organizationId"
      AND t."saleId" = s.id
    WHERE s."organizationId" = ${tenant.organizationId} AND s."customerId" IS NOT NULL
      AND s.status = 'COMPLETED' AND s."completedAt" >= now() - (${settings[0].lookbackDays} * interval '1 day')
    GROUP BY s."customerId"
    ON CONFLICT ("organizationId", "vertical", "customerId", "metricDate") DO UPDATE SET
      "lastActivityAt" = EXCLUDED."lastActivityAt", "orderCount" = EXCLUDED."orderCount",
      "grossAmount" = EXCLUDED."grossAmount", "updatedAt" = now()`;
}

export async function runNightlyCustomerMetrics(metricDate = new Date()) {
  const tenants = await withPlatformDb((db) =>
    db.$queryRaw<EligibleTenant[]>`
      SELECT o.id AS "organizationId", o.vertical::text AS vertical
      FROM organizations o
      WHERE o.status = 'ACTIVE' AND o.vertical::text IN ('PHARMACY', 'RESTAURANT')
      `
  );
  const results = [];
  for (const tenant of tenants) {
    const rows = await withTenantDb(
      tenant.organizationId,
      (db) => collectTenantCustomerMetrics(db, tenant, metricDate),
      { skipDrain: true }
    );
    results.push({ organizationId: tenant.organizationId, rows });
  }
  return { tenants: results.length, rows: results.reduce((sum, result) => sum + result.rows, 0) };
}
