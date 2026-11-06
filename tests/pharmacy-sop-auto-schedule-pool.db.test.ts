// @vitest-environment node
/**
 * DEV-751 — automatic scheduling needs ONE pooled connection per unit of work.
 *
 * The app's Prisma pool (`src/lib/db.ts`, a `pg.Pool` behind the driver
 * adapter) is capped at ONE connection for this test process only, by wrapping
 * the `pg.Pool` constructor that db.ts calls (`max: 1`, plus an
 * `application_name` tag so its backends can be counted in pg_stat_activity).
 * db.ts itself, the adapter, `withTenantDb` and the worker are all real.
 *
 * With one connection, any handler that needed a second connection while the
 * worker's transaction is open could never get it. The control proves the cap
 * bites: a second transaction opened inside a first one (the pattern of the old
 * independent-client design) cannot start. Then the request path (turning a
 * branch ON inside one request transaction, as the tRPC route does) and the
 * full worker flow (parent → per-branch children, a poisoned child retried to
 * DEAD, the next slot, recovery) complete, while a sampler counts the app's
 * backends in pg_stat_activity throughout.
 *
 * Requires PHARMACY_SOP_TEST_RUNTIME_DATABASE_URL, PHARMACY_SOP_TEST_OWNER_DATABASE_URL
 * and PHARMACY_SOP_TEST_SUPERUSER_DATABASE_URL against a disposable migrated
 * database; skipped otherwise.
 */
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  cleanupOrganizations,
  createPoisonTrigger,
  dropPoisonTrigger,
  jobsOf,
  leftoverRows,
  occurrencesOf,
  poisonTriggerExists,
  seedOrganization,
} from './pharmacy-sop-auto-schedule-fixtures';

const pool = vi.hoisted(() => ({
  tag: `dev751_pool1_${Math.random().toString(16).slice(2, 10)}`,
  created: [] as Array<{ max: unknown; application_name: unknown }>,
}));

// Cap the pool db.ts builds; every other export of `pg` is the real one.
vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pg')>();
  const RealPool = actual.default.Pool;
  class CappedPool extends RealPool {
    constructor(config?: import('pg').PoolConfig) {
      const capped = { ...config, max: 1, application_name: pool.tag };
      pool.created.push({ max: capped.max, application_name: capped.application_name });
      super(capped);
    }
  }
  const pg = Object.assign(Object.create(actual.default) as typeof actual.default, {
    Pool: CappedPool,
  });
  return { ...actual, Pool: CappedPool, default: pg };
});

const runtimeUrl = process.env.PHARMACY_SOP_TEST_RUNTIME_DATABASE_URL;
const ownerUrl = process.env.PHARMACY_SOP_TEST_OWNER_DATABASE_URL;
const superuserUrl = process.env.PHARMACY_SOP_TEST_SUPERUSER_DATABASE_URL;
const enabled = Boolean(runtimeUrl && ownerUrl && superuserUrl);
if (enabled) process.env.DATABASE_URL = runtimeUrl;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = enabled ? describe : describe.skip;

type Deps = {
  scoped: typeof import('@/lib/tenancy/scoped-db');
  runner: typeof import('@/lib/restaurant/job-runner');
  autoJob: typeof import('@/lib/pharmacy/sop-auto-schedule-job');
  prisma: typeof import('@/generated/prisma/client');
};
let deps: Deps;

const run = randomBytes(4).toString('hex');
const id = (name: string) => `dev751p_${run}_${name}`;
const P = id('org_p');
const Q = id('org_q');
const ORGS = [P, Q];
const USER = id('manager');
const TRIGGER = `dev751_pool_poison_${run}`;

const CHILD = 'pharmacy.sop.autoGenerateBranch';
const S1 = '2026-11-04T07:00:00.000Z';
const T0 = new Date('2026-11-04T06:30:00.000Z');
const T1 = new Date('2026-11-04T07:00:30.000Z');
const T2 = new Date('2026-11-04T08:00:30.000Z');
const plus = (at: Date, ms: number) => new Date(at.getTime() + ms);

let su: Client;
let sampler: Client;

