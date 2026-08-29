import { describe, expect, it } from 'vitest';

import { findPakistanTaxProfile, PAKISTAN_TAX_PROFILE_CATALOG } from './pakistan-tax-profiles';

function rates(id: string) {
  const profile = findPakistanTaxProfile(id);
  if (!profile) throw new Error(`Missing fixture ${id}`);
  return Object.fromEntries(profile.rules.map((rule) => [rule.paymentCategory, rule.rate]));
}

describe('authoritative Pakistan restaurant tax profile catalog', () => {
  it('has no country-wide default and keeps Punjab disabled', () => {
    expect(PAKISTAN_TAX_PROFILE_CATALOG.map((profile) => String(profile.id))).not.toContain('PK');
    expect(findPakistanTaxProfile('PK-PB-RESTAURANT')).toMatchObject({
      enabled: false,
      effectiveFrom: null,
      rules: [],
    });
  });

  it('represents the D02 Sindh, KP, and ICT rates without flattening entity classes', () => {
    expect(rates('PK-SD-RESTAURANT')).toEqual({ CASH: '0.15', CARD: '0.08', OTHER: '0.15' });
    expect(rates('PK-SD-RESTAURANT-LISTED')).toEqual({ CASH: '0.15', CARD: '0.15', OTHER: '0.15' });
    expect(rates('PK-KP-RESTAURANT-ORDINARY')).toEqual({
      CASH: '0.10',
      CARD: '0.06',
      OTHER: '0.10',
    });
    expect(rates('PK-KP-RESTAURANT-CORPORATE')).toEqual({
      CASH: '0.15',
      CARD: '0.06',
      OTHER: '0.15',
    });
    expect(rates('PK-ICT-RESTAURANT')).toEqual({ CASH: '0.15', CARD: '0.05', OTHER: '0.15' });
    expect(rates('PK-ICT-CATERER')).toEqual({ CASH: '0.15', CARD: '0.15', OTHER: '0.15' });
  });

  it('makes every BRA reduced-rate predicate explicit and excludes stale mechanics', () => {
    expect(rates('PK-BA-RESTAURANT-STANDARD')).toEqual({
      CASH: '0.08',
      CARD: '0.08',
      OTHER: '0.08',
    });
    const reduced = findPakistanTaxProfile('PK-BA-RESTAURANT-BRA-POS');
    expect(reduced?.effectiveFrom).toBe('2026-07-01');
    expect(rates('PK-BA-RESTAURANT-BRA-POS')).toEqual({
      CASH: '0.04',
      CARD: '0.04',
      OTHER: '0.04',
    });
    expect(reduced?.eligibilityControls.map((control) => control.id)).toEqual([
      'braLinkedPos',
      'allElectronic',
      'noInputAdjustment',
      'notExcludedPremises',
      'notFranchise',
    ]);
    expect(JSON.stringify(PAKISTAN_TAX_PROFILE_CATALOG)).not.toMatch(/15,?000|utility.bill/i);
  });
});
