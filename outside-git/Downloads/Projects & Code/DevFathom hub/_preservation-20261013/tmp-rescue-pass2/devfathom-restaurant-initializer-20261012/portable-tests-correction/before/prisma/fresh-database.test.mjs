import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  readFreshDatabaseInput,
  verifyFreshDatabaseSource,
  assertFreshRuntimeRole,
  assertFreshMigrationLedger,
  freshDatabaseIntentSha256,
  runBoundFreshBootstrap,
} from './fresh-database.js';
import { bootstrapFreshDatabase } from './fresh-database-bootstrap.js';
import {
  RESTAURANT_PACKAGES,
  roleTemplatesForVertical,
  defaultDepartmentRowsForVertical,
} from '../src/lib/vertical-catalog.js';

const root = fileURLToPath(new URL('../', import.meta.url));
// Inert synthetic values exist only in test-local objects; no connections or environment files.
function fixture() {
  return {
    DATABASE_URL:
      'postgresql://migration:synthetic@reviewed.private.example/testdb?sslmode=verify-full',
    APP_DATABASE_URL:
      'postgresql://devfathom_app:synthetic@reviewed.private.example/testdb?sslmode=verify-full',
    FRESH_DATABASE_TARGET: 'reviewed.private.example:5432/testdb',
    BOOTSTRAP_MODE: 'RESTAURANT',
    ORGANIZATION_ID: 'org_unit',
    ORGANIZATION_SLUG: 'unit',
    ORGANIZATION_LEGAL_NAME: 'Unit',
    ORGANIZATION_DISPLAY_NAME: 'Unit',
    BOOTSTRAP_PACKAGE_KEY: RESTAURANT_PACKAGES[0].key,
    ADMIN_ID: 'unit_admin',
    ADMIN_NAME: 'Unit Admin',
    ADMIN_EMAIL: 'admin@example.invalid',
    ADMIN_TITLE: 'Owner',
    ADMIN_PASSWORD: 'synthetic-unit-password',
    PLATFORM_ADMIN_ID: 'unit_platform',
    PLATFORM_ADMIN_NAME: 'Unit Platform',
    PLATFORM_ADMIN_EMAIL: 'platform@example.invalid',
    PLATFORM_ADMIN_PASSWORD: 'synthetic-platform-password',
  };
}
const role = {
  current_user: 'devfathom_app',
  database_name: 'testdb',
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolinherit: false,
  rolcanlogin: true,
  rolreplication: false,
  membership_count: 0,
};
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const initial = {
  operationalSha256: digest('initial-operation'),
  catalogSha256: digest('initial-catalog'),
};
const completed = {
  operationalSha256: digest('completed-operation'),
  catalogSha256: digest('completed-catalog'),
};

