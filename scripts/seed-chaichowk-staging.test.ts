import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  explicitCapability,
  parseArguments,
  parseTarget,
  seedNamespace,
  targetDigest,
  validateConnection,
  type SeedTarget,
} from './seed-chaichowk-staging';
import { planFixtures, assertNoCollisions, verifyRows } from './chaichowk-staging-fixtures';
import type { ScopedDb } from '../src/lib/tenancy/scoped-db';

const now = new Date('2026-09-06T12:00:00.000Z');
function target(patch: Partial<SeedTarget> = {}): SeedTarget {
  return parseTarget(
    {
      environment: 'disposable',
      host: '127.0.0.1',
      port: 55482,
      database: 'chaichowk_seed_disposable_unit',
      organizationId: 'org_synthetic',
      organizationSlug: 'synthetic',
      vertical: 'RESTAURANT',
      branchId: 'branch_synthetic',
      branchCode: 'SYNTHETIC',
      ownerUserId: 'owner_synthetic',
      email: 'owner@chaichowk.pk',
      currency: 'PKR',
      timezone: 'Asia/Karachi',
      businessDate: '2026-09-06',
      scenarioAt: '2026-09-06T12:00:00.000Z',
      approvalReference: 'unit-test-only',
      expiresAt: '2026-09-06T13:00:00.000Z',
      ...patch,
    },
    now
  );
}
const url =
  'postgresql://restricted:synthetic-unit-secret@127.0.0.1:55482/chaichowk_seed_disposable_unit';

