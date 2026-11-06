// @vitest-environment node
/**
 * DEV-751 — opt-in pharmacy SOP automatic scheduling, end to end on PostgreSQL.
 *
 * Drives the REAL worker path: `runRestaurantWorkerTick` → the composed job
 * registry → the hourly parent `pharmacySopAutoGenerateHandler`, which enqueues
 * one `pharmacySopAutoGenerateBranchHandler` child per ON branch (drained in
 * the same tick), with claims, handlers and
 * settlement in each organization's own RLS context (`withTenantDb`) as the
 * restricted runtime role, and an injected tick clock. Fixtures: two pharmacy
 * organizations and one restaurant organization.
 *
 *   org A branch 1: automatic scheduling ON (daily 09:00 + every 4h 09:00–17:00)
 *   org A branch 2: ON then OFF (latest wins → OFF)
 *   org B         : never changed (default OFF), with an active daily schedule
 *                   and an event (receiving) procedure started on demand
 *   org R         : restaurant, no pharmacy SOP site
 *
 * Turning a branch ON and every hourly run never back-date: they create the
 * branch's current business date and the next one only, and never work due
 * before the branch was turned ON (or before its schedule was created), so a
 * branch starts at each schedule's next due time. Schedules are created on
 * 1 Nov (pinned, so no run depends on the wall clock).
 *
 * The on-demand start drives the REAL `pharmacySop.startOnDemand` router
 * procedure on the real database (engine assignment + generation + pause);
 * only the session gates (ABAC `can`, the adapter's branch/actor/role lookups)
 * and audit writes are stubbed. The worker path uses none of them.
 *
 * Discovery is the worker's own privileged read scan, restricted to these
 * fixture organizations so jobs of other tenants in a shared scratch database
 * are never touched. Fixture rows are committed (the worker uses its own
 * connections) and removed at the end by the cleanup superuser, because the
 * append-only pharmacy SOP tables have no DELETE policy for any app role.
 *
 * Requires PHARMACY_SOP_TEST_RUNTIME_DATABASE_URL (restricted runtime role),
 * PHARMACY_SOP_TEST_OWNER_DATABASE_URL and PHARMACY_SOP_TEST_SUPERUSER_DATABASE_URL
 * (cleanup only) against a disposable migrated database; skipped otherwise.
 */
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  granted: new Set<string>(),
  adapter: {
    resolvePharmacySopSite: vi.fn(),
    resolvePharmacySopActor: vi.fn(),
    pharmacySopRolesAt: vi.fn(),
  },
}));

// Router gates only (startOnDemand); the worker path never reaches these.
vi.mock('@/server/audit', async () => ({
  ...(await vi.importActual<typeof import('@/server/audit')>('@/server/audit')),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: vi.fn(async (_subject: unknown, action: string) => mocks.granted.has(action)),
}));
vi.mock('@/lib/pharmacy/sop-adapter', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/sop-adapter')>(
    '@/lib/pharmacy/sop-adapter'
  )),
  ...mocks.adapter,
}));

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
  settings: typeof import('@/lib/pharmacy/sop-settings');
  autoJob: typeof import('@/lib/pharmacy/sop-auto-schedule-job');
  prisma: typeof import('@/generated/prisma/client');
  trpc: typeof import('@/server/trpc');
  sopRouter: typeof import('@/server/routers/pharmacy-sop');
  library: typeof import('@/lib/pharmacy/sop-library');
};
let deps: Deps;

const run = randomBytes(4).toString('hex');
const id = (name: string) => `dev751j_${run}_${name}`;
const A = id('org_a');
const B = id('org_b');
const R = id('org_r');
const ORGS = [A, B, R];
const USER = id('manager');

