// @vitest-environment node
/**
 * Import 1/5 CTO hold — the import-core migration applied OVER a populated pre-change schema.
 *
 * Builds a temporary database and runs the real `prisma migrate deploy` over every migration
 * before 20261023140000 (the migrations on main) as the owner, fills the PH-MIG tables with
 * realistic legacy evidence (two branches, so no branch can be inferred; 60,000 rows; open and
 * signed-off exceptions), deploys the import-core migration the same way, and then checks, as the
 * NOSUPERUSER NOBYPASSRLS runtime role, that the evidence survived untouched as legacy, stays
 * hidden from branch-scoped reads, and moves to a branch only through the recorded platform
 * remediation. The temporary database and migration folder are removed afterwards.
 *
 * Opt-in: needs PHARMACY_IMPORT_UPGRADE_ADMIN_URL (a role allowed to CREATE DATABASE), plus the
 * owner URL (OWNER_DATABASE_URL) and the runtime URL (TEST_DATABASE_URL) whose roles it uses.
 * Prisma reads the database URL from the environment of its own process, never from argv.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ADMIN_URL = process.env.PHARMACY_IMPORT_UPGRADE_ADMIN_URL;
const OWNER_URL = process.env.OWNER_DATABASE_URL;
const RUNTIME_URL = process.env.TEST_DATABASE_URL;
const enabled = Boolean(ADMIN_URL && OWNER_URL && RUNTIME_URL);
const describeIfUpgrade = enabled ? describe : describe.skip;

const IMPORT_CORE = '20261023140000_pharmacy_import_core';
const MIGRATIONS = join(process.cwd(), 'prisma/migrations');
const suffix = randomBytes(5).toString('hex');
const prefix = process.env.PHARMACY_IMPORT_UPGRADE_DATABASE_PREFIX ?? 'pharmacy_import_upgrade';
const database = `${prefix}_${suffix}`;
const org = `org_upgrade_${suffix}`;
const branches = [`br_upgrade_1_${suffix}`, `br_upgrade_2_${suffix}`];
const signer = `user_upgrade_${suffix}`;
const ROWS = 60_000;
const EXCEPTIONS = 12_000;
let migrationMs = 0;
let workdir = '';

function on(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}
/**
 * Copy `names` into the private migration folder and run `prisma migrate deploy` on it, exactly
 * as the release pipeline does. Prisma decides per file whether to run it as one script or
 * statement by statement; replaying the SQL any other way would test a different deployment.
 */
