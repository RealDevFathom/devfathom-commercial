const { createRequire } = require('node:module');
const fs = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const pg = createRequire(join(process.cwd(), 'package.json'))('pg');
(async () => {
  const dir = process.env.WHA1354_ENV_DIR;
  const identity = JSON.parse(fs.readFileSync(join(dir, 'identity.json')));
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  try {
    const role = (await client.query('SELECT current_database() AS database, rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.equal(role.database, identity.database);
    assert.equal(role.rolname, identity.runtime);
    for (const key of ['rolsuper', 'rolbypassrls', 'rolcreatedb', 'rolcreaterole']) assert.equal(role[key], false);
    const tables = (await client.query("SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('restaurant_branches','pharmacy_branches') ORDER BY c.relname")).rows;
    assert.equal(tables.length, 2);
    for (const table of tables) { assert.equal(table.relrowsecurity, true); assert.equal(table.relforcerowsecurity, true); assert.equal(table.owner, identity.owner); }
    const owned = (await client.query("SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)")).rows[0].count;
    assert.equal(owned, 0);
    const migrations = (await client.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations ORDER BY migration_name')).rows;
    const files = fs.readdirSync('prisma/migrations').filter(x => fs.existsSync(join('prisma/migrations', x, 'migration.sql'))).sort();
    assert.equal(migrations.length, files.length);
    for (const migration of migrations) {
      assert(migration.finished_at); assert.equal(migration.rolled_back_at, null);
      assert.equal(migration.checksum, createHash('sha256').update(fs.readFileSync(join('prisma/migrations', migration.migration_name, 'migration.sql'))).digest('hex'));
    }
    const report = JSON.parse(fs.readFileSync(join(dir, 'receipt-db-tests.json')));
    assert.equal(report.numPassedTests, 4); assert.equal(report.numFailedTests, 0); assert.equal(report.numPendingTests, 0);
    const result = { role, tables, runtimeOwnedApplicationTables: owned, migrationCount: migrations.length, checksumMismatches: 0, unsuccessfulMigrations: 0, tests: { passed: 4, failed: 0, pending: 0, tenants: 2, restaurantBranches: 3 }, pharmacyAdapterVerified: false };
    fs.writeFileSync(join(dir, 'evidence.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    for (const file of fs.readdirSync(dir)) fs.chmodSync(join(dir,file), 0o600);
    console.log(JSON.stringify(result));
  } finally { await client.end(); }
})().catch(e => { console.error(e.code || e.name, e.message); process.exitCode = 1; });
