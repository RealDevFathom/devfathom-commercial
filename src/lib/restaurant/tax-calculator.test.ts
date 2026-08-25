import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

import {
  calculateTax,
  resolveTaxRule,
  splitMoney,
  TaxConfigurationError,
  type TaxRule,
} from './tax-calculator';

const at = new Date('2030-06-01T00:00:00Z');
const rule = (overrides: Partial<TaxRule> = {}): TaxRule => ({
  id: 'synthetic-standard',
  paymentCategory: 'SYNTHETIC_CARD',
  priceMode: 'EXCLUSIVE',
  rate: '0.10',
  effectiveFrom: new Date('2030-01-01T00:00:00Z'),
  effectiveTo: new Date('2031-01-01T00:00:00Z'),
  status: 'PUBLISHED',
  approvalReference: 'SYNTHETIC-APPROVAL',
  approvedAt: new Date('2029-12-01T00:00:00Z'),
  sourceExpiresAt: new Date('2031-01-01T00:00:00Z'),
  ...overrides,
});

describe('tax calculator', () => {
  it('calculates exclusive modifiers and discounts while conserving totals', () => {
    const result = calculateTax(
      [
        {
          id: 'meal',
          unitPrice: '100',
          quantity: 2,
          modifierTotal: '10',
          discount: '20',
          paymentCategory: 'SYNTHETIC_CARD',
        },
      ],
      [rule()],
      at
    );
    expect(result.net.toFixed(2)).toBe('200.00');
    expect(result.tax.toFixed(2)).toBe('20.00');
    expect(result.gross.toFixed(2)).toBe('220.00');
  });

  it('extracts inclusive tax with half-up rounding', () => {
    const result = calculateTax(
      [{ id: 'meal', unitPrice: '100', quantity: 1, paymentCategory: 'SYNTHETIC_CARD' }],
      [rule({ priceMode: 'INCLUSIVE', rate: '0.15' })],
      at
    );
    expect(result.lines[0].net.toFixed(2)).toBe('86.96');
    expect(result.lines[0].tax.toFixed(2)).toBe('13.04');
    expect(result.lines[0].gross.toFixed(2)).toBe('100.00');
  });

  it('conserves largest-remainder splits', () => {
    const split = splitMoney('10.00', [1, 1, 1]);
    expect(split.map((value) => value.toFixed(2))).toEqual(['3.34', '3.33', '3.33']);
    expect(Prisma.Decimal.sum(...split).toFixed(2)).toBe('10.00');
  });

  it('uses half-open effective boundaries', () => {
    expect(resolveTaxRule([rule()], 'SYNTHETIC_CARD', new Date('2030-01-01T00:00:00Z')).id).toBe(
      'synthetic-standard'
    );
    expect(() =>
      resolveTaxRule([rule()], 'SYNTHETIC_CARD', new Date('2031-01-01T00:00:00Z'))
    ).toThrow(TaxConfigurationError);
  });

  it.each([
    ['unmapped', [], 'OTHER'],
    ['conflict', [rule(), rule({ id: 'duplicate' })], 'SYNTHETIC_CARD'],
    ['draft', [rule({ status: 'DRAFT' })], 'SYNTHETIC_CARD'],
    ['missing approval', [rule({ approvedAt: null })], 'SYNTHETIC_CARD'],
    ['expired source', [rule({ sourceExpiresAt: at })], 'SYNTHETIC_CARD'],
  ])('fails closed for %s', (_name, rules, category) => {
    expect(() => resolveTaxRule(rules as TaxRule[], category as string, at)).toThrow(
      TaxConfigurationError
    );
  });
});
