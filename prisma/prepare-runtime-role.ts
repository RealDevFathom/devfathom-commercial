import pg from 'pg';

const ROLE_NAME = 'devfathom_app';

function required(name: 'DATABASE_URL' | 'APP_DATABASE_URL'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main() {
  const adminUrl = new URL(required('DATABASE_URL'));
  const appUrl = new URL(required('APP_DATABASE_URL'));

  if (decodeURIComponent(appUrl.username) !== ROLE_NAME) {
    throw new Error(`APP_DATABASE_URL must authenticate as ${ROLE_NAME}.`);
  }
  if (
    appUrl.hostname !== adminUrl.hostname ||
    appUrl.port !== adminUrl.port ||
    appUrl.pathname !== adminUrl.pathname
  ) {
    throw new Error('APP_DATABASE_URL must target the same server and database as DATABASE_URL.');
  }

  const password = decodeURIComponent(appUrl.password);
  if (!password) throw new Error('APP_DATABASE_URL must include a password.');

  const client = new pg.Client({ connectionString: adminUrl.toString() });
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(`
      DO $role$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE_NAME}') THEN
          CREATE ROLE ${ROLE_NAME};
        END IF;
      END
      $role$;
      ALTER ROLE ${ROLE_NAME} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    `);

    const passwordSql = await client.query<{ sql: string }>(
      `SELECT format('ALTER ROLE ${ROLE_NAME} PASSWORD %L', $1::text) AS sql`,
      [password]
    );
    await client.query(passwordSql.rows[0]!.sql);
    await client.query(`
      GRANT CONNECT ON DATABASE devfathom TO ${ROLE_NAME};
      GRANT USAGE ON SCHEMA public TO ${ROLE_NAME};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE_NAME};
      GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${ROLE_NAME};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE_NAME};
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${ROLE_NAME};
    `);

    const attributes = await client.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
    }>(`
      SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit
        FROM pg_roles
       WHERE rolname = '${ROLE_NAME}'
    `);
    const role = attributes.rows[0];
    if (
      !role?.rolcanlogin ||
      role.rolsuper ||
      role.rolbypassrls ||
      role.rolcreatedb ||
      role.rolcreaterole ||
      role.rolinherit
    ) {
      throw new Error(`${ROLE_NAME} does not have the required restricted role attributes.`);
    }
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Runtime role preparation and rollback failed.'
      );
    }
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Runtime role preparation failed.');
  process.exitCode = 1;
});
