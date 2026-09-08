import { describe, expect, it, vi } from 'vitest';

import type { AuthzDb } from '@/lib/authz';
import { HOSPITALITY_CAPABILITIES, HOSPITALITY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';

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
      'pharmacy:catalogue-review',
      'pharmacy:orders',
    ] as const satisfies readonly Action[];

    // H1-01 hospitality (06 §1). All nineteen are org-role-driven with no static
    // agency-role policy, so an agency ADMIN never inherits a hotel capability.
    // Taken from the vertical catalog rather than retyped, so the catalog and the
    // ABAC action list cannot drift apart without this failing.
    const hospitality = HOSPITALITY_CAPABILITIES as readonly Action[];

    // Re-derived by counting the policy table: 41 before H1-01, plus the
    // nineteen hospitality capabilities.
    expect(ALL_ACTIONS).toHaveLength(60);
    expect(hospitality).toHaveLength(19);
    for (const action of [...actions, ...hospitality]) {
      expect(ALL_ACTIONS).toContain(action);
      expect(POLICIES[action]).toEqual([]);
      await expect(can(employee, action, undefined, { db: authorizationDb({}) })).resolves.toBe(
        false
      );
    }
  });
});

/**
 * H1-01 — the capability decisions the hospitality role templates actually
 * produce, through the real engine rather than by reading the catalog back.
 *
 * `hotel:reservations` and `hotel:folio-adjust` are the pair worth pinning: the
 * first is the widest-held hotel capability and the second is the one that lets
 * somebody put a charge on a guest's folio with no catalog item behind it. A
 * front desk agent must hold the first and must not hold the second.
 */
describe('hospitality capability routing (06 §2)', () => {
  const permissionsFor = (key: string) => {
    const template = HOSPITALITY_ROLE_TEMPLATES.find((role) => role.key === key);
    if (!template) throw new Error(`Unknown hospitality role template: ${key}`);
    return template.capabilities.map((capability) => ({
      capability,
      effect: 'ALLOW' as const,
    }));
  };

  const decide = (roleKey: string, action: Action) =>
    can(employee, action, undefined, {
      db: authorizationDb({ rolePermissions: permissionsFor(roleKey) }),
    });

  it('allows a front desk agent to work reservations', async () => {
    await expect(decide('front-desk-agent', 'hotel:reservations')).resolves.toBe(true);
  });

  it('refuses folio adjustment to a front desk agent', async () => {
    await expect(decide('front-desk-agent', 'hotel:folio-adjust')).resolves.toBe(false);
    // The agent does hold plain folio access, so the denial is the *narrower*
    // capability being withheld, not the whole surface being closed.
    await expect(decide('front-desk-agent', 'hotel:folio')).resolves.toBe(true);
  });

  it('allows folio adjustment to the night auditor, who owns dated corrections', async () => {
    await expect(decide('night-auditor', 'hotel:folio-adjust')).resolves.toBe(true);
    // …and the night auditor takes no reservations, which is the other half of
    // the same separation.
    await expect(decide('night-auditor', 'hotel:reservations')).resolves.toBe(false);
  });

  it('gives the owner template both through the wildcard grant', async () => {
    await expect(decide('owner', 'hotel:reservations')).resolves.toBe(true);
    await expect(decide('owner', 'hotel:folio-adjust')).resolves.toBe(true);
  });

  it('grants nothing to the two roles the pack flags as over-grantable', async () => {
    for (const roleKey of ['read-only-auditor', 'partner-api-key']) {
      for (const capability of HOSPITALITY_CAPABILITIES) {
        await expect(decide(roleKey, capability as Action)).resolves.toBe(false);
      }
    }
  });

  it('keeps a housekeeper off money and identity entirely', async () => {
    await expect(decide('housekeeper', 'hotel:housekeeping')).resolves.toBe(true);
    for (const capability of [
      'hotel:folio',
      'hotel:folio-adjust',
      'hotel:payments',
      'hotel:refunds',
      'hotel:guest-identity',
      'hotel:reservations',
    ] as const) {
      await expect(decide('housekeeper', capability)).resolves.toBe(false);
    }
  });
});
