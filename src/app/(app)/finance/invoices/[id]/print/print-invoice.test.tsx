// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
    issuer: {
      name: 'Northwind Agency LLC',
      address: '42 Market Street\nSeattle, WA 98101',
      taxId: 'US-12-3456789',
    },
    project: null,
    notes: null,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    dueDate: new Date('2026-10-31T00:00:00.000Z'),
    ...overrides,
  };
}

afterEach(cleanup);

describe('InvoicePrintView seller identity (#458)', () => {
  it('prints the agency as the issuer, never the DevFathom platform', () => {
    mocks.useQuery.mockReturnValue({ isLoading: false, data: invoice() });

    const { container } = render(<InvoicePrintView invoiceId="invoice-497" />);

    expect(screen.getByText('Northwind Agency LLC')).toBeInTheDocument();
    const address = screen.getByText(/42 Market Street/);
    expect(address.textContent).toBe('42 Market Street\nSeattle, WA 98101');
    expect(address).toHaveClass('whitespace-pre-line');
    expect(screen.getByText('Tax ID: US-12-3456789')).toBeInTheDocument();
    expect(container.querySelector('#invoice-print')?.textContent).not.toMatch(
      /DevFathom|hub\.devfathom\.com/
    );
  });

  it('omits the address and tax ID lines when the agency has not set them', () => {
    mocks.useQuery.mockReturnValue({
      isLoading: false,
      data: invoice({ issuer: { name: 'Northwind Agency LLC', address: null, taxId: null } }),
    });

    render(<InvoicePrintView invoiceId="invoice-497" />);

    expect(screen.getByText('Northwind Agency LLC')).toBeInTheDocument();
    expect(screen.queryByText(/Tax ID/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Market Street/)).not.toBeInTheDocument();
  });

  it('still prints the invoice when the issuer is unavailable', () => {
    mocks.useQuery.mockReturnValue({ isLoading: false, data: invoice({ issuer: null }) });

    render(<InvoicePrintView invoiceId="invoice-497" />);

    expect(screen.getByText('INVOICE')).toBeInTheDocument();
    expect(screen.getByText('INV-497')).toBeInTheDocument();
    expect(screen.queryByText('DevFathom')).not.toBeInTheDocument();
  });
});

describe('InvoicePrintView', () => {
  it('prints the server-computed amount paid and balance after a partial payment', () => {
    mocks.useQuery.mockReturnValue({
      isLoading: false,
      data: invoice({ amountPaid: '400.00', balance: '600.00' }),
    });

    render(<InvoicePrintView invoiceId="invoice-497" />);

    expect(screen.getByText('Amount paid').nextElementSibling).toHaveTextContent('$400');
    expect(screen.getByText('Balance due').nextElementSibling).toHaveTextContent('$600');
    expect(screen.getByText('Total').nextElementSibling).toHaveTextContent('$1,000');
    expect(screen.queryByText('$999')).not.toBeInTheDocument();
  });

  it('uses the payment aggregate to decide whether to print the balance', () => {
    mocks.useQuery.mockReturnValue({
      isLoading: false,
      data: invoice({ payments: [] }),
    });

    render(<InvoicePrintView invoiceId="invoice-497" />);

    expect(screen.getByText('Amount paid').nextElementSibling).toHaveTextContent('$400');
    expect(screen.getByText('Balance due').nextElementSibling).toHaveTextContent('$600');
  });

  it('omits payment totals when the authoritative aggregate reports no payment', () => {
    mocks.useQuery.mockReturnValue({
      isLoading: false,
      data: invoice({ amountPaid: 0, balance: 1000 }),
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
