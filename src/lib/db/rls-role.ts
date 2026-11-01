/**
 * Production guard for the connection role used by the application.
 *
 * PostgreSQL skips row level security, including FORCE ROW LEVEL SECURITY, for
 * roles with rolsuper or rolbypassrls. A startup check that only reads
 * current_setting('is_superuser') misses BYPASSRLS. Membership in such a role
 * also lets the session SET ROLE to it. This reads both attributes from
 * pg_roles, rejects membership in any other SUPERUSER or BYPASSRLS role, and
 * fails closed when they cannot be proven unset.
 */

export class RlsRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RlsRoleError';
  }
}

type RoleQuery = (sql: string) => Promise<unknown>;

type RoleAttributes = {
  rolsuper?: unknown;
  rolbypassrls?: unknown;
  member_of_bypass?: unknown;
};

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
      `SELECT rolsuper, rolbypassrls,
              EXISTS (
                SELECT 1 FROM pg_roles r
                WHERE r.rolname <> current_user
                  AND (r.rolsuper OR r.rolbypassrls)
                  AND pg_has_role(current_user, r.oid, 'member')
              ) AS member_of_bypass
       FROM pg_roles WHERE rolname = current_user`
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
  const memberOfBypass = flag(role.member_of_bypass);
  if (rolsuper === null || rolbypassrls === null || memberOfBypass === null) {
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
  if (memberOfBypass) {
    throw new RlsRoleError(
      'Refusing to start: DATABASE_URL connects as a role that is a member of a SUPERUSER or BYPASSRLS role. ' +
        'Membership lets the session assume that role and bypass row level security. ' +
        'Use a role that is not a member of either.'
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
