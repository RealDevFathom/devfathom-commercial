import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  readFreshDatabaseInput,
  assertFreshRuntimeRole,
  assertFreshMigrationLedger,
  verifyFreshDatabaseSource,
  initializeFreshPlatform,
  runBoundFreshBootstrap,
} from './fresh-database.ts';

// Inert test strings. These are never used to connect, hash real credentials, or seed a DB.
const fixture = () => ({
  DATABASE_URL:
    'postgresql://migration:unit-only@fixture.rds.amazonaws.com/devfathom?sslmode=verify-full',
  APP_DATABASE_URL:
    'postgresql://devfathom_app:unit-only@fixture.rds.amazonaws.com/devfathom?sslmode=verify-full',
  FRESH_DATABASE_TARGET: 'fixture.rds.amazonaws.com:5432/devfathom',
  PLATFORM_ADMIN_NAME: 'Unit Test',
  PLATFORM_ADMIN_EMAIL: 'OWNER@example.invalid',
  PLATFORM_ADMIN_PASSWORD: 'unit-test-only-not-a-deployed-secret',
});
const root = fileURLToPath(new URL('../', import.meta.url));

test('all explicit owner inputs required; no fallback secrets', () => {
  for (const key of Object.keys(fixture())) {
    const env = fixture();
    delete env[key];
    assert.throws(() => readFreshDatabaseInput(env), /Missing/);
  }
  assert.equal(readFreshDatabaseInput(fixture()).platformAdminEmail, 'owner@example.invalid');
});
test('rejects wrong target, same privileged identity, transport bypass, injected URL options', () => {
  for (const patch of [
    { FRESH_DATABASE_TARGET: 'another-target' },
    { APP_DATABASE_URL: fixture().DATABASE_URL },
    { APP_DATABASE_URL: fixture().APP_DATABASE_URL.replace('/devfathom?', '/other?') },
    { DATABASE_URL: fixture().DATABASE_URL.replace('verify-full', 'disable') },
    { DATABASE_URL: fixture().DATABASE_URL + '&options=-c%20role=postgres' },
    { DATABASE_URL: fixture().DATABASE_URL + '&sslmode=disable' },
    { DATABASE_URL: 'not-a-url-with-sensitive-input' },
  ])
    assert.throws(() => readFreshDatabaseInput({ ...fixture(), ...patch }));
});
test('password/email validation and errors do not echo sensitive input', () => {
  for (const secret of ['tiny', 'x'.repeat(73), '界'.repeat(25)])
    assert.throws(
      () => readFreshDatabaseInput({ ...fixture(), PLATFORM_ADMIN_PASSWORD: secret }),
      (error) => !error.message.includes(secret)
    );
  assert.throws(() => readFreshDatabaseInput({ ...fixture(), PLATFORM_ADMIN_EMAIL: 'invalid' }));
});
test('runtime posture asserts neither SUPERUSER nor BYPASSRLS and fails closed on missing flags', () => {
  const role = {
    current_user: 'devfathom_app',
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolinherit: false,
    rolcanlogin: true,
  };
  assertFreshRuntimeRole(role);
  for (const key of ['rolsuper', 'rolbypassrls', 'rolcreatedb', 'rolcreaterole', 'rolinherit'])
    assert.throws(() => assertFreshRuntimeRole({ ...role, [key]: true }));
  assert.throws(() => assertFreshRuntimeRole({ ...role, rolcanlogin: false }));
  assert.throws(() => assertFreshRuntimeRole({ ...role, rolsuper: undefined }));
  assert.throws(() => assertFreshRuntimeRole({ ...role, current_user: 'postgres' }));
});
test('120 actual migration bytes and schema pin verified offline', () => {
  assert.equal(verifyFreshDatabaseSource(root).length, 120);
});
test('migration ledger rejects missing, duplicate, failed, rolled-back, and changed entries', () => {
  const pins = [{ name: 'migration', sha256: 'checksum' }];
  const row = {
    migration_name: 'migration',
    checksum: 'checksum',
    finished_at: 'timestamp',
    rolled_back_at: null,
  };
  assertFreshMigrationLedger(pins, [row]);
  for (const rows of [
    [],
    [row, row],
    [{ ...row, checksum: 'changed' }],
    [{ ...row, finished_at: null }],
    [{ ...row, rolled_back_at: 'timestamp' }],
  ])
    assert.throws(() => assertFreshMigrationLedger(pins, rows));
});

