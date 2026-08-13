/**
 * The shared row level security role guard (#39). TEST-ONLY.
 *
 * A suite whose assertions are DECIDED BY row level security is only meaningful
 * when the connection role is actually subject to it. PostgreSQL exempts two
 * kinds of role, and they are separate attributes:
 *
 *   - `rolsuper` (SUPERUSER) bypasses row level security outright;
 *   - `rolbypassrls` (BYPASSRLS) does the same, FORCE ROW LEVEL SECURITY
 *     included, WITHOUT the role being a superuser.
 *
 * `current_setting('is_superuser')` sees only the first. It reads `off` for a
 * BYPASSRLS role, so a guard built on it hands a tenant-boundary suite a
 * connection that reads straight through every policy. This reads both
 * attributes from `pg_roles`, which is the only check that covers both.
 *
 * FAILS CLOSED. If the `pg_roles` row cannot be read at all, enforcement cannot
 * be established, and a guard that cannot establish its precondition must abort
 * rather than assume the happy case.
 *
 * `withPlatformDb` is INJECTED rather than imported. The suites that use this
 * helper import `@/lib/tenancy/scoped-db` dynamically inside `beforeAll`,
 * because `@/lib/db` reads DATABASE_URL when its module is evaluated and the
 * suites overwrite that variable from TEST_DATABASE_URL first. A static import
 * here would evaluate the database client at test-module load, before the
 * override. Injection also leaves this module with no runtime imports at all,
 * which is what keeps it off every production import path.
 */

type WithPlatformDb = (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];

type RoleAttributes = { rolsuper: boolean; rolbypassrls: boolean };

/**
 * Abort unless the connection role is subject to row level security.
 *
 * @throws if the role holds SUPERUSER or BYPASSRLS, or if its `pg_roles` row
 * cannot be read.
 */
export async function assertRlsEnforcingRole(withPlatformDb: WithPlatformDb): Promise<void> {
  const roles = await withPlatformDb((db) =>
    db.$queryRawUnsafe<RoleAttributes[]>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
    )
  );

  const role = roles?.[0];
  if (!role) {
    throw new Error(
      'Could not read the current role from pg_roles; refusing to run a row level ' +
        'security test whose enforcement cannot be established.'
    );
  }

  // Name the attribute that is actually set: "use an unprivileged role" is not
  // actionable until you know which privilege to drop.
  const bypassing: string[] = [];
  if (role.rolsuper) bypassing.push('SUPERUSER (rolsuper)');
  if (role.rolbypassrls) bypassing.push('BYPASSRLS (rolbypassrls)');

  if (bypassing.length > 0) {
    throw new Error(
      `TEST_DATABASE_URL connects as a role holding ${bypassing.join(' and ')} ` +
        `(rolsuper=${role.rolsuper}, rolbypassrls=${role.rolbypassrls}). Either attribute ` +
        'bypasses row level security, FORCE included, so the tenant-scoped cases would not ' +
        'be decided by row level security at all. Use an unprivileged role.'
    );
  }
}
