import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/email', () => ({
  appUrl: () => 'https://test.invalid',
  sendEmail: vi.fn(),
  templates: {},
}));

import { emailChangeDenialFor, holdsOwnerLevelAccess } from './member-email-change';

type Party = Parameters<typeof emailChangeDenialFor>[0];
const ownerRole = {
  key: 'owner',
  isSystem: true,
  permissions: [{ capability: '*', effect: 'ALLOW' }],
};
const member = (id: string, role: string, extra: Partial<Party> = {}): Party => ({
  id,
  role,
  status: 'ACTIVE',
  organizationRole: null,
  permissionOverrides: [],
  ...extra,
});

describe('DEV-974 emailChangeDenialFor', () => {
  const owner = member('owner', 'ADMIN', { organizationRole: ownerRole });
  const admin = member('admin', 'ADMIN');

  it('refuses everyone but the owner themselves for an owner, even a deactivated one', () => {
    expect(emailChangeDenialFor(admin, owner)).toMatch(/only the owner/i);
    expect(emailChangeDenialFor(admin, { ...owner, status: 'INACTIVE' })).toMatch(
      /only the owner/i
    );
    expect(
      emailChangeDenialFor(admin, {
        ...member('restricted', 'ADMIN'),
        permissionOverrides: [
          { capability: '*', effect: 'ALLOW' },
          { capability: 'finance:read', effect: 'DENY' },
        ],
      })
    ).toMatch(/only the owner/i);
    expect(emailChangeDenialFor(owner, owner)).toBeNull();
  });

  it('lets an administrator change only a strictly lower role', () => {
    expect(emailChangeDenialFor(admin, member('admin2', 'ADMIN'))).toMatch(/lower role/i);
    expect(emailChangeDenialFor(admin, member('mystery', 'SUPERUSER'))).toMatch(/lower role/i);
    expect(emailChangeDenialFor(admin, member('hr', 'HR'))).toBeNull();
    expect(emailChangeDenialFor(admin, member('staff', 'EMPLOYEE'))).toBeNull();
    expect(emailChangeDenialFor(member('hr', 'HR'), member('hr2', 'HR'))).toMatch(/lower role/i);
  });

  it('lets the owner correct any non-owner email', () => {
    expect(emailChangeDenialFor(owner, admin)).toBeNull();
    expect(emailChangeDenialFor(owner, member('staff', 'EMPLOYEE'))).toBeNull();
  });

  it('treats the system owner role and any wildcard grant as owner-level', () => {
    expect(holdsOwnerLevelAccess({ organizationRole: ownerRole, permissionOverrides: [] })).toBe(
      true
    );
    expect(
      holdsOwnerLevelAccess({
        organizationRole: null,
        permissionOverrides: [{ capability: '*', effect: 'ALLOW' }],
      })
    ).toBe(true);
    expect(holdsOwnerLevelAccess({ organizationRole: null, permissionOverrides: [] })).toBe(false);
  });
});
