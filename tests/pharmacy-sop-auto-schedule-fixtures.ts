import type { Client } from 'pg';

/**
 * DEV-751 — shared PostgreSQL fixtures for the automatic-scheduling worker
 * suites (`pharmacy-sop-auto-schedule-failure.db.test.ts`,
 * `pharmacy-sop-auto-schedule-pool.db.test.ts`). The worker commits on its own
 * connections, so fixture rows are committed and removed at the end by the
 * cleanup superuser (the append-only pharmacy SOP tables have no DELETE policy
 * for any app role). Nothing here imports application code: callers pass it in
 * after pointing the app's DATABASE_URL at the runtime role.
 */

export type FixtureBranch = { key: string; on: boolean };

/** One daily 09:00 (Asia/Karachi = 04:00Z) assignment per branch. */
export async function seedOrganization(
  runtime: Client,
  org: string,
  opts: { pharmacy: boolean; branches: FixtureBranch[]; userId: string }
) {
  const q = (query: string, params: unknown[]) => runtime.query(query, params);
  // Platform-admin scope on this connection only, for fixture inserts.
  await q(
    `SELECT set_config('app.is_platform_admin','true',false),
            set_config('app.current_organization_id','',false)`,
    []
  );
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
  for (const { key, on } of opts.branches) {
    await q(
      `INSERT INTO "restaurant_branches" ("id","organizationId","name","timezone","updatedAt")
       VALUES ($1,$2,$3,'Asia/Karachi',now())`,
      [`${org}_rb${key}`, org, `Branch ${key}`]
    );
    await q(
      `INSERT INTO "restaurant_sop_assignments" ("id","organizationId","branchId","templateId","frequency","startDate","dueTimeMinutes","assigneeTargetType","assigneeStaffProfileId","updatedAt")
       VALUES ($1,$2,$3,$4,'DAILY','2026-11-01',540,'PERSON',$5,now())`,
      [`${org}_asg${key}`, org, `${org}_rb${key}`, `${org}_tpl`, `${org}_sp`]
    );
    if (!opts.pharmacy) continue;
    await q(
      `INSERT INTO "pharmacy_branches" ("id","organizationId","code","name","addressLine","city","provinceCode","updatedAt")
       VALUES ($1,$2,$3,$3,'1 Road','Lahore','PB',now())`,
      [`${org}_pb${key}`, org, `PB${key}`]
    );
    await q(
      `INSERT INTO "pharmacy_sop_sites" ("id","organizationId","pharmacyBranchId","sopBranchId","enabledByUserId")
       VALUES ($1,$2,$3,$4,$5)`,
      [`${org}_site${key}`, org, `${org}_pb${key}`, `${org}_rb${key}`, opts.userId]
    );
    if (on) {
      await q(
        `INSERT INTO "pharmacy_sop_site_settings" ("id","organizationId","pharmacyBranchId","autoScheduleEnabled","changedByUserId","createdAt")
         VALUES ($1,$2,$3,true,$4,'2026-11-01 00:00')`,
        [`${org}_set${key}`, org, `${org}_pb${key}`, opts.userId]
      );
    }
  }
}

