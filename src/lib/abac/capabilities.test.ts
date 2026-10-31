import { describe, expect, it } from 'vitest';
import { PHARMACY_CHECKED_CAPABILITIES, PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { capabilityMatches } from './capabilities';
import { ALL_ACTIONS } from './policies';

export const intendedPharmacyGrants = {
  owner: [
    'pharmacy:*',
    'reports:operational',
    'reports:financial',
    'pharmacy:dispense',
    'pharmacy:safety',
    'pharmacy:catalogue-review',
  ],
  'owner-operator': [
    'reports:operational',
    'reports:financial',
    'pharmacy:orders',
    'pharmacy:dispense',
    'pharmacy:catalogue-review',
    'pharmacy:safety',
  ],
  pharmacist: ['pharmacy:dispense', 'pharmacy:catalogue-review', 'pharmacy:close'],
  manager: [
    'pharmacy:manage',
    'pharmacy:orders',
    'pharmacy:procurement',
    'pharmacy:counter',
    'pharmacy:inventory',
  ],
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
      // The owner's pharmacy:* never reaches the exact-grant-only actions.
      expect(owner.capabilities.some((grant) => capabilityMatches(grant, action))).toBe(true);
    }
  });

  it.each([
    ['pharmacist', ['pharmacy:dispense', 'pharmacy:catalogue-review', 'pharmacy:close']],
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
  const sensitive = ['pharmacy:dispense', 'pharmacy:safety', 'pharmacy:catalogue-review'];

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
