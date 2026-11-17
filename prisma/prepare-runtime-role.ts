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
export type OpenExtensionAdmin = () => Promise<RuntimeRoleClient>;

const SIMILARITY_FUNCTION = 'public.similarity_op(text,text)';
const SIMILARITY_GRANT = `GRANT EXECUTE ON FUNCTION ${SIMILARITY_FUNCTION} TO ${ROLE_NAME}`;
// prepare-extensions.ts revokes PUBLIC EXECUTE as the extension owner, so a migration role that is
// neither that owner nor a superuser holds no privilege on similarity_op and cannot grant it.
// The extension administrator grants it as the owner instead, exactly as the revoke was made.
export const OWNER_SIMILARITY_GRANT = `DO $similarity_grant$
DECLARE
  owner_name name;
  configured_role_is_superuser boolean;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(procedure.proowner)
    INTO STRICT owner_name
    FROM pg_catalog.pg_proc AS procedure
   WHERE procedure.oid = '${SIMILARITY_FUNCTION}'::regprocedure;
  SELECT role.rolsuper
    INTO STRICT configured_role_is_superuser
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = current_user;
  IF NOT configured_role_is_superuser AND owner_name <> current_user THEN
    IF NOT pg_catalog.pg_has_role(current_user, owner_name, 'SET') THEN
      RAISE EXCEPTION 'extension administrator % cannot SET ROLE to similarity_op owner %',
        current_user, owner_name USING ERRCODE = '42501';
    END IF;
    EXECUTE format('SET LOCAL ROLE %I', owner_name);
  END IF;
  ${SIMILARITY_GRANT};
END
$similarity_grant$`;

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

async function canExecuteSimilarity(client: RuntimeRoleClient): Promise<boolean> {
  const result = await client.query<{ allowed: boolean }>(
    `SELECT has_function_privilege('${ROLE_NAME}', '${SIMILARITY_FUNCTION}', 'EXECUTE') AS allowed`
  );
  return result.rows[0]?.allowed === true;
}

async function grantSimilarity(
  client: RuntimeRoleClient,
  openExtensionAdmin: OpenExtensionAdmin | undefined,
  logger: Logger
): Promise<void> {
  try {
    await client.query(SIMILARITY_GRANT);
    logger.log('medicine search similarity operator: granted');
    return;
  } catch (error) {
    if (!isPermissionDenied(error)) throw error;
  }
  if (openExtensionAdmin) {
    const admin = await openExtensionAdmin();
    await admin.query('BEGIN');
    try {
      await admin.query(OWNER_SIMILARITY_GRANT);
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
    logger.log('medicine search similarity operator: granted (as extension owner)');
  }
  if (!(await canExecuteSimilarity(client)))
    throw new Error(
      `${ROLE_NAME} cannot execute ${SIMILARITY_FUNCTION}, and DATABASE_URL may not grant it. ` +
        'Set EXTENSION_ADMIN_DATABASE_URL, or rerun prisma/prepare-extensions.ts now that the role exists.'
    );
  if (!openExtensionAdmin)
    logger.log('medicine search similarity operator: skipped (already executable)');
}

async function readRole(client: RuntimeRoleClient): Promise<RoleAttributes | undefined> {
  return (await client.query<RoleAttributes>(ATTRIBUTE_QUERY)).rows[0];
}

export async function prepareRuntimeRole(
  client: RuntimeRoleClient,
  password: string | undefined,
  databaseName: string,
  logger: Logger = console,
  openExtensionAdmin?: OpenExtensionAdmin
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
    [
      'database connect',
      `GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(databaseName)} TO ${ROLE_NAME}`,
    ],
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
  await grantSimilarity(client, openExtensionAdmin, logger);

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
  const extensionAdminUrl = process.env.EXTENSION_ADMIN_DATABASE_URL || undefined;
  if (extensionAdminUrl) {
    const extensionUrl = new URL(extensionAdminUrl);
    if (
      extensionUrl.hostname !== adminUrl.hostname ||
      extensionUrl.port !== adminUrl.port ||
      extensionUrl.pathname !== adminUrl.pathname
    )
      throw new Error(
        'EXTENSION_ADMIN_DATABASE_URL must target the same server and database as DATABASE_URL.'
      );
  }
  const client = new pg.Client({ connectionString: adminUrl.toString() });
  let extensionAdmin: pg.Client | undefined;
  const openExtensionAdmin = extensionAdminUrl
    ? async () => {
        extensionAdmin = new pg.Client({ connectionString: extensionAdminUrl });
        await extensionAdmin.connect();
        return extensionAdmin;
      }
    : undefined;
  try {
    await client.connect();
    const password = appUrl.password ? decodeURIComponent(appUrl.password) : undefined;
    const databaseName = decodeURIComponent(adminUrl.pathname.slice(1));
    await prepareRuntimeRole(client, password, databaseName, console, openExtensionAdmin);
  } finally {
    await extensionAdmin?.end();
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Runtime role preparation failed.');
    process.exitCode = 1;
  });
