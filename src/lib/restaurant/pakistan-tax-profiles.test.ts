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

  it('represents the verified Sindh, KP, and ICT rates without flattening entity classes', () => {
    expect(rates('PK-SD-RESTAURANT')).toEqual({ CASH: '0.15', CARD: '0.08', OTHER: '0.15' });
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
    expect(findPakistanTaxProfile('PK-SD-RESTAURANT')?.eligibilityControls).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'sindhNoInputTaxCreditOrAdjustment' })])
    );
    expect(findPakistanTaxProfile('PK-KP-RESTAURANT-ORDINARY')?.eligibilityControls).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'kpNoInputTaxCreditOrAdjustment' })])
    );
    expect(findPakistanTaxProfile('PK-ICT-RESTAURANT')?.eligibilityControls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'ictNoInputTaxCreditOrAdjustment' }),
        expect.objectContaining({ id: 'ictNoRefund' }),
      ])
    );
  });

  it('disables the listed Sindh preset until its official branch evidence is pinned again', () => {
    expect(findPakistanTaxProfile('PK-SD-RESTAURANT-LISTED')).toMatchObject({
      enabled: false,
      disabledReason:
        'Unavailable until current official SRB listed-branch evidence is pinned and reverified.',
      sourceContentHash: null,
      rules: [],
    });
    expect(JSON.stringify(PAKISTAN_TAX_PROFILE_CATALOG)).not.toContain('122743bc');
  });

  it('disables Balochistan until an official instrument is pinned', () => {
    const reduced = findPakistanTaxProfile('PK-BA-RESTAURANT-BRA-POS');
    expect(reduced).toMatchObject({ enabled: false, rules: [], sourceTitle: 'iBRA portal' });
    expect(findPakistanTaxProfile('PK-BA-RESTAURANT-STANDARD')).toMatchObject({
      enabled: false,
      rules: [],
      sourceTitle: 'Balochistan Revenue Authority frequently asked questions',
    });
    expect(JSON.stringify(PAKISTAN_TAX_PROFILE_CATALOG)).not.toMatch(/Finance Act 2026|WHA-526/i);
  });
});
