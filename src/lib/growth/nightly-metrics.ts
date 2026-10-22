import 'server-only';

import { Prisma, type PlatformJob, type PrismaClient } from '@/generated/prisma/client';

export const GROWTH_METRICS_NIGHTLY_JOB = 'growth.metrics.nightly.v1';

export type GrowthSettingRule = {
  effect: 'ALLOW' | 'DENY';
  nightlyMetricsEnabled: boolean;
};

/** Default deny; an applicable DENY always wins over every ALLOW. */
export function nightlyMetricsAllowed(rules: readonly GrowthSettingRule[]): boolean {
  if (rules.some((rule) => rule.effect === 'DENY')) return false;
  return rules.some((rule) => rule.effect === 'ALLOW' && rule.nightlyMetricsEnabled);
}

function payloadString(job: PlatformJob, key: 'branchId' | 'vertical'): string {
  const payload = job.payload;
  const value =
    payload && typeof payload === 'object' && !Array.isArray(payload) ? payload[key] : null;
  if (typeof value !== 'string' || !value) throw new Error(`Growth metrics job requires ${key}.`);
  return value;
}

/** Build one idempotent, aggregate-only snapshot for the job's exact tenant branch. */
export async function runGrowthMetricsNightlyJob(
  db: PrismaClient,
  job: PlatformJob,
  now = new Date()
): Promise<Record<string, unknown>> {
  if (!job.organizationId) throw new Error('Growth metrics job requires an organization.');
  const branchId = payloadString(job, 'branchId');
  const vertical = payloadString(job, 'vertical');
  if (vertical !== 'PHARMACY' && vertical !== 'RESTAURANT') {
    throw new Error('Growth metrics job has an invalid vertical.');
  }

  const rules = await db.$queryRaw<GrowthSettingRule[]>(Prisma.sql`
    SELECT effect, "nightlyMetricsEnabled"
    FROM growth_settings
    WHERE "organizationId"=${job.organizationId} AND "branchId"=${branchId}
      AND vertical=${vertical}
    FOR SHARE
  `);
  if (!nightlyMetricsAllowed(rules)) throw new Error('Nightly growth metrics are denied.');

  const metricDate = now.toISOString().slice(0, 10);
  const rows = await db.$queryRaw<Array<{ inserted: boolean }>>(Prisma.sql`
    INSERT INTO growth_metric_snapshots
      (id, "organizationId", "branchId", vertical, "metricDate", metrics)
    SELECT ${`${job.id}:snapshot`}, ${job.organizationId}, ${branchId}, ${vertical},
      ${metricDate}::date,
      jsonb_build_object(
        'insights', COUNT(*)::integer,
        'ready', COUNT(*) FILTER (WHERE status='READY')::integer,
        'unavailable', COUNT(*) FILTER (WHERE status<>'READY')::integer
      )
    FROM growth_insights
    WHERE "organizationId"=${job.organizationId} AND "branchId"=${branchId}
      AND vertical=${vertical} AND "createdAt" < (${metricDate}::date + INTERVAL '1 day')
    ON CONFLICT ("organizationId", "branchId", vertical, "metricDate") DO NOTHING
    RETURNING true AS inserted
  `);
  return {
    organizationId: job.organizationId,
    branchId,
    vertical,
    metricDate,
    inserted: !!rows[0],
  };
}
