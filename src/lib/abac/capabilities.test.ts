import { describe, expect, it } from 'vitest';
import {
  PHARMACY_CHECKED_CAPABILITIES,
  PHARMACY_ROLE_TEMPLATES,
  PHARMACY_SOP_TEMPLATE_GRANTS,
} from '@/lib/vertical-catalog';
import { EXACT_GRANT_ONLY_ACTIONS, capabilityMatches } from './capabilities';
import { ALL_ACTIONS } from './policies';

export const intendedPharmacyGrants = {
  owner: ['pharmacy:*', 'reports:operational', 'reports:financial', 'pharmacy:safety'],
  'owner-operator': [
    'reports:operational',
    'reports:financial',
    'pharmacy:orders',
    'pharmacy:dispense',
    'pharmacy:catalogue-review',
    'pharmacy:safety',
    'pharmacy:procurement',
    'pharmacy:inventory',
    'pharmacy:counter',
    'pharmacy:close',
    'pharmacy:manage',
  ],
  // Day close: owners, administrators and managers (DEV-32, DEV-739); no default
  // pharmacist grant. A role that grants pharmacy:close decides, not the profession.
  pharmacist: ['pharmacy:dispense', 'pharmacy:catalogue-review'],
  manager: ['pharmacy:manage', 'pharmacy:orders', 'pharmacy:procurement', 'pharmacy:close'],
  cashier: ['pharmacy:counter', 'pharmacy:orders'],
  procurement: ['pharmacy:procurement'],
  inventory: ['pharmacy:inventory'],
  finance: ['reports:financial'],
  auditor: ['reports:operational'],
};

describe('canonical capability contract (#130)', () => {
  it('grants exactly the intended actions to every pharmacy template', () => {
    // DEV-751: the SOP grants are a separate, append-only map (they never touch a
    // pharmacy operation grant), so the contract is base grants + SOP grants.
    expect(Object.fromEntries(PHARMACY_ROLE_TEMPLATES.map((r) => [r.key, r.capabilities]))).toEqual(
      Object.fromEntries(
        Object.entries(intendedPharmacyGrants).map(([key, grants]) => [
          key,
          [...grants, ...(PHARMACY_SOP_TEMPLATE_GRANTS[key] ?? [])],
        ])
      )
    );
    for (const role of PHARMACY_ROLE_TEMPLATES) {
      for (const grant of role.capabilities) {
        expect(
          grant === 'pharmacy:*' || ALL_ACTIONS.includes(grant as (typeof ALL_ACTIONS)[number])
        ).toBe(true);
      }
    }
    expect(
      intendedPharmacyGrants.cashier.some((g) => capabilityMatches(g, 'pharmacy:procurement'))
    ).toBe(false);
  });

  it.each([
    'pharmacy.*',
    'pharmacy.dispense',
    'pharmacy:*:*',
    'pharmacy:dis*',
    'pharmacy:',
    ':*',
    '*:*',
    ' pharmacy:*',
    'pharmacy:*\n',
  ])('ignores malformed grant %j', (grant) => {
    for (const action of [...ALL_ACTIONS, grant])
      expect(capabilityMatches(grant, action)).toBe(false);
  });
  it('matches only exact actions, * and namespace:*', () => {
    expect(capabilityMatches('*', 'pharmacy:counter')).toBe(true);
    expect(capabilityMatches('pharmacy:*', 'pharmacy:counter')).toBe(true);
    expect(capabilityMatches('*', 'pharmacy:dispense')).toBe(false);
    expect(capabilityMatches('pharmacy:*', 'pharmacy:dispense')).toBe(false);
    expect(capabilityMatches('pharmacy:*', 'reports:financial')).toBe(false);
    expect(capabilityMatches('pharmacy:dispense', 'pharmacy:safety')).toBe(false);
    expect(capabilityMatches('*', 'pharmacy.dispense')).toBe(false);
  });

  it('covers the checked pharmacy actions with the owner template', () => {
    const owner = PHARMACY_ROLE_TEMPLATES.find((role) => role.key === 'owner')!;
    for (const action of PHARMACY_CHECKED_CAPABILITIES) {
      expect(ALL_ACTIONS).toContain(action);
      // The owner's pharmacy:* never reaches the exact-grant-only actions; only its
      // explicit pharmacy:safety grant (#479 PV filing/review) does.
      expect(owner.capabilities.some((grant) => capabilityMatches(grant, action))).toBe(
        !EXACT_GRANT_ONLY_ACTIONS.has(action) || action === 'pharmacy:safety'
      );
    }
  });

  it('gives the owner exact pharmacy:safety but never dispense or catalogue review', () => {
    const owner = PHARMACY_ROLE_TEMPLATES.find((role) => role.key === 'owner')!;
    const holds = (action: string) =>
      owner.capabilities.some((grant) => capabilityMatches(grant, action));
    expect(holds('pharmacy:safety')).toBe(true);
    expect(holds('pharmacy:dispense')).toBe(false);
    expect(holds('pharmacy:catalogue-review')).toBe(false);
  });

  it.each([
    ['pharmacist', ['pharmacy:dispense', 'pharmacy:catalogue-review']],
    ['cashier', ['pharmacy:counter', 'pharmacy:orders']],
    ['finance', ['reports:financial']],
    ['auditor', ['reports:operational']],
  ])('limits %s to its intended checked actions', (key, actions) => {
    const role = PHARMACY_ROLE_TEMPLATES.find((role) => role.key === key)!;
    expect(
      PHARMACY_CHECKED_CAPABILITIES.filter((action) =>
        role.capabilities.some((grant) => capabilityMatches(grant, action))
      )
    ).toEqual(expect.arrayContaining(actions));
    expect(
      PHARMACY_CHECKED_CAPABILITIES.filter((action) =>
        role.capabilities.some((grant) => capabilityMatches(grant, action))
      )
    ).toHaveLength(actions.length);
  });
});

describe('sensitive pharmacy actions need an exact grant', () => {
  const sensitive = [
    'pharmacy:dispense',
    'pharmacy:prescriptions',
    'pharmacy:safety',
    'pharmacy:catalogue-review',
  ];

  it('never matches them through `*` or `pharmacy:*`', () => {
    for (const action of sensitive) {
      expect(capabilityMatches('*', action)).toBe(false);
      expect(capabilityMatches('pharmacy:*', action)).toBe(false);
    }
  });

  it('still matches them through their exact grant, and only that one', () => {
    for (const action of sensitive) {
      expect(capabilityMatches(action, action)).toBe(true);
      for (const other of sensitive.filter((a) => a !== action)) {
        expect(capabilityMatches(other, action)).toBe(false);
      }
    }
  });

  it('still lets a wildcard DENY revoke them', () => {
    for (const action of sensitive) {
      expect(capabilityMatches('*', action, 'DENY')).toBe(true);
      expect(capabilityMatches('pharmacy:*', action, 'DENY')).toBe(true);
    }
  });

  it('leaves wildcards working for every other action', () => {
    expect(capabilityMatches('*', 'pharmacy:counter')).toBe(true);
    expect(capabilityMatches('pharmacy:*', 'pharmacy:counter')).toBe(true);
    expect(capabilityMatches('pharmacy:*', 'pharmacy:orders')).toBe(true);
    expect(capabilityMatches('*', 'reports:financial')).toBe(true);
    expect(capabilityMatches('pharmacy:*', 'reports:financial')).toBe(false);
    expect(capabilityMatches('pharmacy:counter', 'pharmacy:counter')).toBe(true);
    expect(capabilityMatches('pharmacy:counter', 'pharmacy:manage')).toBe(false);
  });
});