test('CLI defaults to dry-run and rejects partial/extra apply flags', () => {
  assert.equal(parseArguments(['--target', 'approved.json']).apply, false);
  for (const args of [
    [],
    ['--apply'],
    ['--target', 'a', '--apply'],
    ['--target', 'a', '--apply', '--confirm', 'yes'],
    ['--target', 'a', '--force'],
  ])
    assert.throws(() => parseArguments(args));
  assert.equal(
    parseArguments(['--target', 'a', '--apply', '--confirm', targetDigest(target())]).apply,
    true
  );
});
test('approval binds all target fields and namespace remains stable across dates', () => {
  const first = target();
  const renewed = target({ approvalReference: 'renewed' });
  assert.notEqual(targetDigest(first), targetDigest(renewed));
  assert.equal(seedNamespace(first), seedNamespace(renewed));
  assert.notEqual(seedNamespace(first), seedNamespace(target({ organizationId: 'org_foreign' })));
  assert.notEqual(seedNamespace(first), seedNamespace(target({ branchId: 'branch_foreign' })));
});
test('classification, expiry, unknown fields and invalid dates fail closed', () => {
  for (const patch of [
    { vertical: 'PHARMACY' },
    { email: 'other@example.test' },
    { currency: 'USD' },
    { businessDate: '2026-02-30' },
    { expiresAt: now.toISOString() },
    { expiresAt: '2027-01-01' },
    { timezone: 'invalid' },
    { extra: true },
    { port: 5432 },
    { host: 'staging.example.test' },
    { database: 'existing_data' },
  ])
    assert.throws(() => parseTarget({ ...target(), ...patch }, now));
  assert.throws(() => target({ environment: 'staging', host: 'production.example.test' }));
});
test('connection fencing rejects foreign tenants’ targets, competing URLs and startup overrides without exposing secrets', () => {
  assert.equal(validateConnection(target(), { CHAICHOWK_SEED_DATABASE_URL: url }), url);
  for (const bad of [
    url.replace('55482', '55483'),
    url.replace('_unit', '_foreign'),
    url + '?options=-c%20app.is_platform_admin=true',
    url + '?host=foreign',
    'not-a-url-secret',
    url + '#fragment',
  ]) {
    assert.throws(
      () => validateConnection(target(), { CHAICHOWK_SEED_DATABASE_URL: bad }),
      (error: Error) =>
        !error.message.includes('synthetic-unit-secret') &&
        !error.message.includes('not-a-url-secret')
    );
  }
  assert.throws(() =>
    validateConnection(target(), {
      CHAICHOWK_SEED_DATABASE_URL: url,
      DATABASE_URL: url.replace('55482', '55483'),
    })
  );
  assert.throws(() =>
    validateConnection(target(), {
      CHAICHOWK_SEED_DATABASE_URL: url,
      PGOPTIONS: '-c role=postgres',
    })
  );
});
test('staging requires exact approved endpoint and verified TLS', () => {
  const t = target({
    environment: 'staging',
    host: 'approved-staging.example.test',
    database: 'approved_staging',
    port: 5432,
  });
  const stagingUrl =
    'postgresql://restricted:unit-secret@approved-staging.example.test:5432/approved_staging';
  assert.throws(() => validateConnection(t, { CHAICHOWK_SEED_DATABASE_URL: stagingUrl }));
  assert.throws(() =>
    validateConnection(t, {
      CHAICHOWK_SEED_DATABASE_URL: stagingUrl + '?sslmode=verify-full&sslmode=no-verify',
    })
  );
  assert.equal(
    validateConnection(t, { CHAICHOWK_SEED_DATABASE_URL: stagingUrl + '?sslmode=verify-full' }),
    stagingUrl + '?sslmode=verify-full'
  );
});
test('permission checks preserve explicit deny and override precedence without adding grants', () => {
  const allow = { capability: '*', effect: 'ALLOW' };
  const deny = { capability: 'menu:write', effect: 'DENY' };
  assert.equal(explicitCapability([allow], [deny], 'menu:write'), false);
  assert.equal(explicitCapability([allow, deny], [], 'menu:write'), false);
  assert.equal(explicitCapability([deny], [{ ...deny, effect: 'ALLOW' }], 'menu:write'), true);
  assert.equal(explicitCapability([], [], 'menu:write'), false);
  assert.equal(
    explicitCapability([{ capability: 'menu:*', effect: 'ALLOW' }], [], 'money:read'),
    false
  );
});
test('fixture plan contains no user/role, credential, financial approval or external delivery writes', () => {
  const t = target();
  const plan = planFixtures({
    target: t,
    id: (key) => seedNamespace(t) + key,
    ownerStaffProfileId: 'existing_owner_profile',
    enabled: [
      'catalog',
      'floor',
      'inventory',
      'purchasing',
      'workforce',
      'customers',
      'catering',
      'sop',
    ],
    limits: {},
  });
  assert.equal(
    plan.some((row) => row.model === 'restaurantStaffProfile' && row.data.userId),
    false
  );
  assert.equal(plan.filter((row) => row.model === 'restaurantRecipeLine').length, 3);
  assert.equal(
    plan
      .filter((row) => row.model === 'restaurantCateringOrder')
      .every((row) => row.data.status === 'DRAFT'),
    true
  );
  assert.equal(
    plan.every((row) => row.data.organizationId === t.organizationId),
    true
  );
  assert.equal(new Set(plan.map((row) => row.id)).size, plan.length);
  assert.equal(
    plan.some((row) =>
      Object.keys(row.data).some((key) =>
        /password|token|clockedIn|approvedAt|depositAmount/.test(key)
      )
    ),
    false
  );
});
test('collision and missing-row checks refuse instead of overwriting or repairing', async () => {
  let writes = 0;
  const mock = {
    restaurantProduct: {
      findFirst: async () => ({ id: 'existing' }),
      create: async () => {
        writes++;
      },
    },
  } as unknown as ScopedDb;
  await assert.rejects(
    assertNoCollisions(mock, [{ model: 'restaurantProduct', id: 'existing', data: {} }]),
    /SYNTHETIC_ID_COLLISION/
  );
  assert.equal(writes, 0);
  const missing = { restaurantProduct: { findFirst: async () => null } } as unknown as ScopedDb;
  await assert.rejects(
    verifyRows(missing, [{ model: 'restaurantProduct', id: 'missing' }]),
    /SEED_ROW_MISSING/
  );
});
