/**
 * @vitest-environment node
 *
 * WHA-1209 — the PURGING → PURGED retention path, against a REAL PostgreSQL.
 *
 * Two facts from the PLAT-03/04 migration stopped a pharmacy tenant from ever
 * being destroyed, and neither of them survives a mock — one is a trigger, the
 * other is the shape of the foreign-key graph the purge reads out of the
 * catalog at run time:
 *
 *   (a) `pharmacy_onboarding_events` was append-only under an unconditional
 *       BEFORE UPDATE OR DELETE trigger, so the purge's DELETE was refused for
 *       every role once an operator had confirmed a single onboarding step.
 *
 *   (b) `pharmacy_branches` names a default stock location while every stock
 *       location belongs to a branch. Both sides are ON DELETE RESTRICT, so the
 *       two tables form a cycle and the purge's topological sort threw
 *       "cyclic delete dependency" — for EVERY organization, pharmacy or not,
 *       because that graph is read from the whole schema rather than per tenant.
 *
 * So this suite drives `processPlatformJobs` end to end against a real cluster.
 * The purge has to finish, and the tenant's pharmacy rows — branches included —
 * have to be gone afterwards.
 *
 * The second test is the other half: the history must still be append-only for a
 * tenant that exists. A fix that merely dropped the trigger would pass the first
 * test and fail this one.
 *
 * Requires TEST_DATABASE_URL (a migrated, throwaway database, never
 * DATABASE_URL). Without it the suite reports itself skipped rather than passing
 * vacuously.
 *
 * DELIBERATELY DOES NOT CALL `assertRlsEnforcingRole` (#39): nothing asserted
 * here is DECIDED BY row-level security. The purge worker runs through
 * `withPlatformDb`, which sets `app.is_platform_admin` on purpose, every
 * organization id is unique per run, and every assertion filters by
 * organizationId — so a wider-visibility role cannot reach the asserted rows and
 * the suite is valid on a superuser TEST_DATABASE_URL too.
 */
import { randomBytes } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '@/generated/prisma/client';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// `@/lib/db` reads DATABASE_URL when its module is evaluated, so this must
// happen before the dynamic imports in `beforeAll`.
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

/**
 * `@/lib/db` hands `PrismaPg` a `pg.Pool` it constructed itself, and the adapter
 * separates a pool from a config with `poolOrConfig instanceof pg.Pool`. Under
 * Vitest the application module and the adapter's own bundle resolve to two
 * different copies of `pg`, so that check is false, the adapter treats the pool
 * object as a `PoolConfig`, and the connection dies in the startup packet with
 * "The string argument must be of type string ... Received an instance of
 * Object". It is an artefact of module duplication under the test runner, not of
 * anything this suite or the production path does, and it takes down every
 * database suite that reaches for the shared client.
 *
 * Handing the adapter a connection string instead — its other documented input,
 * and the one that needs no cross-realm `instanceof` — gets the same client
 * without that hazard. Everything under test still runs against the real schema
 * through the real `withPlatformDb`.
 */
vi.mock('@/lib/db', () => ({
  db: new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL, max: 10 }),
    log: ['error'],
  }),
}));
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
process.env.BLOB_READ_WRITE_TOKEN ??= 'vercel_blob_rw_wha1209_test_token';

const suffix = randomBytes(6).toString('hex');

const PURGED_ORG = `wha1209_purge_${suffix}`;
const LIVE_ORG = `wha1209_live_${suffix}`;
const BRANCH_ID = `wha1209_branch_${suffix}`;
const LOCATION_ID = `wha1209_loc_${suffix}`;
const JOB_ID = `wha1209_job_${suffix}`;

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;

let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let processPlatformJobs: typeof import('./jobs').processPlatformJobs;