const T0 = new Date('2026-11-04T06:30:00.000Z'); // 11:30 Asia/Karachi, Wed 4 Nov
const T1 = new Date('2026-11-04T07:00:30.000Z'); // first slot (07:00Z)
const T2 = new Date('2026-11-05T05:00:30.000Z'); // late worker: next day 10:00 PKT
const T3 = new Date('2026-11-05T06:00:30.000Z'); // the slot after T2, after turning OFF

let su: Client;

/** Org-context evidence: every worker unit of work, and the tenant GUC it saw. */
const contexts: Array<{ organizationId: string; guc: string; platform: string }> = [];

async function sql<T extends Record<string, unknown>>(query: string, params: unknown[] = []) {
  return (await su.query<T>(query, params)).rows;
}

let receivingName = '';

async function seed(runtime: Client) {
  const q = (query: string, params: unknown[]) => runtime.query(query, params);
  // Platform-admin scope on this connection only, for fixture inserts.
  await q(
    `SELECT set_config('app.is_platform_admin','true',false),
            set_config('app.current_organization_id','',false)`,
    []
  );
  for (const org of ORGS) {
    await q(
      `INSERT INTO "organizations" ("id","slug","legalName","displayName","updatedAt")
       VALUES ($1,$1,$1,$1,now())`,
      [org]
    );
    await q(
      `INSERT INTO "restaurant_staff_profiles" ("id","organizationId","displayName","updatedAt")
       VALUES ($1,$2,'Staff',now())`,
      [`${org}_sp`, org]
    );
    await q(
      `INSERT INTO "restaurant_sop_templates" ("id","organizationId","name","updatedAt")
       VALUES ($1,$2,'Opening',now())`,
      [`${org}_tpl`, org]
    );
    await q(
      `INSERT INTO "restaurant_sop_template_versions" ("id","organizationId","templateId","versionNumber","status","updatedAt")
       VALUES ($1,$2,$3,1,'PUBLISHED',now())`,
      [`${org}_ver`, org, `${org}_tpl`]
    );
    await q(
      `INSERT INTO "restaurant_sop_template_steps" ("id","organizationId","templateVersionId","stepOrder","title","updatedAt")
       VALUES ($1,$2,$3,1,'Check',now())`,
      [`${org}_tstep`, org, `${org}_ver`]
    );
  }

  const branch = async (org: string, key: string, timezone: string, pharmacy: boolean) => {
    await q(
      `INSERT INTO "restaurant_branches" ("id","organizationId","name","timezone","updatedAt")
       VALUES ($1,$2,$3,$4,now())`,
      [`${org}_rb${key}`, org, `Branch ${key}`, timezone]
    );
    if (!pharmacy) return;
    await q(
      `INSERT INTO "pharmacy_branches" ("id","organizationId","code","name","addressLine","city","provinceCode","updatedAt")
       VALUES ($1,$2,$3,$3,'1 Road','Lahore','PB',now())`,
      [`${org}_pb${key}`, org, `PB${key}`]
    );
    await q(
      `INSERT INTO "pharmacy_sop_sites" ("id","organizationId","pharmacyBranchId","sopBranchId","enabledByUserId")
       VALUES ($1,$2,$3,$4,$5)`,
      [`${org}_site${key}`, org, `${org}_pb${key}`, `${org}_rb${key}`, USER]
    );
  };
  const daily = async (org: string, key: string, asg: string, dueTimeMinutes: number) =>
    q(
      `INSERT INTO "restaurant_sop_assignments" ("id","organizationId","branchId","templateId","frequency","startDate","dueTimeMinutes","assigneeTargetType","assigneeStaffProfileId","createdAt","updatedAt")
       VALUES ($1,$2,$3,$4,'DAILY','2026-11-01',$5,'PERSON',$6,'2026-11-01 00:00',now())`,
      [`${org}_${asg}${key}`, org, `${org}_rb${key}`, `${org}_tpl`, dueTimeMinutes, `${org}_sp`]
    );

  await branch(A, '1', 'Asia/Karachi', true);
  await branch(A, '2', 'Asia/Karachi', true);
  await branch(B, '1', 'Asia/Karachi', true);
  await branch(R, '1', 'Asia/Dubai', false);
  await daily(A, '1', 'asg_daily', 9 * 60);
  await q(
    `INSERT INTO "restaurant_sop_assignments" ("id","organizationId","branchId","templateId","frequency","interval","daysOfWeek","startDate","dueTimeMinutes","intervalEndTimeMinutes","windowMinutes","assigneeTargetType","assigneeStaffProfileId","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,'INTERVAL',240,'{0,1,2,3,4,5,6}','2026-11-01',540,1020,60,'PERSON',$5,'2026-11-01 00:00',now())`,
    [`${A}_asg_interval`, A, `${A}_rb1`, `${A}_tpl`, `${A}_sp`]
  );
  await daily(A, '2', 'asg_daily', 9 * 60);
  await daily(B, '1', 'asg_daily', 9 * 60);
  await daily(R, '1', 'asg_daily', 10 * 60);

  // Org B: an event-triggered pack template (receiving), published, for the
  // on-demand start. Its name is what maps it to the pharmacy pack.
  await q(
    `INSERT INTO "restaurant_sop_templates" ("id","organizationId","name","updatedAt")
     VALUES ($1,$2,$3,now())`,
    [`${B}_tpl_recv`, B, receivingName]
  );
  await q(
    `INSERT INTO "restaurant_sop_template_versions" ("id","organizationId","templateId","versionNumber","status","updatedAt")
     VALUES ($1,$2,$3,1,'PUBLISHED',now())`,
    [`${B}_ver_recv`, B, `${B}_tpl_recv`]
  );
  await q(
    `INSERT INTO "restaurant_sop_template_steps" ("id","organizationId","templateVersionId","stepOrder","title","updatedAt")
     VALUES ($1,$2,$3,1,'Check delivery',now())`,
    [`${B}_tstep_recv`, B, `${B}_ver_recv`]
  );

  // Org A branch 2: turned ON, then OFF later; the latest row wins.
  await q(
    `INSERT INTO "pharmacy_sop_site_settings" ("id","organizationId","pharmacyBranchId","autoScheduleEnabled","changedByUserId","createdAt")
     VALUES ($1,$3,$4,true,$5,'2026-11-01 00:00'), ($2,$3,$4,false,$5,'2026-11-02 00:00')`,
    [id('set_a2_on'), id('set_a2_off'), A, `${A}_pb2`, USER]
  );
}

