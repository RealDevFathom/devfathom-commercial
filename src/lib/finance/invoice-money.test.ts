import { describe, expect, it } from 'vitest';
import { calculateInvoiceMoney, invoiceLineCents, moneyCents } from './invoice-money';

describe('calculateInvoiceMoney invoice form preview', () => {
  it('rounds a line-item decimal midpoint half up to match persistence', () => {
    expect(calculateInvoiceMoney([{ quantity: 1, rate: 1.005 }])).toMatchObject({
      amounts: [1.01],
      subtotal: 1.01,
      total: 1.01,
    });
  });

  it('accepts a discount equal to the rounded subtotal', () => {
    const preview = calculateInvoiceMoney([{ quantity: 1, rate: 1.005 }], 0, 1.01);

    expect(preview.discountCents).toBe(preview.subtotalCents);
    expect(preview.total).toBe(0);
  });

  it('adds and subtracts decimal adjustments without floating-point drift', () => {
    const preview = calculateInvoiceMoney([{ quantity: 3, rate: 0.1 }], 0.2, 0.1);

    expect(preview).toMatchObject({
      subtotalCents: 30n,
      discountCents: 10n,
      taxCents: 20n,
      totalCents: 40n,
      total: 0.4,
    });
  });

  it('preserves the DECIMAL(12,2) maximum exactly in cents', () => {
    const preview = calculateInvoiceMoney([{ quantity: 1, rate: 9_999_999_999.99 }]);

    expect(preview.subtotalCents).toBe(999_999_999_999n);
    expect(preview.totalCents).toBe(999_999_999_999n);
    expect(preview.total).toBe(9_999_999_999.99);
  });
});

describe('moneyCents signed rounding', () => {
  it.each([
    [-0.2, -20n],
    [0.1 - 0.3, -20n],
    [-1.004, -100n],
    [-1.005, -101n],
    [-1.006, -101n],
    [-0.005, -1n],
    [-1e-7, 0n],
    [-1e3, -100000n],
  ])('rounds %s to %s cents', (amount, expected) => {
    expect(moneyCents(amount)).toBe(expected);
    expect(moneyCents(-amount)).toBe(-expected);
  });

  it('rounds a negative decimal line midpoint away from zero', () => {
    expect(invoiceLineCents({ quantity: 3, rate: -0.335 })).toBe(-101n);
  });
});