/** Live count of the app pool's backends (any state), via the superuser. */
async function appBackends(client: Client = sampler): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_stat_activity WHERE application_name = $1`,
    [pool.tag]
  );
  return Number(rows[0]!.n);
}

/** Samples continuously while `work` runs; returns its value and the samples. */
async function sampled<T>(work: () => Promise<T>): Promise<{ value: T; samples: number[] }> {
  const samples: number[] = [];
  let done = false;
  const loop = (async () => {
    while (!done) {
      samples.push(await appBackends());
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  })();
  try {
    return { value: await work(), samples };
  } finally {
    done = true;
    await loop;
  }
}

const inside: number[] = [];

/** The real `withTenantDb`; samples the backend count from inside each unit of work. */
function runInOrg<T>(organizationId: string, work: (db: never) => Promise<T>): Promise<T> {
  return deps.scoped.withTenantDb(organizationId, async (db) => {
    inside.push(await appBackends(su));
    const value = await work(db as never);
    inside.push(await appBackends(su));
    return value;
  });
}

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

function tick(now: Date, workerId: string) {
  return deps.runner.runRestaurantWorkerTick({
    workerId,
    now,
    discoverOrganizations: discover,
    runInOrg: runInOrg as never,
  });
}

const allSamples: number[] = [];

describeIfDatabase(
  'DEV-751 automatic scheduling with the app pool capped at one connection',
  () => {
    beforeAll(async () => {
      const [scoped, runner, autoJob, prisma] = await Promise.all([
        import('@/lib/tenancy/scoped-db'),
        import('@/lib/restaurant/job-runner'),
        import('@/lib/pharmacy/sop-auto-schedule-job'),
        import('@/generated/prisma/client'),
      ]);
      deps = { scoped, runner, autoJob, prisma };

      su = new Client({ connectionString: superuserUrl });
      sampler = new Client({ connectionString: superuserUrl });
      await Promise.all([su.connect(), sampler.connect()]);
      expect(await leftoverRows(su, ORGS)).toBe(0);

      const runtime = new Client({ connectionString: runtimeUrl });
      await runtime.connect();
      try {
        await seedOrganization(runtime, P, {
          pharmacy: true,
          branches: [
            { key: '1', on: true },
            { key: '2', on: true },
          ],
          userId: USER,
        });
        await seedOrganization(runtime, Q, {
          pharmacy: true,
          branches: [{ key: '1', on: true }],
          userId: USER,
        });
      } finally {
        await runtime.end();
      }
      await createPoisonTrigger(su, TRIGGER, [`${P}_rb2`]);
    }, 120_000);

    afterAll(async () => {
      if (!su) return;
      try {
        await dropPoisonTrigger(su, TRIGGER);
        expect(await poisonTriggerExists(su, TRIGGER)).toBe(false);
        await cleanupOrganizations(su, ORGS);
        expect(await leftoverRows(su, ORGS)).toBe(0);
      } finally {
        await Promise.all([su.end(), sampler.end()]);
      }
    }, 120_000);

    it('the cap is real: a second transaction cannot start inside the first', async () => {
      const { withTenantDb } = deps.scoped;
      // The old design: an independent tenant client used while the handler's
      // transaction holds the pool's only connection.
      const nested = withTenantDb(P, () =>
        withTenantDb(P, async () => 'unreachable', { maxWait: 1_000, skipDrain: true })
      );
      await expect(nested).rejects.toThrow(/transaction/i);
      // The app built exactly one pool, capped and tagged.
      expect(pool.created).toEqual([{ max: 1, application_name: pool.tag }]);
      expect(await appBackends()).toBeLessThanOrEqual(1);
    });

    it('turning a branch ON inside one request transaction needs no second connection', async () => {
      const { withTenantDb } = deps.scoped;
      const { value, samples } = await sampled(() =>
        Promise.all(
          [P, Q].map((org) =>
            // As the tRPC route: one outer request transaction, ctx.db = its tx.
            withTenantDb(org, (db) =>
              deps.autoJob.startPharmacySopAutoSchedule(db, {
                organizationId: org,
                sopBranchId: `${org}_rb1`,
                now: T0,
              })
            )
          )
        )
      );
      allSamples.push(...samples);
      for (const started of value) {
        expect(started.generated).toEqual({ assignmentsProcessed: 1, created: 2, skipped: 0 });
        expect(started.job.slot.toISOString()).toBe(S1);
      }
      expect(Math.max(...samples)).toBeLessThanOrEqual(1);
    });

    it('the full worker flow completes on one connection, failure and retries included', async () => {
      inside.length = 0;
      const first = await sampled(() => tick(T1, 'worker-pool'));
      allSamples.push(...first.samples);
      // Parents P, Q; children P1, P2 (poisoned), Q1.
      expect(first.value.jobs).toMatchObject({ claimed: 5, succeeded: 4, retried: 1, dead: 0 });

      let at = T1;
      for (const delay of [30_000, 60_000, 120_000, 240_000]) {
        at = plus(at, delay);
        const retry = await sampled(() => tick(at, 'worker-pool'));
        allSamples.push(...retry.samples);
        expect(retry.value.jobs.claimed).toBe(1);
      }
      const poisoned = (await jobsOf(su, P)).find(
        (job) => job.idempotencyKey === `${CHILD}:${P}_pb2:${S1}`
      );
      expect(poisoned).toMatchObject({ status: 'DEAD', attempts: 5 });

      // Recovery on the next slot, still on one connection.
      await dropPoisonTrigger(su, TRIGGER);
      const next = await sampled(() => tick(T2, 'worker-pool'));
      allSamples.push(...next.samples);
      expect(next.value.jobs).toMatchObject({ claimed: 5, succeeded: 5, retried: 0, dead: 0 });
      for (const branch of [`${P}_rb1`, `${P}_rb2`]) {
        expect(await occurrencesOf(su, P, branch)).toHaveLength(2);
      }
      expect(await occurrencesOf(su, Q, `${Q}_rb1`)).toHaveLength(2);

      // Connection evidence: never more than one app backend, sampled from
      // outside (continuously) and from inside every unit of work.
      expect(inside.length).toBeGreaterThan(0);
      expect(Math.max(...inside)).toBe(1);
      expect(allSamples.length).toBeGreaterThan(0);
      expect(Math.max(...allSamples)).toBe(1);
    }, 60_000);
  }
);
