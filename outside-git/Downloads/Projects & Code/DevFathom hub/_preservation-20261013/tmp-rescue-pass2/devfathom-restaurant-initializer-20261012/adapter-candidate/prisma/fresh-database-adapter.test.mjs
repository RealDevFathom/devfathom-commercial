import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { TLSSocket, rootCertificates } from 'node:tls';
import pg from 'pg';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from 'bcryptjs';
import {
  createPrivateFactory,
  DispatchBarrier,
  privatePoolConfig,
  verifyOwnedTLS,
} from './fresh-database-adapter.js';
import {
  canonicalJSON,
  createdMatches,
  digest,
  fingerprint,
  numeric,
  sha256,
  stable,
  validatePlan,
} from './fresh-database-fingerprint.js';
import {
  policyScope,
  proveVisibility,
  collectRows,
  schemaInventory,
  observedPhase,
  assertCatalog,
  concreteObserver,
} from './fresh-database-observer.js';
import { readPrivateFile, runPrivate } from './fresh-database-runner.js';
import {
  validateEffects,
  generateBaseline,
  verifyBaseline,
  sourceContextPaths,
} from './fresh-database-baseline.js';
import { renderPreparation, WRITER_INSERT_COLUMNS } from './fresh-database-prep.js';
import { readFileSync } from 'node:fs';
import { freshDatabaseIntentSha256, readFreshDatabaseInput } from './fresh-database.js';
import { RESTAURANT_PACKAGES } from '../src/lib/vertical-catalog.js';

const ca = Buffer.from(rootCertificates[0]); // Public synthetic-test trust input; no target or private key.
const endpoint = {
  hostname: 'unit.invalid',
  port: 5432,
  database: 'unit',
  tlsServerName: 'unit.invalid',
  caSha256: sha256(ca),
};
const url = 'postgresql://devfathom_app:synthetic-password@unit.invalid/unit?sslmode=verify-full';
const control = () => ({
  signal: new AbortController().signal,
  deadlineAt: Date.now() + 10000,
  endpoint,
});
const tick = () => new Promise((r) => setImmediate(r));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const options = { maxWait: 1000, timeout: 2000, isolationLevel: 'Serializable' };

async function fakeDriver(body, behavior = {}) {
  const originalPool = pg.Pool,
    originalQuery = pg.Client.prototype.query;
  const state = {
    sent: [],
    clients: [],
    pool: undefined,
    callbacks: [],
    closes: [],
    releases: 0,
    ends: 0,
  };
  class FakePool extends EventEmitter {
    constructor(config) {
      super();
      this.options = config;
      this.checked = new Set();
      state.pool = this;
      if (behavior.allocateFail) throw new Error('synthetic-secret');
    }
    async connect() {
      const client = new this.options.Client(this.options);
      state.clients.push(client);
      const c = client.connection;
      const socket = Object.create(TLSSocket.prototype);
      Object.defineProperties(socket, {
        encrypted: { value: true },
        authorized: { value: !behavior.tlsFail },
        authorizationError: { value: behavior.tlsFail ? 'bad' : null },
        destroyed: { value: false, writable: true },
        remoteAddress: { value: '192.0.2.1' },
        remotePort: { value: 5432 },
        servername: { value: 'unit.invalid' },
      });
      socket.getPeerCertificate = () => ({
        subjectaltname: 'DNS:unit.invalid',
        raw: Buffer.from('synthetic-peer'),
      });
      socket.cork = () => {};
      socket.uncork = () => {};
      socket.destroy = () => {
        if (socket.destroyed) return;
        socket.destroyed = true;
        const end = () => {
          client.emit('end');
          for (const callback of state.callbacks.splice(0)) callback(new Error('synthetic-secret'));
        };
        if (behavior.delayClose) state.closes.push(end);
        else queueMicrotask(end);
      };
      c.stream = socket;
      c.query = () => {};
      client.processID = 42;
      for (const method of ['parse', 'bind', 'execute', 'flush', 'sync', 'describe'])
        c[method] = () => {};
      if (behavior.connectGate) await behavior.connectGate.promise;
      if (behavior.connectFail) {
        socket.destroy();
        throw new Error('synthetic-secret');
      }
      this.checked.add(client);
      client.release = () => {
        state.releases++;
        this.checked.delete(client);
        this.endWait?.();
      };
      return client;
    }
    async end() {
      state.ends++;
      if (this.checked.size)
        await new Promise((r) => {
          this.endWait = r;
        });
      if (behavior.cleanupFail) throw new Error('synthetic-secret');
    }
  }
  pg.Pool = FakePool;
  pg.Client.prototype.query = function (q) {
    const submit = () => {
      const error = q.submit(this.connection);
      if (error) {
        queueMicrotask(() => q.callback(error));
        return;
      }
      state.sent.push(q.text);
      const result = { command: q.text.trim().split(/\s+/)[0], rowCount: 0, rows: [], fields: [] };
      if (
        (behavior.holdCommit && result.command === 'COMMIT') ||
        (behavior.holdQuery && result.command === 'UPDATE')
      )
        state.callbacks.push((error) => q.callback(error, result));
      else
        queueMicrotask(() =>
          q.callback(
            behavior.queryFail && result.command === 'UPDATE'
              ? new Error('synthetic-secret')
              : null,
            result
          )
        );
    };
    if (behavior.queueCommit && q.text === 'COMMIT') state.submitCommit = submit;
    else submit();
    return q;
  };
  try {
    await body(state);
  } finally {
    pg.Pool = originalPool;
    pg.Client.prototype.query = originalQuery;
  }
}