const role = {
  current_user: 'devfathom_app',
  database_name: 'devfathom',
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolinherit: false,
  rolcanlogin: true,
};
const baseline = {
  operationalSha256: 'a'.repeat(64),
  migratedCatalogSha256: 'b'.repeat(64),
  initializedCatalogSha256: 'c'.repeat(64),
};
const admin = { id: 'id', email: 'owner@example.invalid', role: 'SUPER_ADMIN', active: true };
function setup(existing = [], failure, changes = {}) {
  const events = [];
  const tx = {
    $queryRawUnsafe: async (sql) => {
      if (failure === 'observation-query') throw new Error(fixture().DATABASE_URL);
      if (sql.includes('pg_catalog.pg_roles')) {
        events.push('identity');
        return changes.identity ?? [role];
      }
      events.push('ledger');
      return (
        changes.ledger ??
        verifyFreshDatabaseSource(root).map((pin) => ({
          migration_name: pin.name,
          checksum: pin.sha256,
          finished_at: 'timestamp',
          rolled_back_at: null,
        }))
      );
    },
    $executeRawUnsafe: async (sql) => {
      events.push(sql);
    },
    platformUser: {
      findMany: async () => {
        events.push('read');
        return existing;
      },
      create: async ({ data }) => {
        events.push('create');
        assert.equal(data.passwordHash, 'opaque-unit-hash');
        if (failure === 'create') throw new Error('create failure');
        return {};
      },
    },
  };
  const sync = async () => {
    events.push('catalog');
    if (failure === 'catalog') throw new Error('catalog failure');
    return { modulesCreated: 1, packagesCreated: 1, linksCreated: 1 };
  };
  const hash = async () => {
    events.push('hash');
    if (failure === 'hash') throw new Error('hash failure');
    return 'opaque-unit-hash';
  };
  const guard = {
    sourceRoot: root,
    baseline,
    observe: async (observedTx) => {
      assert.equal(observedTx, tx);
      events.push('observe');
      if (failure === 'observer') throw new Error(fixture().PLATFORM_ADMIN_PASSWORD);
      return {
        target: fixture().FRESH_DATABASE_TARGET,
        tlsServerIdentityVerified: true,
        completeVisibility: true,
        operationalSha256: baseline.operationalSha256,
        catalogSha256:
          existing.length === 0
            ? baseline.migratedCatalogSha256
            : baseline.initializedCatalogSha256,
        ...changes.observation,
      };
    },
  };
  const factory = async (url) => {
    events.push('factory');
    assert.equal(url, readFreshDatabaseInput(fixture()).runtimeDatabaseUrl);
    return {
      $transaction: async (body, options) => {
        assert.equal(options.isolationLevel, 'Serializable');
        try {
          return await body(tx);
        } catch (error) {
          events.push('rollback');
          throw error;
        }
      },
    };
  };
  return {
    events,
    tx,
    guard,
    factory,
    sync,
    hash,
    run: () => initializeFreshPlatform(tx, readFreshDatabaseInput(fixture()), sync, hash, guard),
    bound: () => runBoundFreshBootstrap(factory, fixture(), guard, sync, hash),
  };
}
test('new platform bootstrap locks before reads and creates only the platform admin', async () => {
  const unit = setup();
  const result = await unit.run();
  assert.equal(result.administratorCreated, true);
  assert.deepEqual(unit.events, [
    'SELECT pg_advisory_xact_lock(1531, 120)',
    "SELECT set_config('app.is_platform_admin', 'true', true)",
    'identity',
    'ledger',
    'observe',
    'read',
    'catalog',
    'hash',
    'create',
  ]);
});
test('replay preserves credentials and performs no account update or creation', async () => {
  const unit = setup([
    { id: 'id', email: 'owner@example.invalid', role: 'SUPER_ADMIN', active: true },
  ]);
  assert.equal((await unit.run()).administratorCreated, false);
  assert.ok(!unit.events.includes('hash') && !unit.events.includes('create'));
});
test('unexpected existing identities, inactive accounts, and roles rejected before catalog writes', async () => {
  for (const rows of [
    [{ email: 'someone@example.invalid', role: 'SUPER_ADMIN', active: true }],
    [{ email: 'owner@example.invalid', role: 'AUDITOR', active: true }],
    [{ email: 'owner@example.invalid', role: 'SUPER_ADMIN', active: false }],
    [{}, {}],
  ]) {
    const unit = setup(rows);
    await assert.rejects(unit.run(), /Platform state/);
    assert.ok(!unit.events.includes('catalog'));
  }
});
test('catalog, hashing, and insertion errors escape to the owning transaction', async () => {
  for (const step of ['catalog', 'hash', 'create']) {
    const unit = setup([], step);
    await assert.rejects(unit.run(), new RegExp(`${step} failure`));
    if (step !== 'create') assert.ok(!unit.events.includes('create'));
  }
});
test('offline CLI rejects --apply; no execution capability or secret echo', () => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', 'prisma/fresh-database-plan.mjs', '--apply'],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /accepts no arguments/);
  assert.equal(result.stdout, '');
});

