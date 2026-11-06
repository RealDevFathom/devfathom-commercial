// @vitest-environment node
/**
 * DEV-751 — automatic scheduling fans out to one job per branch, so a failing
 * branch fails alone. Real PostgreSQL, the REAL worker tick
 * (`runRestaurantWorkerTick` → composed job registry → real `withTenantDb`,
 * restricted runtime role) and an injected tick clock.
 *
 * The failure is a real database error: a disposable BEFORE INSERT trigger on
 * `restaurant_sop_occurrences` (created by the cleanup superuser, dropped at
 * recovery and again in cleanup) RAISEs for exactly two fixture engine
 * branches. Fixtures:
 *
 *   org A: branch 1 ON (healthy), branch 2 ON (poisoned)
 *   org B: branch 1 ON (healthy); plus a stray child naming A's branch 2
 *   org C: branch 1 ON (poisoned) — every child of this org fails
 *   org R: restaurant, no SOP site; a stray parent and a stray child
 *
 * Pins: healthy branches get their work while the poisoned branch's child
 * retries on the scheduler backoff and ends DEAD after maxAttempts, for that
 * branch only; the next slot is committed even when every child fails; the
 * next slot enqueues a fresh child for the failed branch; after the trigger is
 * dropped that child succeeds with no duplicates; every claim, handler and
 * settle ran in its own organization's RLS context; repeated and concurrent
 * runs create no duplicate job or occurrence.
 *
 * Requires PHARMACY_SOP_TEST_RUNTIME_DATABASE_URL (restricted runtime role),
 * PHARMACY_SOP_TEST_OWNER_DATABASE_URL and PHARMACY_SOP_TEST_SUPERUSER_DATABASE_URL
 * (trigger + cleanup only) against a disposable migrated database; skipped
 * otherwise.
 */
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cleanupOrganizations,
  createPoisonTrigger,
  dropPoisonTrigger,
  executionsOf,
  jobsOf,
  leftoverRows,
  occurrencesOf,
  poisonTriggerExists,
  seedOrganization,
} from './pharmacy-sop-auto-schedule-fixtures';

const runtimeUrl = process.env.PHARMACY_SOP_TEST_RUNTIME_DATABASE_URL;
const ownerUrl = process.env.PHARMACY_SOP_TEST_OWNER_DATABASE_URL;
const superuserUrl = process.env.PHARMACY_SOP_TEST_SUPERUSER_DATABASE_URL;
const enabled = Boolean(runtimeUrl && ownerUrl && superuserUrl);
// The app's Prisma client reads DATABASE_URL at first use; set it only here.
if (enabled) process.env.DATABASE_URL = runtimeUrl;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = enabled ? describe : describe.skip;

type Deps = {
  scoped: typeof import('@/lib/tenancy/scoped-db');
  runner: typeof import('@/lib/restaurant/job-runner');
  scheduler: typeof import('@/lib/restaurant/scheduler');
  autoJob: typeof import('@/lib/pharmacy/sop-auto-schedule-job');
  prisma: typeof import('@/generated/prisma/client');
};
let deps: Deps;

const run = randomBytes(4).toString('hex');
const id = (name: string) => `dev751f_${run}_${name}`;
const A = id('org_a');
const B = id('org_b');
const C = id('org_c');
const R = id('org_r');
const ORGS = [A, B, C, R];
const USER = id('manager');
const TRIGGER = `dev751_poison_${run}`;
const POISONED = [`${A}_rb2`, `${C}_rb1`];

