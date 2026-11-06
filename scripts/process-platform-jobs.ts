// First: loads .env.local and .env (real environment wins) before anything below reads it.
import { requireDatabaseUrl } from '../prisma/load-env';

import { processPlatformJobs } from '@/lib/platform/jobs';

function requestedJobCount(): number {
  const argument = process.argv
    .slice(2)
    .find((value) => /^\d+$/.test(value) || value.startsWith('--max-jobs='));
  const parsed = Number.parseInt(argument?.replace('--max-jobs=', '') ?? '25', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 1_000) : 25;
}

async function main() {
  requireDatabaseUrl(['DATABASE_URL']);
  const result = await processPlatformJobs(requestedJobCount());
  console.log(JSON.stringify(result));
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
