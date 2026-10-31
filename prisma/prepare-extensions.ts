import { readFileSync } from 'node:fs';

import pg from 'pg';

async function main() {
  const databaseUrl = process.env.EXTENSION_ADMIN_DATABASE_URL;
  // Same resolution as prisma.config.ts so preparation delegates to the role that migrates.
  const migrationDatabaseUrl =
    process.env.MIGRATION_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();

  if (!databaseUrl) {
    throw new Error(
      'EXTENSION_ADMIN_DATABASE_URL is required and must authenticate as an extension object owner, a superuser, or a role with explicit SET privilege on every extension object owner.'
    );
  }
  if (!migrationDatabaseUrl) {
    throw new Error(
      'MIGRATION_DATABASE_URL (or DATABASE_URL) is required so extension privileges can be delegated to the migration role.'
    );
  }

  const extensionTarget = new URL(databaseUrl);
  const migrationTarget = new URL(migrationDatabaseUrl);
  if (
    extensionTarget.hostname !== migrationTarget.hostname ||
    extensionTarget.port !== migrationTarget.port ||
    extensionTarget.pathname !== migrationTarget.pathname
  )
    throw new Error(
      'MIGRATION_DATABASE_URL must target the same server and database as EXTENSION_ADMIN_DATABASE_URL.'
    );
  const migrationRole = decodeURIComponent(migrationTarget.username);
  if (!migrationRole) throw new Error('MIGRATION_DATABASE_URL must include a migration role.');

  const client = new pg.Client({ connectionString: databaseUrl });
  const preflight = readFileSync(new URL('./prepare-extensions.sql', import.meta.url), 'utf8');

  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(`SELECT pg_catalog.set_config('devfathom.migration_role', $1, true)`, [
      migrationRole,
    ]);
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
