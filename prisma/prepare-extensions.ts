import { readFileSync } from 'node:fs';

import pg from 'pg';

async function main() {
  const databaseUrl = process.env.EXTENSION_ADMIN_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      'EXTENSION_ADMIN_DATABASE_URL is required and must authenticate as an extension object owner, a superuser, or a role with explicit SET privilege on every extension object owner.'
    );
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  const preflight = readFileSync(new URL('./prepare-extensions.sql', import.meta.url), 'utf8');

  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(preflight);
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Extension preparation and rollback failed.'
      );
    }
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
