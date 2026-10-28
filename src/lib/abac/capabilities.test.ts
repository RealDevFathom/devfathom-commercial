import { describe, expect, it } from 'vitest';
import { PHARMACY_CHECKED_CAPABILITIES, PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { capabilityMatches } from './capabilities';
import { ALL_ACTIONS } from './policies';

export const intendedPharmacyGrants = {
  owner: ['pharmacy:*', 'reports:operational', 'reports:financial'],
  'owner-operator': [
    'reports:operational',
    'reports:financial',
    'pharmacy:orders',
    'pharmacy:dispense',
    'pharmacy:catalogue-review',
    'pharmacy:safety',
  ],
  pharmacist: ['pharmacy:dispense', 'pharmacy:catalogue-review'],
  manager: ['pharmacy:manage', 'pharmacy:orders', 'pharmacy:procurement'],
  cashier: ['pharmacy:counter', 'pharmacy:orders'],
  procurement: ['pharmacy:procurement'],
  inventory: ['pharmacy:inventory'],
  finance: ['reports:financial'],
  auditor: ['reports:operational'],
};

describe('canonical capability contract (#130)', () => {
  it('grants exactly the intended actions to every pharmacy template', () => {
    expect(Object.fromEntries(PHARMACY_ROLE_TEMPLATES.map((r) => [r.key, r.capabilities]))).toEqual(
      intendedPharmacyGrants
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
  it('maps only the exact legacy dotted aliases to their canonical action', () => {
    // The canonical-pharmacy migration renames stored grants; these two aliases are
    // also honored at authorization time for any not-yet-migrated grant. The mapping
    // is exact — a dotted alias never behaves like a namespace wildcard.
    expect(capabilityMatches('pharmacy.procurement', 'pharmacy:procurement')).toBe(true);
    expect(capabilityMatches('pharmacy.dispense', 'pharmacy:dispense')).toBe(true);
    expect(capabilityMatches('pharmacy.dispense', 'pharmacy:safety')).toBe(false);
    expect(capabilityMatches('pharmacy.procurement', 'pharmacy:orders')).toBe(false);
  });
  it('matches only exact actions, * and namespace:*', () => {
    expect(capabilityMatches('*', 'pharmacy:dispense')).toBe(true);
    expect(capabilityMatches('pharmacy:*', 'pharmacy:dispense')).toBe(true);
    expect(capabilityMatches('pharmacy:*', 'reports:financial')).toBe(false);
    expect(capabilityMatches('pharmacy:dispense', 'pharmacy:safety')).toBe(false);
    expect(capabilityMatches('*', 'pharmacy.dispense')).toBe(false);
  });

  it('covers the checked pharmacy actions with the owner template', () => {
    const owner = PHARMACY_ROLE_TEMPLATES.find((role) => role.key === 'owner')!;
    for (const action of PHARMACY_CHECKED_CAPABILITIES) {
      expect(ALL_ACTIONS).toContain(action);
      expect(owner.capabilities.some((grant) => capabilityMatches(grant, action))).toBe(true);
    }
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
