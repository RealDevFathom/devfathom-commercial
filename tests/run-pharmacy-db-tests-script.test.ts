// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// DEV-948: scripts/run-pharmacy-db-tests.sh must check the server and database the suites
// will really reach. Every case below stops at the address checks, before any database or
// vitest run, so no database is needed.
function run(address: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    'PHARMACY_DB_TEST_RUNTIME_URL',
    'PHARMACY_DB_TEST_OWNER_URL',
    'PHARMACY_DB_TEST_SUPERUSER_URL',
    'PHARMACY_DB_TEST_COHORT_URL',
  ])
    env[name] = address;
  const result = spawnSync('bash', ['scripts/run-pharmacy-db-tests.sh'], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, stderr: result.stderr };
}

describe('scripts/run-pharmacy-db-tests.sh address checks', () => {
  it.each([
    [
      'host',
      'postgresql://u:placeholder@localhost:5432/devfathom_pharmacy_test?host=db.example.com',
    ],
    [
      'hostaddr',
      'postgresql://u:placeholder@localhost:5432/devfathom_pharmacy_test?hostaddr=10.0.0.9',
    ],
    [
      'dbname',
      'postgresql://u:placeholder@localhost:5432/devfathom_pharmacy_test?dbname=devfathom',
    ],
    [
      'HOST',
      'postgresql://u:placeholder@localhost:5432/devfathom_pharmacy_test?sslmode=disable&HOST=db.example.com',
    ],
  ])('refuses an address carrying a %s parameter', (parameter, address) => {
    const { status, stderr } = run(address);
    expect(status).toBe(2);
    expect(stderr).toContain(`carries a ${parameter} parameter`);
    expect(stderr).not.toContain('placeholder');
  });

  it('accepts the IPv6 loopback address as local and goes on to check the database name', () => {
    const { status, stderr } = run('postgresql://u:placeholder@[::1]:5432/devfathom');
    expect(stderr).not.toContain('non-local');
    expect(stderr).toContain("Database 'devfathom' is not marked disposable");
    expect(status).toBe(2);
  });

  it('still refuses a remote host and a non-disposable database', () => {
    expect(run('postgresql://u:placeholder@db.example.com:5432/devfathom_pharmacy_test')).toEqual({
      status: 2,
      stderr: 'Refusing a non-local database host: db.example.com\n',
    });
    expect(run('postgresql://u:placeholder@127.0.0.1:5432/devfathom').stderr).toContain(
      'is not marked disposable'
    );
  });
});
