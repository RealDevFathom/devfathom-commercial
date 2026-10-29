/* Fresh private socket cluster. No connection strings are printed or persisted. */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) throw Error('DATABASE_URL_REQUIRED');
  const source = new URL(process.env.DATABASE_URL);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(source.hostname) &&
    !(source.searchParams.get('host') || '').startsWith('/')
  )
    throw Error('LOCAL_DATABASE_URL_REQUIRED');
  const bin = process.env.PHARMACY_TEST_POSTGRES_BIN || '/usr/lib/postgresql/16/bin';
  const dir = fs.mkdtempSync('/tmp/pharmacy-wallet-');
  fs.chmodSync(dir, 0o700);
  const evidence = path.resolve(
    process.env.PHARMACY_WALLET_EVIDENCE_DIR || 'test-results/pharmacy-wallet-db'
  );
  fs.mkdirSync(evidence, { recursive: true });
  const opened = new Set();
  function run(command, args, env = process.env, name = 'setup') {
    const fd = fs.openSync(path.join(evidence, name + '.log'), opened.has(name) ? 'a' : 'w', 0o600);
    opened.add(name);
    const result = spawnSync(command, args, { env, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    if (result.status !== 0) throw Error(name.toUpperCase() + '_FAILED');
  }
  let started = false;
  try {
    run(path.join(bin, 'initdb'), ['-D', dir + '/data', '-A', 'trust', '-U', 'postgres']);
    run(path.join(bin, 'pg_ctl'), [
      '-D',
      dir + '/data',
      '-l',
      dir + '/server.log',
      '-o',
      `-k ${dir} -h '' -p 5432`,
      'start',
    ]);
    started = true;
    const runId = randomBytes(16).toString('hex');
    const database = 'qa603_' + runId;
    const role = 'qa603_runtime_' + runId;
    const admin = new Client({ host: dir, port: 5432, user: 'postgres', database: 'postgres' });
    await admin.connect();
    await admin.query('CREATE ROLE devfathom_app LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT');
    await admin.query(
      `CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`
    );
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    const url = new URL(`postgresql://postgres@localhost/${database}`);
    url.searchParams.set('host', dir);
    const ownerEnv = {
      ...process.env,
      DATABASE_URL: url.href,
      MIGRATION_DATABASE_URL: url.href,
      EXTENSION_ADMIN_DATABASE_URL: url.href,
    };
    const owner = new Client({ connectionString: url.href });
    await owner.connect();
    try {
      // Exercise idempotent preparation before extensions/tables exist.
      const appUrl = new URL(url);
      appUrl.username = 'devfathom_app';
      for (let attempt = 0; attempt < 2; attempt++)
        run(
          'bun',
          ['prisma/prepare-runtime-role.ts'],
          { ...ownerEnv, APP_DATABASE_URL: appUrl.href },
          'runtime-role'
        );
      await owner.query(fs.readFileSync('prisma/prepare-extensions.sql', 'utf8'));
      run('node_modules/.bin/prisma', ['migrate', 'deploy'], ownerEnv, 'migrations');
      await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await owner.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`
      );
      await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
      await owner.query('CREATE TABLE public._qa603_disposable_identity (run_id text NOT NULL)');
      await owner.query('INSERT INTO public._qa603_disposable_identity VALUES ($1)', [runId]);
      await owner.query(`GRANT SELECT ON public._qa603_disposable_identity TO ${role}`);
      // The complete application schema makes tiny fixture RLS queries expensive
      // under generic JIT; this disposable database does not need compilation.
      await owner.query(`ALTER DATABASE ${database} SET jit = off`);
    } finally {
      await owner.end();
    }
    const ownerUrl = url.href;
    url.username = role;
    const env = {
      ...process.env,
      DATABASE_URL: url.href,
      TEST_DATABASE_URL: url.href,
      M8_TEST_RUNTIME_DATABASE_URL: url.href,
      PHARMACY_ACCOUNTS_TEST_RUN_ID: runId,
      PHARMACY_ACCOUNTS_TEST_DATABASE: database,
      PHARMACY_ACCOUNTS_TEST_ROLE: role,
      PHARMACY_ACCOUNTS_TEST_SOCKET: dir,
      PHARMACY_WALLET_REPORTING_TEST_DB: '1',
      PHARMACY_WALLET_REPORTING_DISPOSABLE_DB: '1',
      PHARMACY_STORED_VALUE_BRIDGE_TEST_DB: '1',
      PHARMACY_STORED_VALUE_BRIDGE_DISPOSABLE_DB: '1',
    };
    const files = [
      'src/lib/pharmacy/wallet-security.db.test.ts',
      'src/lib/pharmacy/wallet-reporting.db.test.ts',
      'src/lib/pharmacy/stored-value-finance.db.test.ts',
      'src/server/routers/pharmacy-sales.counter-receipt-auth.db.test.ts',
    ];
    const reportPath = path.join(evidence, 'vitest.json');
    run(
      'node_modules/.bin/vitest',
      [
        'run',
        '--maxWorkers=1',
        '--no-file-parallelism',
        ...files,
        '--reporter=json',
        '--outputFile=' + reportPath,
      ],
      env,
      'vitest'
    );
    const result = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    for (const file of files) {
      if (!result.testResults.some((suite) => suite.name === path.resolve(file)))
        throw Error('WALLET_SUITE_MISSING');
    }
    const assertions = result.testResults.flatMap((suite) => suite.assertionResults);
    if (
      !assertions.length ||
      assertions.some((test) => test.status !== 'passed') ||
      result.numPendingTests ||
      result.numFailedTests
    )
      throw Error('WALLET_DB_REQUIRES_ALL_TESTS_PASSED_ZERO_SKIPS');
    console.log(`Wallet/branch DB: ${assertions.length} passed, zero skipped.`);
    const branchReport = path.join(evidence, 'branch-vitest.json');
    run(
      'node_modules/.bin/vitest',
      [
        'run',
        'src/server/routers/pharmacy-branch-security.db.test.ts',
        '--maxWorkers=1',
        '--reporter=json',
        '--outputFile=' + branchReport,
      ],
      { ...env, DATABASE_URL: ownerUrl },
      'branch-vitest'
    );
    const branchResults = JSON.parse(fs.readFileSync(branchReport, 'utf8'));
    const branchAssertions = branchResults.testResults.flatMap((suite) => suite.assertionResults);
    if (!branchAssertions.length || branchAssertions.some((test) => test.status !== 'passed'))
      throw Error('BRANCH_TESTS_REQUIRE_ZERO_SKIPS');
    console.log(`Branch security: ${branchAssertions.length} passed, zero skipped.`);
    run(
      'bun',
      ['prisma/seed.ts'],
      {
        ...env,
        DATABASE_URL: ownerUrl,
        MIGRATION_DATABASE_URL: ownerUrl,
        SEED_PASSWORD: randomBytes(32).toString('hex'),
      },
      'seed'
    );
    run(
      'bun',
      ['run', 'test:rls'],
      { ...env, DATABASE_URL: ownerUrl, TEST_DATABASE_URL: ownerUrl },
      'rls'
    );
    console.log('Tenant RLS verification passed on fresh isolated local database.');
  } finally {
    if (started)
      spawnSync(path.join(bin, 'pg_ctl'), ['-D', dir + '/data', '-m', 'immediate', 'stop'], {
        stdio: 'ignore',
      });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(() => {
  console.error('Fresh wallet/RLS verification failed; inspect local evidence logs.');
  process.exitCode = 1;
});
