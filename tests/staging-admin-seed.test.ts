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
  const upsert = vi.fn(async () => ({ id: 'user-staging' }));
  return { tx: { user: { upsert } } as never, upsert };
}

describe('staging administrator seed', () => {
  it('does nothing when ADMIN_EMAIL is unset, even if a seed password is present', async () => {
    delete process.env.ADMIN_EMAIL;
    process.env.ADMIN_PASSWORD = 'local-seed-only';
    const { tx, upsert } = transaction();
    await upsertStagingAdmin(tx, scope, async (password) => `hash:${password}`);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('creates the administrator from env and updates the same row on the next run', async () => {
    process.env.ADMIN_EMAIL = 'Admin@staging.devfathom.com';
    process.env.ADMIN_PASSWORD = 'vault-password';
    process.env.ADMIN_NAME = 'Staging Admin';
    process.env.ADMIN_TITLE = 'Administrator';
    process.env.ADMIN_DEPARTMENT = 'LEADERSHIP';
    const hashPassword = vi.fn(async (password: string) => `hash:${password}`);
    const { tx, upsert } = transaction();

    await upsertStagingAdmin(tx, scope, hashPassword);
    process.env.ADMIN_PASSWORD = 'rotated-password';
    await upsertStagingAdmin(tx, scope, hashPassword);

    expect(hashPassword).toHaveBeenNthCalledWith(1, 'vault-password');
    expect(hashPassword).toHaveBeenNthCalledWith(2, 'rotated-password');
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenNthCalledWith(1, {
      where: {
        organizationId_email: {
          organizationId: 'org_devfathom',
          email: 'admin@staging.devfathom.com',
        },
      },
      update: {
        password: 'hash:vault-password',
        role: 'ADMIN',
        status: 'ACTIVE',
        organizationRoleId: 'role-admin',
      },
      create: {
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
    expect(upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          organizationId_email: {
            organizationId: 'org_devfathom',
            email: 'admin@staging.devfathom.com',
          },
        },
        update: expect.objectContaining({ password: 'hash:rotated-password' }),
      })
    );
  });

  it('refuses an email without a password', async () => {
    process.env.ADMIN_EMAIL = 'admin@staging.devfathom.com';
    delete process.env.ADMIN_PASSWORD;
    const { tx, upsert } = transaction();
    await expect(upsertStagingAdmin(tx, scope, async (password) => password)).rejects.toThrow(
      /ADMIN_PASSWORD/
    );
    expect(upsert).not.toHaveBeenCalled();
  });
});
