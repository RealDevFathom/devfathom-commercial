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
      -- grossMinor is the amount actually charged (mixed-lot lines, #636); older
      -- rows fall back to the uniform line price, matching sale-line-money.ts.
      SELECT COALESCE(SUM(COALESCE(l."grossMinor"::bigint, l.quantity::bigint * l."unitPriceMinor") - l."discountMinor"), 0) AS value
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

/** Per-branch tenant transaction ceiling. */
export const CHURN_BRANCH_TIMEOUT_MS = 60_000;
/**
 * Wall-clock budget for starting branch work in one cron tick. The platform job
 * route allows 300s; stopping new branches after this leaves room for one last
 * branch at its full transaction timeout. Unstarted branches stay unclaimed and
 * are picked up by the next tick.
 */
export const CHURN_TICK_BUDGET_MS = 180_000;

/**
 * Nightly scheduler, driven by the platform job cron. Each active branch of an
 * accessible pharmacy workspace with Pharmacy CRM is scored once per local
 * business date (the first tick after local midnight). Entitlement and
 * lifecycle are re-checked inside the owning tenant transaction.
 */
export async function processNightlyChurnScoring(
  now = new Date(),
  limit = 25,
  budgetMs = CHURN_TICK_BUDGET_MS
) {
  const deadline = Date.now() + Math.max(0, budgetMs);
  const take = Math.max(1, Math.min(100, Math.floor(limit)));
  const candidates = await withPlatformDb(async (db) => {
    const organizations = await db.organization.findMany({
      where: { vertical: 'PHARMACY', status: { in: [...ACCESSIBLE_STATUSES] } },
      select: { id: true, timezone: true },
      orderBy: { id: 'asc' },
    });
    if (organizations.length === 0) return [];
    const timezones = new Map(organizations.map((org) => [org.id, org.timezone]));
    const branches = await db.pharmacyBranch.findMany({
      where: { organizationId: { in: organizations.map((org) => org.id) }, active: true },
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
    const key = (run: { organizationId: string; branchId: string; businessDate: string }) =>
      `${run.organizationId}\u0000${run.branchId}\u0000${run.businessDate}`;
    const seen = new Set(done.map(key));
    const pending = dated.filter((branch) => !seen.has(key(branch)));
    if (pending.length === 0) return [];
    // Start each tick at a different pending branch so branches that keep
    // failing (their claim rolls back) cannot lead every tick and spend its
    // whole budget, deferring the same later branches all day.
    const offset = Math.floor(now.getTime() / 300_000) % pending.length;
    const ordered = [...pending.slice(offset), ...pending.slice(0, offset)];
    // Entitlements are resolved only for workspaces that still have a branch
    // due today, and only until the per-tick budget is filled, so a tick after
    // all of today's runs are done costs no entitlement lookups. Unentitled
    // workspaces are skipped here so they cannot starve entitled branches of
    // the budget; the tenant transaction re-checks authoritatively.
    const entitled = new Map<string, boolean>();
    const due: typeof dated = [];
    for (const branch of ordered) {
      if (due.length >= take) break;
      let allowed = entitled.get(branch.organizationId);
      if (allowed === undefined) {
        allowed = hasModule(
          await resolveOrganizationEntitlements(branch.organizationId, db, now),
          'pharmacy-crm'
        );
        entitled.set(branch.organizationId, allowed);
      }
      if (allowed) due.push(branch);
    }
    return due;
  });

  let scoredBranches = 0;
  let scoredCustomers = 0;
  let failed = 0;
  let deferred = 0;
  for (const [index, candidate] of candidates.entries()) {
    // Keep the cron tick inside its route duration; the rest run next tick.
    if (Date.now() >= deadline) {
      deferred = candidates.length - index;
      break;
    }
    // A failure rolls back only this branch's transaction (claim included, so a
    // later tick retries it) and never fails the cron tick. A slow failure can
    // still spend this tick's budget; the rotating start order spreads that cost.
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
      { timeout: CHURN_BRANCH_TIMEOUT_MS }
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
  return { due: candidates.length, scoredBranches, scoredCustomers, failed, deferred };
}