test('explicit PoolConfig cannot inherit URL TLS overrides and validates CA before allocation', () => {
  const c = control(),
    config = privatePoolConfig(url, c, ca);
  assert.equal(config.connectionString, undefined);
  assert.equal(config.query_timeout, 0);
  assert.equal(config.max, 1);
  for (const bad of [
    url + '&sslcert=x',
    url.replace('unit.invalid', 'other.invalid'),
    url.replace('devfathom_app', 'migration'),
  ])
    assert.throws(() => privatePoolConfig(bad, c, ca));
  assert.throws(() =>
    privatePoolConfig(url, { ...c, endpoint: { ...endpoint, tlsServerName: 'other.invalid' } }, ca)
  );
  assert.throws(() => privatePoolConfig(url, c, Buffer.from('invalid')));
  const aborted = new AbortController();
  aborted.abort();
  assert.throws(() => privatePoolConfig(url, { ...c, signal: aborted.signal }, ca));
});

test('concrete private factory commits once, binds the actual TX/client and closes its owned pool', async () =>
  fakeDriver(async (state) => {
    const owner = createPrivateFactory(ca),
      lease = owner.factory.create(url, control()),
      client = await lease.connect();
    assert.throws(() => owner.session({}));
    await client.$transaction(async (tx) => {
      assert.equal(owner.session(tx).backendPid, 42);
    }, options);
    await lease.close();
    await lease.close();
    assert.deepEqual(state.sent, [
      'BEGIN',
      'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
      'COMMIT',
    ]);
    assert.equal(state.ends, 1);
    assert.equal(state.releases, 1);
    assert.deepEqual(owner.receipt(), {
      outcome: 'COMMITTED',
      localQuiescent: true,
      cleanupFailed: false,
    });
  }));

test('partial pool allocation and connect failures still clean up without exposing secrets', async () => {
  for (const behavior of [{ allocateFail: true }, { connectFail: true }, { tlsFail: true }])
    await fakeDriver(async (state) => {
      const owner = createPrivateFactory(ca),
        lease = owner.factory.create(url, control());
      await assert.rejects(async () => {
        const c = await lease.connect();
        await c.$transaction(async () => {}, options);
      });
      await lease.cancelAndDrain();
      await lease.close();
      assert.equal(owner.receipt().localQuiescent, true);
      assert.equal(state.sent.length, 0);
    }, behavior);
});

test('deferred connect late success cannot dispatch BEGIN after cancellation; socket close is awaited', async () => {
  const gate = deferred();
  await fakeDriver(
    async (state) => {
      const owner = createPrivateFactory(ca),
        lease = owner.factory.create(url, control()),
        client = await lease.connect();
      const tx = client.$transaction(async () => {}, options);
      void tx.catch(() => {});
      await tick();
      let settled = false;
      const drain = lease.cancelAndDrain().then(() => {
        settled = true;
      });
      gate.resolve();
      await tick();
      assert.equal(settled, false);
      for (const close of state.closes.splice(0)) close();
      await drain;
      await assert.rejects(tx);
      await lease.close();
      assert.equal(state.sent.length, 0);
      assert.equal(owner.receipt().localQuiescent, true);
    },
    { connectGate: gate, delayClose: true }
  );
});

test('queued physical COMMIT rechecks the deadline and never dispatches', async () =>
  fakeDriver(
    async (state) => {
      const c = control(),
        owner = createPrivateFactory(ca),
        lease = owner.factory.create(url, c),
        client = await lease.connect();
      const tx = client.$transaction(async () => {}, options);
      void tx.catch(() => {});
      await tick();
      await tick();
      c.deadlineAt = Date.now() - 1;
      assert.equal(typeof state.submitCommit, 'function');
      state.submitCommit();
      await assert.rejects(tx);
      await lease.cancelAndDrain();
      await lease.close();
      assert.equal(state.sent.includes('COMMIT'), false);
      assert.equal(owner.receipt().outcome, 'UNKNOWN');
    },
    { queueCommit: true }
  ));