/** The id of a branch's newest setting row (read through the cleanup superuser). */
async function settingId(org: string, pharmacyBranchId: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `SELECT "id" FROM "pharmacy_sop_site_settings"
      WHERE "organizationId" = $1 AND "pharmacyBranchId" = $2
      ORDER BY "createdAt" DESC, "id" DESC LIMIT 1`,
    [org, pharmacyBranchId]
  );
  return row!.id;
}

async function cleanup() {
  await su.query('BEGIN');
  await su.query(`SET LOCAL session_replication_role = replica`);
  const tables = await sql<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='organizationId'`
  );
  for (const { table_name } of tables) {
    await su.query(`DELETE FROM "${table_name}" WHERE "organizationId" = ANY($1::text[])`, [ORGS]);
  }
  await su.query(`DELETE FROM "organizations" WHERE "id" = ANY($1::text[])`, [ORGS]);
  await su.query('COMMIT');
}

async function leftovers(): Promise<number> {
  const tables = await sql<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='organizationId'`
  );
  let total = 0;
  for (const { table_name } of tables) {
    const [row] = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${table_name}" WHERE "organizationId" = ANY($1::text[])`,
      [ORGS]
    );
    total += Number(row!.n);
  }
  const [org] = await sql<{ n: string }>(
    `SELECT count(*)::text AS n FROM "organizations" WHERE "id" = ANY($1::text[])`,
    [ORGS]
  );
  return total + Number(org!.n);
}