function migrateDeploy(names: string[]) {
  for (const name of names)
    cpSync(join(MIGRATIONS, name), join(workdir, 'migrations', name), { recursive: true });
  execFileSync(
    process.execPath,
    [
      join(process.cwd(), 'node_modules/prisma/build/index.js'),
      'migrate',
      'deploy',
      '--config',
      join(workdir, 'prisma.config.ts'),
    ],
    {
      cwd: workdir,
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH ?? '',
        HOME: workdir,
        CHECKPOINT_DISABLE: '1',
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
        DATABASE_URL: on(OWNER_URL!, database),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  );
}
async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}
async function asOwner<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = await connect(on(OWNER_URL!, database));
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}
/** One runtime transaction with the given settings; always rolled back unless `commit`. */
async function asRuntime<T>(
  settings: Record<string, string>,
  run: (client: Client) => Promise<T>,
  commit = false
): Promise<T> {
  const client = await connect(on(RUNTIME_URL!, database));
  try {
    await client.query('BEGIN');
    for (const [key, value] of Object.entries(settings))
      await client.query('SELECT set_config($1, $2, true)', [key, value]);
    const result = await run(client);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}
const tenant = (branchId?: string) => ({
  'app.current_organization_id': org,
  'app.is_platform_admin': 'false',
  ...(branchId ? { 'app.current_branch_id': branchId } : {}),
});
const platform = { 'app.current_organization_id': '', 'app.is_platform_admin': 'true' };
const sources: string[] = [];

beforeAll(async () => {
  if (!ADMIN_URL || !OWNER_URL || !RUNTIME_URL) return;
  workdir = mkdtempSync(join(tmpdir(), 'pharmacy-import-upgrade-'));
  cpSync(
    join(MIGRATIONS, 'migration_lock.toml'),
    join(workdir, 'migrations', 'migration_lock.toml')
  );
  writeFileSync(
    join(workdir, 'prisma.config.ts'),
    `export default {
  schema: ${JSON.stringify(join(process.cwd(), 'prisma/schema.prisma'))},
  migrations: { path: ${JSON.stringify(join(workdir, 'migrations'))} },
  datasource: { url: process.env.DATABASE_URL },
};\n`,
    { mode: 0o600 }
  );
  const ownerRole = decodeURIComponent(new URL(OWNER_URL).username);
  const runtimeRole = decodeURIComponent(new URL(RUNTIME_URL).username);
  const admin = await connect(on(ADMIN_URL, 'postgres'));
  try {
    await admin.query(`CREATE DATABASE "${database}" OWNER "${ownerRole}"`);
    await admin.query(`REVOKE ALL ON DATABASE "${database}" FROM PUBLIC`);
    await admin.query(`GRANT CONNECT, TEMPORARY ON DATABASE "${database}" TO "${runtimeRole}"`);
  } finally {
    await admin.end();
  }
  await asOwner(async (owner) => {
    await owner.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
    await owner.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${runtimeRole}"`
    );
    await owner.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO "${runtimeRole}"`
    );
    migrateDeploy(
      readdirSync(MIGRATIONS)
        .filter((name) => statSync(join(MIGRATIONS, name)).isDirectory() && name < IMPORT_CORE)
        .sort()
    );

    // Legacy evidence, written as the pre-change application wrote it: organization-scoped only.
    await owner.query('BEGIN');
    await owner.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
    await owner.query(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, 'Upgrade', 'Upgrade', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      [org]
    );
    await owner.query(
      `INSERT INTO organization_departments (id, "organizationId", key, name, "sortOrder", "createdAt", "updatedAt")
       VALUES ($1, $2, 'LEADERSHIP', 'Leadership', 0, now(), now())`,
      [`dep_${suffix}`, org]
    );
    await owner.query(
      `INSERT INTO users (id, "organizationId", name, email, role, department, title, "startDate", status, "createdAt", "updatedAt")
       VALUES ($1, $2, 'Legacy signer', $3, 'ADMIN', 'LEADERSHIP', 'Pharmacist', now(), 'ACTIVE', now(), now())`,
      [signer, org, `${signer}@example.test`]
    );
    for (const [index, branchId] of branches.entries())
      await owner.query(
        `INSERT INTO pharmacy_branches (id, "organizationId", code, name, "addressLine", city, "provinceCode", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $1, 'Test', 'Lahore', 'PB', now(), now())`,
        [branchId, org, `B${index + 1}`]
      );
    await owner.query(`SELECT set_config('app.current_organization_id', $1, true)`, [org]);
    for (let index = 0; index < 4; index += 1) {
      const id = `src_upgrade_${index}_${suffix}`;
      sources.push(id);
      await owner.query(
        `INSERT INTO pharmacy_migration_sources (id, "organizationId", kind, "fileName", "byteSize", "contentHash")
         VALUES ($1, $2, 'EXCEL_CSV', $3, 1000, $4)`,
        [id, org, `legacy-${index}.csv`, `${index}`.repeat(64)]
      );
    }
    const batches: Array<[string, string, string]> = [
      [`bat_upgrade_0_${suffix}`, sources[0]!, 'PROFILED'],
      [`bat_upgrade_1_${suffix}`, sources[0]!, 'PROFILED'],
      [`bat_upgrade_2_${suffix}`, sources[1]!, 'PROFILED'],
      [`bat_upgrade_3_${suffix}`, sources[2]!, 'PROFILED'],
      [`bat_upgrade_4_${suffix}`, sources[3]!, 'PROFILING'],
      [`bat_upgrade_5_${suffix}`, sources[3]!, 'FAILED'],
    ];
    for (const [id, sourceId, status] of batches)
      await owner.query(
        `INSERT INTO pharmacy_migration_batches (id, "organizationId", "sourceId", label, status, "profilerVersion", "profiledAt", "updatedAt")
         VALUES ($1, $2, $3, 'Legacy', $4::text::"PharmacyMigrationBatchStatus", 'excel-csv/1',
                 CASE WHEN $4::text = 'PROFILED' THEN now() END, now())`,
        [id, org, sourceId, status]
      );
    await owner.query(
      `INSERT INTO pharmacy_migration_rows (id, "organizationId", "batchId", "sourceKey", "rowNumber", "rawPayload", "targetModelKey", "productName", "quantityCanonical")
       SELECT 'row_' || $1 || '_' || n, $2, $3 || ((n % 6))::text || '_' || $1, n::text, n, jsonb_build_object('QTY', n::text), 'med.product', 'Legacy item ' || n, n
         FROM generate_series(1, $4) AS n`,
      [suffix, org, 'bat_upgrade_', ROWS]
    );
    await owner.query(
      `INSERT INTO pharmacy_migration_exceptions (id, "organizationId", "batchId", "rowId", bucket, severity, status, detail,
                                                  "signedOffByUserId", "signedOffAt", "signOffNote", "updatedAt")
       SELECT 'exc_' || $1 || '_' || n, $2, $3 || ((n % 6))::text || '_' || $1, 'row_' || $1 || '_' || n,
              'MISSING_MRP', 'BLOCKING',
              CASE WHEN n % 6 = 0 THEN 'SIGNED_OFF' ELSE 'OPEN' END::"PharmacyMigrationExceptionStatus",
              'Legacy gap ' || n,
              CASE WHEN n % 6 = 0 THEN $4 END, CASE WHEN n % 6 = 0 THEN now() END,
              CASE WHEN n % 6 = 0 THEN 'Accepted before import-core' END, now()
         FROM generate_series(1, $5) AS n`,
      [suffix, org, 'bat_upgrade_', signer, EXCEPTIONS]
    );
    await owner.query('COMMIT');

    migrateDeploy([IMPORT_CORE]);
    // The migration's own wall time as Prisma recorded it, without the CLI's start-up.
    const { rows } = await owner.query(
      `SELECT round(extract(epoch FROM finished_at - started_at) * 1000)::int AS ms
         FROM _prisma_migrations WHERE migration_name = $1 AND rolled_back_at IS NULL`,
      [IMPORT_CORE]
    );
    migrationMs = rows[0]?.ms ?? 0;
  });
}, 600_000);

afterAll(async () => {
  if (!enabled) return;
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  const admin = await connect(on(ADMIN_URL!, 'postgres'));
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
});

describeIfUpgrade('import-core migration over populated PH-MIG evidence (import 1/5)', () => {
  it('deploys without guessing: every existing row is kept, flagged legacy, with no branch', async () => {
    expect(migrationMs).toBeGreaterThan(0);
    console.info(
      `[import-core upgrade] ${ROWS} rows / ${EXCEPTIONS} exceptions migrated in ${migrationMs} ms`
    );
    const counts = await asOwner(async (owner) => {
      await owner.query('BEGIN');
      await owner.query(`SELECT set_config('app.is_platform_admin', 'true', true)`);
      const result: Record<string, unknown> = {};
      for (const table of [
        'pharmacy_migration_sources',
        'pharmacy_migration_batches',
        'pharmacy_migration_rows',
        'pharmacy_migration_exceptions',
      ]) {
        const { rows } = await owner.query(
          `SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE legacy AND "branchId" IS NULL)::int AS legacy
             FROM ${table}`
        );
        result[table] = rows[0];
      }
      const { rows: statuses } = await owner.query(
        `SELECT status::text AS status, count(*)::int AS n FROM pharmacy_migration_batches GROUP BY 1 ORDER BY 1`
      );
      result.statuses = statuses;
      const { rows: invalid } = await owner.query(
        `SELECT conname FROM pg_constraint
          WHERE conrelid::regclass::text LIKE 'pharmacy_migration_%' AND NOT convalidated`
      );
      result.invalidConstraints = invalid;
      await owner.query('ROLLBACK');
      return result;
    });
    expect(counts).toEqual({
      pharmacy_migration_sources: { total: 4, legacy: 4 },
      pharmacy_migration_batches: { total: 6, legacy: 6 },
      pharmacy_migration_rows: { total: ROWS, legacy: ROWS },
      pharmacy_migration_exceptions: { total: EXCEPTIONS, legacy: EXCEPTIONS },
      // PROFILED -> PREVIEW, PROFILING -> PARSING, FAILED stays FAILED (ordered by name).
      statuses: [
        { status: 'FAILED', n: 1 },
        { status: 'PARSING', n: 1 },
        { status: 'PREVIEW', n: 4 },
      ],
      invalidConstraints: [],
    });
  });

  it('hides legacy evidence from branch-scoped reads and keeps it immutable', async () => {
    for (const branchId of branches)
      expect(
        await asRuntime(tenant(branchId), async (client) => {
          const { rows } = await client.query(
            `SELECT (SELECT count(*) FROM pharmacy_migration_sources)::int
                  + (SELECT count(*) FROM pharmacy_migration_batches)::int
                  + (SELECT count(*) FROM pharmacy_migration_rows)::int
                  + (SELECT count(*) FROM pharmacy_migration_exceptions)::int AS visible`
          );
          return rows[0].visible;
        })
      ).toBe(0);
    // Even the platform remediation policy, the one UPDATE path to legacy rows, cannot move a
    // legacy batch through the lifecycle.
    await expect(
      asRuntime(platform, (client) =>
        client.query(`UPDATE pharmacy_migration_batches SET status = 'COMMITTING' WHERE id = $1`, [
          `bat_upgrade_0_${suffix}`,
        ])
      )
    ).rejects.toThrow(/legacy import evidence cannot change state/);
    await expect(
      asRuntime(tenant(branches[0]), (client) =>
        client.query(
          `INSERT INTO pharmacy_migration_sources (id, "organizationId", "branchId", kind, "fileName", "byteSize", "contentHash", "createdByUserId", legacy)
           VALUES ($1, $2, $3, 'EXCEL_CSV', 'forged.csv', 1, $4, $5, true)`,
          [`src_forged_${suffix}`, org, branches[0], 'a'.repeat(64), signer]
        )
      )
    ).rejects.toThrow(/only the PH-MIG deploy creates legacy evidence/);
  });

  it('moves one legacy source to a branch only through the recorded platform remediation', async () => {
    const remediate = (settings: Record<string, string>) =>
      asRuntime(
        settings,
        async (client) => {
          const { rows } = await client.query(
            `SELECT pharmacy_migration_remediate_legacy_source($1, $2, $3, $4, $5) AS id`,
            [
              org,
              sources[0],
              branches[1],
              'ops:upgrade-test',
              'Handover sheet shows branch 2 evidence.',
            ]
          );
          return rows[0].id as string;
        },
        true
      );
    await expect(remediate(tenant(branches[1]))).rejects.toThrow(/platform operator only/);
    await expect(remediate(platform)).resolves.toEqual(expect.any(String));
    await expect(remediate(platform)).rejects.toThrow(/not unremediated legacy evidence/);

    const seen = await asRuntime(tenant(branches[1]), async (client) => {
      const { rows } = await client.query(
        `SELECT (SELECT count(*) FROM pharmacy_migration_sources WHERE id = $1)::int AS sources,
                (SELECT count(*) FROM pharmacy_migration_batches WHERE "sourceId" = $1 AND legacy)::int AS batches,
                (SELECT count(*) FROM pharmacy_migration_rows r JOIN pharmacy_migration_batches b
                   ON b."organizationId" = r."organizationId" AND b.id = r."batchId" WHERE b."sourceId" = $1)::int AS rows,
                (SELECT count(*) FROM pharmacy_migration_exceptions e JOIN pharmacy_migration_batches b
                   ON b."organizationId" = e."organizationId" AND b.id = e."batchId" WHERE b."sourceId" = $1)::int AS exceptions,
                (SELECT count(*) FROM pharmacy_migration_sources WHERE id <> $1)::int AS others`,
        [sources[0]]
      );
      return rows[0];
    });
    expect(seen).toEqual({
      sources: 1,
      batches: 2,
      rows: ROWS / 3,
      exceptions: EXCEPTIONS / 3,
      others: 0,
    });
    const record = await asRuntime(platform, async (client) => {
      const { rows } = await client.query(
        `SELECT "branchId", "decidedBy", "batchCount", "rowCount", "exceptionCount"
           FROM pharmacy_migration_legacy_remediations WHERE "sourceId" = $1`,
        [sources[0]]
      );
      return rows;
    });
    expect(record).toEqual([
      {
        branchId: branches[1],
        decidedBy: 'ops:upgrade-test',
        batchCount: 2,
        rowCount: ROWS / 3,
        exceptionCount: EXCEPTIONS / 3,
      },
    ]);
    // Remediated evidence stays evidence: still legacy, still read-only, still frozen.
    await expect(
      asOwner((owner) =>
        owner.query(
          `BEGIN; SELECT set_config('app.current_organization_id', '${org}', true), set_config('app.current_branch_id', '${branches[1]}', true);
           UPDATE pharmacy_migration_batches SET status = 'COMMITTING' WHERE id = 'bat_upgrade_0_${suffix}'; COMMIT;`
        )
      )
    ).rejects.toThrow(/legacy import evidence cannot change state/);
    // What branch 2 can do with it: profile a new, non-legacy batch from the remediated source
    // (re-uploading the same bytes there matches it by hash); only such a batch can commit. An
    // unremediated source still has no branch, so no batch of any branch can hang off it.
    const reprofile = (sourceId: string, id: string) =>
      asRuntime(tenant(branches[1]), (client) =>
        client.query(
          `INSERT INTO pharmacy_migration_batches
             (id, "organizationId", "branchId", "sourceId", label, status, "profilerVersion", "createdByUserId", "updatedAt")
           VALUES ($1, $2, $3, $4, 'Re-profiled', 'PARSING', 'excel-csv/1', $5, now())`,
          [id, org, branches[1], sourceId, signer]
        )
      );
    await expect(reprofile(sources[0]!, `bat_reprofile_0_${suffix}`)).resolves.toMatchObject({
      rowCount: 1,
    });
    await expect(reprofile(sources[1]!, `bat_reprofile_1_${suffix}`)).rejects.toThrow(
      /pharmacy_migration_batches_branch_source_fkey/
    );
  });
});
