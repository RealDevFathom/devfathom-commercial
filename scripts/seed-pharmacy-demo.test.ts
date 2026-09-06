import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MIGRATIONS_SHA256,
  PHARMACY_DEMO_VERSION,
  SCHEMA_SHA256,
  type PharmacyDemoEvidence,
} from './pharmacy-demo-contract';
import {
  dryRun,
  evidenceDigest,
  main,
  PharmacyDemoRefusal,
  targetNamespace,
} from './seed-pharmacy-demo';

const NOW = new Date('2026-09-07T07:00:00.000Z');
/** Synthetic unit input only. No workspace, identity or approval is provisioned. */
function fixture(): PharmacyDemoEvidence {
  const evidence: PharmacyDemoEvidence = {
    version: PHARMACY_DEMO_VERSION,
    target: {
      environment: 'disposable',
      targetKey: 'unit-only',
      organizationId: 'unit-org',
      branchId: 'unit-branch',
      ownerUserId: 'unit-owner',
      vertical: 'PHARMACY',
      currency: 'PKR',
      timezone: 'Asia/Karachi',
      businessDate: '2026-09-07',
      scenarioAt: '2026-09-07T07:00:00.000Z',
      namespace: '',
    },
    observed: {
      environment: 'disposable',
      targetKey: 'unit-only',
      observedAt: '2026-09-07T06:55:00.000Z',
      organizationId: 'unit-org',
      vertical: 'PHARMACY',
      organizationActive: true,
      branchId: 'unit-branch',
      branchActive: true,
      currency: 'PKR',
      timezone: 'Asia/Karachi',
      owners: [
        {
          userId: 'unit-owner',
          email: 'owner@chaichowk.pk',
          active: true,
          role: 'ADMIN',
          branchIds: ['unit-branch'],
          capabilities: ['reports:operational', 'reports:financial'],
        },
      ],
      runtimeRole: { superuser: false, bypassRls: false, forceRls: true },
      schemaSha256: SCHEMA_SHA256,
      migrationsSha256: MIGRATIONS_SHA256,
      migrationCount: 106,
      actors: [],
      references: [],
      modules: [],
    },
    history: {
      namespace: '',
      receiptPresent: false,
      tombstonePresent: false,
      namespaceRecordCount: 0,
    },
    confirmation: {
      workspaceConfirmed: true,
      approvalReference: 'unit-not-live-approval',
      evidenceDigest: '',
      expiresAt: '2026-09-07T07:30:00.000Z',
    },
  };
  evidence.target.namespace = targetNamespace(evidence.target);
  evidence.history.namespace = evidence.target.namespace;
  evidence.confirmation.evidenceDigest = evidenceDigest(evidence);
  return evidence;
}
function reject(evidence: unknown, code: string) {
  assert.throws(
    () => dryRun(evidence, NOW),
    (error: unknown) => error instanceof PharmacyDemoRefusal && error.code === code
  );
}
function restamp(evidence: PharmacyDemoEvidence) {
  evidence.confirmation.evidenceDigest = evidenceDigest(evidence);
}

test('valid evidence yields deterministic zero-write coverage without mutating input', () => {
  const evidence = fixture();
  const before = structuredClone(evidence);
  const result = dryRun(evidence, NOW);
  assert.deepEqual(evidence, before);
  assert.deepEqual(result, dryRun(evidence, NOW));
  assert.equal(result.liveTargetVerified, false);
  assert.equal(result.applyEnabled, false);
  assert.equal(result.writes, 0);
  assert.equal(result.plannedRecords, 0);
  assert.equal(result.coverage.length, 10);
  assert.equal(result.receipt.seedReceipt, false);
  assert.ok(result.coverage.every((item) => ['OWNER-INPUT', 'UNSEEDED'].includes(item.status)));
  assert.equal(result.applyBlockers.length, 5);
  assert.deepEqual(result.unmetPrerequisites, {
    references: ['medicine', 'presentation', 'pack', 'location', 'supplier'],
    modules: ['pharmacy-inventory', 'pharmacy-reports'],
    syntheticActors: 'OWNER-INPUT',
  });
});