test('sent COMMIT with lost ACK stays UNKNOWN; repeated drain waits driver callbacks and socket end', async () =>
  fakeDriver(
    async (state) => {
      const owner = createPrivateFactory(ca),
        lease = owner.factory.create(url, control()),
        client = await lease.connect();
      const tx = client.$transaction(async () => {}, options);
      void tx.catch(() => {});
      await tick();
      await tick();
      assert.equal(state.sent.at(-1), 'COMMIT');
      const first = lease.cancelAndDrain();
      assert.equal(first, lease.cancelAndDrain());
      let done = false;
      void first.then(() => {
        done = true;
      });
      await tick();
      assert.equal(done, false);
      for (const end of state.closes.splice(0)) end();
      await first;
      await assert.rejects(tx);
      await lease.close();
      assert.equal(owner.receipt().outcome, 'UNKNOWN');
      assert.equal(owner.receipt().localQuiescent, true);
    },
    { holdCommit: true, delayClose: true }
  ));

test('acknowledged COMMIT remains COMMITTED on later cancellation; cleanup failure explicitly UNKNOWN', async () => {
  for (const cleanupFail of [false, true])
    await fakeDriver(
      async () => {
        const owner = createPrivateFactory(ca),
          lease = owner.factory.create(url, control()),
          c = await lease.connect();
        await c.$transaction(async () => {}, options);
        await lease.cancelAndDrain();
        if (cleanupFail) await assert.rejects(lease.close());
        else await lease.close();
        assert.equal(owner.receipt().outcome, cleanupFail ? 'UNKNOWN' : 'COMMITTED');
      },
      { cleanupFail }
    );
});

test('late successful COMMIT callback beyond boundary is UNKNOWN, never a rollback claim', () => {
  const c = control(),
    barrier = new DispatchBarrier(c),
    connection = {},
    client = { connection };
  const q = { text: 'COMMIT', submit: () => undefined, callback: () => {} };
  barrier.instrument(q, client, () => {});
  q.submit(connection);
  c.deadlineAt = Date.now() - 1;
  q.callback(null, { command: 'COMMIT' });
  assert.equal(barrier.outcome, 'UNKNOWN');
});
test('abort before query blocks physical mutation and waits the complete transaction', async () =>
  fakeDriver(async (state) => {
    const controller = new AbortController(),
      owner = createPrivateFactory(ca),
      lease = owner.factory.create(url, { ...control(), signal: controller.signal }),
      client = await lease.connect();
    await assert.rejects(
      client.$transaction(async (tx) => {
        controller.abort();
        await tx.$executeRawUnsafe('UPDATE unit');
      }, options)
    );
    await lease.cancelAndDrain();
    await lease.close();
    assert.equal(
      state.sent.some((sql) => sql.startsWith('UPDATE')),
      false
    );
    assert.equal(owner.receipt().localQuiescent, true);
  }));
test('body failure receives real ROLLBACK acknowledgement; query failure never fabricates rollback', async () => {
  for (const queryFail of [false, true])
    await fakeDriver(
      async (state) => {
        const owner = createPrivateFactory(ca),
          lease = owner.factory.create(url, control()),
          client = await lease.connect();
        await assert.rejects(
          client.$transaction(async (tx) => {
            if (queryFail) await tx.$executeRawUnsafe('UPDATE unit');
            throw new Error('synthetic-secret');
          }, options)
        );
        await lease.cancelAndDrain();
        await lease.close();
        assert.equal(owner.receipt().outcome, queryFail ? 'UNKNOWN' : 'ROLLED_BACK');
        assert.equal(state.sent.includes('COMMIT'), false);
      },
      { queryFail }
    );
});

test('physical dispatch rejects wrong connection and error latches queued work', () => {
  const b = new DispatchBarrier(control()),
    connection = {},
    client = { connection };
  let sent = 0;
  const q = {
    text: 'UPDATE x',
    submit: () => {
      sent++;
    },
    callback: () => {},
  };
  b.instrument(q, client, () => {});
  assert.ok(q.submit({}) instanceof Error);
  assert.equal(sent, 0);
  assert.throws(() => b.check());
});

test('TLS verification rejects changed CA, hostname, unauthenticated socket and wrong owning connection', async () =>
  fakeDriver(async (state) => {
    const c = control(),
      owner = createPrivateFactory(ca),
      lease = owner.factory.create(url, c),
      client = await lease.connect();
    await client.$transaction(async () => {
      const physical = state.clients[0],
        config = state.pool.options;
      assert.throws(() => verifyOwnedTLS(physical, {}, config, endpoint));
      assert.throws(() =>
        verifyOwnedTLS(physical, physical.connection, config, {
          ...endpoint,
          caSha256: '0'.repeat(64),
        })
      );
      assert.throws(() =>
        verifyOwnedTLS(physical, physical.connection, config, {
          ...endpoint,
          tlsServerName: 'other.invalid',
        })
      );
    }, options);
    await lease.close();
  }));

