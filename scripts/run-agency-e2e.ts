import { spawnSync } from 'node:child_process';

import { agencyE2eEnvironment } from './agency-e2e-environment.js';

const env = agencyE2eEnvironment();
const commands: Array<[string, string[]]> = [
  ['bunx', ['tsx', 'scripts/preflight-agency-e2e.ts']],
  ['bunx', ['tsx', 'scripts/seed-agency-e2e.ts']],
  ['bunx', ['tsx', 'scripts/seed-agency-e2e.ts']],
  [
    'bunx',
    ['playwright', 'test', '--config=playwright.agency.config.ts', ...process.argv.slice(2)],
  ],
];

for (const [command, args] of commands) {
  const result = spawnSync(command, args, { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
