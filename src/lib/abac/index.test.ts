import { describe, expect, it, vi } from 'vitest';

import type { AuthzDb } from '@/lib/authz';
import { isAdmin } from '@/lib/authz';
import { roleTemplatesForVertical } from '@/lib/vertical-catalog';

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

describe('opt-in pharmacy Owner / Operator access', () => {
  const grantedActions = [
    'reports:operational',
    'reports:financial',
    'pharmacy:orders',
    'pharmacy:dispense',
    'pharmacy:catalogue-review',
    'pharmacy:safety',
  ] as const satisfies readonly Action[];
  const proprietor = { ...employee, role: 'ADMIN' };
  const permissionsFor = (key: string): Permission[] =>
    roleTemplatesForVertical('PHARMACY')
      .find((role) => role.key === key)!
      .capabilities.map((capability) => ({ capability, effect: 'ALLOW' }));

  it.each(grantedActions)('grants %s to the explicitly assigned proprietor', async (action) => {
    await expect(
      can(proprietor, action, undefined, {
        db: authorizationDb({ rolePermissions: permissionsFor('owner-operator') }),
      })
    ).resolves.toBe(true);
  });

  it.each(['admin:access', 'finance:read', 'team:setRole'] as const)(
    'requires tenant ADMIN alongside the template for %s',
    async (action) => {
      const db = authorizationDb({ rolePermissions: permissionsFor('owner-operator') });
      expect(isAdmin(proprietor.role)).toBe(true);
      expect(isAdmin(employee.role)).toBe(false);
      await expect(can(proprietor, action, undefined, { db })).resolves.toBe(true);
      await expect(can(employee, action, undefined, { db })).resolves.toBe(false);
    }
  );

  it.each(grantedActions)('keeps user DENY effective for %s', async (action) => {
    await expect(
      can(proprietor, action, undefined, {
        db: authorizationDb({
          rolePermissions: permissionsFor('owner-operator'),
          overrides: [{ capability: action, effect: 'DENY' }],
        }),
      })
    ).resolves.toBe(false);
  });

  it.each(['*', 'pharmacy:*'])(
    'lets a %s DENY override revoke an exact sensitive grant',
    async (wildcard) => {
      for (const action of [
        'pharmacy:dispense',
        'pharmacy:catalogue-review',
        'pharmacy:safety',
      ] as const) {
        await expect(
          can(proprietor, action, undefined, {
            db: authorizationDb({
              rolePermissions: permissionsFor('owner-operator'),
              overrides: [{ capability: wildcard, effect: 'DENY' }],
            }),
          })
        ).resolves.toBe(false);
        await expect(
          can(proprietor, action, undefined, {
            db: authorizationDb({
              rolePermissions: [
                ...permissionsFor('owner-operator'),
                { capability: wildcard, effect: 'DENY' },
              ],
            }),
          })
        ).resolves.toBe(false);
      }
    }
  );

  it('requires an exact dispense grant for admins and lets a wildcard DENY win', async () => {
    await expect(
      can(proprietor, 'pharmacy:dispense', undefined, { db: authorizationDb({}) })
    ).resolves.toBe(false);

    const exactAllow = [{ capability: 'pharmacy:dispense', effect: 'ALLOW' as const }];
    await expect(
      can(proprietor, 'pharmacy:dispense', undefined, {
        db: authorizationDb({ rolePermissions: exactAllow }),
      })
    ).resolves.toBe(true);

    await expect(
      can(proprietor, 'pharmacy:dispense', undefined, {
        db: authorizationDb({
          rolePermissions: exactAllow,
          overrides: [{ capability: 'pharmacy:*', effect: 'DENY' }],
        }),
      })
    ).resolves.toBe(false);
  });

  it('does not grant unrelated capabilities through wildcard or platform authority', async () => {
    const db = authorizationDb({ rolePermissions: permissionsFor('owner-operator') });
    expect(proprietor.role).toBe('ADMIN');
    expect(permissionsFor('owner-operator').some((rule) => rule.capability.includes('*'))).toBe(
      false
    );
    for (const action of ['restaurant:configure', 'devices:manage', 'workforce:rates'] as const) {
      await expect(can(proprietor, action, undefined, { db })).resolves.toBe(false);
    }
  });
});