/** Read-only checks bypass RLS through the cleanup superuser (never writes here). */
async function occurrences(org: string, branchKey?: string) {
  return sql<{
    id: string;
    branchId: string;
    dueAt: Date;
    assignmentId: string;
    organizationId: string;
  }>(
    `SELECT "id","branchId","dueAt","assignmentId","organizationId" FROM "restaurant_sop_occurrences"
      WHERE "organizationId" = $1 ${branchKey ? `AND "branchId" = $2` : ''}
      ORDER BY "dueAt","assignmentId"`,
    branchKey ? [org, `${org}_rb${branchKey}`] : [org]
  );
}

async function jobs(org: string) {
  return sql<{
    id: string;
    organizationId: string;
    type: string;
    status: string;
    idempotencyKey: string | null;
    scheduledAt: Date;
    payload: unknown;
  }>(
    `SELECT "id","organizationId","type","status","idempotencyKey","scheduledAt","payload"
       FROM "restaurant_jobs" WHERE "organizationId" = $1 ORDER BY "scheduledAt","createdAt"`,
    [org]
  );
}

async function executions(org: string) {
  return sql<{ jobId: string; outcome: string; n: string }>(
    `SELECT e."jobId", e."outcome", count(*)::text AS n
       FROM "restaurant_job_executions" e JOIN "restaurant_jobs" j ON j."id" = e."jobId"
      WHERE j."organizationId" = $1 GROUP BY 1,2 ORDER BY 1`,
    [org]
  );
}

