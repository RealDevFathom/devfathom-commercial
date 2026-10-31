import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import { pharmacyE2eEnvironment } from './pharmacy-e2e-environment.js';

const env = pharmacyE2eEnvironment();
const port = env.PLAYWRIGHT_PORT ?? '4331';
const prepareFirstSale = !env.PHARMACY_FIRST_SALE_INPUT;
if (prepareFirstSale) {
  env.PHARMACY_FIRST_SALE_INPUT = resolve('playwright-artifacts/pharmacy-first-sale/input.json');
  env.PHARMACY_FIRST_SALE_PLATFORM_ORIGIN = `http://admin.localhost:${port}`;
  env.PHARMACY_FIRST_SALE_TENANT_ORIGIN = `http://www.localhost:${port}`;
  env.PLAYWRIGHT_PORT = port;
  const admin = new URL(env.DATABASE_URL!);
  admin.searchParams.set('options', '-c app.is_platform_admin=true');
  env.PLAYWRIGHT_DATABASE_ADMIN_URL = admin.href;
}
const commands: Array<[string, string[]]> = [
  ['bunx', ['tsx', 'scripts/preflight-pharmacy-e2e.ts']],
  // Seeded twice on purpose, as the Agency lane does: the second pass proves
  // every write is a genuine upsert, so a re-run cannot leave the corpus
  // duplicated or the spec asserting against a stale row.
  ['bunx', ['tsx', 'scripts/seed-pharmacy-e2e.ts']],
  ['bunx', ['tsx', 'scripts/seed-pharmacy-e2e.ts']],
  ...(prepareFirstSale
    ? ([['bunx', ['tsx', 'scripts/prepare-pharmacy-first-sale.ts']]] as Array<[string, string[]]>)
    : []),
  [
    'bunx',
    [
      'playwright',
      'test',
      '--config=playwright.pharmacy-counter.config.ts',
      ...process.argv.slice(2),
    ],
  ],
];

for (const [command, args] of commands) {
  const result = spawnSync(command, args, { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