describe('custom ABAC decisions', () => {
  it('preserves procurement access for managers and tenant admins without a role', async () => {
    const managerPermissions = roleTemplatesForVertical('PHARMACY')
      .find((role) => role.key === 'manager')!
      .capabilities.map((capability) => ({ capability, effect: 'ALLOW' as const }));

    await expect(
      can(employee, 'pharmacy:procurement', undefined, {
        db: authorizationDb({ rolePermissions: managerPermissions }),
      })
    ).resolves.toBe(true);
    await expect(
      can({ ...employee, role: 'ADMIN' }, 'pharmacy:procurement', undefined, {
        db: authorizationDb({}),
      })
    ).resolves.toBe(true);
  });

  it('lets an explicit deny revoke tenant admin procurement access', async () => {
    await expect(
      can({ ...employee, role: 'ADMIN' }, 'pharmacy:procurement', undefined, {
        db: authorizationDb({
          overrides: [{ capability: 'pharmacy:procurement', effect: 'DENY' }],
        }),
      })
    ).resolves.toBe(false);
  });

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

  it('gives a role deny precedence over a user allow', async () => {
    const db = authorizationDb({
      overrides: [{ capability: 'finance:read', effect: 'ALLOW' }],
      rolePermissions: [{ capability: 'finance:*', effect: 'DENY' }],
    });

    await expect(can(employee, 'finance:read', undefined, { db })).resolves.toBe(false);
  });

  it('gives a role deny precedence over a user-level allow', async () => {
    const db = authorizationDb({
      overrides: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }],
      rolePermissions: [{ capability: 'pharmacy:counter', effect: 'DENY' }],
    });

    await expect(can(employee, 'pharmacy:counter', undefined, { db })).resolves.toBe(false);
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
      // POS landing and terminal order creation share this exact-grant-only
      // capability; agency roles must not inherit it implicitly.
      'orders:take',
      // R-lane (WHA-194): OCR menu import. Default deny like the M8 five above —
      // it is granted only through an organization role, never by an agency role.
      'menu:import',
      // WHA-863: browser enrollment and revocation use the narrower device
      // capability instead of inheriting broad administrator authority.
      'devices:manage',
      // Pharmacy RX-03/04 and RX-05: pharmacist dispense decisions, substitution
      // evidence, controlled register and incident approval. All three remain
      // exact-grant-only and are never inherited from an agency role.
      'pharmacy:dispense',
      'pharmacy:safety',
      'pharmacy:catalogue-review',
      'pharmacy:orders',
    ] as const satisfies readonly Action[];

    expect(ALL_ACTIONS.filter((action) => !action.startsWith('hotel:'))).toHaveLength(46);
    for (const action of actions) {
      expect(ALL_ACTIONS).toContain(action);
      expect(POLICIES[action]).toHaveLength(0);
      await expect(can(employee, action, undefined, { db: authorizationDb({}) })).resolves.toBe(
        false
      );
    }
  });
});

describe('hospitality capability namespace', () => {
  // H1-01 capability contract only. Role templates and property scope are separate steps.
  const actions = [
    'hotel:reservations',
    'hotel:front-desk',
    'hotel:folio',
    'hotel:folio-adjust',
    'hotel:payments',
    'hotel:refunds',
    'hotel:rates',
    'hotel:availability-override',
    'hotel:housekeeping',
    'hotel:night-audit',
    'hotel:guest-identity',
    'hotel:reports-financial',
    'hotel:channels',
    'hotel:property-admin',
    'hotel:marketing',
    'hotel:agents',
    'hotel:banquets',
    'hotel:maintenance',
    'hotel:api-admin',
  ] as const satisfies readonly Action[];

  it('registers the nineteen hospitality actions without static role grants', () => {
    expect(ALL_ACTIONS.filter((action) => action.startsWith('hotel:'))).toEqual(actions);
    for (const action of actions) expect(POLICIES[action]).toEqual([]);
  });
  it.each(['EMPLOYEE', 'ADMIN'])(
    'does not grant hospitality through the %s role alone',
    async (role) => {
      const db = authorizationDb({});
      for (const action of actions) {
        await expect(can({ ...employee, role }, action, undefined, { db })).resolves.toBe(false);
      }
    }
  );
  it.each(actions)('allows an explicit organization-role grant for %s', async (action) => {
    const db = authorizationDb({ rolePermissions: [{ capability: action, effect: 'ALLOW' }] });
    await expect(can(employee, action, undefined, { db })).resolves.toBe(true);
  });
  it('does not widen folio access into folio adjustment', async () => {
    const db = authorizationDb({
      rolePermissions: [{ capability: 'hotel:folio', effect: 'ALLOW' }],
    });
    await expect(can(employee, 'hotel:folio', undefined, { db })).resolves.toBe(true);
    await expect(can(employee, 'hotel:folio-adjust', undefined, { db })).resolves.toBe(false);
  });
  it.each(['hotel:*', '*'])(
    'allows explicit %s while preserving user-level deny precedence',
    async (capability) => {
      const subject = { ...employee, role: 'ADMIN' };
      const granted = authorizationDb({ rolePermissions: [{ capability, effect: 'ALLOW' }] });
      const denied = authorizationDb({
        rolePermissions: [{ capability, effect: 'ALLOW' }],
        overrides: [{ capability: 'hotel:*', effect: 'DENY' }],
      });
      for (const action of actions) {
        await expect(can(subject, action, undefined, { db: granted })).resolves.toBe(true);
        await expect(can(subject, action, undefined, { db: denied })).resolves.toBe(false);
      }
    }
  );
  it('fails closed when hospitality permission lookup is unavailable', async () => {
    const db = authorizationDb({ throws: true });
    for (const role of ['EMPLOYEE', 'ADMIN']) {
      await expect(
        can({ ...employee, role }, 'hotel:folio-adjust', undefined, { db })
      ).resolves.toBe(false);
    }
  });
});
