/** WHA-1388: ONE fresh, owned, socket-only disposable PostgreSQL reproduction.
 * Synthetic prerequisites below are TEST FIXTURES, never live regulatory approvals.
 * Run: bun --no-env-file --conditions=react-server scripts/verify-pharmacy-demo.ts
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PharmacyDraftRequest } from './pharmacy-demo-contract';
import {
  pharmacyHistoryGenesis,
  pharmacyHistoryPath,
  pharmacyMigrationManifest,
  pharmacySourceDigest,
  runDisposablePharmacyDraft,
} from './seed-pharmacy-demo';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Harness TMPDIR can exceed PostgreSQL's 103-byte socket path limit on macOS.
const retry = process.argv[2] === '--resume-initialized' ? process.argv[3] : undefined;
assert.ok(process.argv.length === 2 || (retry && process.argv.length === 4));
const directory = await realpath(retry ?? (await mkdtemp('/tmp/wha1388-pg-')));
assert.equal(dirname(directory), await realpath('/tmp'));
const database = retry
  ? await readFile(join(directory, 'cluster-id'), 'utf8')
  : `wha1388_${randomBytes(12).toString('hex')}`;
if (retry) {
  assert.ok(process.env.PAPERCLIP_RUN_ID);
  assert.equal(
    await readFile(join(directory, 'initializing-run'), 'utf8'),
    process.env.PAPERCLIP_RUN_ID
  );
  assert.equal(await readFile(join(directory, 'data/PG_VERSION'), 'utf8'), '16\n');
}
const target = { directory, database };
const socket = join(directory, 'socket');
const data = join(directory, 'data');
const role = 'wha1388_runtime';
const bootstrap = 'wha1388_bootstrap';
const environment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  NODE_ENV: 'test',
  LANG: 'en_US.UTF-8',
};
const evidence: { name: string; status: string; facts?: unknown }[] = [];
let started = false;
let failed = false;
function command(program: string, args: string[], input?: string, env = environment) {
  const result = spawnSync(program, args, {
    cwd: root,
    env,
    input,
    encoding: 'utf8',
    maxBuffer: 8_000_000,
  });
  if (result.status !== 0) {
    // All commands/inputs here target only the freshly created TEST cluster.
    writeFile(
      join(directory, 'failure-command.txt'),
      `${program}\n${result.stderr}\n${result.stdout}`,
      { mode: 0o600 }
    ).catch(() => {});
    throw new Error(`DISPOSABLE_COMMAND_FAILED:${basenameForLog(program)}:${result.status}`);
  }
  return result.stdout.trim();
}
function basenameForLog(program: string) {
  return program.split('/').at(-1);
}
function sql(query: string, user = bootstrap) {
  return command(
    'psql',
    ['-X', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-U', user, '-d', database, '-At'],
    query
  );
}
function counts() {
  return JSON.parse(
    sql(`SELECT json_build_object('orders',(SELECT count(*) FROM pharmacy_purchase_orders),
    'lines',(SELECT count(*) FROM pharmacy_purchase_order_lines),'audit',(SELECT count(*) FROM audit_logs));`)
  );
}
async function check(name: string, run: () => unknown | Promise<unknown>) {
  try {
    const facts = await run();
    evidence.push({ name, status: 'pass', facts });
    console.log(`PASS ${name}`);
  } catch (error) {
    evidence.push({ name, status: 'fail' });
    throw error;
  }
}
async function processRun(path: string) {
  return new Promise<{
    exit: number | null;
    value: { mode: string; writes: number };
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--no-env-file',
        '--conditions=react-server',
        'scripts/seed-pharmacy-demo.ts',
        '--disposable',
        path,
      ],
      { cwd: root, env: environment }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (exit) => {
      try {
        resolve({ exit, value: JSON.parse(stdout), stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}

try {
  // Do not even read any inherited connection string, password, or token.
  delete process.env.DATABASE_URL;
  if (!retry) {
    await mkdir(socket, { mode: 0o700 });
    await writeFile(join(directory, 'cluster-id'), database, { mode: 0o600, flag: 'wx' });
    await writeFile(
      join(directory, 'initializing-run'),
      process.env.PAPERCLIP_RUN_ID ?? 'standalone',
      { mode: 0o600, flag: 'wx' }
    );
  }
  const migrations = await pharmacyMigrationManifest();
  if (!retry)
    command('initdb', [
      '-D',
      data,
      '-U',
      bootstrap,
      '--auth-local=trust',
      '--auth-host=reject',
      '--no-locale',
      '--encoding=UTF8',
    ]);
  command('pg_ctl', [
    '-D',
    data,
    '-l',
    join(directory, 'postgres.log'),
    '-o',
    `-k ${socket} -c listen_addresses='' -c cluster_name=${database} -c unix_socket_permissions=0700`,
    '-w',
    'start',
  ]);
  started = true;
  const databaseExists =
    command('psql', [
      '-X',
      '-h',
      socket,
      '-U',
      bootstrap,
      '-d',
      'postgres',
      '-Atc',
      `SELECT count(*) FROM pg_database WHERE datname='${database}'`,
    ]) === '1';
  assert.ok(!databaseExists || retry, 'Only this initializing run can resume its database');
  if (!databaseExists) command('createdb', ['-h', socket, '-U', bootstrap, database]);
  const adminUrl = `postgresql://${bootstrap}@localhost/${database}?host=${encodeURIComponent(socket)}`;
  // Normal repository deployment prerequisite; no migration/ACL guard is weakened.
  command(process.execPath, ['--no-env-file', 'prisma/prepare-extensions.ts'], undefined, {
    ...environment,
    EXTENSION_ADMIN_DATABASE_URL: adminUrl,
  });
  const config = join(directory, 'prisma.config.ts');
  await writeFile(
    config,
    `export default { schema: ${JSON.stringify(join(root, 'prisma/schema.prisma'))},
    migrations: { path: ${JSON.stringify(join(root, 'prisma/migrations'))} },
    datasource: { url: process.env.DATABASE_URL } };\n`,
    { mode: 0o600 }
  );
  if (databaseExists) {
    assert.equal(
      sql(`SELECT migration_name FROM _prisma_migrations
      WHERE finished_at IS NULL AND rolled_back_at IS NULL;`),
      '20260830120000_btree_gist_public_execute_acl'
    );
    command(
      'node',
      [
        'node_modules/prisma/build/index.js',
        'migrate',
        'resolve',
        '--rolled-back',
        '20260830120000_btree_gist_public_execute_acl',
        '--config',
        config,
      ],
      undefined,
      { ...environment, DATABASE_URL: adminUrl }
    );
  }
  const migrationLog = command(
    'node',
    ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--config', config],
    undefined,
    {
      ...environment,
      DATABASE_URL: adminUrl,
    }
  );
  await writeFile(join(directory, 'migrations.log'), migrationLog, { mode: 0o600 });
  assert.equal(
    Number(sql('SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;')),
    106
  );
  evidence.push({
    name: 'normal unchanged migrations',
    status: 'pass',
    facts: { count: migrations.length, exit: 0 },
  });
  sql(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    GRANT CONNECT ON DATABASE ${database} TO ${role}; GRANT USAGE ON SCHEMA public TO ${role};
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${role};
    GRANT INSERT ON pharmacy_purchase_orders, pharmacy_purchase_order_lines, audit_logs TO ${role};
    -- PostgreSQL SHARE table locks require UPDATE privilege. Runner never issues UPDATE.
    GRANT UPDATE ON organizations,users,organization_modules,pharmacy_branches,
      pharmacy_central_purchasing_access,pharmacy_suppliers,pharmacy_supplier_licences,
      pharmacy_medicines,pharmacy_presentations,pharmacy_pack_levels TO ${role};`);
  // Bootstrap creates ONLY synthetic TEST prerequisites in this NEW database.
  sql(`INSERT INTO organizations (id,slug,"legalName","displayName",vertical,status,timezone,currency,"updatedAt") VALUES
    ('wha1388_test_org','wha1388-test','TEST FIXTURE ONLY','TEST FIXTURE ONLY','PHARMACY','ACTIVE','Asia/Karachi','PKR',now()),
    ('wha1388_foreign_org','wha1388-foreign','FOREIGN TEST FIXTURE','FOREIGN TEST FIXTURE','PHARMACY','ACTIVE','Asia/Karachi','PKR',now());
    INSERT INTO organization_departments (id,"organizationId",key,name,"updatedAt")
      VALUES ('wha1388_department','wha1388_test_org','wha1388-test-fixtures','TEST ONLY',now());
    INSERT INTO users (id,"organizationId",name,email,role,department,title,"updatedAt") VALUES
      ('wha1388_owner','wha1388_test_org','TEST OWNER','owner@wha1388.invalid','ADMIN','wha1388-test-fixtures','TEST ONLY',now()),
      ('wha1388_actor','wha1388_test_org','TEST PURCHASER','purchaser@wha1388.invalid','EMPLOYEE','wha1388-test-fixtures','TEST ONLY',now());
    INSERT INTO platform_modules (id,key,name,category,band,vertical,"updatedAt")
      VALUES ('wha1388_module','pharmacy-procurement','TEST PROCUREMENT','Pharmacy','VERTICAL_OPTIONAL','PHARMACY',now());
    INSERT INTO organization_modules (id,"organizationId","moduleId","updatedAt")
      VALUES ('wha1388_entitlement','wha1388_test_org','wha1388_module',now());
    INSERT INTO pharmacy_central_purchasing_access (id,"organizationId","userId","grantedById") VALUES
      ('wha1388_owner_access','wha1388_test_org','wha1388_owner','wha1388_owner'),
      ('wha1388_actor_access','wha1388_test_org','wha1388_actor','wha1388_owner');
    INSERT INTO pharmacy_branches (id,"organizationId",code,name,"addressLine",city,"provinceCode","updatedAt")
      SELECT 'wha1388_'||n,'wha1388_test_org',n,'TEST '||n,'TEST ONLY','TEST','PB',now()
      FROM unnest(ARRAY['happy','concurrent','rollback','missing','removed','changed','foreign']) n;
    INSERT INTO pharmacy_suppliers (id,"organizationId",name,authorized,"updatedAt")
      VALUES ('wha1388_supplier','wha1388_test_org','SYNTHETIC TEST SUPPLIER',true,now());
    INSERT INTO pharmacy_supplier_licences (id,"organizationId","supplierId","licenceType","licenceNumber","issuingAuthority","issuedAt","expiresAt","verifiedAt","verifiedByUserId")
      VALUES ('wha1388_licence','wha1388_test_org','wha1388_supplier','TEST ONLY','NOT A REAL LICENCE','SYNTHETIC TEST FIXTURE',now()-interval '1 day',now()+interval '1 day',now(),'wha1388_owner');
    INSERT INTO pharmacy_medicines (id,"organizationId","productName","productFamily",saleable,"updatedAt")
      VALUES ('wha1388_medicine','wha1388_test_org','SYNTHETIC TEST PRODUCT','FRONT_SHOP',true,now());
    INSERT INTO pharmacy_presentations (id,"organizationId","medicineId",presentation,"updatedAt")
      VALUES ('wha1388_presentation','wha1388_test_org','wha1388_medicine','SYNTHETIC TEST UNIT',now());
    INSERT INTO pharmacy_pack_levels (id,"organizationId","presentationId","versionGroupId",version,level,"unitsPerParent","effectiveFrom")
      VALUES ('wha1388_pack','wha1388_test_org','wha1388_presentation','wha1388_pack_version',1,'UNIT',1,now()-interval '1 day');`);
  const scenarioAt = new Date().toISOString();
  const baseRequest: PharmacyDraftRequest = {
    organizationId: 'wha1388_test_org',
    branchId: 'wha1388_happy',
    ownerUserId: 'wha1388_owner',
    actorUserId: 'wha1388_actor',
    supplierId: 'wha1388_supplier',
    medicineId: 'wha1388_medicine',
    presentationId: 'wha1388_presentation',
    packLevelId: 'wha1388_pack',
    scenarioAt,
    businessDate: new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Karachi',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(scenarioAt)),
    timezone: 'Asia/Karachi',
    currency: 'PKR',
  };
  const request = (name: string) => ({ ...baseRequest, branchId: `wha1388_${name}` });
  for (const name of [
    'happy',
    'concurrent',
    'rollback',
    'missing',
    'removed',
    'changed',
    'foreign',
  ]) {
    await writeFile(
      pharmacyHistoryPath(target, request(name)),
      JSON.stringify(pharmacyHistoryGenesis(target, request(name))) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
  }
  const confirm = (digest: string) => ({
    apply: { reviewedDigest: digest, expiresAt: new Date(Date.now() + 600_000).toISOString() },
  });
  const snapshot = () =>
    sql(`SELECT json_build_object(
    'users',(SELECT json_agg(json_build_array(id,"organizationId",status,role,department,"updatedAt") ORDER BY id) FROM users),
    'stock',(SELECT count(*) FROM pharmacy_inventory_lots),
    'supplier',(SELECT json_agg(json_build_array(id,authorized,active,"updatedAt") ORDER BY id) FROM pharmacy_suppliers),
    'access',(SELECT json_agg(json_build_array(id,"userId","branchId") ORDER BY id) FROM pharmacy_central_purchasing_access));`);
  const before = snapshot();
  await check('restricted runtime and cross-tenant RLS', () => {
    const observed = sql(
      `BEGIN; SELECT set_config('app.current_organization_id','wha1388_foreign_org',true);
      SELECT set_config('app.current_user_id','wha1388_actor',true);
      SELECT set_config('app.is_platform_admin','false',true);
      SELECT json_build_object('superuser',rolsuper,'bypass',rolbypassrls,
       'foreignUsers',(SELECT count(*) FROM users WHERE "organizationId"='wha1388_test_org')) FROM pg_roles WHERE rolname=current_user; ROLLBACK;`,
      role
    );
    const facts = JSON.parse(observed.split('\n').find((line) => line.startsWith('{'))!);
    assert.deepEqual(facts, { superuser: false, bypass: false, foreignUsers: 0 });
    return facts;
  });
  let happyDigest = '';
  await check('default actual database dry-run writes zero', async () => {
    const beforeCounts = counts();
    const result = await runDisposablePharmacyDraft(target, baseRequest);
    happyDigest = result.planDigest;
    assert.equal(result.mode, 'database-dry-run');
    assert.equal(result.writes, 0);
    assert.deepEqual(counts(), beforeCounts);
    return result.runtimeRole;
  });
  await check('one generated-ID draft plus atomic receipt and tombstone', async () => {
    const beforeCounts = counts();
    const result = await runDisposablePharmacyDraft(target, baseRequest, confirm(happyDigest));
    assert.equal(result.mode, 'applied');
    assert.equal(result.writes, 4);
    assert.equal(result.receipt?.rows.length, 2);
    assert.ok(
      result.receipt!.rows.every(
        (row) => !row.id.startsWith('phdemo_') && !row.id.startsWith('wha1388_')
      )
    );
    assert.deepEqual(counts(), {
      orders: beforeCounts.orders + 1,
      lines: beforeCounts.lines + 1,
      audit: beforeCounts.audit + 2,
    });
    return { writes: result.writes, mapping: result.receipt!.rows };
  });
  await check('identical replay has zero writes and unchanged operator history', async () => {
    const beforeCounts = counts();
    const history = await readFile(pharmacyHistoryPath(target, baseRequest));
    const result = await runDisposablePharmacyDraft(target, baseRequest, confirm(happyDigest));
    assert.equal(result.mode, 'replayed');
    assert.equal(result.writes, 0);
    assert.deepEqual(counts(), beforeCounts);
    assert.deepEqual(await readFile(pharmacyHistoryPath(target, baseRequest)), history);
    return { writes: 0 };
  });
  await check('changed request refused before dynamic planning', async () => {
    const beforeCounts = counts();
    await assert.rejects(
      runDisposablePharmacyDraft(target, { ...baseRequest, supplierId: 'absent' }),
      /PRIOR_PACKAGE_OR_CHANGED_REQUEST/
    );
    assert.deepEqual(counts(), beforeCounts);
  });
  await check('missing and foreign references refused', async () => {
    const beforeCounts = counts();
    await assert.rejects(
      runDisposablePharmacyDraft(target, { ...request('missing'), medicineId: 'missing' }),
      /MISSING_OR_FOREIGN_REFERENCE/
    );
    await assert.rejects(
      runDisposablePharmacyDraft(target, {
        ...request('foreign'),
        organizationId: 'wha1388_foreign_org',
      })
    );
    assert.deepEqual(counts(), beforeCounts);
  });
  await check('concurrent independent processes create one draft', async () => {
    const req = request('concurrent');
    const plan = await runDisposablePharmacyDraft(target, req);
    const path = join(directory, 'concurrent.pharmacy-demo.json');
    await writeFile(
      path,
      JSON.stringify({ target, request: req, options: confirm(plan.planDigest) }),
      { mode: 0o600 }
    );
    const beforeCounts = counts();
    const results = await Promise.all([processRun(path), processRun(path)]);
    assert.ok(results.every((result) => result.exit === 0 && result.stderr === ''));
    assert.deepEqual(results.map((result) => result.value.mode).sort(), ['applied', 'replayed']);
    assert.deepEqual(counts(), {
      orders: beforeCounts.orders + 1,
      lines: beforeCounts.lines + 1,
      audit: beforeCounts.audit + 2,
    });
    return results.map((result) => ({
      exit: result.exit,
      mode: result.value.mode,
      writes: result.value.writes,
    }));
  });
  await check('receipt permission failure rolls back service draft and line', async () => {
    const req = request('rollback');
    const plan = await runDisposablePharmacyDraft(target, req);
    const beforeCounts = counts();
    sql(`REVOKE INSERT ON audit_logs FROM ${role};`);
    try {
      await assert.rejects(
        runDisposablePharmacyDraft(target, req, confirm(plan.planDigest)),
        /permission denied|permission|access/i
      );
    } finally {
      sql(`GRANT INSERT ON audit_logs TO ${role};`);
    }
    assert.deepEqual(counts(), beforeCounts);
    await assert.rejects(runDisposablePharmacyDraft(target, req), /PARTIAL_OR_REMOVED_HISTORY/);
    return { committedOrders: 0, committedLines: 0, committedReceipts: 0, retainedIntent: true };
  });
  await check('removed database history cannot resurrect retained namespace', async () => {
    const req = request('removed');
    const plan = await runDisposablePharmacyDraft(target, req);
    const result = await runDisposablePharmacyDraft(target, req, confirm(plan.planDigest));
    sql(`DELETE FROM pharmacy_purchase_order_lines WHERE "purchaseOrderId" IN
      (SELECT id FROM pharmacy_purchase_orders WHERE "branchId"='wha1388_removed');
      DELETE FROM pharmacy_purchase_orders WHERE "branchId"='wha1388_removed';
      DELETE FROM audit_logs WHERE "targetId"='${result.namespace}';`);
    const beforeCounts = counts();
    await assert.rejects(
      runDisposablePharmacyDraft(target, req, confirm(plan.planDigest)),
      /PARTIAL_OR_REMOVED_HISTORY/
    );
    assert.deepEqual(counts(), beforeCounts);
  });
  await check('operator scalar change refuses replay without repair', async () => {
    sql(
      `UPDATE pharmacy_purchase_orders SET note='TEST OPERATOR EDIT' WHERE "branchId"='wha1388_happy';`
    );
    const beforeCounts = counts();
    await assert.rejects(
      runDisposablePharmacyDraft(target, baseRequest, confirm(happyDigest)),
      /CHANGED_OR_REMOVED_DRAFT/
    );
    assert.equal(
      sql(`SELECT note FROM pharmacy_purchase_orders WHERE "branchId"='wha1388_happy';`),
      'TEST OPERATOR EDIT'
    );
    assert.deepEqual(counts(), beforeCounts);
  });
  await check('untouched fixture identities, access, supplier and stock preserved', () =>
    assert.equal(snapshot(), before)
  );
  await check('changed prerequisite scalar refuses zero-write replay', async () => {
    const req = request('changed');
    const plan = await runDisposablePharmacyDraft(target, req);
    await runDisposablePharmacyDraft(target, req, confirm(plan.planDigest));
    sql(`UPDATE pharmacy_suppliers SET "paymentTermsDays"=3 WHERE id='wha1388_supplier';`);
    const beforeCounts = counts();
    await assert.rejects(runDisposablePharmacyDraft(target, req), /CHANGED_REFERENCE/);
    assert.deepEqual(counts(), beforeCounts);
  });
} catch (error) {
  failed = true;
  await writeFile(
    join(directory, 'failure.txt'),
    error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : 'Unknown failure',
    { mode: 0o600 }
  );
  console.error('FAIL disposable verification; inspect retained owned evidence');
} finally {
  if (Object.hasOwn(process.env, 'DATABASE_URL'))
    await (await import('../src/lib/db')).db.$disconnect();
  if (started) command('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
  const report = {
    sourceDigest: await pharmacySourceDigest(),
    sourceSha: command('git', ['rev-parse', 'HEAD']),
    target: { database, directory, stopped: started },
    testFixturesOnly: true,
    counts: {
      passed: evidence.filter((item) => item.status === 'pass').length,
      failed: failed ? 1 : 0,
    },
    exit: failed ? 1 : 0,
    evidence,
  };
  await writeFile(join(directory, 'evidence.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(JSON.stringify({ ...report, evidence: undefined }));
  process.exitCode = failed ? 1 : 0;
}