const col = (name, type = 'text', nullable = false) => ({ name, type, nullable });
const table = (name, columns = [col('id')], foreignKeys = []) => ({
  name,
  columns,
  primaryKey: ['id'],
  foreignKeys,
});
const plan = (tables, created = []) => ({ version: 'restaurant-state-v1', tables, created });
test('lossless canonical encoding sorts JSON keys, preserves numeric precision and rejects duplicates', () => {
  assert.equal(
    stable(canonicalJSON('{"b":1.00,"a":9007199254740993}')),
    stable(canonicalJSON('{"a":9007199254740993,"b":1}'))
  );
  assert.notEqual(
    stable(canonicalJSON('9007199254740993')),
    stable(canonicalJSON('9007199254740992'))
  );
  assert.notEqual(numeric('0.00000000000001'), numeric('0.00000000000002'));
  assert.throws(() => canonicalJSON('{"a":1,"a":2}'));
  assert.throws(() => canonicalJSON('01'));
});
test('fingerprints cover every table/column, row multiplicity, NULL/false/zero/date/bytes and history', async () => {
  const p = plan([
    table('organizations', [
      col('id'),
      col('v', 'text', true),
      col('time', 'timestamp(6) without time zone'),
      col('bytes', 'bytea'),
    ]),
  ]);
  const data = {
    organizations: [
      { id: 'org_devfathom', v: null, time: '2026-01-01 00:00:00.000001', bytes: '\\x00' },
    ],
  };
  const original = await fingerprint(p, data);
  for (const patch of [
    { v: '' },
    { v: 'false' },
    { v: '0' },
    { time: '2026-01-01 00:00:00.000002' },
    { bytes: '\\x01' },
  ])
    assert.notEqual(
      (await fingerprint(p, { organizations: [{ ...data.organizations[0], ...patch }] }))
        .operationalSha256,
      original.operationalSha256
    );
  await assert.rejects(fingerprint(p, {}));
  await assert.rejects(fingerprint(p, { ...data, hidden: [] }));
  await assert.rejects(
    fingerprint(p, { organizations: [...data.organizations, ...data.organizations] })
  );
  await assert.rejects(
    fingerprint(p, { organizations: [{ ...data.organizations[0], extra: 'x' }] })
  );
});
test('generated natural-key IDs normalize references consistently; dangling and duplicate identities reject', async () => {
  const p = plan(
    [
      table('organization_roles', [col('id'), col('organizationId'), col('key')]),
      table(
        'organization_role_permissions',
        [col('id'), col('organizationRoleId'), col('capability')],
        [
          {
            columns: ['organizationRoleId'],
            table: 'organization_roles',
            references: ['id'],
            validated: true,
          },
        ]
      ),
    ],
    [
      {
        table: 'organization_roles',
        selector: { organizationId: 'new', key: 'owner' },
        token: 'role-owner',
        idColumn: 'id',
        timestamps: [],
      },
      {
        table: 'organization_role_permissions',
        selector: { organizationRoleId: '@ref:role-owner', capability: '*' },
        token: 'permission-owner',
        idColumn: 'id',
        timestamps: [],
      },
    ]
  );
  const data = (id) => ({
    organization_roles: [{ id, organizationId: 'new', key: 'owner' }],
    organization_role_permissions: [{ id: 'p' + id, organizationRoleId: id, capability: '*' }],
  });
  assert.deepEqual(
    await fingerprint(p, data('one'), { mode: 'AFTER_INITIAL' }),
    await fingerprint(p, data('two'), { mode: 'AFTER_INITIAL' })
  );
  assert.notDeepEqual(await fingerprint(p, data('one')), await fingerprint(p, data('two')));
  const bad = data('one');
  bad.organization_role_permissions[0].organizationRoleId = 'absent';
  await assert.rejects(fingerprint(p, bad));
  assert.equal(createdMatches(p, data('one'))[1].rows.length, 1);
});
test('password normalization applies only after INITIAL, bcrypt verifies exact intended secret; exact replay detects rehash', async () => {
  const p = plan(
    [table('users', [col('id'), col('password')])],
    [
      {
        table: 'users',
        selector: { id: 'unit' },
        token: 'admin',
        timestamps: [],
        password: { column: 'password', secret: 'admin', cost: 12 },
      },
    ]
  );
  const password = await hash('synthetic-password', 12),
    data = { users: [{ id: 'unit', password }] };
  const approved = await fingerprint(
    p,
    { users: [{ id: 'unit', password: '@initial-password:admin' }] },
    { mode: 'OFFLINE' }
  );
  assert.deepEqual(
    await fingerprint(p, data, {
      mode: 'AFTER_INITIAL',
      secrets: { admin: 'synthetic-password', platform: 'unused' },
    }),
    approved
  );
  assert.notEqual((await fingerprint(p, data)).operationalSha256, approved.operationalSha256);
  await assert.rejects(
    fingerprint(p, data, { mode: 'AFTER_INITIAL', secrets: { admin: 'wrong', platform: 'unused' } })
  );
  assert.throws(() => validatePlan({ ...p, created: [{ ...p.created[0], table: 'tokens' }] }));
});

