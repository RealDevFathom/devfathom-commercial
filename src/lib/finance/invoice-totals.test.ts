import { describe, expect, it } from 'vitest';
import { calculateInvoiceTotals } from './invoice-totals';

describe('calculateInvoiceTotals', () => {
  it('subtracts the discount before adding tax', () => {
    expect(
      calculateInvoiceTotals(
        [
          { quantity: 2, rate: 25 },
          { quantity: 1, rate: 10 },
        ],
        5,
        7.5
      )
    ).toEqual({ subtotal: 60, discount: 7.5, tax: 5, total: 57.5 });
  });

  it('rounds every persisted money value to cents', () => {
    expect(calculateInvoiceTotals([{ quantity: 3, rate: 0.335 }], 0.105, 0.205)).toEqual({
      subtotal: 1.01,
      discount: 0.21,
      tax: 0.11,
      total: 0.91,
    });
  });

  it('rejects a discount greater than the subtotal', () => {
    expect(() => calculateInvoiceTotals([{ quantity: 1, rate: 10 }], 0, 10.01)).toThrow(
      'Discount cannot exceed the subtotal'
    );
  });
});
