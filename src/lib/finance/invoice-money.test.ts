import { describe, expect, it } from 'vitest';
import { calculateInvoiceMoney } from './invoice-money';

describe('calculateInvoiceMoney', () => {
  it('calculates tax and discount from the sum of already-rounded line amounts', () => {
    const result = calculateInvoiceMoney(
      [
        { description: 'First', quantity: 1.005, rate: 1 },
        { description: 'Second', quantity: 1.005, rate: 1 },
      ],
      0.25,
      0.5
    );

    expect(result.items.map((line) => line.amount)).toEqual([1, 1]);
    expect(result).toMatchObject({ subtotal: 2, discount: 0.5, tax: 0.25, total: 1.75 });
  });

  it('rejects a discount greater than the subtotal', () => {
    expect(() =>
      calculateInvoiceMoney([{ description: 'Work', quantity: 1, rate: 10 }], 0, 10.01)
    ).toThrow('Discount cannot exceed the invoice subtotal');
  });
});
