import { afterEach, describe, expect, it, vi } from 'vitest';

import { upsertStagingAdmin } from '../prisma/staging-admin';

const scope = { organizationId: 'org_devfathom', organizationRoleId: 'role-admin' };
const envKeys = [
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD',
  'ADMIN_NAME',
  'ADMIN_TITLE',
  'ADMIN_DEPARTMENT',
] as const;
const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of envKeys) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function transaction() {
  let stored: { id: string; password: string | null } | null = null;
  const findUnique = vi.fn(async () => stored);
  const create = vi.fn(async (args: { data: { password: string } }) => {
    stored = { id: 'user-staging', password: args.data.password };
    return stored;
  });
  const update = vi.fn(async (args: { data: { password?: string } }) => {
    if (stored && args.data.password) stored = { ...stored, password: args.data.password };
    return stored;
  });
  return { tx: { user: { findUnique, create, update } } as never, findUnique, create, update };
}

describe('staging administrator seed', () => {
  it('does nothing when ADMIN_EMAIL is unset, even if a seed password is present', async () => {
    delete process.env.ADMIN_EMAIL;
    process.env.ADMIN_PASSWORD = 'local-seed-only';
    const { tx, findUnique, create, update } = transaction();
    await upsertStagingAdmin(tx, scope, async (password) => `hash:${password}`);
    expect(findUnique).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('creates the administrator, keeps sessions when the password is unchanged, and revokes them when it rotates', async () => {
    process.env.ADMIN_EMAIL = 'Admin@staging.devfathom.com';
    process.env.ADMIN_PASSWORD = 'vault-password';
    process.env.ADMIN_NAME = 'Staging Admin';
    process.env.ADMIN_TITLE = 'Administrator';
    process.env.ADMIN_DEPARTMENT = 'LEADERSHIP';
    const hashPassword = vi.fn(async (password: string) => `hash:${password}`);
    const passwordsMatch = vi.fn(
      async (password: string, passwordHash: string) => passwordHash === `hash:${password}`
    );
    const { tx, create, update } = transaction();

    await upsertStagingAdmin(tx, scope, hashPassword, passwordsMatch);
    await upsertStagingAdmin(tx, scope, hashPassword, passwordsMatch);
    process.env.ADMIN_PASSWORD = 'rotated-password';
    await upsertStagingAdmin(tx, scope, hashPassword, passwordsMatch);

    expect(hashPassword).toHaveBeenCalledTimes(2);
    expect(hashPassword).toHaveBeenNthCalledWith(1, 'vault-password');
    expect(hashPassword).toHaveBeenNthCalledWith(2, 'rotated-password');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org_devfathom',
        organizationRoleId: 'role-admin',
        name: 'Staging Admin',
        email: 'admin@staging.devfathom.com',
        password: 'hash:vault-password',
        role: 'ADMIN',
        department: 'LEADERSHIP',
        title: 'Administrator',
        status: 'ACTIVE',
      },
    });
    expect(update).toHaveBeenNthCalledWith(1, {
      where: { id: 'user-staging' },
      data: {
        role: 'ADMIN',
        status: 'ACTIVE',
        organizationRoleId: 'role-admin',
      },
    });
    expect(update).toHaveBeenNthCalledWith(2, {
      where: { id: 'user-staging' },
      data: {
        role: 'ADMIN',
        status: 'ACTIVE',
        organizationRoleId: 'role-admin',
        password: 'hash:rotated-password',
        passwordChangedAt: expect.any(Date),
        tokenVersion: { increment: 1 },
      },
    });
  });

  it('refuses an email without a password', async () => {
    process.env.ADMIN_EMAIL = 'admin@staging.devfathom.com';
    delete process.env.ADMIN_PASSWORD;
    const { tx, create } = transaction();
    await expect(upsertStagingAdmin(tx, scope, async (password) => password)).rejects.toThrow(
      /ADMIN_PASSWORD/
    );
    expect(create).not.toHaveBeenCalled();
  });
});
