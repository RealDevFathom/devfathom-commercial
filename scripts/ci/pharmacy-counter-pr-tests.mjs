import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const suites = {
  641: [
    'src/lib/abac/capabilities.test.ts',
    'src/lib/abac/index.test.ts',
    'src/server/routers/pharmacy-sales.counter-receipt-auth.test.ts',
    'src/server/routers/pharmacy-sales.counter-receipt-auth.db.test.ts',
  ],
};

assert.equal(process.env.CI, 'true', 'Only the isolated PR CI service is allowed');
assert(!existsSync('.env') && !existsSync('.env.local'), 'Environment files are forbidden');
const selected = suites[process.env.PHARMACY_PR_TARGET];
assert(selected, 'An explicitly supported pharmacy PR number is required');
const output = 'test-results/pharmacy-pr';
mkdirSync(output, { recursive: true });
writeFileSync(
  `${output}/head.json`,
  JSON.stringify(
    {
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      pr: process.env.PHARMACY_PR_TARGET,
      suites: selected,
    },
    null,
    2
  )
);

function connection(name, user, database = 'pharmacy_pr_test') {
  const value = process.env[name];
  assert(value, `${name} is required`);
  const url = new URL(value);
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, '55432');
  assert.equal(url.pathname, `/${database}`);
  assert.equal(url.username, user);
  assert.equal(url.password, '');
  assert.equal(url.search, '');
  return value;
}

const runtime = connection('DATABASE_URL', 'pharmacy_runtime');
assert.equal(connection('TEST_DATABASE_URL', 'pharmacy_runtime'), runtime);
const owner = connection('MIGRATION_DATABASE_URL', 'pharmacy_owner');
assert.equal(connection('PHARMACY_TEST_OWNER_DATABASE_URL', 'pharmacy_owner'), owner);
const administrator = connection('EXTENSION_ADMIN_DATABASE_URL', 'postgres');

async function query(url, sql) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

switch (process.argv[2]) {
  case 'bootstrap': {
    const bootstrap = new URL(administrator);
    bootstrap.pathname = '/postgres';
    // Trust authentication is confined to this job's loopback-only disposable service.
    await query(
      bootstrap.toString(),
      'CREATE ROLE pharmacy_owner LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT'
    );
    await query(
      bootstrap.toString(),
      'CREATE ROLE pharmacy_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT'
    );
    await query(bootstrap.toString(), 'CREATE DATABASE pharmacy_pr_test OWNER pharmacy_owner');
    await query(
      administrator,
      'REVOKE ALL ON DATABASE pharmacy_pr_test FROM PUBLIC; GRANT CONNECT, TEMPORARY ON DATABASE pharmacy_pr_test TO pharmacy_runtime'
    );
    break;
  }
  case 'grants': {
    await query(
      owner,
      `
      GRANT USAGE ON SCHEMA public TO pharmacy_runtime;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pharmacy_runtime;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pharmacy_runtime;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pharmacy_runtime;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pharmacy_runtime;
    `
    );
    const result = await query(
      runtime,
      `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user`
    );
    assert.deepEqual(result.rows, [
      {
        rolcanlogin: true,
        rolsuper: false,
        rolbypassrls: false,
        rolcreaterole: false,
        rolcreatedb: false,
      },
    ]);
    writeFileSync(`${output}/runtime-role.json`, JSON.stringify(result.rows));
    break;
  }
  case 'test': {
    for (const file of selected) assert(existsSync(file), `Required suite missing: ${file}`);
    const reportPath = `${output}/vitest.json`;
    const result = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        ...selected,
        '--maxWorkers=1',
        '--no-file-parallelism',
        '--reporter=default',
        '--reporter=json',
        '--outputFile.json',
        reportPath,
      ],
      { stdio: 'inherit' }
    );
    assert.equal(result.status, 0, 'Relevant test execution failed');
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.success, true);
    assert(report.numTotalTests > 0, 'Zero tests is not acceptance');
    assert.equal(report.numPendingTests, 0, 'Skipped tests are not acceptance');
    assert.equal(report.numTodoTests ?? 0, 0, 'Todo tests are not acceptance');
    assert.equal(report.numPassedTests, report.numTotalTests);
    for (const file of selected) {
      const receipt = report.testResults.find((entry) => entry.name.endsWith(`/${file}`));
      assert(receipt && receipt.assertionResults.length > 0, `No executed tests: ${file}`);
      assert.equal(receipt.status, 'passed', file);
      for (const test of receipt.assertionResults)
        assert.equal(test.status, 'passed', `${file}: ${test.fullName}`);
    }
    console.log(
      `Exact-head pharmacy PR ${process.env.PHARMACY_PR_TARGET}: ${report.numPassedTests} passed, zero skipped, ${selected.length} required files.`
    );
    break;
  }
  default:
    throw new Error('Expected bootstrap, grants or test');
}
