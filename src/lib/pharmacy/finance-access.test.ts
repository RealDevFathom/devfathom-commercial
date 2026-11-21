import { expect, it, vi } from 'vitest';
import type { AuthzDb } from '@/lib/authz';
import { canReadPharmacyFinance } from './finance-access';

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
    await expect(canReadPharmacyFinance(sessionAdmin, { db })).resolves.toBe(expected);
  }
);