/** The worker's privileged discovery scan, restricted to the fixture orgs. */
async function discover(): Promise<string[]> {
  const { withPlatformDb } = deps.scoped;
  const { Prisma } = deps.prisma;
  return withPlatformDb(async (db) => {
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

const iso = (rows: Array<{ dueAt: Date }>) => rows.map((row) => new Date(row.dueAt).toISOString());

describeIfDatabase('DEV-751 pharmacy SOP automatic scheduling on the real worker', () => {
  beforeAll(async () => {
    const [scoped, runner, scheduler, settings, autoJob, prisma, trpc, sopRouter, library] =
      await Promise.all([
        import('@/lib/tenancy/scoped-db'),
        import('@/lib/restaurant/job-runner'),
        import('@/lib/restaurant/scheduler'),
        import('@/lib/pharmacy/sop-settings'),
        import('@/lib/pharmacy/sop-auto-schedule-job'),
        import('@/generated/prisma/client'),
        import('@/server/trpc'),
        import('@/server/routers/pharmacy-sop'),
        import('@/lib/pharmacy/sop-library'),
      ]);
    deps = { scoped, runner, scheduler, settings, autoJob, prisma, trpc, sopRouter, library };
    const receiving = library.findPharmacySopPack('receiving');
    expect(receiving?.pharmacy.trigger).toBe('EVENT');
    receivingName = receiving!.name;

    su = new Client({ connectionString: superuserUrl });
    await su.connect();
    expect(await leftovers()).toBe(0);

    const runtime = new Client({ connectionString: runtimeUrl });
    await runtime.connect();
    try {
      const { rows } = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      );
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      await seed(runtime);
    } finally {
      await runtime.end();
    }
  }, 120_000);

  afterAll(async () => {
    if (!su) return;
    try {
      await cleanup();
      expect(await leftovers()).toBe(0);
    } finally {
      await su.end();
    }
  }, 120_000);

  it('nothing runs until a manager opts in: no jobs and no occurrences anywhere', async () => {
    expect(await discover()).toEqual([]);
    for (const org of ORGS) {
      expect(await jobs(org)).toEqual([]);
      expect(await occurrences(org)).toEqual([]);
    }
  });

  it('turning org A branch 1 ON creates its work now and starts exactly one job', async () => {
    const { withTenantDb, createTenantDb } = deps.scoped;
    const changed = await withTenantDb(A, (db) =>
      deps.settings.setPharmacySopAutoSchedule(db, {
        site: { pharmacyBranchId: `${A}_pb1` },
        enabled: true,
        userId: USER,
        reason: 'Team agreed',
      })
    );
    expect(changed).toMatchObject({ changed: true, setting: { autoScheduleEnabled: true } });
    // The switch ON is pinned to T0 (the row was stamped by the wall clock) so
    // the hourly runs below floor at the same instant as this start.
    await su.query(`UPDATE "pharmacy_sop_site_settings" SET "createdAt" = $1 WHERE "id" = $2`, [
      T0,
      await settingId(A, `${A}_pb1`),
    ]);
    // Exactly what the router does after appending the setting (ctx.db is a
    // per-operation tenant client); repeated toggles reuse the same slot job.
    const db = createTenantDb(A, USER);
    const first = await deps.autoJob.startPharmacySopAutoSchedule(db, {
      organizationId: A,
      sopBranchId: `${A}_rb1`,
      now: T0,
      enabledAt: T0,
    });
    const again = await deps.autoJob.startPharmacySopAutoSchedule(db, {
      organizationId: A,
      sopBranchId: `${A}_rb1`,
      now: new Date(T0.getTime() + 60_000),
      enabledAt: T0,
    });
    expect(first.generated).toEqual({ assignmentsProcessed: 2, created: 6, skipped: 0 });
    expect(again.generated.created).toBe(0);
    expect(first.job.deduplicated).toBe(false);
    expect(again.job).toMatchObject({ deduplicated: true, job: { id: first.job.job.id } });

    // Configured times in Asia/Karachi (UTC+5) for business dates 4–5 Nov (the
    // current one and the next; never 3 Nov, when the branch was OFF):
    // daily 09:00 → 04:00Z; every 4h 09:00, 13:00, 17:00 → 04:00Z, 08:00Z, 12:00Z.
    // Turned ON at 11:30 local (06:30Z): today's 09:00 checks were already
    // overdue and are not created; the branch starts at the 13:00 check.
    const expected = [
      '2026-11-04T08:00:00.000Z',
      '2026-11-04T12:00:00.000Z',
      '2026-11-05T04:00:00.000Z',
      '2026-11-05T04:00:00.000Z',
      '2026-11-05T08:00:00.000Z',
      '2026-11-05T12:00:00.000Z',
    ];
    expect(iso(await occurrences(A, '1'))).toEqual(expected);
    const [overdue] = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM "restaurant_sop_occurrences"
        WHERE "organizationId" = $1 AND "dueAt" < $2`,
      [A, T0]
    );
    expect(overdue!.n).toBe('0');
    // Nothing before the business date the branch was turned ON.
    const [backdated] = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM "restaurant_sop_occurrences"
        WHERE "organizationId" = $1 AND "businessDate" < DATE '2026-11-04'`,
      [A]
    );
    expect(backdated!.n).toBe('0');
    expect(await occurrences(A, '2')).toEqual([]);
    expect(await occurrences(B)).toEqual([]);
    expect(await occurrences(R)).toEqual([]);

    expect(await jobs(A)).toEqual([
      expect.objectContaining({
        organizationId: A,
        type: 'pharmacy.sop.autoGenerate',
        status: 'QUEUED',
        idempotencyKey: 'pharmacy.sop.autoGenerate:2026-11-04T07:00:00.000Z',
        payload: { slot: '2026-11-04T07:00:00.000Z' },
      }),
    ]);
    expect(await jobs(B)).toEqual([]);
    expect(await discover()).toEqual([A]);
  });

  it('two concurrent ticks run the slot once; the chain re-enqueues one next-slot job and one child', async () => {
    // A stray pharmacy job in the restaurant org (no product path enqueues one)
    // must be a no-op there.
    const stray = await deps.scoped.withTenantDb(R, (db) =>
      deps.autoJob.ensurePharmacySopAutoScheduleJob(db, { organizationId: R, now: T0 })
    );
    expect(stray.job.organizationId).toBe(R);
    expect(await discover()).toEqual([A, R].sort());

    contexts.length = 0;
    const [left, right] = await Promise.all([tick(T1, 'worker-left'), tick(T1, 'worker-right')]);
    // A's parent, A branch 1's child (due at once, same tick) and R's stray.
    expect(left.jobs.claimed + right.jobs.claimed).toBe(3);
    expect(left.jobs.succeeded + right.jobs.succeeded).toBe(3);
    expect(left.jobs.retried + right.jobs.retried + left.jobs.dead + right.jobs.dead).toBe(0);

    // No duplicates: the slot ran once and created nothing new (nor the 09:00
    // checks skipped at the switch ON: the child floors at the same instant).
    expect(await occurrences(A, '1')).toHaveLength(6);
    expect(await occurrences(A, '2')).toEqual([]);
    expect(await occurrences(B)).toEqual([]);
    expect(await occurrences(R)).toEqual([]);

    const aJobs = await jobs(A);
    expect(aJobs.map((job) => [job.idempotencyKey, job.status])).toEqual([
      ['pharmacy.sop.autoGenerate:2026-11-04T07:00:00.000Z', 'SUCCEEDED'],
      [`pharmacy.sop.autoGenerateBranch:${A}_pb1:2026-11-04T07:00:00.000Z`, 'SUCCEEDED'],
      ['pharmacy.sop.autoGenerate:2026-11-04T08:00:00.000Z', 'QUEUED'],
    ]);
    // Only the ON branch got a child; branch 2 (latest OFF) none.
    expect(aJobs[1]!.payload).toEqual({
      slot: '2026-11-04T07:00:00.000Z',
      pharmacyBranchId: `${A}_pb1`,
    });
    expect(aJobs.every((job) => job.organizationId === A)).toBe(true);
    // The restaurant org's stray job did nothing and enqueued nothing.
    expect((await jobs(R)).map((job) => job.status)).toEqual(['SUCCEEDED']);
    expect(await jobs(B)).toEqual([]);
    for (const org of [A, R]) {
      for (const row of await executions(org))
        expect(row).toMatchObject({ outcome: 'SUCCEEDED', n: '1' });
    }

    // RLS: every claim, handler and settle ran in its own org's tenant context.
    expect(contexts.length).toBeGreaterThan(0);
    for (const context of contexts) {
      expect(context).toEqual({
        organizationId: context.organizationId,
        guc: context.organizationId,
        platform: 'false',
      });
    }
    expect(new Set(contexts.map((context) => context.organizationId))).toEqual(new Set([A, R]));

    // A repeat tick at the same instant finds nothing due and changes nothing.
    const repeat = await tick(T1, 'worker-repeat');
    expect(repeat.jobs.claimed).toBe(0);
    expect(await jobs(A)).toHaveLength(3);
    expect(await occurrences(A, '1')).toHaveLength(6);
  });

  it('a late worker creates the next day at the configured times; restaurant jobs are unaffected', async () => {
    // An ordinary restaurant job in the restaurant org, due in the same tick.
    await deps.scoped.withTenantDb(R, (db) =>
      deps.scheduler.enqueue(
        db,
        { type: 'sop.generateOccurrences', payload: { now: T2.toISOString() }, scheduledAt: T2 },
        T2
      )
    );

    contexts.length = 0;
    const result = await tick(T2, 'worker-late');
    // A's parent, its child for branch 1, and R's own engine job.
    expect(result.jobs).toMatchObject({ claimed: 3, succeeded: 3, retried: 0, dead: 0, failed: 0 });

    // Window moved to 5–6 Nov: only 6 Nov is new for org A branch 1 (4 rows).
    const a1 = iso(await occurrences(A, '1'));
    expect(a1).toHaveLength(10);
    expect(a1.slice(6)).toEqual([
      '2026-11-06T04:00:00.000Z',
      '2026-11-06T04:00:00.000Z',
      '2026-11-06T08:00:00.000Z',
      '2026-11-06T12:00:00.000Z',
    ]);
    // 8 distinct times (4 Nov from 08:00Z, then 3 a day); both assignments are
    // due at 04:00Z, as distinct rows.
    expect(new Set(a1).size).toBe(8);
    expect(new Set((await occurrences(A, '1')).map((row) => row.id)).size).toBe(10);
    expect(await occurrences(A, '2')).toEqual([]);
    expect(await occurrences(B)).toEqual([]);

    // The restaurant org's own engine job ran normally (Asia/Dubai 10:00 → 06:00Z).
    expect(iso(await occurrences(R))).toEqual([
      '2026-11-04T06:00:00.000Z',
      '2026-11-05T06:00:00.000Z',
      '2026-11-06T06:00:00.000Z',
    ]);
    expect((await jobs(R)).map((job) => [job.type, job.status])).toEqual([
      ['pharmacy.sop.autoGenerate', 'SUCCEEDED'],
      ['sop.generateOccurrences', 'SUCCEEDED'],
    ]);

    // The late worker scheduled the slot after now, not every missed hour.
    // The child keeps its parent's slot; it ran as of the late claim instant.
    expect((await jobs(A)).map((job) => [job.idempotencyKey, job.status])).toEqual([
      ['pharmacy.sop.autoGenerate:2026-11-04T07:00:00.000Z', 'SUCCEEDED'],
      [`pharmacy.sop.autoGenerateBranch:${A}_pb1:2026-11-04T07:00:00.000Z`, 'SUCCEEDED'],
      ['pharmacy.sop.autoGenerate:2026-11-04T08:00:00.000Z', 'SUCCEEDED'],
      [`pharmacy.sop.autoGenerateBranch:${A}_pb1:2026-11-04T08:00:00.000Z`, 'SUCCEEDED'],
      ['pharmacy.sop.autoGenerate:2026-11-05T06:00:00.000Z', 'QUEUED'],
    ]);
    for (const context of contexts) expect(context.guc).toBe(context.organizationId);
  });

  it('turning branch 1 OFF: the next slot generates nothing and the chain stops', async () => {
    await deps.scoped.withTenantDb(A, (db) =>
      deps.settings.setPharmacySopAutoSchedule(db, {
        site: { pharmacyBranchId: `${A}_pb1` },
        enabled: false,
        userId: USER,
      })
    );
    // OFF appends the setting only: the queued slot is still there until it runs.
    expect((await jobs(A)).filter((job) => job.status === 'QUEUED')).toHaveLength(1);

    const result = await tick(T3, 'worker-off');
    // The parent only: no branch is ON, so no child and no next slot.
    expect(result.jobs).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(await occurrences(A, '1')).toHaveLength(10);
    expect(await occurrences(A, '2')).toEqual([]);
    const aJobs = await jobs(A);
    expect(aJobs).toHaveLength(5);
    expect(aJobs.every((job) => job.status === 'SUCCEEDED')).toBe(true);
    for (const row of await executions(A))
      expect(row).toMatchObject({ outcome: 'SUCCEEDED', n: '1' });

    // No fixture org carries a recurring job any more; later ticks find nothing.
    expect(await discover()).toEqual([]);
    const later = await tick(new Date(T3.getTime() + 3_600_000), 'worker-after');
    expect(later).toMatchObject({ organizations: 0, jobs: { claimed: 0 } });
    expect(await jobs(B)).toEqual([]);
    expect(await occurrences(B)).toEqual([]);
  });

  it('an on-demand start where automatic scheduling is OFF creates exactly that one occurrence', async () => {
    // Org B branch 1: never turned on, with an active daily 09:00 schedule that
    // has never been generated.
    const setting = await deps.scoped.withTenantDb(B, (db) =>
      deps.settings.pharmacySopAutoSchedule(db, { pharmacyBranchId: `${B}_pb1` })
    );
    expect(setting.autoScheduleEnabled).toBe(false);
    const [active] = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM "restaurant_sop_assignments"
        WHERE "organizationId" = $1 AND "branchId" = $2 AND "active"`,
      [B, `${B}_rb1`]
    );
    expect(active!.n).toBe('1');
    expect(await occurrences(B)).toEqual([]);

    const receiving = deps.library.findPharmacySopPack('receiving')!;
    mocks.granted.add('sop:complete');
    mocks.adapter.resolvePharmacySopSite.mockResolvedValue({
      pharmacyBranchId: `${B}_pb1`,
      sopBranchId: `${B}_rb1`,
      timezone: 'Asia/Karachi',
      businessDayCutoff: '00:00',
    });
    mocks.adapter.resolvePharmacySopActor.mockResolvedValue({
      staffProfileId: `${B}_sp`,
      displayName: 'Staff',
      userId: USER,
    });
    mocks.adapter.pharmacySopRolesAt.mockResolvedValue([receiving.pharmacy.roleKey]);

    const app = deps.trpc.router({ pharmacySop: deps.sopRouter.pharmacySopRouter });
    const caller = app.createCaller({
      db: deps.scoped.createTenantDb(B, USER),
      entitlements: {
        organizationId: B,
        enabledModules: ['pharmacy-core', 'pharmacy-safety'],
        modules: [],
        limits: {},
        activeSeats: 1,
        seatLimit: 10,
      },
      session: {
        expires: 'later',
        user: {
          id: USER,
          organizationId: B,
          role: 'EMPLOYEE',
          department: 'OPERATIONS',
          status: 'ACTIVE',
        },
      },
      organization: null,
      support: null,
      requestMeta: { ip: null, userAgent: null },
      audit: { detail: {} },
    } as never).pharmacySop;
    const input = { pharmacyBranchId: `${B}_pb1`, templateId: `${B}_tpl_recv` };

    const started = await caller.startOnDemand(input);
    expect(started.created).toBe(true);

    // Exactly one occurrence: the one-off run. The daily schedule was not swept.
    const rows = await occurrences(B);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: started.occurrenceId, branchId: `${B}_rb1` });
    const [oneOff] = await sql<{ frequency: string; active: boolean; templateId: string }>(
      `SELECT "frequency","active","templateId" FROM "restaurant_sop_assignments" WHERE "id" = $1`,
      [rows[0]!.assignmentId]
    );
    expect(oneOff).toEqual({ frequency: 'ONCE', active: false, templateId: `${B}_tpl_recv` });
    const [daily] = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM "restaurant_sop_occurrences" WHERE "assignmentId" = $1`,
      [`${B}_asg_daily1`]
    );
    expect(daily!.n).toBe('0');

    // Starting again returns the open run; still one occurrence, no job, still OFF.
    await expect(caller.startOnDemand(input)).resolves.toEqual({
      occurrenceId: started.occurrenceId,
      created: false,
    });
    expect(await occurrences(B)).toHaveLength(1);
    expect(await jobs(B)).toEqual([]);
    expect(await discover()).toEqual([]);
  });

  it('pharmacy automatic scheduling created no escalation policy or sweep job', async () => {
    const [policies] = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM "restaurant_sop_escalation_policies" WHERE "organizationId" = ANY($1::text[])`,
      [[A, B]]
    );
    expect(policies!.n).toBe('0');
    const types = await sql<{ type: string }>(
      `SELECT DISTINCT "type" FROM "restaurant_jobs" WHERE "organizationId" = ANY($1::text[])
        ORDER BY "type"`,
      [[A, B]]
    );
    expect(types.map((row) => row.type)).toEqual([
      'pharmacy.sop.autoGenerate',
      'pharmacy.sop.autoGenerateBranch',
    ]);
  });
});