const PARENT = 'pharmacy.sop.autoGenerate';
const CHILD = 'pharmacy.sop.autoGenerateBranch';
const S1 = '2026-11-04T07:00:00.000Z';
const S2 = '2026-11-04T08:00:00.000Z';
const S3 = '2026-11-04T09:00:00.000Z';
const S4 = '2026-11-04T10:00:00.000Z';
const T0 = new Date('2026-11-04T06:30:00.000Z'); // chain started (11:30 Asia/Karachi)
const T1 = new Date('2026-11-04T07:00:30.000Z'); // slot S1 runs
const T2 = new Date('2026-11-04T08:00:30.000Z'); // slot S2 runs
const T3 = new Date('2026-11-04T09:00:30.000Z'); // slot S3 runs
const plus = (at: Date, ms: number) => new Date(at.getTime() + ms);
const childKey = (org: string, branch: string, slot: string) =>
  `${CHILD}:${org}_pb${branch}:${slot}`;

let su: Client;

/** Org-context evidence: every worker unit of work, and the tenant GUC it saw. */
const contexts: Array<{ organizationId: string; guc: string; platform: string }> = [];

/** The worker's privileged discovery scan, restricted to the fixture orgs. */
async function discover(): Promise<string[]> {
  const { Prisma } = deps.prisma;
  return deps.scoped.withPlatformDb(async (db) => {
    const rows = await db.$queryRaw<Array<{ organizationId: string }>>(Prisma.sql`
      SELECT DISTINCT "organizationId" FROM "restaurant_jobs"
       WHERE "status" IN ('QUEUED','RUNNING') AND "type" <> 'demo-reset'
         AND "organizationId" IN (${Prisma.join(ORGS)})
       ORDER BY "organizationId" ASC`);
    return rows.map((row) => row.organizationId);
  });
}

/** The real `withTenantDb`, recording the tenant context each unit of work ran in. */
function runInOrg<T>(organizationId: string, work: (db: never) => Promise<T>): Promise<T> {
  return deps.scoped.withTenantDb(organizationId, async (db) => {
    const [row] = await db.$queryRaw<Array<{ guc: string; platform: string }>>`
      SELECT current_setting('app.current_organization_id', true) AS guc,
             current_setting('app.is_platform_admin', true) AS platform`;
    contexts.push({ organizationId, guc: row!.guc, platform: row!.platform });
    return work(db as never);
  });
}

function tick(now: Date, workerId: string) {
  return deps.runner.runRestaurantWorkerTick({
    workerId,
    now,
    discoverOrganizations: discover,
    runInOrg: runInOrg as never,
  });
}

const keyStatus = async (org: string) =>
  (await jobsOf(su, org)).map((job) => [job.idempotencyKey, job.status, job.attempts]);

async function jobByKey(org: string, key: string) {
  const job = (await jobsOf(su, org)).find((row) => row.idempotencyKey === key);
  expect(job, key).toBeDefined();
  return job!;
}

async function occurrenceCounts() {
  return {
    a1: (await occurrencesOf(su, A, `${A}_rb1`)).length,
    a2: (await occurrencesOf(su, A, `${A}_rb2`)).length,
    b1: (await occurrencesOf(su, B, `${B}_rb1`)).length,
    c1: (await occurrencesOf(su, C, `${C}_rb1`)).length,
    r: (await occurrencesOf(su, R)).length,
  };
}

function expectOwnContexts() {
  expect(contexts.length).toBeGreaterThan(0);
  for (const context of contexts) {
    expect(context).toEqual({
      organizationId: context.organizationId,
      guc: context.organizationId,
      platform: 'false',
    });
  }
}

