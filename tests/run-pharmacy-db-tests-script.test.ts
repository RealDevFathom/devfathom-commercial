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
  const base = 'postgresql://u:placeholder@localhost:5432/devfathom_pharmacy_test';
  it.each([
    ['host', `${base}?host=db.example.com`],
    ['hostaddr', `${base}?hostaddr=10.0.0.9`],
    ['dbname', `${base}?dbname=devfathom`],
    // node-postgres reads port from the query string, over the port in the address.
    ['port', 'postgresql://u:placeholder@localhost:5650/devfathom_test?port=5432'],
    ['db', `${base}?db=devfathom`],
    ['database', `${base}?database=devfathom`],
    // Any letter case, percent-encoded, or repeated: each is the same parameter to the driver.
    ['host', `${base}?sslmode=disable&HOST=db.example.com`],
    ['port', `${base}?Port=5433`],
    ['port', `${base}?%70ort=5433`],
    ['host', `${base}?host=localhost&host=db.example.com`],
  ])('refuses an address carrying a %s parameter (%s)', (parameter, address) => {
    const { status, stderr } = run(address);
    expect(status).toBe(2);
    expect(stderr).toBe(
      `PHARMACY_DB_TEST_RUNTIME_URL carries a ${parameter} parameter; put the host, port and database in the address itself.\n`
    );
  });

  it.each([
    // node-postgres reads socket: as a unix socket path (/tmp) and db= as the database.
    'socket://u:placeholder@localhost/tmp?db=devfathom',
    'socket://u:placeholder@localhost/devfathom_pharmacy_test',
    'mysql://u:placeholder@localhost:5432/devfathom_pharmacy_test',
  ])('refuses a scheme other than postgres: or postgresql: (%s)', (address) => {
    expect(run(address)).toEqual({
      status: 2,
      stderr: 'PHARMACY_DB_TEST_RUNTIME_URL must use the postgres: or postgresql: scheme.\n',
    });
  });

  it('refuses an address that is not a URL without echoing it', () => {
    expect(run('not a url placeholder')).toEqual({
      status: 2,
      stderr: 'PHARMACY_DB_TEST_RUNTIME_URL is not a valid database URL.\n',
    });
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
