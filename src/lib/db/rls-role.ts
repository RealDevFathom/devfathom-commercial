/**
 * Production guard for the connection role used by the application.
 *
 * PostgreSQL skips row level security, including FORCE ROW LEVEL SECURITY, for
 * roles with rolsuper or rolbypassrls. A startup check that only reads
 * current_setting('is_superuser') misses BYPASSRLS. This reads both attributes
 * from pg_roles and fails closed when they cannot be proven unset.
 */

export class RlsRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RlsRoleError';
  }
}

type RoleQuery = (sql: string) => Promise<unknown>;

type RoleAttributes = { rolsuper?: unknown; rolbypassrls?: unknown };

function flag(value: unknown): boolean | null {
  if (value === true || value === 1 || value === 't' || value === 'true') return true;
  if (value === false || value === 0 || value === 'f' || value === 'false') return false;
  return null;
}

/**
 * Abort unless `query` shows the current role is subject to row level security.
 * The SQL is fixed; callers pass a bound query function so this module does not
 * open a pool by itself.
 */
export async function assertRlsEnforcingRole(query: RoleQuery): Promise<void> {
  let rows: unknown;
  try {
    rows = await query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    );
  } catch {
    throw new RlsRoleError(
      'Refusing to start: the database role could not be checked for row level security.'
    );
  }

  const role = Array.isArray(rows) ? (rows[0] as RoleAttributes | undefined) : undefined;
  if (!role) {
    throw new RlsRoleError(
      'Refusing to start: the current database role could not be read from pg_roles.'
    );
  }

  const rolsuper = flag(role.rolsuper);
  const rolbypassrls = flag(role.rolbypassrls);
  if (rolsuper === null || rolbypassrls === null) {
    throw new RlsRoleError(
      'Refusing to start: the database role attributes needed for row level security were unreadable.'
    );
  }

  const bypassing: string[] = [];
  if (rolsuper) bypassing.push('SUPERUSER (rolsuper)');
  if (rolbypassrls) bypassing.push('BYPASSRLS (rolbypassrls)');
  if (bypassing.length > 0) {
    throw new RlsRoleError(
      `Refusing to start: DATABASE_URL connects as a role holding ${bypassing.join(' and ')}. ` +
        'Either attribute bypasses row level security, FORCE included. Use a role without SUPERUSER and without BYPASSRLS.'
    );
  }
}

/** Run the guard when a production server is actually starting. */
export async function assertProductionDatabaseRole(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;

  const { db } = await import('@/lib/db');
  await assertRlsEnforcingRole((sql) => db.$queryRawUnsafe(sql));
}