async function orgTables(su: Client): Promise<string[]> {
  const { rows } = await su.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='organizationId'`
  );
  return rows.map((row) => row.table_name);
}

/** Remove every fixture row (superuser; bypasses append-only triggers and FKs). */
export async function cleanupOrganizations(su: Client, orgs: string[]) {
  await su.query('BEGIN');
  try {
    await su.query(`SET LOCAL session_replication_role = replica`);
    for (const table of await orgTables(su)) {
      await su.query(`DELETE FROM "${table}" WHERE "organizationId" = ANY($1::text[])`, [orgs]);
    }
    await su.query(`DELETE FROM "organizations" WHERE "id" = ANY($1::text[])`, [orgs]);
    await su.query('COMMIT');
  } catch (error) {
    await su.query('ROLLBACK');
    throw error;
  }
}

/** Rows left for the fixture organizations, across every org-scoped table. */
export async function leftoverRows(su: Client, orgs: string[]): Promise<number> {
  let total = 0;
  for (const table of await orgTables(su)) {
    const { rows } = await su.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${table}" WHERE "organizationId" = ANY($1::text[])`,
      [orgs]
    );
    total += Number(rows[0]!.n);
  }
  const { rows } = await su.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM "organizations" WHERE "id" = ANY($1::text[])`,
    [orgs]
  );
  return total + Number(rows[0]!.n);
}

/**
 * A disposable BEFORE INSERT trigger that makes occurrence inserts fail for
 * exactly the given engine branches (a real database error inside the child
 * job's transaction). Names carry the run id so concurrent runs never collide.
 */
export async function createPoisonTrigger(su: Client, name: string, branchIds: string[]) {
  const literal = branchIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
  await su.query(`
    CREATE FUNCTION "${name}"() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW."branchId" IN (${literal}) THEN
        RAISE EXCEPTION 'DEV-751 injected occurrence failure for %', NEW."branchId";
      END IF;
      RETURN NEW;
    END
    $fn$`);
  await su.query(
    `CREATE TRIGGER "${name}" BEFORE INSERT ON "restaurant_sop_occurrences"
       FOR EACH ROW EXECUTE FUNCTION "${name}"()`
  );
}

export async function dropPoisonTrigger(su: Client, name: string) {
  await su.query(`DROP TRIGGER IF EXISTS "${name}" ON "restaurant_sop_occurrences"`);
  await su.query(`DROP FUNCTION IF EXISTS "${name}"()`);
}

export async function poisonTriggerExists(su: Client, name: string): Promise<boolean> {
  const { rows } = await su.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM pg_trigger WHERE tgname = $1)
          + (SELECT count(*) FROM pg_proc WHERE proname = $1) AS n`,
    [name]
  );
  return Number(rows[0]!.n) > 0;
}

export type JobRow = {
  id: string;
  organizationId: string;
  type: string;
  status: string;
  attempts: number;
  idempotencyKey: string | null;
  scheduledAt: Date;
  nextAttemptAt: Date;
  payload: unknown;
  lastError: string | null;
};

/** Read-only checks bypass RLS through the cleanup superuser (never writes). */
export async function jobsOf(su: Client, org: string): Promise<JobRow[]> {
  const { rows } = await su.query<JobRow>(
    `SELECT "id","organizationId","type","status","attempts","idempotencyKey","scheduledAt",
            "nextAttemptAt","payload","lastError"
       FROM "restaurant_jobs" WHERE "organizationId" = $1
      ORDER BY "scheduledAt","createdAt","idempotencyKey"`,
    [org]
  );
  return rows;
}

export async function occurrencesOf(su: Client, org: string, branchId?: string) {
  const { rows } = await su.query<{
    id: string;
    organizationId: string;
    branchId: string;
    dueAt: Date;
  }>(
    `SELECT "id","organizationId","branchId","dueAt" FROM "restaurant_sop_occurrences"
      WHERE "organizationId" = $1 ${branchId ? `AND "branchId" = $2` : ''}
      ORDER BY "dueAt","id"`,
    branchId ? [org, branchId] : [org]
  );
  return rows;
}

/** Execution outcomes per job (id → outcomes in attempt order). */
export async function executionsOf(su: Client, org: string) {
  const { rows } = await su.query<{ jobId: string; attempt: number; outcome: string }>(
    `SELECT "jobId","attempt","outcome" FROM "restaurant_job_executions"
      WHERE "organizationId" = $1 ORDER BY "jobId","attempt"`,
    [org]
  );
  const byJob = new Map<string, string[]>();
  for (const row of rows) byJob.set(row.jobId, [...(byJob.get(row.jobId) ?? []), row.outcome]);
  return byJob;
}
