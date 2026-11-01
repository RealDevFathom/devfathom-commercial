// Clone only the local DATABASE_URL schema, test with a restricted role, then drop the disposable database and role.
import pg from 'pg';
const { Client } = pg;
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
(async () => {
  const source = new URL(process.env.DATABASE_URL);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(source.hostname))
    throw Error('Local database required');
  const suffix = randomBytes(6).toString('hex');
  const database = 'support_security_test_' + suffix;
  const role = 'support_security_' + suffix;
  const password = randomBytes(32).toString('hex');
  const owner = new Client({ connectionString: source.toString() });
  await owner.connect();
  let target;
  try {
    await owner.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
    await owner.query(`CREATE DATABASE "${database}"`);
    target = new URL(source);
    target.pathname = '/' + database;
    const pgEnv = {
      ...process.env,
      PGHOST: source.hostname,
      PGPORT: source.port || '5432',
      PGUSER: decodeURIComponent(source.username),
      PGPASSWORD: decodeURIComponent(source.password),
      PGDATABASE: decodeURIComponent(source.pathname.slice(1)),
    };
    const dump = spawnSync('pg_dump', ['--schema-only', '--no-owner', '--no-privileges'], {
      env: pgEnv,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (dump.status !== 0) throw Error('Schema dump failed');
    const restore = spawnSync(
      'psql',
      ['-X', '--single-transaction', '-v', 'ON_ERROR_STOP=1', '-q'],
      {
        env: { ...pgEnv, PGDATABASE: database },
        input: dump.stdout,
        maxBuffer: 64 * 1024 * 1024,
      }
    );
    if (restore.status !== 0) throw Error('Schema restore failed');
    // Preserve the clone's migration history, then apply every pending migration.
    // Schema-only dumps omit this table's rows and cannot establish the baseline.
    const history = spawnSync(
      'pg_dump',
      ['--data-only', '--table=public._prisma_migrations', '--no-owner', '--no-privileges'],
      {
        env: pgEnv,
        maxBuffer: 16 * 1024 * 1024,
      }
    );
    if (history.status !== 0) throw Error('Migration history dump failed');
    const baseline = spawnSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-q'], {
      env: { ...pgEnv, PGDATABASE: database },
      input: history.stdout,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (baseline.status !== 0) throw Error('Migration history restore failed');
    const migrate = spawnSync('node_modules/.bin/prisma', ['migrate', 'deploy'], {
      env: {
        ...process.env,
        DATABASE_URL: target.toString(),
        MIGRATION_DATABASE_URL: target.toString(),
      },
      maxBuffer: 32 * 1024 * 1024,
    });
    if (migrate.status !== 0) throw Error('Clone migration failed');

    const admin = new Client({ connectionString: target.toString() });
    await admin.connect();
    await admin.query(
      `GRANT USAGE ON SCHEMA public TO "${role}"; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${role}"; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`
    );
    await admin.end();
    target.username = role;
    target.password = password;
    console.log(
      'Running real local PostgreSQL tests with NOSUPERUSER NOBYPASSRLS on a fully migrated disposable schema clone.'
    );
    const run = spawnSync(
      'node_modules/.bin/vitest',
      ['run', 'tests/support-read-only.db.test.ts', 'tests/support-session-hardening.db.test.ts'],
      {
        env: {
          ...process.env,
          DATABASE_URL: target.toString(),
          TEST_DATABASE_URL: target.toString(),
        },
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      }
    );
    fs.writeFileSync(
      '/tmp/sec-postgres-results.log',
      (run.stdout + run.stderr)
        .replaceAll(target.toString(), '[redacted database URL]')
        .replaceAll(password, '[redacted]')
    );
    process.stdout.write(fs.readFileSync('/tmp/sec-postgres-results.log', 'utf8'));
    process.exitCode = run.status ?? 1;
  } finally {
    await owner.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await owner.query(`DROP ROLE IF EXISTS "${role}"`);
    await owner.end();
  }
})().catch(() => {
  console.error('PostgreSQL test setup failed; connection details withheld.');
  process.exitCode = 1;
});
