/**
 * WHA-79 — the BINDING M7 scheduler concurrency battery.
 *
 * Requires TEST_DATABASE_URL (a migrated, disposable, unprivileged/NOBYPASSRLS
 * database). Skipped when unavailable.
 *
 * The org-scoped durable job queue must claim EXACTLY ONCE under concurrency
 * (§11.5 / D13): >=8 independent workers drain N due jobs, each claim/settle in
 * its OWN tenant-scoped transaction (a separate pooled connection = true
 * parallelism), so `SELECT … FOR UPDATE SKIP LOCKED` is exercised for real. After
 * they all finish, every job is SUCCEEDED exactly once, the append-only execution
 * history has EXACTLY one row per job, and no job was lost or double-claimed. A
 * separately-driven failing job proves bounded retries with backoff terminate at
 * DEAD with one immutable execution row per attempt.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  scheduler: typeof import('@/lib/restaurant/scheduler');
};

const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha79_sched_${suffix}`;

let deps: Deps;

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, scheduler] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/scheduler'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    scheduler,
  };

  await deps.withPlatformDb((tx) =>
    tx.organization.create({
      data: {
        id: orgId,
        slug: `wha79-sched-${suffix}`,
        legalName: 'WHA-79 Scheduler Test',
        displayName: 'WHA-79 Scheduler',
        status: 'ACTIVE',
      },
    })
  );
}, 60_000);

describeIfDatabase('WHA-79 M7 scheduler concurrency battery (real DB)', () => {
  it('claims every due job exactly once under >=8 parallel workers', async () => {
    const WORKERS = 8;
    const JOBS = 40;
    const { withTenantDb, scheduler } = deps;
    const now = new Date();

    // Enqueue N distinct due jobs in one tenant transaction.
    await withTenantDb(orgId, async (tx) => {
      for (let index = 0; index < JOBS; index += 1) {
        await scheduler.enqueue(
          tx,
          {
            type: 'battery.noop',
            payload: { index },
            idempotencyKey: `batt_${suffix}_${index}`,
            scheduledAt: now,
          },
          now
        );
      }
    });

    // Each worker loops claim -> (trivial success) -> complete until the queue is
    // drained. Every claim and every settle is its OWN tenant-scoped transaction,
    // so workers run on separate connections and truly contend for jobs.
    const runWorker = async (workerId: string): Promise<number> => {
      let processed = 0;
      for (;;) {
        const job = await withTenantDb(orgId, (tx) =>
          scheduler.claimNextDue(tx, { workerId, now: new Date() })
        );
        if (!job) break;
        await withTenantDb(orgId, (tx) =>
          scheduler.complete(tx, job.id, {
            workerId,
            attempt: job.attempts,
            claimToken: job.claimToken,
            now: new Date(),
          })
        );
        processed += 1;
      }
      return processed;
    };

    const processedCounts = await Promise.all(
      Array.from({ length: WORKERS }, (_worker, index) => runWorker(`w${index}_${suffix}`))
    );

    // Every claim-success is accounted for and the total equals the job count —
    // no job was lost, none was processed twice.
    expect(processedCounts.reduce((total, count) => total + count, 0)).toBe(JOBS);

    const [statusGroups, executionCount, perJob] = await withTenantDb(orgId, async (tx) => {
      const groups = await tx.restaurantJob.groupBy({
        by: ['status'],
        where: { type: 'battery.noop' },
        _count: { _all: true },
      });
      const total = await tx.restaurantJobExecution.count({
        where: { job: { type: 'battery.noop' } },
      });
      const byJob = await tx.restaurantJobExecution.groupBy({
        by: ['jobId'],
        where: { job: { type: 'battery.noop' } },
        _count: { _all: true },
      });
      return [groups, total, byJob] as const;
    });

    // All jobs terminal-succeeded; none stuck QUEUED/RUNNING or DEAD.
    expect(statusGroups).toEqual([{ status: 'SUCCEEDED', _count: { _all: JOBS } }]);
    // Exactly one execution row per job — the exactly-once evidence.
    expect(executionCount).toBe(JOBS);
    expect(perJob).toHaveLength(JOBS);
    // No job was claimed/executed more than once.
    expect(perJob.filter((group) => group._count._all > 1)).toEqual([]);
  }, 120_000);

  it('drives a failing job through bounded retries to DEAD', async () => {
    const { withTenantDb, scheduler } = deps;
    const key = `dead_${suffix}`;
    // A clock that advances 2 h per call — always past max backoff (30 min cap)
    // so the job is due on every reclaim regardless of elapsed wall time.
    const startMs = Date.now() + 86_400_000;
    let clockTick = 0;
    const clock = () => new Date(startMs + clockTick++ * 2 * 3_600_000);

    const { job } = await withTenantDb(orgId, (tx) =>
      scheduler.enqueue(
        tx,
        { type: 'battery.always-fails', idempotencyKey: key, maxAttempts: 3 },
        new Date()
      )
    );

    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const claimed = await withTenantDb(orgId, (tx) =>
        scheduler.claimNextDue(tx, { workerId: `dead_w_${suffix}`, now: clock() })
      );
      if (!claimed) break;
      const outcome = await withTenantDb(orgId, (tx) =>
        scheduler.fail(tx, claimed.id, new Error('always fails'), {
          workerId: `dead_w_${suffix}`,
          attempt: claimed.attempts,
          claimToken: claimed.claimToken,
          now: clock(),
        })
      );
      outcomes.push(outcome);
    }

    // Two bounded retries, then DEAD — exactly maxAttempts attempts total.
    expect(outcomes).toEqual(['retried', 'retried', 'dead']);

    const [status, executions] = await withTenantDb(orgId, async (tx) => {
      const row = await tx.restaurantJob.findUniqueOrThrow({
        where: { id: job.id },
        select: { status: true },
      });
      const execs = await tx.restaurantJobExecution.findMany({
        where: { jobId: job.id },
        select: { outcome: true, attempt: true },
        orderBy: { attempt: 'asc' },
      });
      return [row.status, execs] as const;
    });

    expect(status).toBe('DEAD');
    expect(executions).toEqual([
      { outcome: 'FAILED', attempt: 1 },
      { outcome: 'FAILED', attempt: 2 },
      { outcome: 'FAILED', attempt: 3 },
    ]);
  }, 60_000);
});
