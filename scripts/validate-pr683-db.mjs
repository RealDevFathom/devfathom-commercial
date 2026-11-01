/** Disposable local DB acceptance. Never logs URLs or child output containing credentials. */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import pg from 'pg';
import dotenv from 'dotenv';

const root = resolve(import.meta.dirname, '..');
const local = {};
for (const file of ['.env', '.env.local']) {
  try {
    Object.assign(local, dotenv.parse(readFileSync(join(root, file))));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}
const adminUrl = process.env.DATABASE_URL || local.DATABASE_URL;
if (!adminUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(adminUrl).hostname)) {
  throw new Error('A loopback DATABASE_URL admin is required for disposable setup.');
}
const suffix = randomBytes(8).toString('hex');
const database = `pr683_${suffix}`;
const app = `${database}_app`;
const owner = `${database}_fixture`;
const password = randomBytes(32).toString('hex');
const secrets = [adminUrl, password, new URL(adminUrl).password].filter(Boolean);
const safe = (value) => {
  let text = String(value).replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, '[redacted database URL]');
  for (const secret of secrets) text = text.split(secret).join('[redacted]');
  return text;
};
const temp = mkdtempSync(join(tmpdir(), 'pr683-validation-'));
const base = { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' };
// Do not pass inherited privileged URLs into test workers.
for (const key of Object.keys(base)) if (/DATABASE_URL/.test(key)) delete base[key];
async function run(bin, args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    // Buffer complete lines so a URL split across chunks cannot evade redaction.
    for (const [source, target] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      let pending = '';
      source.on('data', (chunk) => {
        pending += chunk.toString();
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) target.write(safe(line) + '\n');
      });
      source.on('end', () => {
        if (pending) target.write(safe(pending));
      });
    }
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} validation failed (exit ${code})`))
    );
  });
}
function url(role, credential) {
  const u = new URL(adminUrl);
  u.pathname = `/${database}`;
  u.username = role;
  u.password = credential;
  u.searchParams.delete('options');
  return u.toString();
}
const control = new pg.Client({ connectionString: adminUrl });
let migration;
let proxy;
const clones = [];
const extraRoles = [];
try {
  await control.connect();
  await control.query(
    `CREATE ROLE "${owner}" LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE PASSWORD '${password}'`
  );
  await control.query(
    `CREATE ROLE "${app}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD '${password}'`
  );
  await control.query(`GRANT "${app}" TO "${owner}"`);
  await control.query(`CREATE DATABASE "${database}"`);
  const elevated = new URL(adminUrl);
  elevated.pathname = `/${database}`;
  migration = new pg.Client({ connectionString: elevated.toString() });
  await migration.connect();
  await migration.query(readFileSync(join(root, 'prisma/prepare-extensions.sql'), 'utf8'));
  const config = join(temp, 'prisma.config.ts');
  writeFileSync(
    config,
    `export default {schema:${JSON.stringify(join(root, 'prisma/schema.prisma'))},migrations:{path:${JSON.stringify(join(root, 'prisma/migrations'))}},datasource:{url:process.env.MIGRATION_DATABASE_URL}};\n`
  );
  await run(join(root, 'node_modules/.bin/prisma'), ['migrate', 'deploy', '--config', config], {
    ...base,
    DATABASE_URL: elevated.toString(),
    MIGRATION_DATABASE_URL: elevated.toString(),
  });
  const {
    rows: [history],
  } = await migration.query(
    'SELECT count(*)::int AS total, count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS unfinished FROM _prisma_migrations'
  );
  if (history.unfinished) throw new Error('Unfinished migrations remain');
  console.log(
    `Fresh migration replay: ${history.total} applied; ${history.unfinished} unfinished.`
  );
  // Restricted fixture owner may replay DDL in tests; runtime owns no tables.
  await migration.query(
    `GRANT USAGE, CREATE ON SCHEMA public TO "${owner}"; GRANT USAGE ON SCHEMA public TO "${app}"`
  );
  const objects =
    await migration.query(`SELECT 'ALTER TABLE ' || quote_ident(n.nspname)||'.'||quote_ident(c.relname)||' OWNER TO "${owner}"' AS sql FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype='e')
  UNION ALL SELECT 'ALTER FUNCTION '||p.oid::regprocedure||' OWNER TO "${owner}"' FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')`);
  for (const row of objects.rows) await migration.query(row.sql);
  await migration.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${app}"; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${app}"; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO "${app}", "${owner}"`
  );
  await migration.query(
    `GRANT EXECUTE ON FUNCTION public.similarity_op(text,text) TO "${owner}" WITH GRANT OPTION`
  );
  await migration.end();
  migration = undefined;
  // From this point the admin is used only for teardown, never by validation.
  const runtimeUrl = url(app, password);
  const ownerUrl = url(owner, password);
  const probe = new pg.Client({ connectionString: runtimeUrl });
  await probe.connect();
  const {
    rows: [role],
  } = await probe.query(
    'SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname=current_user'
  );
  await probe.end();
  if (Object.values(role).some(Boolean)) throw new Error('Runtime role is elevated');
  console.log('Runtime login: NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB.');
  const env = { ...base, DATABASE_URL: runtimeUrl, TEST_DATABASE_URL: runtimeUrl };
  const files = spawnSync('git', ['diff', '--name-only', 'origin/develop'], {
    cwd: root,
    encoding: 'utf8',
  })
    .stdout.trim()
    .split('\n')
    .filter((f) => /\.test\.[jt]sx?$/.test(f));
  const all = spawnSync('rg', ['--files', 'src', 'tests'], { cwd: root, encoding: 'utf8' })
    .stdout.trim()
    .split('\n');
  const pharmacy = all.filter(
    (f) =>
      /pharmacy/.test(f) &&
      /\.test\.tsx?$/.test(f) &&
      (/\.db\.test\.tsx?$/.test(f) ||
        /process\.env\.[A-Z0-9_]*DATABASE_URL/.test(readFileSync(join(root, f), 'utf8')))
  );
  const selected = [...new Set([...files, ...pharmacy])].sort();
  // Discover suite-specific URL aliases without reading any private environment files.
  for (const file of selected) {
    const source = readFileSync(join(root, file), 'utf8');
    for (const [, key] of source.matchAll(/process\.env\.([A-Z0-9_]*DATABASE_URL)/g)) {
      env[key] = /OWNER/.test(key) ? ownerUrl : runtimeUrl;
    }
  }
  // Dedicated clones keep global worker queues and fixed read-only fixtures separate.
  async function clone(name) {
    const nameWithSuffix = `${name}_${clones.length}_${suffix}`;
    await control.query(`CREATE DATABASE "${nameWithSuffix}" TEMPLATE "${database}"`);
    clones.push(nameWithSuffix);
    const target = new URL(runtimeUrl);
    target.pathname = `/${nameWithSuffix}`;
    return target;
  }
  for (const key of Object.keys(env).filter(
    (k) => /DATABASE_URL/.test(k) && /CAMERA|COLDCHAIN|COUNTER_EVIDENCE|RECEIPT_TEST/.test(k)
  )) {
    env[key] = (
      await clone(key.includes('RECEIPT') ? 'wha1364_disposable' : 'camera_disposable')
    ).toString();
  }
  const repeat = await clone('repeat_disposable');
  const reader = `${database}_reader`;
  extraRoles.push(reader);
  await control.query(
    `CREATE ROLE "${reader}" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD '${password}'`
  );
  const repeatOwner = new URL(adminUrl);
  repeatOwner.pathname = repeat.pathname;
  const fixture = new pg.Client({ connectionString: repeatOwner.toString() });
  await fixture.connect();
  await fixture.query("SELECT set_config('app.is_platform_admin','true',false)");
  await fixture.query(
    `INSERT INTO organizations(id,slug,"legalName","displayName",status,vertical,"updatedAt") VALUES ('org_a','org-a','Synthetic','Synthetic','ACTIVE','PHARMACY',now()),('org_b','org-b','Synthetic','Synthetic','ACTIVE','PHARMACY',now())`
  );
  await fixture.query(
    readFileSync(join(root, 'src/lib/pharmacy/repeat-purchasing.fixture.sql'), 'utf8')
  );
  await fixture.query(
    `GRANT USAGE ON SCHEMA public TO "${reader}"; GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${reader}"; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO "${reader}"`
  );
  await fixture.end();
  repeat.username = reader;
  env.PHARMACY_REPEAT_PURCHASING_TEST_DATABASE_URL = repeat.toString();
  // The return/refund acceptance suite reserves a loopback 556xx slot.
  const returnDb = await clone('returns_disposable');
  const upstream = new URL(adminUrl);
  proxy = net.createServer((socket) => {
    const upstreamSocket = net.connect(Number(upstream.port || 5432), upstream.hostname);
    socket.pipe(upstreamSocket).pipe(socket);
    socket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.on('error', () => socket.destroy());
  });
  let reservedPort;
  for (let port = 55600; port <= 55699; port++) {
    const available = await new Promise((resolve, reject) => {
      const onError = (error) => (error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
      proxy.once('error', onError);
      proxy.listen(port, '127.0.0.1', () => {
        proxy.removeListener('error', onError);
        resolve(true);
      });
    });
    if (available) {
      reservedPort = port;
      break;
    }
  }
  if (!reservedPort) throw new Error('No free reserved loopback port');
  returnDb.hostname = '127.0.0.1';
  returnDb.port = String(reservedPort);
  env.PHARMACY_E2E_DATABASE_URL = returnDb.toString();
  env.M8_TEST_OWNER_DATABASE_URL = ownerUrl;
  env.PHARMACY_E2E = '1';
  env.PLATFORM_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  env.PAPERCLIP_RUN_SCRATCH_DIR = temp;
  console.log(`Selected ${selected.length} changed/pharmacy Vitest files.`);
  await run(
    join(root, 'node_modules/.bin/vitest'),
    [
      'run',
      '--maxWorkers=4',
      '--testTimeout=30000',
      '--hookTimeout=60000',
      ...selected,
      ...process.argv.slice(2),
    ],
    env
  );
  const finalProbe = new pg.Client({ connectionString: ownerUrl });
  await finalProbe.connect();
  try {
    const {
      rows: [state],
    } = await finalProbe.query(
      'SELECT count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::int AS unfinished FROM _prisma_migrations'
    );
    if (state.unfinished) throw new Error('Test replay left unfinished migrations');
    console.log('Post-validation unfinished migrations: 0.');
  } finally {
    await finalProbe.end();
  }
} catch (error) {
  console.error(safe(error.message));
  process.exitCode = 1;
} finally {
  if (migration) await migration.end().catch(() => {});
  if (proxy) proxy.close();
  for (const name of clones)
    await control.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
  for (const role of extraRoles)
    await control.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
  await control.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
  await control.query(`DROP ROLE IF EXISTS "${app}"`).catch(() => {});
  await control.query(`DROP ROLE IF EXISTS "${owner}"`).catch(() => {});
  await control.end().catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}
