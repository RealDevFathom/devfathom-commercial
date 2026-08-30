import { spawnSync } from 'node:child_process';

import { restaurantE2eEnvironment } from './restaurant-e2e-database.js';

const env = restaurantE2eEnvironment();
const commands: Array<[string, string[]]> = [
  ['bunx', ['tsx', 'scripts/preflight-restaurant-e2e.ts']],
  ['bunx', ['tsx', 'scripts/seed-restaurant-e2e.ts']],
  ['bunx', ['tsx', 'scripts/seed-restaurant-e2e.ts']],
  [
    'bunx',
    [
      'playwright',
      'test',
      '--config=playwright.restaurant-integrated.config.ts',
      ...process.argv.slice(2),
    ],
  ],
];

for (const [command, args] of commands) {
  const result = spawnSync(command, args, { env: env as NodeJS.ProcessEnv, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
