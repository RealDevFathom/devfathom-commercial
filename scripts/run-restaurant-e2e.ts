import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

import { restaurantE2eEnvironment } from './restaurant-e2e-database.js';

const env = restaurantE2eEnvironment();
const args = process.argv.slice(2);
const config = '--config=playwright.restaurant-integrated.config.ts';
function run(command: string, argv: string[], childEnv = env) {
  const result = spawnSync(command, argv, { env: childEnv as NodeJS.ProcessEnv, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function main() {
  if (args.includes('--list')) {
    process.exitCode = run('bunx', ['playwright', 'test', config, ...args]);
    return;
  }
  const runtime = new URL(env.RESTAURANT_E2E_DATABASE_URL!);
  const admin = new URL(env.RESTAURANT_E2E_CLONE_ADMIN_URL ?? '');
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(runtime.hostname) ||
    ['5432', '6432'].includes(runtime.port) ||
    !/(?:^|[_-])(test|e2e|tmp|disposable)(?:[_-]|$)/i.test(
      decodeURIComponent(runtime.pathname.slice(1))
    ) ||
    admin.host !== runtime.host ||
    !['postgres:', 'postgresql:'].includes(admin.protocol)
  ) {
    throw new Error('Template cloning requires one loopback disposable database on an isolated port.');
  }
  const template = decodeURIComponent(runtime.pathname.slice(1));
  const actorOwnerBase = new URL(env.RESTAURANT_ACTOR_OWNER_DATABASE_URL ?? '');
  if (actorOwnerBase.host !== runtime.host || !actorOwnerBase.username) {
    throw new Error('Actor owner must name a database owner on the disposable lane.');
  }
  const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
  // Discover through Playwright so filters and the registered corpus stay identical.
  const listingEnv = { ...env };
  delete listingEnv.PLAYWRIGHT_JSON_OUTPUT_FILE;
  delete listingEnv.PLAYWRIGHT_JSON_OUTPUT_NAME;
  const listing = spawnSync(
    'bunx',
    ['playwright', 'test', config, ...args, '--list', '--reporter=json'],
    { env: listingEnv as NodeJS.ProcessEnv, encoding: 'utf8' }
  );
  if (listing.status !== 0) throw new Error(listing.stderr || 'Could not collect the corpus.');
  type Suite = { file?: string; suites?: Suite[]; specs?: unknown[] };
  const files = new Set<string>();
  function collect(suite: Suite) {
    if (suite.file && suite.specs?.length) files.add(suite.file);
    suite.suites?.forEach(collect);
  }
  collect(JSON.parse(listing.stdout));
  if (!files.size) throw new Error('No spec files matched.');
  const commands: Array<[string, string[]]> = [
    ...(env.RESTAURANT_E2E_SKIP_BUILD === '1'
      ? []
      : ([['bun', ['run', 'build']]] as Array<[string, string[]]>)),
    ['bunx', ['tsx', 'scripts/preflight-restaurant-e2e.ts']],
    ['bunx', ['tsx', 'scripts/seed-restaurant-e2e.ts']],
    ['bunx', ['tsx', 'scripts/seed-restaurant-e2e.ts']],
  ];
  for (const [command, argv] of commands) {
    const code = run(command, argv);
    if (code) {
      process.exitCode = code;
      return;
    }
  }
  const evidence = resolve(
    env.RESTAURANT_E2E_EVIDENCE_DIR ?? `test-results/restaurant-corpus-${Date.now()}`
  );
  mkdirSync(evidence, { recursive: true });
  const pool = new pg.Pool({ connectionString: admin.href, max: 1 });
  const results: Array<{ file: string; exitCode: number; report: string }> = [];
  try {
    for (const file of files) {
      const database = `restaurant_e2e_${randomUUID().replaceAll('-', '')}`;
      await pool.query(
        `CREATE DATABASE ${quote(database)} OWNER ${quote(decodeURIComponent(actorOwnerBase.username))} TEMPLATE ${quote(template)}`
      );
      try {
        const target = new URL(runtime);
        target.pathname = '/' + database;
        const actorOwner = new URL(actorOwnerBase);
        actorOwner.pathname = '/' + database;
        const name = file.replaceAll(/[^a-zA-Z0-9.-]/g, '_');
        const childEnv = {
          ...env,
          DATABASE_URL: target.href,
          TEST_DATABASE_URL: target.href,
          RESTAURANT_E2E_DATABASE_URL: target.href,
          RESTAURANT_ACTOR_OWNER_DATABASE_URL: actorOwner.href,
          RESTAURANT_ACTOR_RUNTIME_DATABASE_URL: target.href,
          // Config-level selection intersects existing CLI filters; adding a positional
          // file argument would OR it with those filters and rerun unrelated files.
          RESTAURANT_E2E_SPEC_FILE: file,
          PLAYWRIGHT_JSON_OUTPUT_FILE: resolve(evidence, name + '.json'),
        };
        const preflight = run('bunx', ['tsx', 'scripts/preflight-restaurant-e2e.ts'], childEnv);
        const code =
          preflight ||
          run(
            'bunx',
            [
              'playwright',
              'test',
              config,
              ...args,
              '--workers=1',
              '--retries=0',
              '--reporter=list,json',
              '--output=' + resolve(evidence, name),
            ],
            childEnv
          );
        results.push({ file, exitCode: code, report: childEnv.PLAYWRIGHT_JSON_OUTPUT_FILE });
        writeFileSync(resolve(evidence, 'summary.json'), JSON.stringify(results, null, 2));
        if (code) process.exitCode = 1;
      } finally {
        // Only the uniquely named database created by this iteration is disposable.
        await pool.query(`DROP DATABASE ${quote(database)} WITH (FORCE)`);
      }
    }
  } finally {
    await pool.end();
    const output = env.PLAYWRIGHT_JSON_OUTPUT_FILE ?? env.PLAYWRIGHT_JSON_OUTPUT_NAME;
    if (output) {
      const reports = results.map(({ report }) => JSON.parse(readFileSync(report, 'utf8')));
      const combined = {
        ...reports[0],
        suites: reports.flatMap((report) => report.suites ?? []),
        errors: reports.flatMap((report) => report.errors ?? []),
        stats: {
          startTime: reports[0]?.stats?.startTime,
          duration: reports.reduce((total, report) => total + (report.stats?.duration ?? 0), 0),
          expected: reports.reduce((total, report) => total + (report.stats?.expected ?? 0), 0),
          unexpected: reports.reduce((total, report) => total + (report.stats?.unexpected ?? 0), 0),
          flaky: reports.reduce((total, report) => total + (report.stats?.flaky ?? 0), 0),
          skipped: reports.reduce((total, report) => total + (report.stats?.skipped ?? 0), 0),
        },
      };
      mkdirSync(resolve(output, '..'), { recursive: true });
      writeFileSync(output, JSON.stringify(combined, null, 2));
    }
  }
  const combinedReport = env.PLAYWRIGHT_JSON_OUTPUT_NAME;
  if (combinedReport) {
    const reports = results.map(({ report }) => JSON.parse(readFileSync(report, 'utf8')));
    writeFileSync(
      resolve(combinedReport),
      JSON.stringify({
        ...(reports[0] ?? {}),
        suites: reports.flatMap((report) => report.suites ?? []),
      })
    );
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
