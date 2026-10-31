import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { hasModule, resolveOrganizationEntitlements } from '@/lib/entitlements';
import { withPlatformDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import { workspaceTimezone } from '@/lib/timezone';
import {
  CHURN_MODEL_VERSION,
  CHURN_WINDOW_DAYS,
  scoreChurnRfm,
  type ChurnInputRow,
} from './churn-scoring';

const DAY = 86_400_000;
const WRITE_CHUNK = 1000;
const ACCESSIBLE_STATUSES = ['ONBOARDING', 'ACTIVE', 'GRACE'] as const;

export type ChurnBranchScope = { organizationId: string; branchId: string };

/** The workspace's local calendar date; a zone Intl refuses reads as UTC. */
export function churnBusinessDate(at: Date, timezone: string | null | undefined): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: workspaceTimezone(timezone),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(at)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Retail-only per-customer aggregates for one branch. Mirrors the marketing
 * audience rules: completed, unreturned receipts with a customer, completed no
 * later than `asOf`. Never selects names, phone, medicine or clinical fields.
 */
export async function readBranchChurnInputs(
  db: ScopedDb,
  scope: ChurnBranchScope,
  asOf: Date
): Promise<ChurnInputRow[]> {
  const windowStart = new Date(asOf.getTime() - CHURN_WINDOW_DAYS * DAY);
  const rows = await db.$queryRaw<
    Array<{ customerId: string; lastCompletedAt: Date; frequency: number; monetary: string }>
  >(Prisma.sql`
    SELECT s."customerId" AS "customerId", MAX(s."completedAt") AS "lastCompletedAt",
      (COUNT(*) FILTER (WHERE s."completedAt" > ${windowStart}))::integer AS frequency,
      GREATEST(COALESCE(SUM(v.value) FILTER (WHERE s."completedAt" > ${windowStart}), 0), 0)::text AS monetary
    FROM pharmacy_sales s
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(l.quantity::bigint * l."unitPriceMinor" - l."discountMinor"), 0) AS value
      FROM pharmacy_sale_lines l
      WHERE l."organizationId" = s."organizationId" AND l."branchId" = s."branchId" AND l."saleId" = s.id
    ) v ON true
    WHERE s."organizationId" = ${scope.organizationId} AND s."branchId" = ${scope.branchId}
      AND s.status = 'COMPLETED' AND s."customerId" IS NOT NULL
      AND s."completedAt" IS NOT NULL AND s."completedAt" <= ${asOf}
      AND NOT EXISTS (
        SELECT 1 FROM pharmacy_sale_returns r
        WHERE r."organizationId" = s."organizationId" AND r."branchId" = s."branchId" AND r."originalSaleId" = s.id
      )
    GROUP BY s."customerId"
    ORDER BY s."customerId" ASC
  `);
  return rows.map((row) => ({
    customerId: row.customerId,
    lastCompletedAt: new Date(row.lastCompletedAt),
    frequency: Number(row.frequency),
    monetaryMinor: BigInt(row.monetary),
  }));
}

/**
 * Score one branch for one local business date, inside the caller's tenant
 * transaction. The run ledger row is the idempotency claim: a second worker
 * for the same branch/date inserts nothing and returns without writing scores.
 * Scores are replaced as a set so customers never carry a stale mix of runs.
 */
export async function refreshBranchChurnScores(
  db: ScopedDb,
  scope: ChurnBranchScope & { businessDate: string },
  now = new Date()
): Promise<{ scored: number; replay: boolean }> {
  const claim = await db.pharmacyChurnScoringRun.createMany({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      businessDate: scope.businessDate,
      modelVersion: CHURN_MODEL_VERSION,
      scoredCustomers: 0,
    },
    skipDuplicates: true,
  });
  if (claim.count !== 1) return { scored: 0, replay: true };

  const scores = scoreChurnRfm(await readBranchChurnInputs(db, scope, now), now);
  await db.pharmacyCustomerChurnScore.deleteMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId },
  });
  for (let start = 0; start < scores.length; start += WRITE_CHUNK) {
    await db.pharmacyCustomerChurnScore.createMany({
      data: scores.slice(start, start + WRITE_CHUNK).map((score) => ({
        ...score,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        businessDate: scope.businessDate,
        scoredAt: now,
      })),
    });
  }
  await db.pharmacyChurnScoringRun.updateMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      businessDate: scope.businessDate,
    },
    data: { scoredCustomers: scores.length },
  });
  return { scored: scores.length, replay: false };
}

