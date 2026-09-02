import { spawnSync } from 'node:child_process';

import { pharmacyE2eEnvironment } from './pharmacy-e2e-environment.js';

const env = pharmacyE2eEnvironment();
const commands: Array<[string, string[]]> = [
  ['bunx', ['tsx', 'scripts/preflight-pharmacy-e2e.ts']],
  // Seeded twice on purpose, as the Agency lane does: the second pass proves
  // every write is a genuine upsert, so a re-run cannot leave the corpus
  // duplicated or the spec asserting against a stale row.
  ['bunx', ['tsx', 'scripts/seed-pharmacy-e2e.ts']],
  ['bunx', ['tsx', 'scripts/seed-pharmacy-e2e.ts']],
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