describeIfDatabase('DEV-751 automatic scheduling: per-branch failure on the real worker', () => {
  beforeAll(async () => {
    const [scoped, runner, scheduler, autoJob, prisma] = await Promise.all([
      import('@/lib/tenancy/scoped-db'),
      import('@/lib/restaurant/job-runner'),
      import('@/lib/restaurant/scheduler'),
      import('@/lib/pharmacy/sop-auto-schedule-job'),
      import('@/generated/prisma/client'),
    ]);
    deps = { scoped, runner, scheduler, autoJob, prisma };

    su = new Client({ connectionString: superuserUrl });
    await su.connect();
    expect(await leftoverRows(su, ORGS)).toBe(0);

    const runtime = new Client({ connectionString: runtimeUrl });
    await runtime.connect();
    try {
      const { rows } = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      const both = [
        { key: '1', on: true },
        { key: '2', on: true },
      ];
      await seedOrganization(runtime, A, { pharmacy: true, branches: both, userId: USER });
      await seedOrganization(runtime, B, {
        pharmacy: true,
        branches: [{ key: '1', on: true }],
        userId: USER,
      });
      await seedOrganization(runtime, C, {
        pharmacy: true,
        branches: [{ key: '1', on: true }],
        userId: USER,
      });
      await seedOrganization(runtime, R, {
        pharmacy: false,
        branches: [{ key: '1', on: false }],
        userId: USER,
      });
    } finally {
      await runtime.end();
    }
    await createPoisonTrigger(su, TRIGGER, POISONED);
  }, 120_000);

  afterAll(async () => {
    if (!su) return;
    try {
      await dropPoisonTrigger(su, TRIGGER);
      expect(await poisonTriggerExists(su, TRIGGER)).toBe(false);
      await cleanupOrganizations(su, ORGS);
      expect(await leftoverRows(su, ORGS)).toBe(0);
    } finally {
      await su.end();
    }
  }, 120_000);

  it('the injected failure is real: the runtime role cannot insert a poisoned occurrence', async () => {
    await expect(
      deps.scoped.withTenantDb(A, (db) =>
        db.restaurantSopOccurrence.create({
          data: {
            id: id('probe'),
            assignmentId: `${A}_asg2`,
            templateVersionId: `${A}_ver`,
            branchId: `${A}_rb2`,
            businessDate: new Date('2026-11-04T00:00:00Z'),
            status: 'SCHEDULED',
            dueAt: new Date('2026-11-04T04:00:00Z'),
            windowEndsAt: new Date('2026-11-04T05:00:00Z'),
            assignedStaffProfileId: `${A}_sp`,
          },
        })
      )
    ).rejects.toThrow(/DEV-751 injected occurrence failure/);
    expect(await occurrencesOf(su, A)).toEqual([]);
  });

  it('starts the chains and stray jobs; nothing has generated yet', async () => {
    const { withTenantDb } = deps.scoped;
    for (const org of [A, B, C]) {
      const ensured = await withTenantDb(org, (db) =>
        deps.autoJob.ensurePharmacySopAutoScheduleJob(db, { organizationId: org, now: T0 })
      );
      expect(ensured).toMatchObject({
        deduplicated: false,
        job: { idempotencyKey: `${PARENT}:${S1}` },
      });
    }
    // A stray parent in the restaurant org (no product path enqueues one).
    await withTenantDb(R, (db) =>
      deps.autoJob.ensurePharmacySopAutoScheduleJob(db, { organizationId: R, now: T0 })
    );
    // Stray children whose payload names ANOTHER organization's branch: the
    // tenant context hides it, so both must be no-ops (and never reach A's
    // poisoned branch, which would fail them).
    const stray = (org: string) =>
      withTenantDb(org, (db) =>
        deps.scheduler.enqueue(
          db,
          {
            type: CHILD,
            payload: { slot: S1, pharmacyBranchId: `${A}_pb2` },
            idempotencyKey: `${CHILD}:${A}_pb2:${S1}`,
            scheduledAt: T0,
          },
          T0
        )
      );
    await stray(B);
    await stray(R);
    expect(await discover()).toEqual([...ORGS].sort());
    expect(await occurrenceCounts()).toEqual({ a1: 0, a2: 0, b1: 0, c1: 0, r: 0 });
  });

  it('slot S1 under two concurrent workers: healthy branches done, poisoned children retried', async () => {
    contexts.length = 0;
    const [left, right] = await Promise.all([tick(T1, 'worker-left'), tick(T1, 'worker-right')]);
    const sum = (key: 'claimed' | 'succeeded' | 'retried' | 'dead' | 'failed') =>
      left.jobs[key] + right.jobs[key];
    // Parents A, B, C, R's stray parent, the two stray children, children A1,
    // A2, B1, C1. Only the two poisoned children failed.
    expect(sum('claimed')).toBe(10);
    expect(sum('succeeded')).toBe(8);
    expect(sum('retried')).toBe(2);
    expect(sum('dead') + sum('failed')).toBe(0);

    expect(await occurrenceCounts()).toEqual({ a1: 2, a2: 0, b1: 2, c1: 0, r: 0 });

    expect(await keyStatus(A)).toEqual([
      [`${PARENT}:${S1}`, 'SUCCEEDED', 1],
      [childKey(A, '1', S1), 'SUCCEEDED', 1],
      [childKey(A, '2', S1), 'QUEUED', 1],
      [`${PARENT}:${S2}`, 'QUEUED', 0],
    ]);
    const poisoned = await jobByKey(A, childKey(A, '2', S1));
    expect(poisoned.lastError).toMatch(/DEV-751 injected occurrence failure/);
    expect(poisoned.payload).toEqual({ slot: S1, pharmacyBranchId: `${A}_pb2` });
    // Scheduler backoff: the first retry is 30 s after the failed attempt.
    expect(new Date(poisoned.nextAttemptAt).toISOString()).toBe(plus(T1, 30_000).toISOString());

    // Durability: C's only child failed, and its next slot is committed anyway.
    expect(await keyStatus(C)).toEqual([
      [`${PARENT}:${S1}`, 'SUCCEEDED', 1],
      [childKey(C, '1', S1), 'QUEUED', 1],
      [`${PARENT}:${S2}`, 'QUEUED', 0],
    ]);
    expect(await keyStatus(B)).toEqual([
      [`${CHILD}:${A}_pb2:${S1}`, 'SUCCEEDED', 1],
      [`${PARENT}:${S1}`, 'SUCCEEDED', 1],
      [childKey(B, '1', S1), 'SUCCEEDED', 1],
      [`${PARENT}:${S2}`, 'QUEUED', 0],
    ]);
    // The restaurant org: both strays did nothing and enqueued nothing.
    expect(await keyStatus(R)).toEqual([
      [`${CHILD}:${A}_pb2:${S1}`, 'SUCCEEDED', 1],
      [`${PARENT}:${S1}`, 'SUCCEEDED', 1],
    ]);
    expectOwnContexts();
    expect(new Set(contexts.map((context) => context.organizationId))).toEqual(new Set(ORGS));

    // A repeat tick at the same instant finds nothing due (backoff holds).
    const repeat = await tick(T1, 'worker-repeat');
    expect(repeat.jobs.claimed).toBe(0);
  });

  it('the poisoned children retry on the backoff schedule and end DEAD after maxAttempts', async () => {
    // Attempt k fails at t → next attempt at t + 30 s · 2^(k-1); attempt 5 → DEAD.
    let at = T1;
    for (const [attempt, delay] of [
      [2, 30_000],
      [3, 60_000],
      [4, 120_000],
      [5, 240_000],
    ] as const) {
      const due = plus(at, delay);
      const early = await tick(plus(due, -1_000), `worker-early-${attempt}`);
      expect(early.jobs.claimed).toBe(0);
      const result = await tick(due, `worker-retry-${attempt}`);
      expect(result.jobs).toMatchObject(
        attempt < 5
          ? { claimed: 2, retried: 2, succeeded: 0, dead: 0 }
          : { claimed: 2, retried: 0, succeeded: 0, dead: 2 }
      );
      at = due;
    }
    for (const [org, branch] of [
      [A, '2'],
      [C, '1'],
    ] as const) {
      const job = await jobByKey(org, childKey(org, branch, S1));
      expect(job).toMatchObject({ status: 'DEAD', attempts: 5 });
      expect(job.lastError).toMatch(/DEV-751 injected occurrence failure/);
      expect((await executionsOf(su, org)).get(job.id)).toEqual(Array(5).fill('FAILED'));
    }
    // Healthy branches unaffected: each child ran once, successfully.
    expect((await jobByKey(A, childKey(A, '1', S1))).status).toBe('SUCCEEDED');
    const aExecutions = await executionsOf(su, A);
    expect(aExecutions.get((await jobByKey(A, childKey(A, '1', S1))).id)).toEqual(['SUCCEEDED']);
    expect(await occurrenceCounts()).toEqual({ a1: 2, a2: 0, b1: 2, c1: 0, r: 0 });
    // The chain continues for every pharmacy org, including the all-failed one.
    for (const org of [A, B, C]) {
      expect((await jobByKey(org, `${PARENT}:${S2}`)).status).toBe('QUEUED');
    }
  });

  it('the next slot runs and enqueues a fresh child for the failed branch', async () => {
    contexts.length = 0;
    const result = await tick(T2, 'worker-s2');
    // Parents A, B, C and children A1, A2, B1, C1; the two poisoned ones fail again.
    expect(result.jobs).toMatchObject({ claimed: 7, succeeded: 5, retried: 2, dead: 0 });
    expect(await keyStatus(A)).toEqual([
      [`${PARENT}:${S1}`, 'SUCCEEDED', 1],
      [childKey(A, '1', S1), 'SUCCEEDED', 1],
      [childKey(A, '2', S1), 'DEAD', 5],
      [`${PARENT}:${S2}`, 'SUCCEEDED', 1],
      [childKey(A, '1', S2), 'SUCCEEDED', 1],
      [childKey(A, '2', S2), 'QUEUED', 1],
      [`${PARENT}:${S3}`, 'QUEUED', 0],
    ]);
    expect((await jobByKey(C, childKey(C, '1', S2))).status).toBe('QUEUED');
    // Healthy branches: idempotent, nothing new for the same business dates.
    expect(await occurrenceCounts()).toEqual({ a1: 2, a2: 0, b1: 2, c1: 0, r: 0 });
    expectOwnContexts();
  });

  it('after the trigger is dropped, the failed branches recover with no duplicates', async () => {
    await dropPoisonTrigger(su, TRIGGER);
    expect(await poisonTriggerExists(su, TRIGGER)).toBe(false);

    const result = await tick(plus(T2, 30_000), 'worker-recover');
    expect(result.jobs).toMatchObject({ claimed: 2, succeeded: 2, retried: 0, dead: 0 });
    for (const [org, branch] of [
      [A, '2'],
      [C, '1'],
    ] as const) {
      expect(await jobByKey(org, childKey(org, branch, S2))).toMatchObject({
        status: 'SUCCEEDED',
        attempts: 2,
      });
    }
    // Business dates 4–5 Nov at 09:00 Asia/Karachi (04:00Z), once per branch.
    expect(await occurrenceCounts()).toEqual({ a1: 2, a2: 2, b1: 2, c1: 2, r: 0 });
    for (const [org, branch] of [
      [A, '1'],
      [A, '2'],
      [B, '1'],
      [C, '1'],
    ] as const) {
      const rows = await occurrencesOf(su, org, `${org}_rb${branch}`);
      expect(rows.map((row) => new Date(row.dueAt).toISOString())).toEqual([
        '2026-11-04T04:00:00.000Z',
        '2026-11-05T04:00:00.000Z',
      ]);
      expect(rows.every((row) => row.organizationId === org)).toBe(true);
    }
  });

  it('repeated and concurrent runs create no duplicate parent, child or occurrence', async () => {
    const [left, right, third] = await Promise.all([
      tick(T3, 'worker-s3-left'),
      tick(T3, 'worker-s3-right'),
      tick(T3, 'worker-s3-third'),
    ]);
    const claimed = left.jobs.claimed + right.jobs.claimed + third.jobs.claimed;
    const succeeded = left.jobs.succeeded + right.jobs.succeeded + third.jobs.succeeded;
    expect({ claimed, succeeded }).toEqual({ claimed: 7, succeeded: 7 });
    expect((await tick(T3, 'worker-s3-repeat')).jobs.claimed).toBe(0);

    // Re-run A's S3 parent twice, concurrently, as a duplicate delivery would.
    const before = await jobsOf(su, A);
    const parent = await jobByKey(A, `${PARENT}:${S3}`);
    const rerun = () =>
      deps.scoped.withTenantDb(A, (db) =>
        deps.autoJob.pharmacySopAutoGenerateHandler({
          db,
          job: {
            id: parent.id,
            organizationId: A,
            type: PARENT,
            payload: { slot: S3 },
            attempts: 2,
            maxAttempts: 5,
            claimedBy: 'worker-dup',
            claimToken: 'dup',
            startedAt: T3,
          },
        })
      );
    await Promise.all([rerun(), rerun()]);
    expect(await jobsOf(su, A)).toHaveLength(before.length);

    for (const org of [A, B, C]) {
      const rows = await jobsOf(su, org);
      const keys = rows.map((row) => row.idempotencyKey);
      expect(new Set(keys).size, org).toBe(keys.length);
      expect(rows.filter((row) => row.type === PARENT).map((row) => row.idempotencyKey)).toEqual(
        [S1, S2, S3, S4].map((slot) => `${PARENT}:${slot}`)
      );
      expect((await jobByKey(org, `${PARENT}:${S4}`)).status).toBe('QUEUED');
    }
    expect((await jobsOf(su, A)).filter((row) => row.type === CHILD)).toHaveLength(6);
    expect((await jobsOf(su, C)).filter((row) => row.type === CHILD)).toHaveLength(3);
    expect(await occurrenceCounts()).toEqual({ a1: 2, a2: 2, b1: 2, c1: 2, r: 0 });
    const [dupes] = (
      await su.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM (
           SELECT "assignmentId","dueAt" FROM "restaurant_sop_occurrences"
            WHERE "organizationId" = ANY($1::text[]) GROUP BY 1,2 HAVING count(*) > 1) d`,
        [ORGS]
      )
    ).rows;
    expect(dupes!.n).toBe('0');
  });

  it('tenant isolation: each organization sees only its own jobs, settings and occurrences', async () => {
    for (const org of ORGS) {
      const seen = await deps.scoped.withTenantDb(org, async (db) => ({
        jobs: await db.restaurantJob.findMany({ select: { organizationId: true, payload: true } }),
        occurrences: await db.restaurantSopOccurrence.findMany({
          select: { organizationId: true, branchId: true },
        }),
        settings: await db.pharmacySopSiteSetting.findMany({ select: { organizationId: true } }),
        sites: await db.pharmacySopSite.findMany({ select: { organizationId: true } }),
      }));
      for (const rows of Object.values(seen)) {
        for (const row of rows) expect(row.organizationId).toBe(org);
      }
      for (const row of seen.occurrences) expect(row.branchId.startsWith(`${org}_`)).toBe(true);
      // Every job the org's own parent enqueued names the org's own branches.
      for (const { payload } of seen.jobs) {
        const branch = (payload as { pharmacyBranchId?: string }).pharmacyBranchId;
        if (branch && !branch.startsWith(`${A}_pb2`))
          expect(branch.startsWith(`${org}_`)).toBe(true);
      }
    }
    // The restaurant org created nothing beyond its two strays.
    expect((await jobsOf(su, R)).map((job) => job.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
    expect(await occurrencesOf(su, R)).toEqual([]);
    // No pharmacy SOP job created an escalation policy.
    const { rows } = await su.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "restaurant_sop_escalation_policies"
        WHERE "organizationId" = ANY($1::text[])`,
      [ORGS]
    );
    expect(rows[0]!.n).toBe('0');
  });
});