/**
 * Nightly scheduler, driven by the platform job cron. Each active branch of an
 * accessible pharmacy workspace with Pharmacy CRM is scored once per local
 * business date (the first tick after local midnight). Entitlement and
 * lifecycle are re-checked inside the owning tenant transaction.
 */
export async function processNightlyChurnScoring(now = new Date(), limit = 25) {
  const take = Math.max(1, Math.min(100, Math.floor(limit)));
  const candidates = await withPlatformDb(async (db) => {
    const organizations = await db.organization.findMany({
      where: { vertical: 'PHARMACY', status: { in: [...ACCESSIBLE_STATUSES] } },
      select: { id: true, timezone: true },
      orderBy: { id: 'asc' },
    });
    // Skip unentitled workspaces here so they cannot starve entitled branches
    // of the per-tick budget; the tenant transaction re-checks authoritatively.
    const entitled: typeof organizations = [];
    for (const org of organizations) {
      const entitlements = await resolveOrganizationEntitlements(org.id, db, now);
      if (hasModule(entitlements, 'pharmacy-crm')) entitled.push(org);
    }
    if (entitled.length === 0) return [];
    const timezones = new Map(entitled.map((org) => [org.id, org.timezone]));
    const branches = await db.pharmacyBranch.findMany({
      where: { organizationId: { in: entitled.map((org) => org.id) }, active: true },
      select: { id: true, organizationId: true },
      orderBy: [{ organizationId: 'asc' }, { id: 'asc' }],
    });
    const dated = branches.map((branch) => ({
      organizationId: branch.organizationId,
      branchId: branch.id,
      businessDate: churnBusinessDate(now, timezones.get(branch.organizationId)),
    }));
    if (dated.length === 0) return [];
    const done = await db.pharmacyChurnScoringRun.findMany({
      where: {
        branchId: { in: dated.map((branch) => branch.branchId) },
        businessDate: { in: [...new Set(dated.map((branch) => branch.businessDate))] },
      },
      select: { organizationId: true, branchId: true, businessDate: true },
    });
    const seen = new Set(
      done.map((run) => `${run.organizationId}\u0000${run.branchId}\u0000${run.businessDate}`)
    );
    return dated
      .filter(
        (branch) =>
          !seen.has(`${branch.organizationId}\u0000${branch.branchId}\u0000${branch.businessDate}`)
      )
      .slice(0, take);
  });

  let scoredBranches = 0;
  let scoredCustomers = 0;
  let failed = 0;
  for (const candidate of candidates) {
    // One branch's failure rolls back only its own transaction (claim included,
    // so the next tick retries) and never blocks other branches or cron work.
    const result = await withTenantDb(
      candidate.organizationId,
      async (db) => {
        const organization = await db.organization.findUnique({
          where: { id: candidate.organizationId },
          select: { vertical: true, status: true },
        });
        if (
          !organization ||
          organization.vertical !== 'PHARMACY' ||
          !(ACCESSIBLE_STATUSES as readonly string[]).includes(organization.status)
        )
          return null;
        const branch = await db.pharmacyBranch.findFirst({
          where: { organizationId: candidate.organizationId, id: candidate.branchId, active: true },
          select: { id: true },
        });
        if (!branch) return null;
        const entitlements = await resolveOrganizationEntitlements(
          candidate.organizationId,
          db,
          new Date()
        );
        if (!hasModule(entitlements, 'pharmacy-crm')) return null;
        return refreshBranchChurnScores(db, candidate, now);
      },
      { timeout: 60_000 }
    ).catch((error: unknown) => {
      failed += 1;
      console.error('[churn-scoring] branch scoring failed', {
        organizationId: candidate.organizationId,
        branchId: candidate.branchId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (result && !result.replay) {
      scoredBranches += 1;
      scoredCustomers += result.scored;
    }
  }
  return { due: candidates.length, scoredBranches, scoredCustomers, failed };
}
