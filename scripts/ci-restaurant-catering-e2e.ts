/** Own the admitted database, source receipt and app for the catering browser corpus. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { acceptanceOrigin } from './restaurant-acceptance-target';

const evidence = resolve(process.env.CI_RESERVED_EVIDENCE_DIR ?? 'gate/browser/catering');
mkdirSync(evidence, { recursive: true });
const admin = new URL(process.env.CI_RESERVED_ADMIN_DATABASE_URL ?? '');
if (admin.hostname !== '127.0.0.1' || admin.port !== '55683')
  throw new Error('Catering acceptance requires its isolated loopback PostgreSQL on port 55683.');
const database = `restaurant_growth_test_catering_${Date.now()}`;
const url = (role: string) => {
  const result = new URL(admin);
  result.pathname = '/' + database;
  result.username = role;
  return result.href;
};
function run(name: string, args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync('bunx', args, {
    env,
    stdio: [
      'ignore',
      openSync(resolve(evidence, name + '.stdout.log'), 'w'),
      openSync(resolve(evidence, name + '.stderr.log'), 'w'),
    ],
  });
  console.log(`${name}: ${result.status ?? 1}`);
  if (result.status !== 0) throw new Error(`${name} failed; inspect its retained log.`);
}
async function main() {
  if (process.env.CI_CATERING_TEMPLATE_PREPARED !== '1')
    run('prepare', ['tsx', 'scripts/ci-reserved-tests.ts'], {
      ...process.env,
      CI_RESERVED_BROWSER_ONLY: '1',
      CI_RESERVED_EVIDENCE_DIR: evidence,
    });
  const client = new pg.Client({ connectionString: admin.href });
  await client.connect();
  try {
    await client.query(
      `CREATE DATABASE "${database}" TEMPLATE reserved_template_test OWNER restaurant_acceptance_owner`
    );
  } finally {
    await client.end();
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: url('restaurant_acceptance_runtime'),
    TEST_DATABASE_URL: url('restaurant_acceptance_runtime'),
    RESTAURANT_E2E_DATABASE_URL: url('restaurant_acceptance_runtime'),
    MIGRATION_DATABASE_URL: url('restaurant_acceptance_owner'),
    RESTAURANT_ACTOR_OWNER_DATABASE_URL: url('restaurant_acceptance_owner'),
    RESTAURANT_ACTOR_RUNTIME_DATABASE_URL: url('restaurant_acceptance_runtime'),
    RESTAURANT_INTEGRATED_E2E: '1',
    DEFAULT_ORGANIZATION_ID: 'org_chai_chowk',
    AUTH_URL: acceptanceOrigin,
    AUTH_TRUST_HOST: 'true',
    CLIENT_IP_HEADER: '',
    NODE_ENV: 'test',
    RESTAURANT_E2E_RELAX_TERMINAL_FLOOD_LIMITS: '1',
  };
  run('seed', ['tsx', 'scripts/seed-restaurant-e2e.ts'], env);
  run('seed-replay', ['tsx', 'scripts/seed-restaurant-e2e.ts'], env);
  const runtimeRoot = resolve('restaurant-growth-completion-20261009/runtime');
  const sourceFiles = spawnSync(
    'git',
    [
      'ls-files',
      'src/lib/restaurant',
      'src/components/restaurant/catering',
      'scripts/seed-restaurant*',
      'scripts/restaurant-acceptance-target.ts',
      'scripts/ci-restaurant-catering-e2e.ts',
      'tests/e2e/restaurant-catering.spec.ts',
      'prisma',
    ],
    { encoding: 'utf8' }
  )
    .stdout.trim()
    .split('\n')
    .filter(Boolean);
  sourceFiles.push('scripts/ci-restaurant-catering-e2e.ts');
  const manifest = JSON.stringify(
    [...new Set(sourceFiles)].sort().map((file) => ({
      file,
      sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    })),
    null,
    2
  );
  const receipt = resolve(runtimeRoot, 'runs/catering/runtime.json');
  mkdirSync(resolve(receipt, '..'), { recursive: true });
  writeFileSync(resolve(runtimeRoot, 'source-manifest.json'), manifest);
  const server = spawn(process.execPath, ['scripts/start-standalone.mjs'], {
    env: {
      ...env,
      HOSTNAME: '127.0.0.1',
      PORT: '4483',
      // This CI server accepts traffic only on loopback; keep production IP validation enabled.
      TRUSTED_PROXY_CIDRS: '127.0.0.1/32,::1/128',
    },
    stdio: [
      'ignore',
      openSync(resolve(evidence, 'app.stdout.log'), 'w'),
      openSync(resolve(evidence, 'app.stderr.log'), 'w'),
    ],
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (server.exitCode !== null) throw new Error('Candidate app exited before readiness.');
      try {
        const response = await fetch('http://127.0.0.1:4483/login');
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        /* Server is starting. */
      }
      await new Promise((done) => setTimeout(done, 1000));
    }
    if (!ready || !server.pid) throw new Error('Candidate app did not become ready.');
    writeFileSync(
      receipt,
      JSON.stringify({
        environment: 'TEST_SANDBOX',
        repository: process.cwd(),
        sourceManifestSHA256: createHash('sha256').update(manifest).digest('hex'),
        database,
        databasePort: 55683,
        runtimeRole: 'restaurant_acceptance_runtime',
        ownerRole: 'restaurant_acceptance_owner',
        appOrigin: acceptanceOrigin,
        appPid: server.pid,
        buildId: readFileSync('.next/BUILD_ID', 'utf8').trim(),
        stages: ['migrate', 'app'],
      }),
      { mode: 0o600 }
    );
    run(
      'playwright',
      [
        'playwright',
        'test',
        '--config=tests/e2e/restaurant-acceptance.config.ts',
        '--project=restaurant-acceptance',
        'tests/e2e/restaurant-catering.spec.ts',
        '--workers=1',
        '--reporter=list,json',
      ],
      {
        ...env,
        PLAYWRIGHT_BASE_URL: acceptanceOrigin,
        RESTAURANT_ACCEPTANCE_ADMITTED: '1',
        RESTAURANT_ACCEPTANCE_RUNTIME_RECEIPT: receipt,
      }
    );
  } finally {
    server.kill('SIGTERM');
    await new Promise<void>((done) => {
      if (server.exitCode !== null) done();
      else server.once('exit', () => done());
    });
  }
}
main().catch(() => {
  console.error('Catering acceptance failed; inspect retained lane logs.');
  process.exitCode = 1;
});