function setup(options = {}) {
  const env = fixture();
  const events = [];
  const writes = [];
  const input = readFreshDatabaseInput(env);
  const historical = { id: 'org_devfathom', vertical: 'AGENCY', historical: true };
  const state = {
    organizations: [historical],
    users: [],
    platformUsers: [],
    modules: [],
    packages: [],
    links: [],
    roles: [],
    departments: [],
    brands: [],
  };
  const identityMatches = (row) =>
    [input.restaurant.adminId, input.restaurant.platformAdminId].includes(row.id) ||
    [input.restaurant.adminEmail, input.restaurant.platformAdminEmail].includes(
      row.email?.toLowerCase()
    );
  const write = (table, data) => {
    events.push('write:' + table);
    writes.push({ table, data: structuredClone(data) });
    if (options.fail === table) throw new Error(env.APP_DATABASE_URL);
    const row = { id: `${table}-${state[table].length}`, ...data };
    state[table].push(row);
    return row;
  };
  const tx = {
    $executeRawUnsafe: async (sql, ...args) => {
      events.push(sql);
      if (args.length) assert.equal(args[0], env.ORGANIZATION_ID);
    },
    $queryRawUnsafe: async (sql) => {
      events.push(sql.includes('pg_roles') ? 'identity' : 'ledger');
      if (options.fail === 'query') throw new Error(env.DATABASE_URL);
      return sql.includes('pg_roles')
        ? (options.identity ?? [role])
        : (options.ledger ??
            verifyFreshDatabaseSource(root).map((p) => ({
              migration_name: p.name,
              checksum: p.sha256,
              finished_at: 'fixture-finished',
              rolled_back_at: null,
            })));
    },
    organization: {
      findMany: async () =>
        state.organizations.filter(
          (r) => r.id === env.ORGANIZATION_ID || r.slug === env.ORGANIZATION_SLUG
        ),
      create: async ({ data }) => write('organizations', data),
    },
    user: {
      findMany: async () => state.users.filter(identityMatches),
      create: async ({ data }) => write('users', data),
    },
    platformUser: {
      findMany: async () => state.platformUsers.filter(identityMatches),
      create: async ({ data }) => write('platformUsers', data),
    },
    platformModule: {
      findMany: async () => state.modules,
      upsert: async ({ create, update }) => {
        assert.deepEqual(update, {});
        return state.modules.find((r) => r.key === create.key) ?? write('modules', create);
      },
    },
    platformPackage: {
      findMany: async () => state.packages,
      findUnique: async ({ where }) => state.packages.find((r) => r.key === where.key) ?? null,
      findUniqueOrThrow: async ({ where }) => {
        const row = state.packages.find((r) => r.key === where.key);
        assert.ok(row);
        return row;
      },
      upsert: async ({ create, update }) => {
        assert.deepEqual(update, {});
        return (
          state.packages.find((r) => r.key === create.key) ??
          write('packages', { defaultSeats: 5, ...create })
        );
      },
    },
    platformPackageModule: {
      upsert: async ({ create, update }) => {
        assert.deepEqual(update, {});
        return write('links', create);
      },
    },
    organizationDepartment: {
      createMany: async ({ data }) => {
        for (const row of data) write('departments', row);
        return { count: data.length };
      },
    },
    organizationRole: { create: async ({ data }) => write('roles', data) },
    organizationBrand: { create: async ({ data }) => write('brands', data) },
  };
  const endpoint = {
    hostname: 'reviewed.private.example',
    port: 5432,
    database: 'testdb',
    tlsServerName: 'reviewed.private.example',
    caSha256: digest('ca'),
  };
  const baseline = {
    reviewId: 'synthetic-offline-review',
    intentSha256: freshDatabaseIntentSha256(input),
    fingerprintPlanSha256: digest('plan'),
    postureSha256: digest('posture'),
    initial,
    completed,
  };
  let observations = 0;
  const guard = {
    sourceRoot: root,
    endpoint,
    baseline,
    observe: async (observedTx) => {
      assert.equal(observedTx, tx);
      events.push('observe');
      observations++;
      if (options.fail === 'observer') throw new Error(env.ADMIN_PASSWORD);
      const phase = state.organizations.length === 1 ? 'INITIAL' : 'COMPLETED';
      return {
        phase,
        target: env.FRESH_DATABASE_TARGET,
        endpoint,
        tlsServerIdentityVerified: true,
        completeVisibility: true,
        fingerprintPlanSha256: baseline.fingerprintPlanSha256,
        postureSha256: baseline.postureSha256,
        ...(phase === 'INITIAL' ? initial : baseline.completed),
        ...options.observation,
        ...(observations > 1 ? options.after : {}),
      };
    },
  };
  const hash = async () => {
    events.push('hash');
    if (options.fail === 'hash') throw new Error(env.ADMIN_PASSWORD);
    return 'synthetic-hash';
  };
  const factory = {
    contract: 'private-runtime-client-cancel-drain-v1',
    create(url, control) {
      events.push('factory');
      assert.equal(url, input.runtimeDatabaseUrl);
      assert.deepEqual(control.endpoint, endpoint);
      if (options.fail === 'factory') throw new Error(url);
      return {
        connect: async () => {
          events.push('connect');
          if (options.fail === 'connect') throw new Error(url);
          return {
            $transaction: async (body, transactionOptions) => {
              events.push('transaction');
              assert.equal(transactionOptions.isolationLevel, 'Serializable');
              assert.ok(
                transactionOptions.timeout <= 300000 && transactionOptions.maxWait <= 30000
              );
              try {
                const result = await body(tx);
                if (options.fail === 'serialization') throw new Error('P2034 ' + url);
                events.push('commit');
                return result;
              } catch (error) {
                events.push('rollback');
                throw error;
              }
            },
          };
        },
        cancelAndDrain: async () => {
          events.push('cancel-drain');
          if (options.fail === 'cancel') throw new Error(url);
        },
        close: async () => {
          events.push('close');
          if (options.fail === 'close') throw new Error(url);
        },
      };
    },
  };
  return {
    env,
    events,
    writes,
    state,
    historical,
    tx,
    guard,
    factory,
    hash,
    run: () => runBoundFreshBootstrap(factory, env, guard, 10000, hash),
  };
}

