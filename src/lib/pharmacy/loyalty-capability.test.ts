import { describe, expect, it } from 'vitest';

import { capabilityMatches, EXACT_GRANT_ONLY_ACTIONS } from '@/lib/abac/capabilities';
import { ALL_ACTIONS, POLICIES } from '@/lib/abac/policies';
import {
  PHARMACY_CAPABILITIES,
  PHARMACY_CHECKED_CAPABILITIES,
  PHARMACY_ROLE_TEMPLATES,
} from '@/lib/vertical-catalog';

const ACTION = 'pharmacy:loyalty-manage';
const grants = (key: string) =>
  PHARMACY_ROLE_TEMPLATES.find((role) => role.key === key)!.capabilities.some((capability) =>
    capabilityMatches(capability, ACTION)
  );

/**
 * Loyalty settings (rates, point value, redemption minimum, expiry, tiers, voucher scope)
 * are owner policy (decisions/loyalty-points-defaults.md, loyalty-voucher-scope.md).
 */
describe('pharmacy:loyalty-manage is a registered capability', () => {
  it('is a canonical ABAC action with no static policy, so only grants allow it', () => {
    expect(ALL_ACTIONS).toContain(ACTION);
    expect(POLICIES[ACTION]).toEqual([]);
  });

  it('is in the pharmacy capability catalogue and the checked set, like other pharmacy actions', () => {
    expect(PHARMACY_CAPABILITIES).toContain(ACTION);
    expect(PHARMACY_CHECKED_CAPABILITIES).toContain(ACTION);
  });

  it('reaches the Owner the intended way: through the canonical pharmacy:* grant', () => {
    // The Owner template stays exactly the #130 canonical grant set, which every migrated
    // Owner role already holds (20261021110000), so new and existing Owners get it alike.
    const owner = PHARMACY_ROLE_TEMPLATES.find((role) => role.key === 'owner')!;
    expect(owner.capabilities).toEqual(['pharmacy:*', 'reports:operational', 'reports:financial']);
    expect(EXACT_GRANT_ONLY_ACTIONS.has(ACTION)).toBe(false);
    expect(capabilityMatches('pharmacy:*', ACTION)).toBe(true);
  });

  it('is granted by no other pharmacy role template', () => {
    const holders = PHARMACY_ROLE_TEMPLATES.filter((role) => grants(role.key)).map(
      (role) => role.key
    );
    expect(holders).toEqual(['owner']);
  });

  it('is revoked by an exact or a wildcard DENY', () => {
    expect(capabilityMatches(ACTION, ACTION, 'DENY')).toBe(true);
    expect(capabilityMatches('pharmacy:*', ACTION, 'DENY')).toBe(true);
    expect(capabilityMatches('*', ACTION, 'DENY')).toBe(true);
  });
});