for (const environment of ['lan', 'azure-staging'] as const) {
  test(`${environment} accepts only matching offline evidence, never live verification`, () => {
    const e = fixture();
    e.target.environment = e.observed.environment = environment;
    e.target.namespace = e.history.namespace = targetNamespace(e.target);
    restamp(e);
    const result = dryRun(e, NOW);
    assert.equal(result.liveTargetVerified, false);
    assert.equal(result.applyEnabled, false);
  });
}

test('independent simultaneous dry-runs produce equal reports, not database concurrency proof', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, async () => dryRun(fixture(), NOW)));
  for (const result of results) assert.deepEqual(result, results[0]);
});

const mutations: [string, (e: PharmacyDemoEvidence) => void, string][] = [
  [
    'Restaurant',
    (e) => Object.assign(e.target, { vertical: 'RESTAURANT' }),
    'APPROVED_PHARMACY_REQUIRED',
  ],
  [
    'absent Pharmacy',
    (e) => Object.assign(e.observed, { organizationActive: false }),
    'APPROVED_PHARMACY_REQUIRED',
  ],
  [
    'unconfirmed workspace',
    (e) => Object.assign(e.confirmation, { workspaceConfirmed: false }),
    'WORKSPACE_UNCONFIRMED',
  ],
  [
    'missing owner',
    (e) => {
      e.observed.owners = [];
    },
    'OWNER_MISSING_OR_AMBIGUOUS',
  ],
  [
    'ambiguous owner',
    (e) => {
      e.observed.owners.push(e.observed.owners[0]);
    },
    'OWNER_MISSING_OR_AMBIGUOUS',
  ],
  [
    'wrong owner',
    (e) => {
      e.observed.owners[0].userId = 'other-owner';
    },
    'EXISTING_OWNER_REQUIRED',
  ],
  [
    'inactive owner',
    (e) => Object.assign(e.observed.owners[0], { active: false }),
    'EXISTING_OWNER_REQUIRED',
  ],
  [
    'wrong role',
    (e) => Object.assign(e.observed.owners[0], { role: 'MANAGER' }),
    'EXISTING_OWNER_REQUIRED',
  ],
  [
    'wrong email',
    (e) => Object.assign(e.observed.owners[0], { email: 'unapproved@example.invalid' }),
    'EXISTING_OWNER_REQUIRED',
  ],
  [
    'unassigned branch',
    (e) => {
      e.observed.owners[0].branchIds = [];
    },
    'OWNER_BRANCH_UNASSIGNED',
  ],
  [
    'inactive branch',
    (e) => Object.assign(e.observed, { branchActive: false }),
    'ACTIVE_BRANCH_REQUIRED',
  ],
  [
    'wrong tenant',
    (e) => {
      e.observed.organizationId = 'other-org';
    },
    'TARGET_OBSERVATION_MISMATCH',
  ],
  [
    'wrong branch',
    (e) => {
      e.observed.branchId = 'other-branch';
    },
    'TARGET_OBSERVATION_MISMATCH',
  ],
  [
    'wrong currency',
    (e) => {
      Object.assign(e.target, { currency: 'USD' });
      Object.assign(e.observed, { currency: 'USD' });
    },
    'CURRENCY_MISMATCH',
  ],
  [
    'timezone mismatch',
    (e) => {
      e.observed.timezone = 'UTC';
    },
    'TARGET_OBSERVATION_MISMATCH',
  ],
  [
    'invalid timezone',
    (e) => {
      e.observed.timezone = e.target.timezone = 'Invalid/Zone';
    },
    'INVALID_TIMEZONE',
  ],
  [
    'date mismatch',
    (e) => {
      e.target.businessDate = '2026-09-08';
    },
    'BUSINESS_DATE_MISMATCH',
  ],
  [
    'impossible instant',
    (e) => {
      e.target.scenarioAt = '2026-02-30T07:00:00.000Z';
    },
    'INVALID_INSTANT',
  ],
  [
    'schema mismatch',
    (e) => {
      e.observed.schemaSha256 = '0'.repeat(64);
    },
    'SCHEMA_MISMATCH',
  ],
  [
    'migration mismatch',
    (e) => {
      e.observed.migrationsSha256 = '0'.repeat(64);
    },
    'SCHEMA_MISMATCH',
  ],
  ['migration count', (e) => Object.assign(e.observed, { migrationCount: 105 }), 'SCHEMA_MISMATCH'],
  [
    'superuser',
    (e) => Object.assign(e.observed.runtimeRole, { superuser: true }),
    'UNSAFE_RUNTIME_ROLE',
  ],
  [
    'bypass RLS',
    (e) => Object.assign(e.observed.runtimeRole, { bypassRls: true }),
    'UNSAFE_RUNTIME_ROLE',
  ],
  [
    'non-forced RLS',
    (e) => Object.assign(e.observed.runtimeRole, { forceRls: false }),
    'UNSAFE_RUNTIME_ROLE',
  ],
  [
    'missing capabilities',
    (e) => {
      e.observed.owners[0].capabilities = [];
    },
    'OWNER_CAPABILITY_MISSING',
  ],
  [
    'production',
    (e) => Object.assign(e.target, { environment: 'production' }),
    'UNSAFE_ENVIRONMENT',
  ],
  [
    'environment mismatch',
    (e) => {
      e.observed.environment = 'lan';
    },
    'UNSAFE_ENVIRONMENT',
  ],
  [
    'target mismatch',
    (e) => {
      e.observed.targetKey = 'other-target';
    },
    'TARGET_OBSERVATION_MISMATCH',
  ],
  [
    'expired',
    (e) => {
      e.confirmation.expiresAt = NOW.toISOString();
    },
    'EXPIRED_OR_UNBOUNDED_CONFIRMATION',
  ],
  [
    'unbounded approval',
    (e) => {
      e.confirmation.expiresAt = '2026-09-08T07:00:00.000Z';
    },
    'EXPIRED_OR_UNBOUNDED_CONFIRMATION',
  ],
  [
    'stale observations',
    (e) => {
      e.observed.observedAt = '2026-09-07T05:00:00.000Z';
    },
    'STALE_OBSERVATION',
  ],
  [
    'future observations',
    (e) => {
      e.observed.observedAt = '2026-09-07T07:01:00.000Z';
    },
    'STALE_OBSERVATION',
  ],
  [
    'namespace drift',
    (e) => {
      e.target.namespace = e.history.namespace = 'phdemo_renamed_';
    },
    'NAMESPACE_MISMATCH',
  ],
  [
    'unknown field',
    (e) => Object.assign(e.target, { password: 'unit-sensitive-sentinel' }),
    'INVALID_EVIDENCE_KEYS',
  ],
  [
    'missing field',
    (e) => {
      Reflect.deleteProperty(e.observed, 'owners');
    },
    'INVALID_EVIDENCE_KEYS',
  ],
  [
    'duplicate capability',
    (e) => {
      e.observed.owners[0].capabilities.push('reports:financial');
    },
    'AMBIGUOUS_EVIDENCE',
  ],
  [
    'duplicate module',
    (e) => {
      e.observed.modules = [
        { key: 'pharmacy-inventory', enabled: true },
        { key: 'pharmacy-inventory', enabled: false },
      ];
    },
    'AMBIGUOUS_MODULES',
  ],
  [
    'wrong actor scope',
    (e) => {
      e.observed.actors = [
        {
          userId: 'unit-actor-user',
          actorId: 'unit-actor',
          organizationId: 'other-org',
          branchId: e.target.branchId,
          active: true,
          synthetic: true,
          capabilities: [],
        },
      ];
    },
    'SYNTHETIC_ACTOR_PREREQUISITE',
  ],
  [
    'wrong reference scope',
    (e) => {
      e.observed.references = [
        {
          kind: 'supplier',
          id: 'unit-supplier',
          organizationId: 'other-org',
          branchId: e.target.branchId,
          approved: true,
          observedHash: '0'.repeat(64),
        },
      ];
    },
    'REFERENCE_PREREQUISITE',
  ],
];
for (const [name, mutate, code] of mutations) {
  test(`refuses ${name}`, () => {
    const e = fixture();
    mutate(e);
    restamp(e);
    reject(e, code);
  });
}

