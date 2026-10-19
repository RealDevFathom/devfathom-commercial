const { createRequire } = require('node:module');
const { mkdtempSync, writeFileSync, chmodSync, realpathSync } = require('node:fs');
const { randomBytes } = require('node:crypto');
const { join } = require('node:path');
const pg = createRequire(join(process.cwd(), 'package.json'))('pg');

(async () => {
  const adminUrl = new URL(process.env.WHA1350_ADMIN_DATABASE_URL);
  if (adminUrl.hostname !== '127.0.0.1' || adminUrl.port !== '52027') throw Error('Cluster address mismatch');
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const identity = (await admin.query("SELECT current_setting('data_directory') AS dir, inet_server_addr()::text AS host, inet_server_port() AS port, current_setting('server_version') AS version")).rows[0];
  if (realpathSync(identity.dir) !== realpathSync(process.env.WHA1350_PGDATA) || identity.host !== '127.0.0.1/32' || identity.port !== 52027 || !identity.version.startsWith('16.')) throw Error('Disposable identity mismatch');
  const suffix = randomBytes(5).toString('hex');
  const database = `wha1354_disposable_${suffix}`;
  const owner = `wha1354_owner_${suffix}`;
  const runtime = `wha1354_runtime_${suffix}`;
  const ownerPass = randomBytes(24).toString('hex');
  const runtimePass = randomBytes(24).toString('hex');
  const dir = mkdtempSync(join(process.cwd(), '.wha1354-verification-'));
  chmodSync(dir, 0o700);
  const url = (user, password) => {
    const value = new URL(adminUrl); value.username = user; value.password = password; value.pathname = `/${database}`; return value.toString();
  };
  const env = { OWNER_DATABASE_URL: url(owner, ownerPass), TEST_DATABASE_URL: url(runtime, runtimePass), DATABASE_URL: url(runtime, runtimePass), AUTH_SECRET: randomBytes(32).toString('hex'), WHA1354_ENV_DIR: dir };
  writeFileSync(join(dir, 'connections.env'), Object.entries(env).map(([k,v]) => `export ${k}='${v}'`).join('\n')+'\n', { mode: 0o600 });
  writeFileSync(join(dir, 'identity.json'), JSON.stringify({ ...identity, database, owner, runtime }, null, 2), { mode: 0o600 });
  writeFileSync(join(dir, 'migration.config.mjs'), `export default ${JSON.stringify({ schema: join(process.cwd(), 'prisma/schema.prisma'), migrations: { path: join(process.cwd(), 'prisma/migrations') } }).slice(0,-1)},datasource:{url:process.env.OWNER_DATABASE_URL}};\n`, { mode: 0o600 });
  await admin.query(`CREATE ROLE ${owner} LOGIN PASSWORD '${ownerPass}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`);
  await admin.query(`CREATE ROLE ${runtime} LOGIN PASSWORD '${runtimePass}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`);
  await admin.query(`CREATE DATABASE ${database} OWNER ${owner}`);
  await admin.query(`REVOKE ALL ON DATABASE ${database} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${database} TO ${runtime}`);
  await admin.end();
  writeFileSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR, 'environment-path'), dir);
  console.log(JSON.stringify({ directory: dir, database, host: identity.host, port: identity.port, version: identity.version, identityVerified: true }));
})().catch(e => { console.error('Provisioning failed:', e.code || e.name); process.exitCode = 1; });
