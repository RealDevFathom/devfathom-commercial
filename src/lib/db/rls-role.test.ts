import { describe, expect, it, vi } from 'vitest';

import { assertProductionDatabaseRole, assertRlsEnforcingRole, RlsRoleError } from './rls-role';

describe('assertRlsEnforcingRole', () => {
  it('accepts a role that is neither superuser nor bypassrls', async () => {
    const query = vi.fn(async () => [
      { rolsuper: false, rolbypassrls: false, member_of_bypass: false },
    ]);
    await expect(assertRlsEnforcingRole(query)).resolves.toBeUndefined();
  });

  it('refuses SUPERUSER and BYPASSRLS, including driver string flags', async () => {
    await expect(
      assertRlsEnforcingRole(async () => [
        { rolsuper: true, rolbypassrls: false, member_of_bypass: false },
      ])
    ).rejects.toThrow(/SUPERUSER/);
    await expect(
      assertRlsEnforcingRole(async () => [
        { rolsuper: 'f', rolbypassrls: 't', member_of_bypass: 'f' },
      ])
    ).rejects.toThrow(/BYPASSRLS/);
  });

  it('refuses a role that is a member of a SUPERUSER or BYPASSRLS role', async () => {
    await expect(
      assertRlsEnforcingRole(async () => [
        { rolsuper: false, rolbypassrls: false, member_of_bypass: true },
      ])
    ).rejects.toThrow(/member of a SUPERUSER or BYPASSRLS role/);
    await expect(
      assertRlsEnforcingRole(async () => [
        { rolsuper: 'f', rolbypassrls: 'f', member_of_bypass: 't' },
      ])
    ).rejects.toThrow(/member of a SUPERUSER or BYPASSRLS role/);
  });

  it('fails closed when the role row or its attributes cannot be read', async () => {
    await expect(assertRlsEnforcingRole(async () => [])).rejects.toBeInstanceOf(RlsRoleError);
    await expect(
      assertRlsEnforcingRole(async () => [{ rolsuper: false, rolbypassrls: null }])
    ).rejects.toThrow(/unreadable/);
    await expect(
      assertRlsEnforcingRole(async () => [
        { rolsuper: false, rolbypassrls: false, member_of_bypass: null },
      ])
    ).rejects.toThrow(/unreadable/);
    await expect(
      assertRlsEnforcingRole(async () => {
        throw new Error('connection refused');
      })
    ).rejects.toThrow(/could not be checked/);
  });

  it('does not query during tests or a production build', async () => {
    const query = vi.fn();
    vi.stubEnv('NODE_ENV', 'test');
    await assertProductionDatabaseRole();
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_PHASE', 'phase-production-build');
    await assertProductionDatabaseRole();
    expect(query).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});
