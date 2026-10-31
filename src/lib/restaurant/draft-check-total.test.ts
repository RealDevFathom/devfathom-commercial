import { describe, expect, it } from 'vitest';

import { quoteDraftCheckBreakdown, quoteDraftCheckTotal } from './draft-check-total';
import { MAX_ORDER_ITEM_QUANTITY } from './order-quantity';
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
    const rules = [rule('CASH', '0.10'), rule('CARD', '0.10'), rule('OTHER', '0.10')];
    const preview = quoteDraftCheckBreakdown({
      at,
      profiles: [profile],
      rules,
      lines: [{ id: 'small-item', unitPrice: '0.05', quantity: 3 }],
    });
    const settlement = quoteTaxSettlement({
      at,
      profiles: [profile],
      rules,
      proposedTenderType: 'CASH',
      acceptedPrincipal: '0.18',
      lines: Array.from({ length: 3 }, (_, unitOrdinal) => ({
        id: `small-item:${unitOrdinal}`,
        unitPrice: '0.05',
        quantity: 1,
      })),
    });

    expect(preview).toEqual({ tax: '0.03', serviceCharge: '0.00', total: '0.18' });
    expect(settlement.tax.toFixed(2)).toBe(preview.tax);
    expect(settlement.grandTotal.toFixed(2)).toBe(preview.total);
    expect(settlement.roundingAdjustment.toFixed(2)).toBe('0.00');
    expect(settlement.remainingDue.toFixed(2)).toBe('0.00');
  });

  it('applies modifiers to every expanded unit', () => {
    expect(
      quoteDraftCheckBreakdown({
        at,
        profiles: [profile],
        rules: [rule('CASH', '0.10'), rule('CARD', '0.10'), rule('OTHER', '0.10')],
        lines: [{ id: 'small-item', unitPrice: '0.04', quantity: 2, modifierDeltas: ['0.01'] }],
      })
    ).toEqual({ tax: '0.02', serviceCharge: '0.00', total: '0.12' });
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects invalid quantity %s before quoting', (quantity) => {
    expect(() =>
      quoteDraftCheckBreakdown({
        at,
        lines: [{ id: 'invalid', unitPrice: '1.00', quantity }],
      })
    ).toThrow(RangeError);
  });

  it('accepts a quantity within the order-line limit', () => {
    expect(
      quoteDraftCheckTotal({
        at,
        lines: [{ id: 'valid', unitPrice: '0.01', quantity: MAX_ORDER_ITEM_QUANTITY }],
      })
    ).toBe('1.00');
  });

  it('accepts an aggregate quantity at the former draft-check limit', () => {
    const lines = Array.from({ length: 10_000 / MAX_ORDER_ITEM_QUANTITY }, (_, index) => ({
      id: `item-${index}`,
      unitPrice: '0.01',
      quantity: MAX_ORDER_ITEM_QUANTITY,
    }));

    expect(quoteDraftCheckTotal({ at, lines })).toBe('100.00');
  });

  it('quotes orders above the former aggregate limit without expanding units', () => {
    const fullLines = 10_000 / MAX_ORDER_ITEM_QUANTITY;
    const lines = Array.from({ length: fullLines + 1 }, (_, index) => ({
      id: `item-${index}`,
      unitPrice: '0.01',
      quantity: MAX_ORDER_ITEM_QUANTITY,
    }));

    expect(quoteDraftCheckBreakdown({ at, lines })).toEqual({
      tax: '0.00',
      serviceCharge: '0.00',
      total: '101.00',
    });
  });

  it.each(['EXCLUSIVE', 'INCLUSIVE'] as const)(
    'quotes legacy quantities with per-unit %s rounding, modifiers, service and delivery',
    (priceMode) => {
      const rules = [rule('CASH', '0.10')].map((rule) => ({ ...rule, priceMode }));
      const quantity = MAX_ORDER_ITEM_QUANTITY + 1;
      const preview = quoteDraftCheckBreakdown({
        at,
        profiles: [profile],
        rules,
        lines: [
          { id: 'legacy', unitPrice: '0.05', quantity, modifierDeltas: ['0.01'] },
          { id: 'other', unitPrice: '0.05', quantity: 3 },
        ],
        serviceChargeRate: '0.10',
        deliveryFee: '1.00',
      });
      const settlement = quoteTaxSettlement({
        at,
        profiles: [profile],
        rules,
        proposedTenderType: 'CASH',
        lines: [
          ...Array.from({ length: quantity }, (_, index) => ({
            id: `legacy:${index}`,
            unitPrice: '0.05',
            modifierTotal: '0.01',
            quantity: 1,
          })),
          ...Array.from({ length: 3 }, (_, index) => ({
            id: `other:${index}`,
            unitPrice: '0.05',
            quantity: 1,
          })),
        ],
        serviceCharge: { amount: '0.62', taxable: false },
      });

      expect(preview.tax).toBe(settlement.tax.toFixed(2));
      expect(preview.serviceCharge).toBe('0.62');
      expect(preview.total).toBe(settlement.grandTotal.plus('1.00').toFixed(2));
    }
  );

  it('quotes the largest persisted integer quantity without per-unit allocation', () => {
    expect(
      quoteDraftCheckBreakdown({
        at,
        profiles: [profile],
        rules: [rule('CASH', '0.10')],
        lines: [{ id: 'legacy-large', unitPrice: '0.05', quantity: 2_147_483_647 }],
      })
    ).toEqual({ tax: '21474836.47', serviceCharge: '0.00', total: '128849018.82' });
  });
});
