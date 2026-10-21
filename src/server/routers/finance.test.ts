import { describe, expect, it } from 'vitest';
import { createInvoiceInputSchema } from './finance';

const validInvoice = {
  clientId: 'client-1',
  items: [{ description: 'Consulting', quantity: 1, rate: 100, amount: 100 }],
  subtotal: 100,
  tax: 0,
  total: 100,
  dueDate: new Date('2026-10-31T00:00:00.000Z'),
};

describe('createInvoiceInputSchema', () => {
  it('requires at least one line item', () => {
    const result = createInvoiceInputSchema.safeParse({ ...validInvoice, items: [] });

    expect(result.success).toBe(false);
  });

  it.each(['subtotal', 'tax', 'total'] as const)('rejects a negative %s', (field) => {
    const result = createInvoiceInputSchema.safeParse({ ...validInvoice, [field]: -1 });

    expect(result.success).toBe(false);
  });

  it('accepts a non-negative invoice with a line item', () => {
    expect(createInvoiceInputSchema.safeParse(validInvoice).success).toBe(true);
  });
});
