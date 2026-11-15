import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { passwordResetDenial, passwordResetDenialFor } from './admin-password-reset';

type Party = Parameters<typeof passwordResetDenialFor>[0];

function party(
  id: string,
  role: 'EMPLOYEE' | 'HR' | 'ADMIN',
  extra: Partial<Party> = {}
): Party {
  return { id, role, status: 'ACTIVE', organizationRole: null, permissionOverrides: [], ...extra };
}
const owner = (id = 'owner') =>
  party(id, 'ADMIN', { organizationRole: { key: 'owner', isSystem: true, permissions: [] } });
const admin = (id = 'admin') => party(id, 'ADMIN');
const hr = (id = 'hr') => party(id, 'HR');
const staff = (id = 'staff') => party(id, 'EMPLOYEE');

describe('passwordResetDenialFor', () => {
  it('lets an admin reset staff and HR', () => {
    expect(passwordResetDenialFor(admin(), staff())).toBeNull();
    expect(passwordResetDenialFor(admin(), hr())).toBeNull();
  });

  it('refuses an admin resetting another admin or the owner', () => {
    expect(passwordResetDenialFor(admin('a'), admin('b'))).toMatch(/lower role/);
    expect(passwordResetDenialFor(admin(), owner())).toMatch(/owner/);
  });

  it('lets the owner reset an admin, HR and staff (solo owner recovers staff)', () => {
    expect(passwordResetDenialFor(owner(), admin())).toBeNull();
    expect(passwordResetDenialFor(owner(), hr())).toBeNull();
    expect(passwordResetDenialFor(owner(), staff())).toBeNull();
  });

  it('refuses everyone, the owner included, resetting the owner or themselves', () => {
    expect(passwordResetDenialFor(owner('o1'), owner('o2'))).toMatch(/owner/);
    expect(passwordResetDenialFor(owner('o'), owner('o'))).toMatch(/own password/);
    expect(passwordResetDenialFor(admin('a'), admin('a'))).toMatch(/own password/);
  });

  it('refuses equal or higher roles below admin', () => {
    expect(passwordResetDenialFor(hr('a'), hr('b'))).toMatch(/lower role/);
    expect(passwordResetDenialFor(hr(), admin())).toMatch(/lower role/);
    expect(passwordResetDenialFor(staff('a'), staff('b'))).toMatch(/lower role/);
  });

  it('an explicit DENY removes owner status, so that member is an ordinary admin', () => {
    const denied = party('o', 'ADMIN', {
      organizationRole: {
        key: 'owner',
        isSystem: true,
        permissions: [{ capability: 'billing:manage', effect: 'DENY' }],
      },
    });
    expect(passwordResetDenialFor(denied, admin())).toMatch(/lower role/);
    expect(passwordResetDenialFor(admin(), denied)).toMatch(/lower role/);
  });

  it('fails closed on an unknown target role', () => {
    expect(passwordResetDenialFor(owner(), admin())).toBeNull();
    expect(
      passwordResetDenialFor(admin(), { ...staff('x'), role: 'SUPERUSER' } as unknown as Party)
    ).toMatch(/lower role/);
  });
});

describe('passwordResetDenial', () => {
  function dbWith(users: Record<string, Party | null>) {
    return {
      user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => users[where.id]) },
    } as unknown as Parameters<typeof passwordResetDenial>[0];
  }

  it('loads both members live and applies the guard', async () => {
    const db = dbWith({ a: admin('a'), s: staff('s'), b: admin('b') });
    expect(await passwordResetDenial(db, { actorId: 'a', targetId: 's' })).toBeNull();
    expect(await passwordResetDenial(db, { actorId: 'a', targetId: 'b' })).toMatch(/lower role/);
  });

  it('reports a missing member', async () => {
    const db = dbWith({ a: admin('a'), gone: null });
    expect(await passwordResetDenial(db, { actorId: 'a', targetId: 'gone' })).toBe(
      'Member not found.'
    );
  });
});
