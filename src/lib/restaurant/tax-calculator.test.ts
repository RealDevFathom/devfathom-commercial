import { describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import {
  calculateTax,
  mapTenderTypeToPaymentCategory,
  quoteTaxSettlement,
  resolveTaxRule,
  splitMoney,
  TaxConfigurationError,
  TaxPaymentCategoryError,
  type PaymentCategory,
  type TaxRule,
} from './tax-calculator';

const at = new Date('2030-06-01T00:00:00Z');
const rule = (
  category: PaymentCategory,
  rate: string,
  overrides: Partial<TaxRule> = {}
): TaxRule => ({
  id: `synthetic-${category.toLowerCase()}`,
  paymentCategory: category,
  priceMode: 'EXCLUSIVE',
  rate,
  effectiveFrom: new Date('2030-01-01T00:00:00Z'),
  effectiveTo: new Date('2031-01-01T00:00:00Z'),
  status: 'PUBLISHED',
  approvalReference: 'SYNTHETIC-APPROVAL',
  approvedAt: new Date('2029-12-01T00:00:00Z'),
  sourceExpiresAt: new Date('2031-01-01T00:00:00Z'),
  ...overrides,
});
const rules = [rule('CASH', '0.05'), rule('CARD', '0.10'), rule('OTHER', '0.20')];
const line = { id: 'meal', unitPrice: '100', quantity: 1 };

describe('tax calculator G1 mapping', () => {
  it('tax_tender_type_maps_reserved_category_and_rejects_raw_payment_category', () => {
    expect(['CASH', 'CARD', 'OTHER'].map(mapTenderTypeToPaymentCategory)).toEqual([
      'CASH',
      'CARD',
      'OTHER',
    ]);
    expect(() => mapTenderTypeToPaymentCategory('GIFT')).toThrow(TaxPaymentCategoryError);
    expect(() =>
      calculateTax([{ ...line, paymentCategory: 'CASH' } as never], rules, at, 'CARD')
    ).toThrow('Raw paymentCategory input is forbidden');
  });

  it('tax_other_never_infers_gift_voucher_or_loyalty_subtype', () => {
    const quote = quoteTaxSettlement({ lines: [line], rules, at, proposedTenderType: 'OTHER' });
    expect(quote.lines[0].buckets[0].category).toBe('OTHER');
    expect(quote.lines[0].buckets[0].ruleId).toBe('synthetic-other');
  });
});

describe('tax calculator G2 cent arithmetic', () => {
  it('tax_quote_cash_card_other_uses_effective_category_rule', () => {
    expect(
      (['CASH', 'CARD', 'OTHER'] as const).map((proposedTenderType) =>
        quoteTaxSettlement({ lines: [line], rules, at, proposedTenderType }).grandTotal.toFixed(2)
      )
    ).toEqual(['105.00', '110.00', '120.00']);
  });

  it('tax_split_final_category_receives_residual_without_fixed_point', () => {
    const quote = quoteTaxSettlement({
      lines: [line],
      rules,
      at,
      priorTenders: [{ tenderType: 'CASH', principal: '40' }],
      proposedTenderType: 'CARD',
    });
    expect([quote.weights.CASH.toFixed(2), quote.weights.CARD.toFixed(2)]).toEqual([
      '40.00',
      '60.00',
    ]);
    expect([
      quote.tax.toFixed(2),
      quote.grandTotal.toFixed(2),
      quote.remainingDue.toFixed(2),
    ]).toEqual(['8.00', '108.00', '68.00']);
  });

  it('tax_split_allocates_each_line_by_largest_remainder_category_order', () => {
    const split = splitMoney('10.01', [1, 1, 1]);
    expect(split.map((value) => value.toFixed(2))).toEqual(['3.34', '3.34', '3.33']);
    expect(Prisma.Decimal.sum(...split).toFixed(2)).toBe('10.01');
    const quote = quoteTaxSettlement({
      lines: [{ id: 'odd-cent', unitPrice: '10.01', quantity: 1 }],
      rules,
      at,
      priorTenders: [
        { tenderType: 'CASH', principal: '1' },
        { tenderType: 'CARD', principal: '1' },
      ],
      proposedTenderType: 'OTHER',
    });
    expect(
      quote.lines[0].buckets
        .reduce((sum, bucket) => sum.plus(bucket.consideration), new Prisma.Decimal(0))
        .toFixed(2)
    ).toBe('10.01');
  });

  it('tax_mixed_inclusive_exclusive_extracts_or_adds_once', () => {
    const inclusiveRules = [
      rule('CASH', '0.10', { priceMode: 'INCLUSIVE' }),
      rule('CARD', '0.25', { priceMode: 'INCLUSIVE' }),
    ];
    const quote = quoteTaxSettlement({
      lines: [{ id: 'inclusive', unitPrice: '110', quantity: 1 }],
      rules: inclusiveRules,
      at,
      priorTenders: [{ tenderType: 'CASH', principal: '55' }],
      proposedTenderType: 'CARD',
    });
    expect(
      quote.lines[0].buckets.map((bucket) => [bucket.net.toFixed(2), bucket.tax.toFixed(2)])
    ).toEqual([
      ['50.00', '5.00'],
      ['44.00', '11.00'],
    ]);
    expect([quote.grandTotal.toFixed(2), quote.remainingDue.toFixed(2)]).toEqual([
      '110.00',
      '55.00',
    ]);
  });

  it('tax_before_after_discount_preserves_tax_basis', () => {
    const quote = quoteTaxSettlement({
      lines: [{ id: 'meal', unitPrice: '50', quantity: 1, comp: '10', beforeTaxDiscount: '5' }],
      rules: [rule('CARD', '0.10')],
      at,
      proposedTenderType: 'CARD',
      afterTaxDiscount: '2',
    });
    expect([
      quote.lines[0].consideration.toFixed(2),
      quote.tax.toFixed(2),
      quote.grandTotal.toFixed(2),
    ]).toEqual(['35.00', '3.50', '36.50']);
  });

  it('tax_comp_service_charge_and_rounding_pipeline_reconciles', () => {
    const quote = quoteTaxSettlement({
      lines: [{ id: 'meal', unitPrice: '50', quantity: 1, comp: '10', beforeTaxDiscount: '5' }],
      rules: [rule('CARD', '0.10')],
      at,
      proposedTenderType: 'CARD',
      afterTaxDiscount: '2',
      serviceCharge: { amount: '5', taxable: false },
      roundingAdjustment: '0.01',
    });
    expect([
      quote.tax.toFixed(2),
      quote.serviceChargePayable.toFixed(2),
      quote.roundingAdjustment.toFixed(2),
      quote.grandTotal.toFixed(2),
    ]).toEqual(['3.50', '5.00', '0.01', '41.51']);
  });
});

describe('effective rule resolution', () => {
  it('uses half-open effective boundaries', () => {
    expect(resolveTaxRule([rule('CARD', '0.1')], 'CARD', new Date('2030-01-01T00:00:00Z')).id).toBe(
      'synthetic-card'
    );
    expect(() =>
      resolveTaxRule([rule('CARD', '0.1')], 'CARD', new Date('2031-01-01T00:00:00Z'))
    ).toThrow(TaxConfigurationError);
  });

  it.each([
    ['unmapped', [], 'OTHER'],
    ['conflict', [rule('CARD', '0.1'), rule('CARD', '0.2')], 'CARD'],
    ['draft', [rule('CARD', '0.1', { status: 'DRAFT' })], 'CARD'],
    ['missing approval', [rule('CARD', '0.1', { approvedAt: null })], 'CARD'],
    ['expired source', [rule('CARD', '0.1', { sourceExpiresAt: at })], 'CARD'],
  ] as const)('fails closed for %s', (_name, candidateRules, category) => {
    expect(() => resolveTaxRule([...candidateRules], category, at)).toThrow(TaxConfigurationError);
  });
});
