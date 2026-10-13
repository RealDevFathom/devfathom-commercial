import { fileURLToPath } from 'node:url';
import { freshDatabasePlan } from './fresh-database.ts';

// This CLI deliberately has no execution flag and never loads .env.
try {
  if (process.argv.length !== 2) throw new Error('This source-only command accepts no arguments.');
  console.log(
    JSON.stringify(freshDatabasePlan(fileURLToPath(new URL('../', import.meta.url))), null, 2)
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Fresh database plan failed.');
  process.exitCode = 1;
}
