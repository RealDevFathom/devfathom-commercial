import { describe, expect, it } from 'vitest';

import { invoiceTotalLabel } from './invoice-display';

describe('invoiceTotalLabel', () => {
  it.each([
    [{ total: 125000, currency: 'PKR' }, 'Rs 125,000'],
    [{ total: 125000, currency: 'USD' }, '$125,000'],
  ])('formats an invoice using its own currency', (invoice, expected) => {
    expect(invoiceTotalLabel(invoice)).toBe(expected);
  });
});