test('changed evidence requires a new digest', () => {
  const e = fixture();
  e.target.businessDate = '2026-09-06';
  e.target.scenarioAt = '2026-09-06T07:00:00.000Z';
  reject(e, 'CONFIRMATION_DIGEST_MISMATCH');
});
test('canonical digest ignores object key order, binds history and observation facts', () => {
  const e = fixture();
  assert.equal(
    evidenceDigest(e),
    evidenceDigest({
      history: e.history,
      observed: e.observed,
      target: e.target,
      version: e.version,
    })
  );
  const before = evidenceDigest(e);
  e.history.namespaceRecordCount = 1;
  assert.notEqual(evidenceDigest(e), before);
});
test('namespace does not rotate with owner or business date', () => {
  const e = fixture();
  const before = targetNamespace(e.target);
  e.target.ownerUserId = 'changed-owner';
  e.target.businessDate = '2026-09-08';
  assert.equal(targetNamespace(e.target), before);
});
for (const [receipt, tombstone, count, code] of [
  [true, false, 0, 'RECEIPT_TOMBSTONE_INCOMPLETE'],
  [false, true, 0, 'RECEIPT_TOMBSTONE_INCOMPLETE'],
  [true, true, 0, 'EXISTING_RECEIPT_RECONCILIATION_REQUIRED'],
  [false, false, 1, 'NAMESPACE_COLLISION'],
] as const) {
  test(`history ${receipt}/${tombstone}/${count} refuses before coverage`, () => {
    const e = fixture();
    Object.assign(e.history, {
      receiptPresent: receipt,
      tombstonePresent: tombstone,
      namespaceRecordCount: count,
    });
    restamp(e);
    reject(e, code);
  });
}
test('null, arrays and invalid clock refuse', () => {
  for (const value of [null, [], 'input']) reject(value, 'INVALID_EVIDENCE');
  assert.throws(() => dryRun(fixture(), new Date(NaN)), /INVALID_CLOCK/);
});
test('CLI defaults to refusal and apply refuses before any file read', async () => {
  const output: string[] = [];
  assert.equal(await main([], (s) => output.push(s)), 2);
  assert.equal(
    await main(['--apply', '--evidence', '/never-read.pharmacy-demo.json'], (s) => output.push(s)),
    2
  );
  assert.equal(await main(['--evidence', 'login.txt'], (s) => output.push(s)), 2);
  assert.deepEqual(
    output.map((s) => JSON.parse(s).code),
    ['EVIDENCE_REQUIRED', 'APPLY_DISABLED', 'NONSECRET_EVIDENCE_FILE_REQUIRED']
  );
});
test('CLI bounded file reads, redaction, symlink refusal and unchanged input', async () => {
  const root = process.env.PAPERCLIP_RUN_SCRATCH_DIR;
  assert.ok(root, 'PAPERCLIP_RUN_SCRATCH_DIR is required for owned test artifacts');
  const directory = await mkdtemp(join(root, 'pharmacy-demo-tests-'));
  const path = join(directory, 'unit.pharmacy-demo.json');
  const output: string[] = [];
  const run = (file = path) => main(['--evidence', file], (s) => output.push(s));
  try {
    const e = fixture();
    const current = new Date();
    e.observed.observedAt = current.toISOString();
    e.confirmation.expiresAt = new Date(current.getTime() + 600_000).toISOString();
    restamp(e);
    const original = JSON.stringify(e);
    await writeFile(path, original);
    assert.equal(await run(), 0);
    assert.equal(await readFile(path, 'utf8'), original);
    assert.equal(JSON.parse(output.at(-1)!).liveTargetVerified, false);
    const link = join(directory, 'link.pharmacy-demo.json');
    await symlink(path, link);
    assert.equal(await run(link), 2);
    await writeFile(path, '{unit-sensitive-sentinel');
    assert.equal(await run(), 2);
    await writeFile(path, 'x'.repeat(65_537));
    assert.equal(await run(), 2);
    assert.ok(
      output.every(
        (s) =>
          !s.includes('unit-sensitive-sentinel') &&
          !s.includes(directory) &&
          !s.includes('unit-owner')
      )
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
