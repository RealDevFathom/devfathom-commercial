import { expect, it, vi } from 'vitest';
import type { AuthzDb } from '@/lib/authz';
import { canAccessPharmacyFinance } from './finance-access';

const sessionAdmin = { id: 'admin', role: 'ADMIN', status: 'ACTIVE' };
const owner = { key: 'owner', isSystem: true, permissions: [] };

it.each([
  ['the active system Owner', owner, 'ADMIN', 'ACTIVE', [], true],
  [
    'an Owner with a finance deny',
    owner,
    'ADMIN',
    'ACTIVE',
    [{ capability: 'finance:*', effect: 'DENY' }],
    false,
  ],
  ['a custom role named owner', { ...owner, isSystem: false }, 'ADMIN', 'ACTIVE', [], false],
  [
    'the owner-operator template',
    { ...owner, key: 'owner-operator' },
    'ADMIN',
    'ACTIVE',
    [],
    false,
  ],
  ['a roleless administrator', null, 'ADMIN', 'ACTIVE', [], false],
  ['a former administrator', owner, 'EMPLOYEE', 'ACTIVE', [], false],
  ['an inactive owner', owner, 'ADMIN', 'INACTIVE', [], false],
  [
    'a direct finance grant',
    null,
    'ADMIN',
    'ACTIVE',
    [{ capability: 'finance:read', effect: 'ALLOW' }],
    true,
  ],
] as const)(
  'resolves pharmacy finance access for %s',
  async (_label, organizationRole, role, status, permissionOverrides, expected) => {
    const db = {
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ role, status, organizationRole, permissionOverrides }),
      },
    } as unknown as AuthzDb;
    await expect(canAccessPharmacyFinance(sessionAdmin, { db })).resolves.toBe(expected);
  }
);

it.each(['finance:read', 'finance:manage'] as const)(
  'honors the built-in Finance employee grant for %s and its explicit revocation',
  async (action) => {
    const user = { id: 'accountant', role: 'EMPLOYEE', status: 'ACTIVE' };
    const findUnique = vi.fn();
    const db = { user: { findUnique } } as unknown as AuthzDb;
    const member = {
      ...user,
      organization: { vertical: 'PHARMACY' },
      organizationRole: {
        key: 'finance',
        isSystem: true,
        permissions: [{ capability: action, effect: 'ALLOW' }],
      },
      permissionOverrides: [],
    };
    findUnique.mockResolvedValue(member);
    await expect(canAccessPharmacyFinance(user, { db }, action)).resolves.toBe(true);
    findUnique.mockResolvedValue({
      ...member,
      permissionOverrides: [{ capability: 'finance:*', effect: 'DENY' }],
    });
    await expect(canAccessPharmacyFinance(user, { db }, action)).resolves.toBe(false);
  }
);
