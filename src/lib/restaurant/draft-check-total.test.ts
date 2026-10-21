import { describe, expect, it } from 'vitest';

import {
  DraftCheckTaxError,
  quoteDraftCheckBreakdown,
  quoteDraftCheckTotal,
} from './draft-check-total';
import type { TaxProfile, TaxRule } from './tax-calculator';

const at = new Date('2030-06-01T00:00:00Z');

const profile: TaxProfile = {
  id: 'synthetic-profile',
  effectiveFrom: new Date('2030-01-01T00:00:00Z'),
  effectiveTo: new Date('2031-01-01T00:00:00Z'),
  status: 'PUBLISHED',
  approvalReference: 'SYNTHETIC-PROFILE-APPROVAL',
  approvedAt: new Date('2029-12-01T00:00:00Z'),
};

function rule(category: 'CASH' | 'CARD' | 'OTHER', rate: string): TaxRule {
  return {
    id: `synthetic-${category.toLowerCase()}`,
    profileVersionId: profile.id,
    paymentCategory: category,
    priceMode: 'EXCLUSIVE',
    rate,
    effectiveFrom: profile.effectiveFrom,
    effectiveTo: profile.effectiveTo,
    status: 'PUBLISHED',
    approvalReference: 'SYNTHETIC-APPROVAL',
    approvedAt: profile.approvedAt,
    sourceExpiresAt: profile.effectiveTo,
  };
}

describe('quoteDraftCheckTotal', () => {
  it('includes modifier deltas, tax, service, and delivery without truncating a third decimal', () => {
    const total = quoteDraftCheckTotal({
      at,
      profiles: [profile],
      rules: [rule('CASH', '0.05'), rule('CARD', '0.10'), rule('OTHER', '0.00')],
      serviceCharge: '2.00',
      deliveryFee: '4.00',
      lines: [{ id: 'steak', unitPrice: '10.00', quantity: 1, modifierDeltas: ['1.50'] }],
    });
    // 10.00 + 1.50 = 11.50; tax 5% = 0.58; service 2.00; delivery 4.00.
    expect(total).toBe('18.08');
    expect(
      quoteDraftCheckTotal({
        at,
        profiles: [profile],
        rules: [rule('CASH', '0'), rule('CARD', '0'), rule('OTHER', '0')],
        lines: [{ id: 'rounded', unitPrice: '10.005', quantity: 1 }],
      })
    ).toBe('10.01');
  });

  it('applies a branch service-charge rate to the pre-tax basis', () => {
    expect(
      quoteDraftCheckTotal({
        at,
        profiles: [profile],
        rules: [rule('CASH', '0.05'), rule('CARD', '0.10'), rule('OTHER', '0.00')],
        serviceChargeRate: '0.10',
        lines: [{ id: 'coffee', unitPrice: '4.00', quantity: 1, modifierDeltas: ['0.50'] }],
      })
    ).toBe('5.18');
  });

  it('treats a zero service-charge rate as no charge', () => {
    expect(
      quoteDraftCheckTotal({
        at,
        profiles: [profile],
        rules: [rule('CASH', '0'), rule('CARD', '0'), rule('OTHER', '0')],
        serviceChargeRate: '0',
        lines: [{ id: 'coffee', unitPrice: '4.00', quantity: 1, modifierDeltas: ['0.50'] }],
      })
    ).toBe('4.50');
  });

  it('keeps two decimal places when a published profile charges no tax', () => {
    expect(
      quoteDraftCheckTotal({
        at,
        profiles: [profile],
        rules: [rule('CASH', '0'), rule('CARD', '0'), rule('OTHER', '0')],
        lines: [{ id: 'coffee', unitPrice: '4.00', quantity: 1, modifierDeltas: ['0.50'] }],
      })
    ).toBe('4.50');
  });

  it('reports the cash tender it quotes under, so the UI can flag a differing card rate', () => {
    const breakdown = quoteDraftCheckBreakdown({
      at,
      profiles: [profile],
      rules: [rule('CASH', '0.05'), rule('CARD', '0.10'), rule('OTHER', '0.00')],
      lines: [{ id: 'steak', unitPrice: '10.00', quantity: 1 }],
    });
    // Priced at the 5% cash rate, not the 10% card rate.
    expect(breakdown.tax).toBe('0.50');
    expect(breakdown.tenderType).toBe('CASH');
  });

  it('fails closed when no tax profile is in effect', () => {
    expect(() =>
      quoteDraftCheckTotal({
        at,
        lines: [{ id: 'coffee', unitPrice: '4.00', quantity: 1 }],
      })
    ).toThrow(DraftCheckTaxError);
    expect(() =>
      quoteDraftCheckTotal({
        at,
        profiles: [],
        rules: [],
        lines: [{ id: 'coffee', unitPrice: '4.00', quantity: 1 }],
      })
    ).toThrow('No tax profile is in effect.');
  });
});
