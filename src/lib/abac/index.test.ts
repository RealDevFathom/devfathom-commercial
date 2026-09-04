import { describe, expect, it, vi } from 'vitest';

import type { AuthzDb } from '@/lib/authz';

import { can, subjectFromSession } from '.';
import { ALL_ACTIONS, POLICIES, type Action } from './policies';

type Permission = { capability: string; effect: 'ALLOW' | 'DENY' };

function authorizationDb(options: {
  overrides?: Permission[];
  rolePermissions?: Permission[];
  throws?: boolean;
}): AuthzDb {
  return {
    user: {
      findUnique: options.throws
        ? vi.fn().mockRejectedValue(new Error('database unavailable'))
        : vi.fn().mockResolvedValue({
            organizationRole: options.rolePermissions
              ? { permissions: options.rolePermissions }
              : null,
            permissionOverrides: options.overrides ?? [],
          }),
    },
  } as unknown as AuthzDb;
}

const employee = {
  id: 'user_1',
  role: 'EMPLOYEE',
  department: 'ENGINEERING',
  status: 'ACTIVE',
};

describe('custom ABAC decisions', () => {
  it('allows exact and namespace wildcard capabilities from a custom role', async () => {
    const db = authorizationDb({
      rolePermissions: [
        { capability: 'finance:read', effect: 'ALLOW' },
        { capability: 'team:*', effect: 'ALLOW' },
      ],
    });

    await expect(can(employee, 'finance:read', undefined, { db })).resolves.toBe(true);
    await expect(can(employee, 'team:setRole', undefined, { db })).resolves.toBe(true);
  });

  it('gives a user-level deny precedence over role and static admin grants', async () => {
    const db = authorizationDb({
      overrides: [{ capability: 'finance:*', effect: 'DENY' }],
      rolePermissions: [{ capability: '*', effect: 'ALLOW' }],
    });

    await expect(
      can({ ...employee, role: 'ADMIN' }, 'finance:read', undefined, { db })
    ).resolves.toBe(false);
  });

  it('falls back to built-in policy only when no custom rule matches', async () => {
    const db = authorizationDb({});

    await expect(can(employee, 'team:view', undefined, { db })).resolves.toBe(true);
    await expect(can(employee, 'finance:read', undefined, { db })).resolves.toBe(false);
  });

  it('fails closed when the custom permission lookup is unavailable', async () => {
    const db = authorizationDb({ throws: true });

    await expect(
      can({ ...employee, role: 'ADMIN' }, 'finance:read', undefined, { db })
    ).resolves.toBe(false);
  });

  it('normalizes a session user into a policy subject', () => {
    expect(subjectFromSession({ id: 'u1' })).toEqual({
      id: 'u1',
      role: 'EMPLOYEE',
      department: null,
      status: null,
    });
  });

  it('pins customer management and the M8 capabilities as typed default-deny actions', async () => {
    const actions = [
      'customers:read',
      'customers:manage',
      'loyalty:redeem',
      'reports:financial',
      'workforce:rates',
      'restaurant:configure',
      'catering:read',
      'catering:manage',
      // R-lane (WHA-194): OCR menu import. Default deny like the M8 five above —
      // it is granted only through an organization role, never by an agency role.
      'menu:import',
      // WHA-863: browser enrollment and revocation use the narrower device
      // capability instead of inheriting broad administrator authority.
      'devices:manage',
      // Pharmacy RX-03/04 and RX-05: pharmacist dispense decisions, substitution
      // evidence, controlled register and incident approval. Org-role-driven
      // through the DB customDecision path with no static agency-role policy,
      // so they stay default-deny like the restaurant capabilities above.
      'pharmacy:dispense',
      'pharmacy:safety',
    ] as const satisfies readonly Action[];

    expect(ALL_ACTIONS).toHaveLength(39);
    for (const action of actions) {
      expect(ALL_ACTIONS).toContain(action);
      expect(POLICIES[action]).toEqual([]);
      await expect(can(employee, action, undefined, { db: authorizationDb({}) })).resolves.toBe(
        false
      );
    }
  });
});