test('all explicit inputs required; mode cannot inherit Agency default', () => {
  for (const key of Object.keys(fixture())) {
    const env = fixture();
    delete env[key];
    assert.throws(() => readFreshDatabaseInput(env));
  }
  for (const BOOTSTRAP_MODE of ['AGENCY', 'PHARMACY', '', undefined])
    assert.throws(() => readFreshDatabaseInput({ ...fixture(), BOOTSTRAP_MODE }));
});
test('rejects URL bypasses, identity/target mismatch, malformed credentials and bcrypt truncation', () => {
  const env = fixture();
  for (const patch of [
    { FRESH_DATABASE_TARGET: 'wrong' },
    { APP_DATABASE_URL: env.DATABASE_URL },
    { APP_DATABASE_URL: env.APP_DATABASE_URL.replace('/testdb?', '/other?') },
    { DATABASE_URL: env.DATABASE_URL.replace('verify-full', 'disable') },
    { DATABASE_URL: env.DATABASE_URL + '&options=-c%20role=postgres' },
    { DATABASE_URL: env.DATABASE_URL + '&sslmode=disable' },
    { DATABASE_URL: 'sensitive-invalid' },
    { ADMIN_ID: env.PLATFORM_ADMIN_ID },
    { ADMIN_EMAIL: env.PLATFORM_ADMIN_EMAIL },
    ...['tiny', 'x'.repeat(73), '界'.repeat(25)].flatMap((password) => [
      { ADMIN_PASSWORD: password },
      { PLATFORM_ADMIN_PASSWORD: password },
    ]),
  ])
    assert.throws(() => readFreshDatabaseInput({ ...env, ...patch }));
});
test('role flags and memberships fail closed', () => {
  assertFreshRuntimeRole(role);
  for (const key of Object.keys(role).filter((key) => key !== 'database_name')) {
    assert.throws(() => assertFreshRuntimeRole({ ...role, [key]: undefined }));
  }
  for (const key of [
    'rolsuper',
    'rolbypassrls',
    'rolcreatedb',
    'rolcreaterole',
    'rolinherit',
    'rolreplication',
  ])
    assert.throws(() => assertFreshRuntimeRole({ ...role, [key]: true }));
  assert.throws(() => assertFreshRuntimeRole({ ...role, membership_count: 1 }));
});
test('125 migration bytes, schema and deterministic exact manifest verified', () => {
  const bytes = readFileSync(join(root, 'prisma/fresh-database-manifest.json'));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '4343385168f4b3c3c557266e48a13807589c5022edce2cf706a9047018add482'
  );
  assert.equal(bytes.toString(), JSON.stringify(JSON.parse(bytes), null, 2) + '\n');
  assert.equal(verifyFreshDatabaseSource(root).length, 125);
});
test('ledger rejects missing/extra/duplicate/unfinished/rolled-back/changed entries', () => {
  const pins = [{ name: 'one', sha256: 'checksum' }];
  const row = {
    migration_name: 'one',
    checksum: 'checksum',
    finished_at: 'done',
    rolled_back_at: null,
  };
  assertFreshMigrationLedger(pins, [row]);
  for (const rows of [
    [],
    [row, row],
    [{ ...row, checksum: 'bad' }],
    [{ ...row, finished_at: null }],
    [{ ...row, rolled_back_at: 'yes' }],
    [{ ...row, migration_name: 'extra' }],
  ])
    assert.throws(() => assertFreshMigrationLedger(pins, rows));
});
test('SQL, schema, inventory and SQL-plus-manifest tampering rejected in owned scratch', () => {
  const dir = mkdtempSync(join(root, 'checks/tamper-'));
  mkdirSync(join(dir, 'prisma'));
  const manifest = JSON.parse(readFileSync(join(root, 'prisma/fresh-database-manifest.json')));
  copyFileSync(join(root, 'prisma/schema.prisma'), join(dir, 'prisma/schema.prisma'));
  copyFileSync(
    join(root, 'prisma/fresh-database-manifest.json'),
    join(dir, 'prisma/fresh-database-manifest.json')
  );
  for (const p of manifest.migrations) {
    const target = join(dir, 'prisma/migrations', p.name);
    mkdirSync(target, { recursive: true });
    copyFileSync(
      join(root, 'prisma/migrations', p.name, 'migration.sql'),
      join(target, 'migration.sql')
    );
  }
  const sql = join(dir, 'prisma/migrations', manifest.migrations[0].name, 'migration.sql');
  const original = readFileSync(sql);
  writeFileSync(sql, original + '\n-- tamper');
  assert.throws(() => verifyFreshDatabaseSource(dir), /checksum/);
  manifest.migrations[0].sha256 = createHash('sha256').update(readFileSync(sql)).digest('hex');
  writeFileSync(
    join(dir, 'prisma/fresh-database-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  assert.throws(() => verifyFreshDatabaseSource(dir), /manifest identity/);
  copyFileSync(
    join(root, 'prisma/fresh-database-manifest.json'),
    join(dir, 'prisma/fresh-database-manifest.json')
  );
  writeFileSync(sql, original);
  writeFileSync(join(dir, 'prisma/schema.prisma'), '// tampered');
  assert.throws(() => verifyFreshDatabaseSource(dir), /schema pin/);
  copyFileSync(join(root, 'prisma/schema.prisma'), join(dir, 'prisma/schema.prisma'));
  mkdirSync(join(dir, 'prisma/migrations/20990101000000_extra'));
  assert.throws(() => verifyFreshDatabaseSource(dir), /inventory/);
});
test('missing factory/endpoint/CA/observer/review/phase contracts refuse before client creation', async () => {
  const unit = setup();
  for (const guard of [
    undefined,
    {},
    { ...unit.guard, observe: undefined },
    { ...unit.guard, endpoint: undefined },
    { ...unit.guard, endpoint: { ...unit.guard.endpoint, caSha256: '' } },
    ...[
      'reviewId',
      'intentSha256',
      'fingerprintPlanSha256',
      'postureSha256',
      'initial',
      'completed',
    ].map((key) => ({ ...unit.guard, baseline: { ...unit.guard.baseline, [key]: undefined } })),
  ]) {
    await assert.rejects(runBoundFreshBootstrap(unit.factory, unit.env, guard, 10000, unit.hash));
  }
  for (const factory of [undefined, {}, { ...unit.factory, contract: undefined }])
    await assert.rejects(runBoundFreshBootstrap(factory, unit.env, unit.guard, 10000, unit.hash));
  for (const deadline of [undefined, 0, -1, 330001, Infinity])
    await assert.rejects(
      runBoundFreshBootstrap(unit.factory, unit.env, unit.guard, deadline, unit.hash)
    );
  assert.deepEqual(unit.events, []);
});
test('authenticated role/ledger and all observer evidence required before hashes or writes', async () => {
  const patches = [
    { identity: [] },
    { identity: [{ ...role, current_user: 'postgres' }] },
    { identity: [{ ...role, database_name: 'other' }] },
    { identity: [{ ...role, membership_count: 1 }] },
    { ledger: [] },
    ...[
      'target',
      'phase',
      'endpoint',
      'tlsServerIdentityVerified',
      'completeVisibility',
      'fingerprintPlanSha256',
      'postureSha256',
      'operationalSha256',
      'catalogSha256',
    ].map((key) => ({ observation: { [key]: undefined } })),
    { observation: { endpoint: { hostname: 'other' } } },
  ];
  for (const patch of patches) {
    const unit = setup(patch);
    await assert.rejects(unit.run());
    assert.equal(unit.writes.length, 0);
    assert.ok(!unit.events.includes('hash'));
    assert.ok(unit.events.includes('rollback'));
    assert.equal(unit.events.at(-1), 'close');
  }
});
test('canonical initial writer runs once under same lock, preserves shell, creates only scoped onboarding', async () => {
  const unit = setup();
  const result = await unit.run();
  assert.equal(result.phase, 'INITIAL');
  const firstLock = unit.events.indexOf('SELECT pg_advisory_xact_lock(734219061)');
  const secondLock = unit.events.indexOf('SELECT pg_advisory_xact_lock(734219061)', firstLock + 1);
  assert.ok(
    firstLock < unit.events.indexOf('identity') && unit.events.indexOf('observe') < secondLock
  );
  assert.equal(unit.events.filter((e) => e.includes('pg_advisory_xact_lock')).length, 2);
  assert.equal(unit.events.filter((e) => e === 'hash').length, 2);
  assert.equal(unit.events.filter((e) => e === 'observe').length, 2);
  assert.equal(unit.state.organizations[0], unit.historical);
  assert.equal(unit.state.organizations[1].status, 'ONBOARDING');
  assert.equal(unit.state.organizations[1].isDemo, false);
  assert.equal(unit.state.roles.length, roleTemplatesForVertical('RESTAURANT').length);
  assert.equal(
    unit.state.departments.length,
    defaultDepartmentRowsForVertical('RESTAURANT').length
  );
  assert.deepEqual(
    unit.state.packages.map((p) => p.key),
    [unit.env.BOOTSTRAP_PACKAGE_KEY]
  );
  assert.ok(unit.state.modules.every((m) => m.band === 'BASELINE' || m.vertical === 'RESTAURANT'));
  assert.deepEqual(
    unit.state.brands.map((b) => b.organizationId),
    [unit.env.ORGANIZATION_ID]
  );
  assert.equal(unit.state.users[0].role, 'ADMIN');
  assert.equal(unit.state.platformUsers[0].role, 'SUPER_ADMIN');
  assert.equal(unit.events.at(-1), 'close');
});
test('reviewed completed replay preserves demotion/status/password/permissions/entitlements without hashing or repair', async () => {
  const unit = setup();
  await unit.run();
  Object.assign(unit.state.users[0], { role: 'MEMBER', status: 'INACTIVE', password: 'changed' });
  Object.assign(unit.state.platformUsers[0], {
    role: 'AUDITOR',
    active: false,
    passwordHash: 'changed',
  });
  unit.state.organizations[1].status = 'SUSPENDED';
  unit.state.roles[0].permissions = { create: [] };
  unit.state.links[0].enabled = false;
  unit.state.packages[0].active = false;
  // Explicit synthetic reviewed COMPLETED baseline; never auto-approved by production code.
  unit.guard.baseline.completed = {
    operationalSha256: digest('reviewed-demotion'),
    catalogSha256: digest('reviewed-entitlement'),
  };
  const before = structuredClone(unit.state);
  unit.events.length = 0;
  unit.writes.length = 0;
  assert.equal((await unit.run()).phase, 'COMPLETED');
  assert.deepEqual(unit.state, before);
  assert.equal(unit.writes.length, 0);
  assert.ok(!unit.events.includes('hash'));
});
test('unexpected identity collision remains refused by canonical writer', async () => {
  const unit = setup();
  unit.state.users.push({
    id: unit.env.ADMIN_ID,
    email: unit.env.ADMIN_EMAIL,
    organizationId: 'wrong',
  });
  await assert.rejects(unit.run());
  assert.equal(unit.writes.length, 0);
  assert.ok(!unit.events.includes('hash'));
});
test('unreviewed operational/catalog drift refuses initial and completed replay', async () => {
  for (const replay of [false, true])
    for (const key of ['operationalSha256', 'catalogSha256']) {
      const options = {};
      const unit = setup(options);
      if (replay) await unit.run();
      unit.events.length = 0;
      unit.writes.length = 0;
      options.observation = { [key]: digest('unrelated-drift') };
      await assert.rejects(unit.run());
      assert.equal(unit.writes.length, 0);
      assert.ok(!unit.events.includes('hash'));
    }
});
test('post-write phase and baseline mismatch reject owning transaction', async () => {
  for (const after of [
    { phase: 'INITIAL' },
    { operationalSha256: digest('bad') },
    { catalogSha256: digest('bad') },
  ]) {
    const unit = setup({ after });
    await assert.rejects(unit.run());
    assert.ok(unit.events.includes('rollback'));
    assert.ok(!unit.events.includes('commit'));
    assert.equal(unit.events.at(-1), 'close');
  }
});
test('driver/observer/hash/write/serialization failures sanitized; no retry; cancel/drain then cleanup', async () => {
  for (const fail of [
    'factory',
    'connect',
    'query',
    'observer',
    'hash',
    'organizations',
    'users',
    'platformUsers',
    'serialization',
    'close',
  ]) {
    const unit = setup({ fail });
    await assert.rejects(
      unit.run(),
      (e) => e.message === 'Fresh Restaurant bootstrap failed; transaction outcome requires review.'
    );
    assert.equal(unit.events.filter((e) => e === 'factory').length, 1);
    if (fail !== 'factory') assert.equal(unit.events.at(-1), 'close');
    if (unit.events.includes('rollback'))
      assert.ok(unit.events.indexOf('rollback') < unit.events.indexOf('cancel-drain'));
  }
});
test('deadline cancels, awaits settled transaction and cleanup before rejection; no detached commit', async () => {
  const unit = setup();
  let resolveWriter;
  let releaseCancellation;
  let cancelled;
  let transactionSettled;
  const settlement = new Promise((resolve) => {
    transactionSettled = resolve;
  });
  const started = new Promise((resolve) => {
    cancelled = resolve;
  });
  const barrier = new Promise((resolve) => {
    releaseCancellation = resolve;
  });
  const factory = {
    contract: 'private-runtime-client-cancel-drain-v1',
    create() {
      return {
        connect: async () => ({
          $transaction: async (body) => {
            try {
              await body(unit.tx);
              unit.events.push('forbidden-commit');
            } catch (e) {
              unit.events.push('settled-rollback');
              transactionSettled();
              throw e;
            }
          },
        }),
        cancelAndDrain: async () => {
          unit.events.push('cancel');
          resolveWriter();
          cancelled();
          await settlement;
          await barrier;
          unit.events.push('drained');
        },
        close: async () => {
          unit.events.push('closed');
        },
      };
    },
  };
  const hash = async () => {
    await new Promise((resolve) => {
      resolveWriter = resolve;
    });
    return 'synthetic-hash';
  };
  // Only first hashing call waits; second must settle too after cancellation.
  let hashes = 0;
  const hashing = async () => (++hashes === 1 ? hash() : 'synthetic-hash');
  let settled = false;
  const result = runBoundFreshBootstrap(factory, unit.env, unit.guard, 100, hashing).finally(() => {
    settled = true;
  });
  await started;
  assert.equal(settled, false);
  assert.ok(!unit.events.includes('closed'));
  releaseCancellation();
  await assert.rejects(result);
  assert.ok(!unit.events.includes('forbidden-commit'));
  assert.ok(unit.events.indexOf('settled-rollback') < unit.events.indexOf('closed'));
  assert.ok(unit.events.indexOf('drained') < unit.events.indexOf('closed'));
});
test('deadline during connect cleans partial private resources after settlement', async () => {
  const unit = setup();
  let rejectConnect;
  const events = [];
  const factory = {
    contract: 'private-runtime-client-cancel-drain-v1',
    create() {
      return {
        connect: () =>
          new Promise((resolve, reject) => {
            rejectConnect = reject;
          }),
        cancelAndDrain: async () => {
          events.push('cancel');
          rejectConnect(new Error('sensitive'));
        },
        close: async () => {
          events.push('close');
        },
      };
    },
  };
  await assert.rejects(runBoundFreshBootstrap(factory, unit.env, unit.guard, 30, unit.hash));
  assert.deepEqual(events, ['cancel', 'close']);
});
test('public wrapper refuses missing adapter and offline plan refuses execution arguments', async () => {
  const unit = setup();
  await assert.rejects(bootstrapFreshDatabase(undefined, unit.env, unit.guard, 10000));
  const r = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--import',
      './checks/register.mjs',
      'prisma/fresh-database-plan.mjs',
      '--apply',
    ],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /accepts no arguments/);
  assert.equal(r.stdout, '');
});

test('every endpoint/TLS/CA binding field must match the reviewed contract', async () => {
  for (const key of ['hostname', 'port', 'database', 'tlsServerName', 'caSha256']) {
    const unit = setup();
    const observe = unit.guard.observe;
    unit.guard.observe = async (tx) => {
      const result = await observe(tx);
      return { ...result, endpoint: { ...result.endpoint, [key]: undefined } };
    };
    await assert.rejects(unit.run());
    assert.equal(unit.writes.length, 0);
    assert.ok(!unit.events.includes('hash'));
  }
});
test('failed cancellation is sanitized and still awaits cleanup after settled failure', async () => {
  const unit = setup({ fail: 'observer' });
  const create = unit.factory.create;
  unit.factory.create = (...args) => ({
    ...create(...args),
    cancelAndDrain: async () => {
      throw new Error(unit.env.APP_DATABASE_URL);
    },
  });
  await assert.rejects(
    unit.run(),
    (error) =>
      error.message === 'Fresh Restaurant bootstrap failed; transaction outcome requires review.'
  );
  assert.equal(unit.events.at(-1), 'close');
});
