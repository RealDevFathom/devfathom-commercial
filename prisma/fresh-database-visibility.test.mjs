import { enforced, withEnforcement } from './fk-test-premises.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { policyScope, proveVisibility, schemaInventory } from './fresh-database-observer.js';
import { verifyFreshDatabaseSource } from './fresh-database.js';
const root = new URL('../', import.meta.url).pathname;
const platform = "(current_setting('app.is_platform_admin'::text, true) = 'true'::text)";
const organization = `("organizationId" = NULLIF(current_setting('app.current_organization_id'::text, true), ''::text))`;
const policy = (using) => ({
  name: 'read',
  command: 'r',
  permissive: true,
  roles: ['public'],
  using,
  check: null,
});
const column = (name) => ({ name, type: 'text', nullable: false });
const table = (name, using, foreignKeys = []) => ({
  name,
  columns: [column('id'), column('organizationId')],
  primaryKey: ['id'],
  foreignKeys: foreignKeys.map((f, i) => enforced(name, f, i)),
  rls: true,
  force: true,
  owner: 'migration_owner',
  select: true,
  policies: [policy(using)],
});
const fk = (table, columns = ['organizationId'], references = ['id']) => ({
  table,
  columns,
  references,
  validated: true,
});
const anchors = () => [
  table('organizations', `(${platform} OR ${organization.replace('"organizationId"', 'id')})`),
  table('restaurant_branches', `(${platform} OR ${organization})`),
];
const descendants = () => [
  table('pharmacy_migration_sources', organization, [fk('organizations')]),
  {
    ...table('pharmacy_migration_batches', organization, [
      fk('pharmacy_migration_sources', ['organizationId', 'sourceId'], ['organizationId', 'id']),
    ]),
    columns: [column('id'), column('organizationId'), column('sourceId')],
  },
  {
    ...table('pharmacy_migration_rows', organization, [
      fk('pharmacy_migration_batches', ['organizationId', 'batchId'], ['organizationId', 'id']),
    ]),
    columns: [column('id'), column('organizationId'), column('batchId')],
  },
  {
    ...table('pharmacy_migration_exceptions', organization, [
      fk('pharmacy_migration_batches', ['organizationId', 'batchId'], ['organizationId', 'id']),
    ]),
    columns: [column('id'), column('organizationId'), column('batchId')],
  },
];
test('exact stored jurisdiction literal true is global, without policy normalization', () => {
  const t = table('pharmacy_jurisdiction_rule_sets', 'true');
  t.columns = [column('id')];
  t.policies[0].name = 'jurisdiction_rules_read';
  assert.equal(policyScope(t), 'global');
  for (const using of [
    'TRUE',
    ' true',
    'true ',
    '(true)',
    "'true'",
    'true::boolean',
    'true OR false',
    null,
  ])
    assert.throws(() => policyScope({ ...t, policies: [policy(using)] }));
  assert.equal(
    policyScope({ ...t, policies: [{ ...policy('true'), roles: ['devfathom_app'] }] }),
    'global'
  );
});
test('global true rejects noncovering policies and unsafe table posture', () => {
  assert.throws(() => policyScope(table('users', 'true')));
  const t = table('pharmacy_jurisdiction_rule_sets', 'true');
  t.columns = [column('id')];
  for (const policies of [
    [],
    [{ ...policy('true'), permissive: false }],
    [{ ...policy('true'), roles: ['another_role'] }],
    [{ ...policy('true'), roles: [] }],
    [policy('true'), { ...policy('false'), permissive: false }],
    [{ ...policy('true'), command: 'a' }],
  ])
    assert.throws(() => policyScope({ ...t, policies }));
  for (const delta of [{ force: false }, { select: false }, { owner: 'devfathom_app' }])
    assert.throws(() => policyScope({ ...t, ...delta }));
  // Write-only policy cannot hide SELECT rows, including an inapplicable restrictive policy.
  assert.equal(
    policyScope({
      ...t,
      policies: [
        policy('true'),
        { ...policy('false'), command: 'a', permissive: false, roles: ['another_role'] },
      ],
    }),
    'global'
  );
  assert.equal(policyScope({ ...t, policies: [{ ...policy('true'), command: '*' }] }), 'global');
});
test('v2 adversarial literals, quoted identifiers and grouping remain rejected', () => {
  const t = table('sample', `(${platform} OR ${organization})`);
  for (const using of [
    t.policies[0].using.replace("'true'", "'TRUE'"),
    t.policies[0].using.replace("'true'", "'tr ue'"),
    t.policies[0].using.replace('"organizationId"', '"OrganizationId"'),
    t.policies[0].using.slice(1, -1),
  ])
    assert.throws(() => policyScope({ ...t, policies: [policy(using)] }));
});
test('validated nonnull tenant anchor proves descendants; absent/unvalidated/nullable/misdirected anchor refuses', () => {
  const good = [...anchors(), ...descendants()];
  assert.equal(proveVisibility(good).get('pharmacy_migration_sources'), 'organization');
  assert.equal(proveVisibility(good).get('pharmacy_migration_exceptions'), 'organization');
  for (const edit of [
    (t) => (t.foreignKeys = []),
    (t) => (t.foreignKeys[0].validated = false),
    (t) => (t.columns[1].nullable = true),
    (t) => (t.foreignKeys[0].references = ['slug']),
    (t) => (t.foreignKeys[0].table = 'missing'),
  ]) {
    const changed = structuredClone(good);
    edit(changed[2]);
    assert.throws(() => proveVisibility(changed));
  }
});
test('new source relation and additive migration preserve immutable evidence without orphan repair', () => {
  const schema = readFileSync(new URL('schema.prisma', import.meta.url), 'utf8');
  const model = /model PharmacyMigrationSource \{([\s\S]*?)\n\}/.exec(schema)[1];
  assert.match(
    model,
    /organization\s+Organization\s+@relation\(fields: \[organizationId\], references: \[id\], onDelete: Restrict, onUpdate: Restrict\)/
  );
  assert.match(schema, /pharmacyMigrationSources\s+PharmacyMigrationSource\[\]/);
  const sql = readFileSync(
    new URL(
      'migrations/20261012110000_pharmacy_migration_source_tenant_anchor/migration.sql',
      import.meta.url
    ),
    'utf8'
  ).replace(/--[^\n]*/g, '');
  assert.match(
    sql,
    /FOREIGN KEY \("organizationId"\) REFERENCES "public"\."organizations"\("id"\)\s+ON DELETE RESTRICT ON UPDATE RESTRICT/
  );
  assert.match(sql, /^\s*BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.doesNotMatch(
    sql,
    /NOT VALID|DISABLE|NO FORCE|GRANT|DELETE FROM|UPDATE "|INSERT INTO|CASCADE/i
  );
  const inventory = schemaInventory(root);
  assert.equal(inventory.length, 451);
  assert.equal(inventory.find((t) => t.name === 'pharmacy_migration_sources').columns.length, 8);
});
test('proposed 127 migration manifest accepts exact source and retains historical pins', () => {
  assert.equal(verifyFreshDatabaseSource(root).length, 127);
});

test('saved 125 catalog reproduces source ancestry refusal; proposed FK closes affected four-table chain', () => {
  const { tables } = JSON.parse(
    readFileSync(new URL('fixtures/visibility-saved-125.json', import.meta.url), 'utf8')
  );
  const jurisdiction = tables.find((t) => t.name === 'pharmacy_jurisdiction_rule_sets');
  assert.equal(jurisdiction.columns.length, 13);
  assert.equal(policyScope(jurisdiction), 'global');
  assert.throws(() => proveVisibility(tables));
  const source = tables.find((t) => t.name === 'pharmacy_migration_sources');
  assert.deepEqual(source.foreignKeys, []);
  source.foreignKeys.push(enforced(source.name, fk('organizations')));
  withEnforcement(tables);
  const scopes = proveVisibility(tables);
  for (const name of [
    'pharmacy_migration_sources',
    'pharmacy_migration_batches',
    'pharmacy_migration_rows',
    'pharmacy_migration_exceptions',
  ])
    assert.equal(scopes.get(name), 'organization');
});
