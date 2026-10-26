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
    invoiceNumber: 'INV-497',
    status: 'SENT',
    currency: 'USD',
    subtotal: 1000,
    tax: 0,
    total: 1000,
    amountPaid: 400,
    balance: 600,
    items: [{ description: 'Consulting', quantity: 1, rate: 1000, amount: 1000 }],
    // Deliberately differs from the aggregate fields so the test catches any
    // client-side re-summing instead of rendering the server-authoritative values.
    payments: [{ id: 'payment-1', amount: 999 }],
    client: { name: 'Example Client', contacts: [] },
    project: null,
    notes: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    dueDate: new Date('2026-10-31T00:00:00.000Z'),
    ...overrides,
  };
}

describe('InvoicePrintView', () => {
  it('prints the server-computed amount paid and balance after a partial payment', () => {
    mocks.useQuery.mockReturnValue({
      isLoading: false,
      data: invoice(),
    });

    render(<InvoicePrintView invoiceId="invoice-497" />);

    expect(screen.getByText('Amount paid').nextElementSibling).toHaveTextContent('$400');
    expect(screen.getByText('Balance due').nextElementSibling).toHaveTextContent('$600');
    expect(screen.getByText('Total').nextElementSibling).toHaveTextContent('$1,000');
  });

  it('omits payment totals when the invoice has no payments', () => {
    mocks.useQuery.mockReturnValue({
      isLoading: false,
      data: invoice({ amountPaid: 0, balance: 1000, payments: [] }),
    });

    render(<InvoicePrintView invoiceId="invoice-497" />);

    expect(screen.queryByText('Amount paid')).not.toBeInTheDocument();
    expect(screen.queryByText('Balance due')).not.toBeInTheDocument();
    expect(screen.getByText('Total').nextElementSibling).toHaveTextContent('$1,000');
  });

  it('prints a zero balance for a fully paid invoice with multiple payments', () => {
    mocks.useQuery.mockReturnValue({
      isLoading: false,
      data: invoice({
        status: 'PAID',
        amountPaid: 1000,
        balance: 0,
        payments: [
          { id: 'payment-1', amount: 400 },
          { id: 'payment-2', amount: 600 },
        ],
      }),
    });

    render(<InvoicePrintView invoiceId="invoice-497" />);

    expect(screen.getByText('Amount paid').nextElementSibling).toHaveTextContent('$1,000');
    expect(screen.getByText('Balance due').nextElementSibling).toHaveTextContent('$0');
  });
});