/** An organization plus the onboarding history that made it undeletable. */
async function seedTenant(db: ScopedDb, organizationId: string, status: string) {
  await db.$executeRawUnsafe(
    `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "purgeScheduledAt", "createdAt", "updatedAt")
     VALUES ($1, $1, $1, $1, 'PHARMACY', $2::"OrganizationStatus", 'SHARED', now() - interval '1 day', now(), now())`,
    organizationId,
    status
  );
  await db.$executeRawUnsafe(
    `INSERT INTO pharmacy_onboarding_states (id, "organizationId", "updatedAt") VALUES ($1, $2, now())`,
    `state_${organizationId}`,
    organizationId
  );
  // The row that the append-only trigger refused to let go of.
  await db.$executeRawUnsafe(
    `INSERT INTO pharmacy_onboarding_events (id, "organizationId", gate, "fromStatus", "toStatus", "actorId", "occurredAt")
     VALUES ($1, $2, 'ORG_TYPE', 'NOT_STARTED', 'PASSED', 'wha1209-operator', now())`,
    `event_${organizationId}`,
    organizationId
  );
}

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDatabase('tenant purge, against PostgreSQL', () => {
  beforeAll(async () => {
    ({ withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
    ({ processPlatformJobs } = await import('./jobs'));

    await withPlatformDb(async (db) => {
      await seedTenant(db, PURGED_ORG, 'PURGING');
      await seedTenant(db, LIVE_ORG, 'ACTIVE');

      // The mutually-referencing pair: a branch that names a default stock
      // location which in turn belongs to that branch.
      await db.$executeRawUnsafe(
        `INSERT INTO pharmacy_branches (id, "organizationId", code, name, "addressLine", city, "provinceCode", "updatedAt")
         VALUES ($1, $2, $1, 'Gulberg', '12 Mall Road', 'Lahore', 'PB', now())`,
        BRANCH_ID,
        PURGED_ORG
      );
      await db.$executeRawUnsafe(
        `INSERT INTO pharmacy_stock_locations (id, "organizationId", "branchId", code, name, kind, "updatedAt")
         VALUES ($1, $2, $3, $1, 'Main store', 'STORE', now())`,
        LOCATION_ID,
        PURGED_ORG,
        BRANCH_ID
      );
      await db.$executeRawUnsafe(
        `UPDATE pharmacy_branches SET "defaultStockLocationId" = $1 WHERE id = $2`,
        LOCATION_ID,
        BRANCH_ID
      );

      await db.$executeRawUnsafe(
        // maxAttempts 1: a failure is terminal, so it lands in `error` for the
        // assertion to report instead of being rescheduled silently.
        `INSERT INTO platform_jobs (id, "organizationId", type, status, payload, "maxAttempts", "updatedAt")
         VALUES ($1, $2, 'PURGE_DATA', 'QUEUED', '{}'::jsonb, 1, now())`,
        JOB_ID,
        PURGED_ORG
      );

      // The worker claims the oldest job whose `scheduledAt` has come, so any
      // job a previous suite or seed left QUEUED would be claimed ahead of this
      // one. Defer them rather than deleting them: the queue is left intact, and
      // `processPlatformJobs(1)` can only pick the job under test.
      await db.$executeRawUnsafe(
        `UPDATE platform_jobs SET "scheduledAt" = now() + interval '1 day'
         WHERE status = 'QUEUED' AND id <> $1`,
        JOB_ID
      );
    });
  }, 60_000);

  it('purges a pharmacy tenant that has confirmed an onboarding step', async () => {
    const result = await processPlatformJobs(1);

    const job = await withPlatformDb((db) =>
      db.platformJob.findUniqueOrThrow({
        where: { id: JOB_ID },
        select: { status: true, error: true },
      })
    );
    // One assertion over the job row and the worker's tally together, so a
    // failure reports the database's own message rather than an opaque
    // "expected 'QUEUED' to be 'SUCCEEDED'".
    expect({
      status: job.status,
      error: job.error,
      claimed: result.claimed,
      succeeded: result.succeeded,
      retried: result.retried,
      failed: result.failed,
    }).toEqual({
      status: 'SUCCEEDED',
      error: null,
      claimed: 1,
      succeeded: 1,
      retried: 0,
      failed: 0,
    });

    const [remaining] = await withPlatformDb((db) =>
      db.$queryRawUnsafe<Array<Record<string, bigint>>>(
        `SELECT (SELECT count(*) FROM pharmacy_branches WHERE "organizationId" = $1) AS branches,
                (SELECT count(*) FROM pharmacy_stock_locations WHERE "organizationId" = $1) AS locations,
                (SELECT count(*) FROM pharmacy_onboarding_events WHERE "organizationId" = $1) AS events,
                (SELECT count(*) FROM pharmacy_onboarding_states WHERE "organizationId" = $1) AS states`,
        PURGED_ORG
      )
    );
    // The branch aggregate is the row the issue reports as outliving its tenant.
    // `count(*)` arrives as a bigint; the tsconfig target predates bigint
    // literals, so compare against BigInt(0) rather than 0n.
    const none = BigInt(0);
    expect(remaining).toEqual({
      branches: none,
      locations: none,
      events: none,
      states: none,
    });

    const organization = await withPlatformDb((db) =>
      db.organization.findUniqueOrThrow({
        where: { id: PURGED_ORG },
        select: { status: true },
      })
    );
    expect(organization.status).toBe('PURGED');
  });

  it('keeps the onboarding history append-only while the tenant exists', async () => {
    await expect(
      withPlatformDb((db) =>
        db.$executeRawUnsafe(
          `DELETE FROM pharmacy_onboarding_events WHERE "organizationId" = $1`,
          LIVE_ORG
        )
      )
    ).rejects.toThrow(/append-only/);

    await expect(
      withPlatformDb((db) =>
        db.$executeRawUnsafe(
          `UPDATE pharmacy_onboarding_events SET note = 'rewritten' WHERE "organizationId" = $1`,
          LIVE_ORG
        )
      )
    ).rejects.toThrow(/append-only/);

    // Still exactly one row, and the tenant is still deletable: the declared
    // ON DELETE CASCADE now reaches the history instead of being refused by it.
    const [before] = await withPlatformDb((db) =>
      db.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*) AS count FROM pharmacy_onboarding_events WHERE "organizationId" = $1`,
        LIVE_ORG
      )
    );
    expect(before.count).toBe(BigInt(1));

    await withPlatformDb((db) =>
      db.$executeRawUnsafe(`DELETE FROM organizations WHERE id = $1`, LIVE_ORG)
    );

    const [after] = await withPlatformDb((db) =>
      db.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*) AS count FROM pharmacy_onboarding_events WHERE "organizationId" = $1`,
        LIVE_ORG
      )
    );
    expect(after.count).toBe(BigInt(0));
  });
});
