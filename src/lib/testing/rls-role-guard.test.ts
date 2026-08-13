/**
 * The shared row level security role guard (#39).
 *
 * These cases need no database: the guard's whole job is to decide, from the
 * two `pg_roles` attributes, whether the connection is subject to row level
 * security. Driving that decision from a fake role is what makes every branch
 * reachable — a real database can only ever present the ONE role the harness
 * happens to be connected as, and the roles worth testing (SUPERUSER,
 * BYPASSRLS, an unreadable `pg_roles` row) are exactly the ones the suites must
 * never be run under.
 *
 * The BYPASSRLS case below runs the RETIRED `current_setting('is_superuser')`
 * check and the new guard against ONE role, so the regression this change
 * closes stays demonstrable rather than remembered.
 */
import { describe, expect, it } from 'vitest';

import { assertRlsEnforcingRole } from './rls-role-guard';

type WithPlatformDb = (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];

/**
 * A fake role that answers BOTH probes: the `pg_roles` query the shared guard
 * runs, and the `current_setting('is_superuser')` query the retired guard ran.
 * One role, both checks, so they can be compared directly.
 */
const roleWith = (attributes: { rolsuper: boolean; rolbypassrls: boolean }): WithPlatformDb =>
  ((run: (db: unknown) => unknown) =>
    run({
      $queryRawUnsafe: async (sql: string) =>
        sql.includes('pg_roles')
          ? [attributes]
          : [{ is_superuser: attributes.rolsuper ? 'on' : 'off' }],
    })) as unknown as WithPlatformDb;

/** A role whose `pg_roles` row the connection cannot read: zero rows come back. */
const roleWithNoVisibleRow: WithPlatformDb = ((run: (db: unknown) => unknown) =>
  run({ $queryRawUnsafe: async () => [] })) as unknown as WithPlatformDb;

/** A connection on which the `pg_roles` query itself fails. */
const roleWhoseProbeFails: WithPlatformDb = ((run: (db: unknown) => unknown) =>
  run({
    $queryRawUnsafe: async () => {
      throw new Error('permission denied for relation pg_authid');
    },
  })) as unknown as WithPlatformDb;

/**
 * The guard this change retires, preserved here for one purpose: proving what
 * it let through. Not exported, and used by exactly one case below.
 */
async function retiredIsSuperuserCheck(withPlatformDb: WithPlatformDb): Promise<void> {
  const [{ is_superuser: isSuperuser }] = await withPlatformDb((db) =>
    db.$queryRawUnsafe<Array<{ is_superuser: string }>>(
      `SELECT current_setting('is_superuser') AS is_superuser`
    )
  );
  if (isSuperuser === 'on') {
    throw new Error('TEST_DATABASE_URL connects as a superuser.');
  }
}

describe('assertRlsEnforcingRole', () => {
  it('passes an unprivileged role, which is the only role the suites may use', async () => {
    await expect(
      assertRlsEnforcingRole(roleWith({ rolsuper: false, rolbypassrls: false }))
    ).resolves.toBeUndefined();
  });

  it('aborts on a SUPERUSER role, naming the attribute', async () => {
    await expect(
      assertRlsEnforcingRole(roleWith({ rolsuper: true, rolbypassrls: false }))
    ).rejects.toThrow(/SUPERUSER \(rolsuper\)/);
  });

  // THE NEW CAPABILITY. A role can hold BYPASSRLS without being a superuser,
  // and such a role reads through every policy, FORCE included. The retired
  // check could not see it: `current_setting('is_superuser')` reads `off`.
  it('aborts on BYPASSRLS without SUPERUSER, which the retired check let through', async () => {
    const bypassrlsRole = roleWith({ rolsuper: false, rolbypassrls: true });

    // Before: the retired guard inspects the same role and raises nothing.
    await expect(retiredIsSuperuserCheck(bypassrlsRole)).resolves.toBeUndefined();

    // After: the shared guard reads the attribute the retired check never saw.
    await expect(assertRlsEnforcingRole(bypassrlsRole)).rejects.toThrow(
      /BYPASSRLS \(rolbypassrls\)/
    );
  });

  it('names both attributes when a role holds both', async () => {
    await expect(
      assertRlsEnforcingRole(roleWith({ rolsuper: true, rolbypassrls: true }))
    ).rejects.toThrow(/SUPERUSER \(rolsuper\) and BYPASSRLS \(rolbypassrls\)/);
  });

  // FAIL CLOSED. An unreadable role is not an unprivileged role: enforcement
  // cannot be established, so the guard refuses rather than assume the happy
  // case. This is `audit-cursor.test.ts`'s behaviour, preserved.
  it('aborts when the pg_roles row cannot be read at all', async () => {
    await expect(assertRlsEnforcingRole(roleWithNoVisibleRow)).rejects.toThrow(
      /Could not read the current role from pg_roles/
    );
  });

  it('lets a failing pg_roles probe abort the suite rather than swallowing it', async () => {
    await expect(assertRlsEnforcingRole(roleWhoseProbeFails)).rejects.toThrow(
      /permission denied for relation pg_authid/
    );
  });
});