test('SQL and manifest checksum tampering rejected by independent manifest identity', () => {
  const scratch = process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR;
  assert.ok(scratch, 'run-owned scratch required');
  const dir = mkdtempSync(join(scratch, 'fresh-manifest-'));
  try {
    mkdirSync(join(dir, 'prisma'));
    cpSync(join(root, 'prisma/schema.prisma'), join(dir, 'prisma/schema.prisma'));
    cpSync(join(root, 'prisma/migrations'), join(dir, 'prisma/migrations'), { recursive: true });
    const manifest = JSON.parse(
      readFileSync(join(root, 'prisma/fresh-database-manifest.json'), 'utf8')
    );
    const migration = join(dir, 'prisma/migrations', manifest.migrations[0].name, 'migration.sql');
    const altered = readFileSync(migration, 'utf8') + '\n-- unit tampering';
    writeFileSync(migration, altered);
    manifest.migrations[0].sha256 = createHash('sha256').update(altered).digest('hex');
    writeFileSync(join(dir, 'prisma/fresh-database-manifest.json'), JSON.stringify(manifest));
    assert.throws(() => verifyFreshDatabaseSource(dir), /manifest identity mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('validated URL factory, same-transaction observation and exact replay baseline', async () => {
  for (const rows of [[], [admin]]) {
    const unit = setup(rows);
    assert.equal((await unit.bound()).administratorCreated, rows.length === 0);
    assert.equal(unit.events[0], 'factory');
    assert.ok(unit.events.indexOf('observe') < unit.events.indexOf('catalog'));
    if (rows.length) assert.ok(!unit.events.includes('hash') && !unit.events.includes('create'));
  }
});
test('missing binding or reviewed baseline refuses before factory and writes', async () => {
  const unit = setup();
  for (const guard of [
    undefined,
    {},
    { ...unit.guard, baseline: undefined },
    { ...unit.guard, observe: undefined },
    { ...unit.guard, baseline: { ...baseline, operationalSha256: '' } },
  ])
    await assert.rejects(
      runBoundFreshBootstrap(unit.factory, fixture(), guard, unit.sync, unit.hash),
      /binding/
    );
  await assert.rejects(
    runBoundFreshBootstrap(undefined, fixture(), unit.guard, unit.sync, unit.hash),
    /factory/
  );
  assert.deepEqual(unit.events, []);
});
test('wrong authenticated identity, endpoint, missing posture and failed observations refuse all writes', async () => {
  for (const changes of [
    { identity: [{ ...role, database_name: 'other' }] },
    { identity: [] },
    { identity: [{ ...role, current_user: 'postgres' }] },
    { identity: [{ ...role, rolsuper: undefined }] },
    { identity: [{ ...role, rolbypassrls: true }] },
    { ledger: [] },
    { observation: { target: 'other:5432/devfathom' } },
    { observation: { tlsServerIdentityVerified: false } },
    { observation: { completeVisibility: undefined } },
  ]) {
    const unit = setup([], undefined, changes);
    await assert.rejects(unit.bound(), /bootstrap failed/);
    assert.ok(unit.events.includes('rollback'));
    assert.ok(!unit.events.some((event) => ['catalog', 'hash', 'create'].includes(event)));
  }
  for (const failure of ['observation-query', 'observer']) {
    const unit = setup([], failure);
    await assert.rejects(
      unit.bound(),
      (error) =>
        !error.message.includes('unit-only') &&
        !error.message.includes(fixture().PLATFORM_ADMIN_PASSWORD)
    );
    assert.ok(!unit.events.includes('catalog'));
  }
});
test('operational state or catalog drift refuses both initial and replay phases', async () => {
  // The trusted observer fingerprints all operational rows, not merely platform administrators.
  for (const rows of [[], [admin]]) {
    for (const observation of [
      { operationalSha256: 'd'.repeat(64) },
      { operationalSha256: undefined },
      { catalogSha256: 'e'.repeat(64) },
      { catalogSha256: undefined },
    ]) {
      const unit = setup(rows, undefined, { observation });
      await assert.rejects(unit.bound(), /bootstrap failed/);
      assert.ok(!unit.events.some((event) => ['catalog', 'hash', 'create'].includes(event)));
    }
  }
});
test('factory and transaction errors are sanitized and remain rejected', async () => {
  const unit = setup();
  for (const factory of [
    async () => {
      throw new Error(fixture().DATABASE_URL);
    },
    async () => ({
      $transaction: async () => {
        throw new Error(fixture().PLATFORM_ADMIN_PASSWORD);
      },
    }),
  ]) {
    await assert.rejects(
      runBoundFreshBootstrap(factory, fixture(), unit.guard, unit.sync, unit.hash),
      (error) =>
        error.message === 'Fresh database bootstrap failed; owning transaction must roll back.'
    );
  }
  assert.deepEqual(unit.events, []);
});
test('explicit private endpoint uses existing URL policy without inferred provider topology', () => {
  const env = fixture();
  for (const key of ['DATABASE_URL', 'APP_DATABASE_URL', 'FRESH_DATABASE_TARGET'])
    env[key] = env[key].replace('fixture.rds.amazonaws.com', 'reviewed.private.example');
  assert.equal(readFreshDatabaseInput(env).target, 'reviewed.private.example:5432/devfathom');
});
