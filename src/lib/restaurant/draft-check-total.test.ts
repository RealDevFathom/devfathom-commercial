import { describe, expect, it } from 'vitest';

import { quoteDraftCheckBreakdown, quoteDraftCheckTotal } from './draft-check-total';
import { quoteTaxSettlement, type TaxProfile, type TaxRule } from './tax-calculator';

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

  it('keeps two decimal places when tax, service, and delivery are zero', () => {
    expect(
      quoteDraftCheckTotal({
        at,
        lines: [{ id: 'coffee', unitPrice: '4.00', quantity: 1, modifierDeltas: ['0.50'] }],
      })
    ).toBe('4.50');
  });

  it('rounds tax per unit to match settlement for multi-quantity lines', () => {
    const quote = quoteDraftCheckBreakdown({
      at,
      profiles: [profile],
      rules: [rule('CASH', '0.10'), rule('CARD', '0.10'), rule('OTHER', '0.10')],
      lines: [{ id: 'small-item', unitPrice: '0.05', quantity: 3 }],
    });

    // Settlement expands this to three units: each 0.005 tax rounds to 0.01.
    expect(quote).toEqual({ tax: '0.03', serviceCharge: '0.00', total: '0.18' });
  });

  it.each([
    { quantity: 150_000, tax: '1500.00', total: '9000.00' },
    { quantity: 2_147_483_647, tax: '21474836.47', total: '128849018.82' },
  ])('quotes $quantity units without expanding every physical unit', ({ quantity, tax, total }) => {
    expect(
      quoteDraftCheckBreakdown({
        at,
        profiles: [profile],
        rules: [rule('CASH', '0.10'), rule('CARD', '0.10'), rule('OTHER', '0.10')],
        lines: [{ id: 'bulk-item', unitPrice: '0.05', quantity }],
      })
    ).toEqual({ tax, serviceCharge: '0.00', total });
  });

  it('quotes large quantities with the default zero-tax configuration', () => {
    expect(
      quoteDraftCheckTotal({
        at,
        lines: [{ id: 'bulk-item', unitPrice: '1.00', quantity: 150_000 }],
      })
    ).toBe('150000.00');
  });

  it.each(['EXCLUSIVE', 'INCLUSIVE'] as const)(
    'matches per-unit settlement with %s tax, modifiers, service, and delivery',
    (priceMode) => {
      for (const rate of ['0', '0.05', '0.10']) {
        const rules = [rule('CASH', rate), rule('CARD', rate), rule('OTHER', rate)].map((rule) => ({
          ...rule,
          priceMode,
        }));
        const lines = [
          { id: 'small', unitPrice: '0.05', quantity: 3, modifierDeltas: [] },
          { id: 'rounded', unitPrice: '10.005', quantity: 2, modifierDeltas: ['0.10', '-0.005'] },
          { id: 'free', unitPrice: '0', quantity: 4, modifierDeltas: [] },
          { id: 'sub-cent', unitPrice: '0.004', quantity: 2, modifierDeltas: [] },
        ];
        for (const service of [
          { serviceCharge: '2.50' },
          { serviceCharge: '9.99', serviceChargeRate: '0.10' },
        ]) {
          // The unrounded pre-tax basis is 20.368, so the 10% service charge is 2.04.
          const serviceAmount = 'serviceChargeRate' in service ? '2.04' : '2.50';
          const settlement = quoteTaxSettlement({
            at,
            profiles: [profile],
            rules,
            proposedTenderType: 'CASH',
            serviceCharge: { amount: serviceAmount, taxable: false },
            lines: lines.flatMap((line) =>
              Array.from({ length: line.quantity }, (_, ordinal) => ({
                id: `${line.id}:${ordinal}`,
                unitPrice: line.unitPrice,
                quantity: 1,
                modifierTotal: line.id === 'rounded' ? '0.10' : '0.00',
              }))
            ),
          });

          expect(
            quoteDraftCheckBreakdown({
              at,
              profiles: [profile],
              rules,
              lines,
              ...service,
              deliveryFee: '4.00',
            })
          ).toEqual({
            tax: settlement.tax.toFixed(2),
            serviceCharge: serviceAmount,
            total: settlement.grandTotal.plus('4.00').toFixed(2),
          });
        }
      }
    }
  );

  it('quotes an empty draft with flat service and delivery charges', () => {
    expect(
      quoteDraftCheckBreakdown({ at, lines: [], serviceCharge: '2.50', deliveryFee: '4.00' })
    ).toEqual({ tax: '0.00', serviceCharge: '2.50', total: '6.50' });
  });

  it.each([0, -1, 1.5, NaN, Infinity])('continues to reject invalid quantity %s', (quantity) => {
    expect(() =>
      quoteDraftCheckTotal({
        at,
        lines: [{ id: 'invalid', unitPrice: '1.00', quantity }],
      })
    ).toThrow('Invalid quantity for invalid');
  });
});
