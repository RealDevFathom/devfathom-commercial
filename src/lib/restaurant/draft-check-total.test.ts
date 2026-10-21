import { describe, expect, it } from 'vitest';

import { quoteDraftCheckTotal } from './draft-check-total';
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
        lines: [{ id: 'rounded', unitPrice: '10.005', quantity: 1 }],
      })
    ).toBe('10.01');
  });

  it('keeps two decimal places when tax, service, and delivery are zero', () => {
    expect(
      quoteDraftCheckTotal({
        at,
        lines: [{ id: 'coffee', unitPrice: '4.00', quantity: 1, modifierDeltas: ['0.50'] }],
      })
    ).toBe('4.50');
  });
});
