// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ useQuery: vi.fn() }));

vi.mock('@/lib/trpc', () => ({
  trpc: { finance: { getInvoiceById: { useQuery: mocks.useQuery } } },
}));

import { InvoicePrintView } from './print-invoice';

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    invoiceNumber: 'INV-252',
    status: 'SENT',
    currency: 'USD',
    subtotal: 100,
    discount: 25,
    tax: 5,
    total: 80,
    amountPaid: 0,
    balance: 80,
    items: [{ description: 'Consulting', quantity: 1, rate: 100, amount: 100 }],
    payments: [],
    client: { name: 'Example Client', contacts: [] },
    project: null,
    notes: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    dueDate: new Date('2026-10-31T00:00:00.000Z'),
    ...overrides,
  };
}

function printed(invoiceData: ReturnType<typeof invoice>) {
  mocks.useQuery.mockReturnValue({ isLoading: false, data: invoiceData });
  render(<InvoicePrintView invoiceId="invoice-252" />);
}

const amountFor = (label: string) => screen.getByText(label).nextElementSibling?.textContent;

describe('InvoicePrintView discount (DEV-252)', () => {
  it('prints the discount between subtotal and tax, with the server totals', () => {
    printed(invoice());

    const totalRows = screen.getByText('Subtotal').parentElement!.parentElement!.children;
    expect(Array.from(totalRows, (row) => row.firstElementChild?.textContent)).toEqual([
      'Subtotal',
      'Discount',
      'Tax',
      'Total',
    ]);
    expect(amountFor('Subtotal')).toBe('$100');
    expect(amountFor('Discount')).toBe('-$25');
    expect(amountFor('Tax')).toBe('$5');
    expect(amountFor('Total')).toBe('$80');
  });

  it('formats a PKR discount and totals in rupees from Decimal strings', () => {
    printed(
      invoice({
        currency: 'PKR',
        subtotal: '50000.00',
        discount: '12500.00',
        tax: '0.00',
        total: '37500.00',
        amountPaid: '0.00',
        balance: '37500.00',
        items: [{ description: 'Retainer', quantity: 1, rate: 50000, amount: 50000 }],
      })
    );

    expect(amountFor('Subtotal')).toBe('Rs 50,000');
    expect(amountFor('Discount')).toBe('-Rs 12,500');
    expect(amountFor('Tax')).toBe('Rs 0');
    expect(amountFor('Total')).toBe('Rs 37,500');
    expect(screen.queryAllByText(/\$/)).toHaveLength(0);
  });

  it('prints a zero discount as -$0 and leaves the totals unchanged', () => {
    printed(
      invoice({
        subtotal: '1000.00',
        discount: '0.00',
        tax: '0.00',
        total: '1000.00',
        balance: '1000.00',
        items: [{ description: 'Consulting', quantity: 1, rate: 1000, amount: 1000 }],
      })
    );

    expect(amountFor('Discount')).toBe('-$0');
    expect(amountFor('Subtotal')).toBe('$1,000');
    expect(amountFor('Total')).toBe('$1,000');
    expect(screen.queryAllByText(/NaN/)).toHaveLength(0);
  });
});
