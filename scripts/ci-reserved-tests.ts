/** Run suites whose safety contracts require their own disposable loopback database. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';

const adminUrl = new URL(process.env.CI_RESERVED_ADMIN_DATABASE_URL ?? '');
if (adminUrl.hostname !== '127.0.0.1' || !['55677', '55678', '55683'].includes(adminUrl.port)) {
  throw new Error('Reserved CI tests require an isolated loopback PostgreSQL port.');
}
const mode =
  adminUrl.port === '55683' ? 'acceptance' : adminUrl.port === '55678' ? 'boundary' : 'standard';
const ownerRole =
  mode === 'acceptance'
    ? 'restaurant_acceptance_owner'
    : mode === 'boundary'
      ? 'boundary_owner'
      : 'reserved_owner';
const runtimeRole =
  mode === 'acceptance'
    ? 'restaurant_acceptance_runtime'
    : mode === 'boundary'
      ? 'boundary_runtime'
      : 'reserved_runtime';
const roles =
  mode === 'standard' ? [ownerRole, runtimeRole, 'wha1606_runtime'] : [ownerRole, runtimeRole];
const evidence = resolve(process.env.CI_RESERVED_EVIDENCE_DIR ?? 'gate');
mkdirSync(evidence, { recursive: true });
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const databaseUrl = (database: string, username: string) => {
  const url = new URL(adminUrl);
  url.pathname = '/' + database;
  url.username = username;
  return url.href;
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
  const code = result.status ?? 1;
  console.log(`${name}: ${code}`);
  return code;
}
async function main() {
  let admin: pg.Client | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    const client = new pg.Client({ connectionString: adminUrl.href });
    try {
      await client.connect();
      admin = client;
      break;
    } catch {
      await client.end().catch(() => {});
      await new Promise((done) => setTimeout(done, 1000));
    }
  }
  if (!admin) throw new Error('Reserved PostgreSQL did not become ready.');
  try {
    for (const role of roles) {
      const password = decodeURIComponent(adminUrl.password).replaceAll("'", "''");
      await admin.query(
        `CREATE ROLE ${quote(role)} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`
      );
    }
    const template = 'reserved_template_test';
    await admin.query(`CREATE DATABASE ${quote(template)} OWNER ${quote(ownerRole)}`);
    const ownerUrl = databaseUrl(template, ownerRole);
    const setupEnv = {
      ...process.env,
      DATABASE_URL: ownerUrl,
      MIGRATION_DATABASE_URL: ownerUrl,
      EXTENSION_ADMIN_DATABASE_URL: databaseUrl(template, 'postgres'),
    };
    if (run('reserved-extensions', ['tsx', 'prisma/prepare-extensions.ts'], setupEnv)) return 1;
    if (run('reserved-migrate', ['prisma', 'migrate', 'deploy'], setupEnv)) return 1;
    if (mode !== 'boundary' && run('reserved-seed-' + mode, ['prisma', 'db', 'seed'], setupEnv))
      return 1;
    const setup = new pg.Client({ connectionString: databaseUrl(template, 'postgres') });
    await setup.connect();
    try {
      for (const role of roles.filter((role) => role !== ownerRole)) {
        await setup.query(`GRANT USAGE ON SCHEMA public TO ${quote(role)};
          GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quote(role)};
          GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quote(role)};
          GRANT EXECUTE ON FUNCTION public.similarity_op(text,text) TO ${quote(role)};`);
      }
    } finally {
      await setup.end();
    }
    if (process.env.CI_RESERVED_BROWSER_ONLY === '1') return 0;
    const standardLanes = [
      [
        'counter-evidence',
        'counter_evidence_disposable_test',
        'reserved_runtime',
        'src/lib/pharmacy/counter-evidence.db.test.ts',
      ],
      [
        'growth',
        'restaurant_growth_test_ci',
        'reserved_runtime',
        'src/lib/restaurant/growth-concurrency.db.test.ts',
      ],
      [
        'platform-concurrency',
        'platform_concurrency_disposable_test',
        'reserved_runtime',
        'tests/platform-sensitive-concurrency.db.test.ts',
      ],
      [
        'price-intelligence',
        'price_intelligence_disposable_test',
        'wha1606_runtime',
        'tests/pharmacy-price-intelligence.integration.test.ts',
      ],
      [
        'returns',
        'pharmacy_returns_disposable_test',
        'reserved_runtime',
        'src/lib/pharmacy/settlement.returns.db.test.ts',
      ],
    ] as const;
    const lanes =
      mode === 'standard'
        ? standardLanes
        : mode === 'boundary'
          ? [
              [
                'boundary-http',
                'boundary_disposable',
                runtimeRole,
                'src/app/api/trpc/transaction-boundary.real-http.test.ts',
              ],
            ]
          : [
              [
                'growth-ready',
                'restaurant_growth_test_ready_ci',
                runtimeRole,
                'tests/restaurant-growth-ready.db.test.ts',
              ],
              [
                'growth-sandbox',
                'restaurant_growth_test_sandbox_ci',
                runtimeRole,
                'tests/restaurant-growth-sandbox.db.test.ts',
              ],
            ];
    let failed = false;
    for (const [lane, database, role, file] of lanes) {
      await admin.query(
        `CREATE DATABASE ${quote(database)} TEMPLATE ${quote(template)} OWNER ${quote(ownerRole)}`
      );
      const runtime = databaseUrl(database, role);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DATABASE_URL: runtime,
        TEST_DATABASE_URL: runtime,
        MIGRATION_DATABASE_URL: databaseUrl(database, ownerRole),
        RESTAURANT_GROWTH_TEST_DATABASE_URL: runtime,
        RESTAURANT_GROWTH_DB_ADMITTED: '1',
        RESTAURANT_GROWTH_TEST_ENVIRONMENT: 'TEST_SANDBOX',
        WHA1597_DATABASE_URL: runtime,
        WHA1606_DATABASE_TEST: '1',
        PHARMACY_E2E: '1',
        PHARMACY_E2E_DATABASE_URL: runtime,
        PHARMACY_E2E_ADMIN_EMAIL: 'pharmacy-admin@pharmacy-e2e.test',
        PHARMACY_E2E_ADMIN_PASSWORD: decodeURIComponent(adminUrl.password),
      };
      if (mode === 'boundary') {
        env.BOUNDARY_REAL_HTTP = '1';
        env.BOUNDARY_OWNER_DATABASE_URL = databaseUrl(database, ownerRole);
        const fixture = new pg.Client({ connectionString: databaseUrl(database, 'postgres') });
        await fixture.connect();
        try {
          for (const id of ['boundary_org_a', 'boundary_org_b']) {
            await fixture.query(
              `INSERT INTO organizations (id,slug,"legalName","displayName",status,"updatedAt") VALUES ($1,$1,$1,$1,'ACTIVE',now())`,
              [id]
            );
          }
        } finally {
          await fixture.end();
        }
      }
      if (mode === 'acceptance') {
        const root = resolve('restaurant-growth-completion-20261009/runtime');
        const files = [
          'prisma/schema.prisma',
          'tests/restaurant-growth-ready.db.test.ts',
          'tests/restaurant-growth-sandbox.db.test.ts',
          'scripts/restaurant-acceptance-target.ts',
          ...spawnSync('git', ['ls-files', 'src/lib/restaurant/growth*', 'prisma/migrations'], {
            encoding: 'utf8',
          })
            .stdout.trim()
            .split('\n'),
        ]
          .filter(Boolean)
          .sort();
        const manifest = JSON.stringify(
          files.map((file) => ({
            file,
            sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
          })),
          null,
          2
        );
        mkdirSync(resolve(root, 'runs', lane), { recursive: true });
        writeFileSync(resolve(root, 'source-manifest.json'), manifest);
        const receipt = resolve(root, 'runs', lane, 'runtime.json');
        writeFileSync(
          receipt,
          JSON.stringify({
            environment: 'TEST_SANDBOX',
            repository: process.cwd(),
            sourceManifestSHA256: createHash('sha256').update(manifest).digest('hex'),
            database,
            databasePort: Number(adminUrl.port),
            runtimeRole,
            ownerRole,
            appOrigin: 'http://chai-chowk.localhost:4483',
            stages: ['migrate'],
          }),
          { mode: 0o600 }
        );
        env.RESTAURANT_ACCEPTANCE_ADMITTED = '1';
        env.RESTAURANT_ACCEPTANCE_RUNTIME_RECEIPT = receipt;
      }
      if (
        lane === 'returns' &&
        run('reserved-pharmacy-seed', ['tsx', 'scripts/seed-pharmacy-e2e.ts'], env)
      ) {
        failed = true;
        continue;
      }
      failed =
        Boolean(
          run(
            'vitest-' + lane,
            [
              'vitest',
              'run',
              file,
              '--maxWorkers=1',
              '--no-file-parallelism',
              '--reporter=json',
              '--outputFile=' + resolve(evidence, `vitest-${lane}.json`),
            ],
            env
          )
        ) || failed;
    }
    return failed ? 1 : 0;
  } finally {
    await admin.end();
  }
}
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch(() => {
    console.error('Reserved database setup failed; inspect the retained lane logs.');
    process.exitCode = 1;
  });
