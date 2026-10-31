import { describe, expect, it } from 'vitest';
import { calculateInvoiceTotals, createInvoiceInputSchema } from './finance';

const validInvoice = {
  clientId: 'client-1',
  items: [{ description: 'Consulting', quantity: 1, rate: 100, amount: 100 }],
  subtotal: 100,
  tax: 0,
  discount: 0,
  total: 100,
  dueDate: new Date('2026-10-31T00:00:00.000Z'),
};

describe('createInvoiceInputSchema', () => {
  it('requires at least one line item', () => {
    const result = createInvoiceInputSchema.safeParse({ ...validInvoice, items: [] });

    expect(result.success).toBe(false);
  });

  it.each(['subtotal', 'discount', 'tax', 'total'] as const)('rejects a negative %s', (field) => {
    const result = createInvoiceInputSchema.safeParse({ ...validInvoice, [field]: -1 });

    expect(result.success).toBe(false);
  });

  it('accepts a non-negative invoice with a line item', () => {
    expect(createInvoiceInputSchema.safeParse(validInvoice).success).toBe(true);
  });
});

describe('calculateInvoiceTotals', () => {
  it('applies discount and tax to server-derived line totals', () => {
    expect(calculateInvoiceTotals([{ quantity: 2, rate: 12.345 }], 2.5, 5)).toEqual({
      amounts: [24.69],
      subtotal: 24.69,
      discount: 5,
      tax: 2.5,
      total: 22.19,
    });
  });

  it('rounds positive line amounts, discounts, and tax at decimal midpoints', () => {
    expect(calculateInvoiceTotals([{ quantity: 1, rate: 1.005 }], 0.005, 0.005)).toEqual({
      amounts: [1.01],
      subtotal: 1.01,
      discount: 0.01,
      tax: 0.01,
      total: 1.01,
    });
  });

  it('rejects derived values outside the database money range', () => {
    expect(() =>
      calculateInvoiceTotals([{ quantity: 2, rate: 9_999_999_999.99 }])
    ).toThrow('Amount must be 9,999,999,999.99 or less');
  });

  it('rejects a discount greater than the derived subtotal', () => {
    expect(() => calculateInvoiceTotals([{ quantity: 1, rate: 10 }], 0, 10.01)).toThrow(
      'Discount cannot exceed the invoice subtotal'
    );
  });
});
