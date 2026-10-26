import { describe, expect, it } from 'vitest';
import { moneyListLabel } from './currency';
import { clientInvoiceTotals } from './client-invoice-totals';

describe('clientInvoiceTotals', () => {
  it('keeps paid revenue and outstanding balances separate by currency and status', () => {
    const totals = clientInvoiceTotals([
      { status: 'PAID', currency: 'PKR', total: '100.10' },
      { status: 'PAID', currency: 'USD', total: '100.20' },
      { status: 'PAID', currency: 'USD', total: '0.10' },
      { status: 'SENT', currency: 'PKR', total: '30.20' },
      { status: 'OVERDUE', currency: 'USD', total: '20.10' },
      { status: 'DRAFT', currency: 'USD', total: '9000' },
      { status: 'CANCELLED', currency: 'PKR', total: '8000' },
    ]);

    expect(totals).toEqual({
      revenue: [
        { currency: 'USD', amount: 100.3 },
        { currency: 'PKR', amount: 100.1 },
      ],
      outstanding: [
        { currency: 'USD', amount: 20.1 },
        { currency: 'PKR', amount: 30.2 },
      ],
    });
    expect(moneyListLabel(totals.revenue)).toBe('$100.3 · Rs 100.1');
    expect(moneyListLabel(totals.outstanding)).toBe('$20.1 · Rs 30.2');
  });

  it('returns empty totals that render as zero when there are no relevant invoices', () => {
    const totals = clientInvoiceTotals([
      { status: 'DRAFT', currency: 'USD', total: 10 },
      { status: 'CANCELLED', currency: 'PKR', total: 20 },
    ]);

    expect(totals).toEqual({ revenue: [], outstanding: [] });
    expect(moneyListLabel(totals.revenue)).toBe('$0');
    expect(moneyListLabel(totals.outstanding)).toBe('$0');
  });

  it('rounds accumulated decimal amounts to cents without combining currencies', () => {
    const totals = clientInvoiceTotals([
      { status: 'PAID', currency: 'USD', total: '0.10' },
      { status: 'PAID', currency: 'USD', total: '0.20' },
      { status: 'PAID', currency: 'PKR', total: '100.00' },
      { status: 'SENT', currency: 'USD', total: '1.01' },
      { status: 'OVERDUE', currency: 'USD', total: '2.02' },
    ]);

    expect(totals).toEqual({
      revenue: [
        { currency: 'USD', amount: 0.3 },
        { currency: 'PKR', amount: 100 },
      ],
      outstanding: [{ currency: 'USD', amount: 3.03 }],
    });
  });
});
