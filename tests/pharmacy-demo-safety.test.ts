/**
 * Run query checks: bun --no-env-file test tests/pharmacy-demo-safety.test.ts
 * Include offline runner checks: set PHARMACY_DEMO_REVIEW_ROOT to a read-only
 * export of 72ac8671086a4d7c46ab2075d80685bb50a508e4, then run that command.
 * Exact runner/contract bytes are pinned before importing real callable exports.
 * Missing review input registers no runner checks: never report six query checks
 * as package acceptance. No database, real credentials, or live target is used.
 * Offline refusal is not runtime authorization, RLS, writes, or resumption proof.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mock } from 'bun:test';
import {
  findBranch,
  getBranchPurchaseOrder,
  listBranchPurchaseOrders,
} from '../src/lib/pharmacy/branch-scope.ts';

type Db = Parameters<typeof findBranch>[0];

for (const scope of [
  { organizationId: 'synthetic-tenant-a', branchId: 'synthetic-branch-a' },
  { organizationId: 'synthetic-tenant-b', branchId: 'synthetic-branch-a' },
  { organizationId: 'synthetic-tenant-a', branchId: 'synthetic-branch-b' },
]) {
  test(`branch lookup retains both predicates: ${JSON.stringify(scope)}`, async () => {
    let calls = 0;
    const db = {
      pharmacyBranch: {
        async findFirst(query: unknown) {
          calls++;
          assert.deepEqual(query, {
            where: { organizationId: scope.organizationId, id: scope.branchId },
          });
          return null;
        },
      },
    } as unknown as Db;
    assert.equal(await findBranch(db, scope), null);
    assert.equal(calls, 1);
  });

  test(`purchase reads retain tenant and branch: ${JSON.stringify(scope)}`, async () => {
    const queries: { where: unknown }[] = [];
    const db = {
      pharmacyPurchaseOrder: {
        async findFirst(query: { where: unknown }) {
          queries.push(query);
          return null;
        },
        async findMany(query: { where: unknown }) {
          queries.push(query);
          return [];
        },
      },
    } as unknown as Db;
    assert.equal(await getBranchPurchaseOrder(db, scope, 'synthetic-foreign-order'), null);
    assert.deepEqual(await listBranchPurchaseOrders(db, scope), []);
    assert.deepEqual(queries.map(({ where }) => where), [
      { ...scope, id: 'synthetic-foreign-order' },
      scope,
    ]);
  });
}

const reviewRoot = process.env.PHARMACY_DEMO_REVIEW_ROOT;
if (reviewRoot) {
  // Setup binding failures are input errors, not fabricated product test cases.
  for (const [name, digest] of [
    ['seed-pharmacy-demo.ts', '64f611db4607eaf94d178a4da7c474134b0228c5a94a74af73bf1a6fdd0e4c95'],
    ['pharmacy-demo-contract.ts', 'd0d64970e9acc78c84d14aeef330a837089db396dd6b87607d701efa82e6c76c'],
  ]) {
    assert.equal(createHash('sha256').update(readFileSync(join(reviewRoot, 'scripts', name))).digest('hex'), digest);
  }

  // Only I/O boundaries are doubled. All validation and refusal logic is real.
  const io: string[] = [];
  let content = '';
  let openError = false;
  mock.module('node:fs/promises', () => ({
    open: async () => {
      io.push('open');
      if (openError) throw new Error('SYNTHETIC_PRIVATE_MARKER');
      let offset = 0;
      return {
        stat: async () => ({ isFile: () => true, size: Buffer.byteLength(content) }),
        read: async (buffer: Buffer, start: number, length: number) => {
          const source = Buffer.from(content);
          const bytesRead = source.copy(buffer, start, offset, offset + length);
          offset += bytesRead;
          return { bytesRead };
        },
        close: async () => { io.push('close'); },
      };
    },
    writeFile: async () => { io.push('writeFile'); throw new Error('unexpected write'); },
  }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { io.push('fetch'); throw new Error('unexpected send'); }) as typeof fetch;
  const root = await import(pathToFileURL(join(reviewRoot, 'scripts/seed-pharmacy-demo.ts')).href);
  const contract = await import(pathToFileURL(join(reviewRoot, 'scripts/pharmacy-demo-contract.ts')).href);
  const NOW = new Date('2026-09-07T07:00:00.000Z');
  function fixture() {
    const e = {
      version: contract.PHARMACY_DEMO_VERSION,
      target: {
        environment: 'disposable', targetKey: 'qa7-offline-only', organizationId: 'synthetic-org',
        branchId: 'synthetic-branch', ownerUserId: 'synthetic-owner', vertical: 'PHARMACY',
        currency: 'PKR', timezone: 'Asia/Karachi', businessDate: '2026-09-07',
        scenarioAt: NOW.toISOString(), namespace: '',
      },
      observed: {
        environment: 'disposable', targetKey: 'qa7-offline-only', organizationId: 'synthetic-org',
        branchId: 'synthetic-branch', vertical: 'PHARMACY', organizationActive: true,
        branchActive: true, currency: 'PKR', timezone: 'Asia/Karachi',
        observedAt: '2026-09-07T06:55:00.000Z',
        owners: [{ userId: 'synthetic-owner', email: 'owner@chaichowk.pk', active: true,
          role: 'ADMIN', branchIds: ['synthetic-branch'], capabilities: ['reports:operational', 'reports:financial'] }],
        runtimeRole: { superuser: false, bypassRls: false, forceRls: true },
        schemaSha256: contract.SCHEMA_SHA256, migrationsSha256: contract.MIGRATIONS_SHA256,
        migrationCount: 106, actors: [], references: [], modules: [],
      },
      history: { namespace: '', receiptPresent: false, tombstonePresent: false, namespaceRecordCount: 0 },
      confirmation: { workspaceConfirmed: true, approvalReference: 'synthetic-not-an-approval',
        evidenceDigest: '', expiresAt: '2026-09-07T07:30:00.000Z' },
    };
    e.target.namespace = root.targetNamespace(e.target);
    e.history.namespace = e.target.namespace;
    e.confirmation.evidenceDigest = root.evidenceDigest(e);
    return e;
  }
  function set(e: unknown, path: string, value: unknown) {
    const parts = path.split('.');
    let item = e as Record<string, unknown>;
    for (const key of parts.slice(0, -1)) item = item[key] as Record<string, unknown>;
    item[parts.at(-1)!] = value;
  }
  function refuses(e: unknown, code: string) {
    assert.throws(() => root.dryRun(e, NOW), (error: unknown) =>
      error instanceof root.PharmacyDemoRefusal && (error as { code: string }).code === code);
  }
  const mutations: [string, unknown, string][] = [
    ['target.vertical', 'RESTAURANT', 'APPROVED_PHARMACY_REQUIRED'],
    ['observed.organizationId', 'foreign-org', 'TARGET_OBSERVATION_MISMATCH'],
    ['observed.branchId', 'foreign-branch', 'TARGET_OBSERVATION_MISMATCH'],
    ['observed.targetKey', 'foreign-target', 'TARGET_OBSERVATION_MISMATCH'],
    ['observed.environment', 'lan', 'UNSAFE_ENVIRONMENT'],
    ['observed.owners.0.userId', 'foreign-owner', 'EXISTING_OWNER_REQUIRED'],
    ['observed.owners.0.branchIds', ['foreign-branch'], 'OWNER_BRANCH_UNASSIGNED'],
    ['observed.owners.0.capabilities', [], 'OWNER_CAPABILITY_MISSING'],
    ['observed.owners.0.active', false, 'EXISTING_OWNER_REQUIRED'],
    ['observed.runtimeRole.superuser', true, 'UNSAFE_RUNTIME_ROLE'],
    ['observed.runtimeRole.bypassRls', true, 'UNSAFE_RUNTIME_ROLE'],
    ['observed.runtimeRole.forceRls', false, 'UNSAFE_RUNTIME_ROLE'],
    ['observed.schemaSha256', '0'.repeat(64), 'SCHEMA_MISMATCH'],
    ['observed.migrationCount', 105, 'SCHEMA_MISMATCH'],
    ['observed.observedAt', '2026-09-07T05:00:00.000Z', 'STALE_OBSERVATION'],
    ['confirmation', null, 'INVALID_EVIDENCE'],
    ['confirmation.workspaceConfirmed', false, 'WORKSPACE_UNCONFIRMED'],
    ['confirmation.expiresAt', NOW.toISOString(), 'EXPIRED_OR_UNBOUNDED_CONFIRMATION'],
    ['confirmation.expiresAt', '2026-09-07T08:00:00.000Z', 'EXPIRED_OR_UNBOUNDED_CONFIRMATION'],
    ['target.businessDate', '2026-09-08', 'BUSINESS_DATE_MISMATCH'],
    ['target.scenarioAt', '2026-02-30T07:00:00.000Z', 'INVALID_INSTANT'],
    ['target.namespace', 'arbitrary-reset', 'NAMESPACE_MISMATCH'],
    ['history.receiptPresent', true, 'RECEIPT_TOMBSTONE_INCOMPLETE'],
    ['history.tombstonePresent', true, 'RECEIPT_TOMBSTONE_INCOMPLETE'],
    ['history.namespaceRecordCount', 1, 'NAMESPACE_COLLISION'],
  ];
  for (const [path, value, code] of mutations) {
    test(`72ac offline refusal: ${path} -> ${code}`, () => {
      const e = fixture();
      set(e, path, value);
      if (path === 'target.namespace') e.history.namespace = e.target.namespace;
      if (e.confirmation) e.confirmation.evidenceDigest = root.evidenceDigest(e);
      refuses(e, code);
    });
  }
  test('72ac namespace is stable across scenario/owner changes and separates targets', () => {
    const t = fixture().target;
    assert.equal(root.targetNamespace(t), root.targetNamespace({ ...t, ownerUserId: 'different', scenarioAt: '2027-01-01T00:00:00.000Z' }));
    for (const key of ['environment', 'targetKey', 'organizationId', 'branchId']) {
      assert.notEqual(root.targetNamespace(t), root.targetNamespace({ ...t, [key]: 'different' }));
    }
  });
  test('72ac content drift invalidates digest; complete receipts refuse empty reseed', () => {
    const e = fixture();
    e.confirmation.approvalReference = 'another-manual-claim';
    e.target.scenarioAt = '2026-09-07T07:01:00.000Z';
    refuses(e, 'CONFIRMATION_DIGEST_MISMATCH');
    e.history.receiptPresent = e.history.tombstonePresent = true;
    e.confirmation.evidenceDigest = root.evidenceDigest(e);
    refuses(e, 'EXISTING_RECEIPT_RECONCILIATION_REQUIRED');
  });
  test('72ac manual evidence and repeated dry-runs confer no authority or I/O', () => {
    assert.deepEqual(io, []); // Import and preceding pure checks performed no I/O.
    const e = fixture();
    const before = structuredClone(e);
    const a = root.dryRun(e, NOW);
    assert.deepEqual(root.dryRun(e, NOW), a);
    assert.deepEqual(e, before);
    assert.deepEqual([a.liveTargetVerified, a.applyEnabled, a.writes, a.plannedRecords], [false, false, 0, 0]);
    assert.equal(a.receipt.seedReceipt, false);
    assert.ok(a.applyBlockers.includes('LIVE_OBSERVATION_ADAPTER_REQUIRED'));
    assert.ok(a.applyBlockers.includes('SERVICE_CONCURRENCY_AND_RESUMPTION_PROOF_REQUIRED'));
    assert.ok(a.coverage.every((gap: { status: string }) => ['UNSEEDED', 'OWNER-INPUT'].includes(gap.status)));
    assert.deepEqual(io, []);
  });
  test('72ac apply rejects before opening supplied paths, including parallel invocations', async () => {
    io.length = 0;
    const outputs: string[] = [];
    const results = await Promise.all(Array.from({ length: 3 }, () => root.main(
      ['--evidence', 'SYNTHETIC_PRIVATE_MARKER.pharmacy-demo.json', '--apply'], (s: string) => outputs.push(s))));
    assert.deepEqual(results, [2, 2, 2]);
    assert.deepEqual(io, []);
    for (const output of outputs) assert.deepEqual(JSON.parse(output), { mode: 'refused', code: 'APPLY_DISABLED', writes: 0, applyEnabled: false });
  });
  test('72ac credential/permission/activation fields refuse without echo or writes', async () => {
    for (const field of ['password', 'token', 'connectionString', 'permissions', 'activation', 'sendEmail']) {
      io.length = 0;
      const e = fixture();
      set(e, field, 'SYNTHETIC_PRIVATE_MARKER');
      content = JSON.stringify(e);
      const outputs: string[] = [];
      assert.equal(await root.main(['--evidence', 'synthetic.pharmacy-demo.json'], (s: string) => outputs.push(s)), 2);
      assert.deepEqual(io, ['open', 'close']);
      assert.deepEqual(JSON.parse(outputs[0]), { mode: 'refused', code: 'INVALID_EVIDENCE_KEYS', writes: 0, applyEnabled: false });
      assert.ok(!outputs.join('').includes('SYNTHETIC_PRIVATE_MARKER'));
    }
  });
  test('72ac read and JSON parse errors omit underlying text and supplied path', async () => {
    for (const failOpen of [true, false]) {
      openError = failOpen;
      content = 'SYNTHETIC_PRIVATE_MARKER invalid JSON';
      const outputs: string[] = [];
      assert.equal(await root.main(['--evidence', 'SYNTHETIC_PRIVATE_MARKER.pharmacy-demo.json'], (s: string) => outputs.push(s)), 2);
      assert.deepEqual(JSON.parse(outputs[0]), { mode: 'refused', code: 'EVIDENCE_READ_OR_PARSE_FAILED', writes: 0, applyEnabled: false });
    }
    openError = false;
    globalThis.fetch = originalFetch;
  });
}
