import pg from 'pg';
import { fileURLToPath } from 'node:url';

const ROLE_NAME = 'devfathom_app';
type RoleAttributes = {
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolinherit: boolean;
};
type QueryResult<Row> = { rows: Row[] };
export type RuntimeRoleClient = {
  query<Row = never>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>;
};
type Logger = Pick<Console, 'log' | 'warn'>;

const ATTRIBUTE_QUERY = `
  SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit
    FROM pg_roles
   WHERE rolname = '${ROLE_NAME}'
`;

function isPermissionDenied(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '42501';
}

function hasRequiredPosture(role: RoleAttributes | undefined): role is RoleAttributes {
  return Boolean(
    role?.rolcanlogin &&
    !role.rolsuper &&
    !role.rolbypassrls &&
    !role.rolcreatedb &&
    !role.rolcreaterole &&
    !role.rolinherit
  );
}

async function readRole(client: RuntimeRoleClient): Promise<RoleAttributes | undefined> {
  return (await client.query<RoleAttributes>(ATTRIBUTE_QUERY)).rows[0];
}

export async function prepareRuntimeRole(
  client: RuntimeRoleClient,
  password: string | undefined,
  logger: Logger = console
): Promise<void> {
  let role = await readRole(client);
  if (!role) {
    await client.query(`CREATE ROLE ${ROLE_NAME} LOGIN NOCREATEDB NOCREATEROLE NOINHERIT`);
    logger.log('role: created');
    role = await readRole(client);
  } else logger.log('role: skipped (already exists)');

  const changes = [
    !role?.rolcanlogin && 'LOGIN',
    role?.rolcreatedb && 'NOCREATEDB',
    role?.rolcreaterole && 'NOCREATEROLE',
    role?.rolinherit && 'NOINHERIT',
  ].filter((change): change is string => Boolean(change));
  let attributeAlterPermissionDenied = false;
  if (changes.length) {
    try {
      await client.query(`ALTER ROLE ${ROLE_NAME} ${changes.join(' ')}`);
      logger.log(`attributes: altered (${changes.join(', ')})`);
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      attributeAlterPermissionDenied = true;
    }
  } else logger.log('attributes: skipped (already correct)');

  let passwordAlterPermissionDenied = false;
  if (password !== undefined) {
    const passwordSql = await client.query<{ sql: string }>(
      `SELECT format('ALTER ROLE ${ROLE_NAME} PASSWORD %L', $1::text) AS sql`,
      [password]
    );
    try {
      await client.query(passwordSql.rows[0]!.sql);
      logger.log('password: altered');
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      passwordAlterPermissionDenied = true;
    }
  } else logger.log('password: skipped (APP_DATABASE_URL has no password)');

  const grants = [
    ['database connect', `GRANT CONNECT ON DATABASE devfathom TO ${ROLE_NAME}`],
    ['schema usage', `GRANT USAGE ON SCHEMA public TO ${ROLE_NAME}`],
    [
      'existing tables',
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE_NAME}`,
    ],
    [
      'existing sequences',
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${ROLE_NAME}`,
    ],
    [
      'medicine search similarity operator',
      `GRANT EXECUTE ON FUNCTION public.similarity_op(text,text) TO ${ROLE_NAME}`,
    ],
    [
      'future tables',
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE_NAME}`,
    ],
    [
      'future sequences',
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${ROLE_NAME}`,
    ],
  ] as const;
  for (const [step, sql] of grants) {
    await client.query(sql);
    logger.log(`${step}: granted`);
  }

  const finalRole = await readRole(client);
  if (!hasRequiredPosture(finalRole))
    throw new Error(`${ROLE_NAME} does not have the required restricted role attributes.`);
  if (attributeAlterPermissionDenied)
    logger.warn('attributes: skipped (permission denied; final posture verified)');
  if (passwordAlterPermissionDenied)
    logger.warn('password: skipped (permission denied; final posture verified)');
  logger.log('posture: skipped (verified correct)');
}

function required(name: 'DATABASE_URL' | 'APP_DATABASE_URL'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function main() {
  const adminUrl = new URL(required('DATABASE_URL'));
  const appUrl = new URL(required('APP_DATABASE_URL'));
  if (decodeURIComponent(appUrl.username) !== ROLE_NAME)
    throw new Error(`APP_DATABASE_URL must authenticate as ${ROLE_NAME}.`);
  if (
    appUrl.hostname !== adminUrl.hostname ||
    appUrl.port !== adminUrl.port ||
    appUrl.pathname !== adminUrl.pathname
  )
    throw new Error('APP_DATABASE_URL must target the same server and database as DATABASE_URL.');
  const client = new pg.Client({ connectionString: adminUrl.toString() });
  try {
    await client.connect();
    const password = appUrl.password ? decodeURIComponent(appUrl.password) : undefined;
    await prepareRuntimeRole(client, password);
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Runtime role preparation failed.');
    process.exitCode = 1;
  });
