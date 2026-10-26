import { describe, expect, it } from 'vitest';
import { calculateInvoiceMoney } from './invoice-money';

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
});
