import { describe, expect, it } from 'vitest';
import { PHARMACY_SUB_ROLES } from './pharmacy-sub-roles';
import { PHARMACY_WEIGHTY_SUB_ROLES, isWeightyPharmacySubRole } from './pharmacy-sub-role-weight';

describe('DEV-959B: sub-roles that carry extra weight when ticked', () => {
  const keys = new Set(PHARMACY_SUB_ROLES.map((subRole) => subRole.key));

  it('names only real sub-roles, each with one plain line', () => {
    for (const [key, line] of Object.entries(PHARMACY_WEIGHTY_SUB_ROLES)) {
      expect(keys.has(key), key).toBe(true);
      expect(line.split(/(?<=\.)\s/)).toHaveLength(1);
      expect(line, key).not.toMatch(/[a-z]+:[a-z]/);
    }
  });

  it('covers every exact-grant-only sub-role, and cash, approvals and day close', () => {
    for (const subRole of PHARMACY_SUB_ROLES.filter((candidate) => candidate.sensitive))
      expect(isWeightyPharmacySubRole(subRole.key), subRole.key).toBe(true);
    for (const key of ['run-branches', 'close-the-day', 'approve-purchase-orders'])
      expect(isWeightyPharmacySubRole(key), key).toBe(true);
    expect(isWeightyPharmacySubRole('take-payment')).toBe(false);
    expect(isWeightyPharmacySubRole('toString')).toBe(false);
  });
});