const platformPolicy = {
  name: 'tenant',
  command: '*',
  permissive: true,
  roles: ['public'],
  using: `((current_setting('app.is_platform_admin'::text, true) = 'true'::text) OR ("organizationId" = NULLIF(current_setting('app.current_organization_id'::text, true), ''::text)))`,
  check: null,
};
const catalogTable = (
  name,
  columns = [col('id'), col('organizationId')],
  policy = platformPolicy,
  fks = []
) => ({
  ...table(name, columns, fks),
  rls: true,
  force: true,
  owner: 'migration',
  select: true,
  policies: [policy],
});
const anchors = () => [
  catalogTable('organizations', [col('id')], {
    ...platformPolicy,
    using: platformPolicy.using.replace('"organizationId"', 'id'),
  }),
  catalogTable('restaurant_branches'),
];
const orgPolicy = {
  ...platformPolicy,
  using: `("organizationId" = NULLIF(current_setting('app.current_organization_id'::text, true), ''::text))`,
};
test('exact supported policies include nullable global org rows and reject unknown/restrictive/no-FORCE/no-SELECT', () => {
  assert.equal(
    policyScope(
      catalogTable('platform_accounts', [col('id'), col('organizationId', 'text', true)])
    ),
    'global'
  );
  for (const change of [
    { force: false },
    { select: false },
    { owner: 'devfathom_app' },
    { policies: [{ ...platformPolicy, permissive: false }] },
    { policies: [{ ...platformPolicy, using: 'true' }] },
    { policies: [platformPolicy, orgPolicy] },
  ])
    assert.throws(() => policyScope({ ...catalogTable('users'), ...change }));
});
test('strict org source without validated nonnullable anchor fails even with zero rows; descendants cannot launder gap', () => {
  const source = catalogTable('pharmacy_migration_sources', undefined, orgPolicy);
  assert.throws(() => proveVisibility([...anchors(), source]));
  source.foreignKeys = [
    { columns: ['organizationId'], table: 'organizations', references: ['id'], validated: true },
  ];
  assert.equal(proveVisibility([...anchors(), source]).get(source.name), 'organization');
  source.foreignKeys[0].validated = false;
  assert.throws(() => proveVisibility([...anchors(), source]));
});
test('strict branch coverage requires exact composite anchor, including orphan org/branch pairs', async () => {
  const using = `(("organizationId" = NULLIF(current_setting('app.current_organization_id'::text, true), ''::text)) AND ("branchId" = NULLIF(current_setting('app.current_branch_id'::text, true), ''::text)))`;
  const t = catalogTable(
    'restaurant_growth_reviews',
    [col('id'), col('organizationId'), col('branchId')],
    { ...platformPolicy, using },
    [
      {
        columns: ['organizationId', 'branchId'],
        table: 'restaurant_branches',
        references: ['organizationId', 'id'],
        validated: true,
      },
    ]
  );
  assert.equal(proveVisibility([...anchors(), t]).get(t.name), 'branch');
  t.foreignKeys = [];
  assert.throws(() => proveVisibility([...anchors(), t]));
});
test('same-TX row collection enumerates ALL branches and restores all three GUCs on success/error', async () => {
  for (const failRead of [false, true]) {
    const p = plan([
      table('organizations'),
      table('restaurant_branches', [col('id'), col('organizationId')]),
      table('restaurant_growth_reviews'),
    ]);
    const calls = [];
    const tx = {
      $queryRawUnsafe: async (sql, ...args) => {
        calls.push([sql, args]);
        if (sql.startsWith('SELECT current_setting'))
          return [{ platform: 'prior', organization: 'prior-org', branch: 'prior-branch' }];
        if (sql.includes('FROM public."organizations"')) return [{ id: 'known' }];
        if (sql.includes('FROM public."restaurant_branches"'))
          return [{ id: 'orphan-branch', organizationId: 'orphan-org' }];
        if (sql.includes('FROM public."restaurant_growth_reviews"')) {
          if (failRead) throw new Error('fake');
          return [{ id: 'visible' }];
        }
        return [];
      },
    };
    const read = collectRows(
      tx,
      p,
      new Map([
        ['organizations', 'global'],
        ['restaurant_branches', 'global'],
        ['restaurant_growth_reviews', 'branch'],
      ])
    );
    if (failRead) await assert.rejects(read);
    else assert.equal((await read).restaurant_growth_reviews.length, 1);
    assert.ok(
      calls.some(([, args]) => stable(args) === stable(['true', 'orphan-org', 'orphan-branch']))
    );
    assert.deepEqual(calls.at(-1)[1], ['prior', 'prior-org', 'prior-branch']);
  }
});
test('schema inventory independently covers all 451 mapped models', () => {
  const inventory = schemaInventory(new URL('../', import.meta.url).pathname);
  assert.equal(inventory.length, 451);
  assert.ok(inventory.some((t) => t.name === 'pharmacy_migration_sources'));
});
test('offline effect validation refuses historical edits before normalization', () => {
  const review = {
    plan: plan([table('organizations')]),
    initial: { organizations: [{ id: 'org_devfathom' }] },
    completed: { organizations: [{ id: 'changed' }] },
  };
  assert.throws(() => validateEffects(review, { restaurant: {} }));
});
test('private CLI missing/config permission/symlink failures happen before factory allocation; messages omit input values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'initializer-private-test-'));
  try {
    const path = join(root, 'private.json');
    writeFileSync(path, '{"secret":"DO_NOT_EMIT"}', { mode: 0o600 });
    assert.equal(readPrivateFile(path).toString().includes('DO_NOT_EMIT'), true);
    assert.deepEqual(await runPrivate(path), {
      code: 2,
      outcome: 'CONFIG_REJECTED',
      manualReview: false,
    });
    chmodSync(path, 0o644);
    assert.throws(() => readPrivateFile(path));
    chmodSync(path, 0o600);
    const link = join(root, 'link');
    symlinkSync(path, link);
    assert.throws(() => readPrivateFile(link));
    assert.deepEqual(await runPrivate(join(root, 'missing')), {
      code: 2,
      outcome: 'CONFIG_REJECTED',
      manualReview: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('offline prep rejects incomplete inventory and unsafe identifiers', () => {
  assert.throws(() =>
    renderPreparation(
      plan([table('users')]),
      { runtime: 'devfathom_app', migration: 'migration' },
      'unit'
    )
  );
});

test('real generated Prisma create SQL needs only the explicitly rendered writer columns', async () => {
  const operations = [
    [
      'platformModule',
      'platform_modules',
      {
        key: 'unit',
        name: 'Unit',
        category: 'test',
        routePrefix: '/unit',
        band: 'BASELINE',
        vertical: 'RESTAURANT',
      },
    ],
    ['platformPackage', 'platform_packages', { key: 'unit', name: 'Unit', vertical: 'RESTAURANT' }],
    [
      'platformPackageModule',
      'platform_package_modules',
      { packageId: 'package', moduleId: 'module', limits: { unit: 1 } },
    ],
    [
      'organization',
      'organizations',
      {
        id: 'unit',
        slug: 'unit',
        legalName: 'Unit',
        displayName: 'Unit',
        vertical: 'RESTAURANT',
        status: 'ONBOARDING',
        isDemo: false,
        packageId: 'package',
        seatLimit: 1,
      },
    ],
    [
      'organizationDepartment',
      'organization_departments',
      { organizationId: 'unit', key: 'unit', name: 'Unit', sortOrder: 0 },
    ],
    [
      'organizationRole',
      'organization_roles',
      { organizationId: 'unit', key: 'owner', name: 'Owner', isSystem: true },
    ],
    [
      'organizationRolePermission',
      'organization_role_permissions',
      { organizationId: 'unit', organizationRoleId: 'role', capability: '*', effect: 'ALLOW' },
    ],
    ['organizationBrand', 'organization_brands', { organizationId: 'unit' }],
    [
      'user',
      'users',
      {
        id: 'admin',
        organizationId: 'unit',
        organizationRoleId: 'role',
        name: 'Unit',
        email: 'unit@example.invalid',
        password: 'synthetic-hash',
        role: 'ADMIN',
        department: 'unit',
        title: 'Owner',
        status: 'ACTIVE',
      },
    ],
    [
      'platformUser',
      'platform_users',
      {
        id: 'platform',
        name: 'Unit',
        email: 'platform@example.invalid',
        passwordHash: 'synthetic-hash',
        role: 'SUPER_ADMIN',
        active: true,
      },
    ],
  ];
  for (const [model, name, data] of operations)
    await fakeDriver(async (state) => {
      const owner = createPrivateFactory(ca),
        lease = owner.factory.create(url, control()),
        c = await lease.connect();
      await c.$transaction(async (tx) => {
        await tx[model].create({ data });
      }, options);
      await lease.close();
      const sql = state.sent.find((sql) => sql.startsWith('INSERT'));
      assert.ok(sql, model);
      const columns = /INSERT INTO [^(]+\(([^)]+)\)/
        .exec(sql)[1]
        .split(',')
        .map((c) => c.trim().replaceAll('"', ''));
      assert.deepEqual(columns.sort(), [...WRITER_INSERT_COLUMNS[name]].sort(), name);
    });
});

function fullSyntheticReview(purpose = 'INITIAL_TRANSITION') {
  const root = new URL('../', import.meta.url).pathname;
  const env = {
    DATABASE_URL: 'postgresql://migration:synthetic@unit.invalid/unit?sslmode=verify-full',
    APP_DATABASE_URL: url,
    FRESH_DATABASE_TARGET: 'unit.invalid:5432/unit',
    BOOTSTRAP_MODE: 'RESTAURANT',
    ORGANIZATION_ID: 'unit',
    ORGANIZATION_SLUG: 'unit',
    ORGANIZATION_LEGAL_NAME: 'Unit',
    ORGANIZATION_DISPLAY_NAME: 'Unit',
    BOOTSTRAP_PACKAGE_KEY: RESTAURANT_PACKAGES[0].key,
    ADMIN_ID: 'admin',
    ADMIN_NAME: 'Unit Admin',
    ADMIN_EMAIL: 'admin@example.invalid',
    ADMIN_TITLE: 'Owner',
    ADMIN_PASSWORD: 'synthetic-password',
    PLATFORM_ADMIN_ID: 'platform',
    PLATFORM_ADMIN_NAME: 'Unit Platform',
    PLATFORM_ADMIN_EMAIL: 'platform@example.invalid',
    PLATFORM_ADMIN_PASSWORD: 'synthetic-platform',
  };
  const input = readFreshDatabaseInput(env);
  const tables = schemaInventory(root).map((t) => ({
    ...table(
      t.name,
      t.columns.map((n) => col(n, 'text', true))
    ),
    primaryKey: [t.columns.includes('id') ? 'id' : t.columns[0]],
  }));
  const initial = Object.fromEntries(tables.map((t) => [t.name, []]));
  const row = (name, values) =>
    Object.assign(
      Object.fromEntries(tables.find((t) => t.name === name).columns.map((c) => [c.name, null])),
      values
    );
  initial.organizations.push(row('organizations', { id: 'org_devfathom' }));
  initial.organization_departments.push(
    row('organization_departments', { id: 'historical', organizationId: 'org_devfathom' })
  );
  const completed = structuredClone(initial);
  completed.organizations.push(
    row('organizations', {
      id: 'unit',
      slug: 'unit',
      legalName: 'Unit',
      displayName: 'Unit',
      vertical: 'RESTAURANT',
      isDemo: 'false',
      status: 'ONBOARDING',
    })
  );
  completed.organization_roles.push(
    row('organization_roles', { id: 'role', organizationId: 'unit', key: 'owner' })
  );
  completed.users.push(
    row('users', {
      id: 'admin',
      organizationId: 'unit',
      organizationRoleId: 'role',
      email: 'admin@example.invalid',
      role: 'ADMIN',
      status: 'ACTIVE',
      password:
        purpose === 'INITIAL_TRANSITION' ? '@initial-password:admin' : 'exact-reviewed-hash',
    })
  );
  completed.platform_users.push(
    row('platform_users', {
      id: 'platform',
      email: 'platform@example.invalid',
      role: 'SUPER_ADMIN',
      active: 'true',
      passwordHash:
        purpose === 'INITIAL_TRANSITION'
          ? '@initial-password:platform'
          : 'exact-reviewed-platform-hash',
    })
  );
  const created =
    purpose === 'INITIAL_TRANSITION'
      ? [
          {
            table: 'users',
            selector: { id: 'admin' },
            token: 'admin',
            timestamps: [],
            password: { column: 'password', secret: 'admin', cost: 12 },
          },
          {
            table: 'platform_users',
            selector: { id: 'platform' },
            token: 'platform',
            timestamps: [],
            password: { column: 'passwordHash', secret: 'platform', cost: 12 },
          },
        ]
      : [];
  const catalog = {
    tables: tables.map((t) => ({
      ...t,
      rls: t.name === 'organizations' || t.columns.some((c) => c.name === 'organizationId'),
      force: true,
      owner: 'migration',
      select: true,
      policies:
        t.name === 'organizations'
          ? [{ ...platformPolicy, using: platformPolicy.using.replace('"organizationId"', 'id') }]
          : [platformPolicy],
    })),
    facts: [
      { section: 'columns', value: { table: 'users', name: 'id', kind: 'r', select: true } },
      { section: 'columns', value: { table: 'users_pkey', name: 'id', kind: 'i', select: false } },
    ],
  };
  catalog.tables.push({
    ...table('_prisma_migrations'),
    rls: false,
    force: false,
    owner: 'migration',
    select: true,
    policies: [],
  });
  catalog.tables.sort((a, b) => (a.name < b.name ? -1 : 1));
  const role = {
    current_user: 'devfathom_app',
    session_user: 'devfathom_app',
    database_name: 'unit',
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolinherit: false,
    rolcanlogin: true,
    rolreplication: false,
    membership_count: 0,
  };
  const source = Object.fromEntries(
    sourceContextPaths(root).map((p) => [p, sha256(readFileSync(join(root, p)))])
  );
  return {
    root,
    env,
    input,
    review: {
      version: 'restaurant-offline-review-v1',
      provenance: 'independently-reviewed-source-effects',
      purpose,
      reviewId: 'SYNTHETIC-PRIVATE-TEST-ONLY',
      source,
      intentSha256: freshDatabaseIntentSha256(input),
      endpoint,
      plan: plan(tables, created),
      initial,
      completed,
      catalog,
      role,
    },
  };
}

test('offline generation verifies complete source/data/artifact bindings; source tampering and historical normalization refuse', async () => {
  const { review, input, root } = fullSyntheticReview();
  const artifact = await generateBaseline(review, input, root);
  assert.deepEqual(await verifyBaseline(artifact, input, root), artifact);
  const corrupt = structuredClone(artifact);
  corrupt.baseline.completed.operationalSha256 = '0'.repeat(64);
  await assert.rejects(verifyBaseline(corrupt, input, root));
  const source = structuredClone(review);
  source.source['prisma/production-bootstrap.ts'] = '0'.repeat(64);
  await assert.rejects(generateBaseline(source, input, root));
  const historical = structuredClone(review);
  historical.plan.created.push({
    table: 'organizations',
    selector: { id: 'org_devfathom' },
    token: 'history',
    timestamps: [],
  });
  await assert.rejects(generateBaseline(historical, input, root));
  const existing = structuredClone(review);
  const module = Object.fromEntries(
    existing.plan.tables
      .find((t) => t.name === 'platform_modules')
      .columns.map((c) => [c.name, null])
  );
  Object.assign(module, { id: 'existing', key: 'dashboard' });
  existing.initial.platform_modules.push(module);
  existing.completed.platform_modules.push({ ...module });
  existing.plan.created.push({
    table: 'platform_modules',
    selector: { key: 'dashboard' },
    token: 'existing-module',
    idColumn: 'id',
    timestamps: [],
  });
  await assert.rejects(generateBaseline(existing, input, root));
});
test('INITIAL transition and independently approved exact COMPLETED replay have explicit distinct semantics', async () => {
  for (const purpose of ['INITIAL_TRANSITION', 'COMPLETED_REPLAY']) {
    const { review, input, root } = fullSyntheticReview(purpose);
    const artifact = await generateBaseline(review, input, root);
    if (purpose === 'INITIAL_TRANSITION') {
      assert.equal(observedPhase(artifact.baseline.initial, artifact.baseline, purpose), 'INITIAL');
      assert.equal(
        observedPhase(artifact.baseline.completed, artifact.baseline, purpose, 'INITIAL'),
        'COMPLETED'
      );
      assert.throws(() => observedPhase(artifact.baseline.completed, artifact.baseline, purpose));
    } else {
      assert.equal(
        observedPhase(await fingerprint(review.plan, review.completed), artifact.baseline, purpose),
        'COMPLETED'
      );
      review.completed.users[0].role = 'EMPLOYEE';
      assert.notEqual(
        (await fingerprint(review.plan, review.completed)).operationalSha256,
        artifact.baseline.completed.operationalSha256
      );
    }
  }
});
test('complete catalog proof ignores index column ACL as a table SELECT requirement but detects table/policy/ACL/FK drift', () => {
  const { review, root } = fullSyntheticReview();
  assert.equal(assertCatalog(review.plan, review.catalog, review.catalog, root).size, 451);
  for (const mutation of [
    (c) => {
      c.tables.pop();
    },
    (c) => {
      c.tables.find((t) => t.name === 'users').force = false;
    },
    (c) => {
      c.facts[0].value.select = false;
    },
    (c) => {
      c.tables.find((t) => t.name === 'users').columns.pop();
    },
  ]) {
    const changed = structuredClone(review.catalog);
    mutation(changed);
    assert.throws(() => assertCatalog(review.plan, changed, review.catalog, root));
  }
});
test('concrete observer queries identity/catalog/rows on identical TX and rejects mismatched PID before rows', async () => {
  const { review, input, root } = fullSyntheticReview();
  const artifact = await generateBaseline(review, input, root);
  let rowQueries = 0;
  const tx = {
    $queryRawUnsafe: async (sql, ...args) => {
      if (sql.startsWith('SELECT current_user')) return [{ ...review.role, pid: 42 }];
      if (sql.includes("'foreignKeys'")) return review.catalog.tables.map((value) => ({ value }));
      if (sql.startsWith('SELECT section')) return review.catalog.facts;
      if (sql.startsWith('SELECT current_setting'))
        return [{ platform: 'true', organization: 'unit', branch: '' }];
      if (sql.includes(' FROM public.')) {
        rowQueries++;
        const name = / FROM public\."([^"]+)"/.exec(sql)[1];
        return review.initial[name];
      }
      return [];
    },
  };
  const owner = {
    session: (current) => {
      assert.equal(current, tx);
      return { backendPid: 42 };
    },
  };
  const guard = { sourceRoot: root, endpoint, baseline: artifact.baseline };
  const observe = concreteObserver(
    owner,
    input,
    guard,
    review.plan,
    review.catalog,
    review.purpose
  );
  assert.equal((await observe(tx)).phase, 'INITIAL');
  assert.equal(rowQueries, 451);
  rowQueries = 0;
  await assert.rejects(
    concreteObserver(
      { session: () => ({ backendPid: 99 }) },
      input,
      guard,
      review.plan,
      review.catalog,
      review.purpose
    )(tx)
  );
  assert.equal(rowQueries, 0);
});
