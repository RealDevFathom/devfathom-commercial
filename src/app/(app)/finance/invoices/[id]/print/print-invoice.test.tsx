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
    issuer: {
      legalName: 'Northwind Studio LLC',
      displayName: 'Northwind Studio',
      logoUrl: null,
      supportEmail: null,
    },
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

  it('names the issuing workspace as the seller instead of the platform', () => {
    mocks.useQuery.mockReturnValue({
      isLoading: false,
      data: invoice({
        issuer: {
          legalName: 'Northwind Studio LLC',
          displayName: 'Northwind Studio',
          logoUrl: 'https://cdn.example.com/northwind-logo.png',
          supportEmail: 'billing@northwind.example',
        },
      }),
    });

    const { container } = render(<InvoicePrintView invoiceId="invoice-497" />);
    const issuer = screen.getByTestId('invoice-issuer');

    expect(issuer).toHaveTextContent('Northwind Studio');
    expect(issuer).toHaveTextContent('Northwind Studio LLC');
    expect(issuer).toHaveTextContent('billing@northwind.example');
    expect(issuer.querySelector('img')).toHaveAttribute(
      'src',
      'https://cdn.example.com/northwind-logo.png'
    );
    const paper = container.querySelector('#invoice-print');
    expect(paper).not.toHaveTextContent(/DevFathom/i);
    expect(paper).not.toHaveTextContent('hub.devfathom.com');
  });

  it('prints the legal name once when it matches the display name and has no logo', () => {
    mocks.useQuery.mockReturnValue({
      isLoading: false,
      data: invoice({
        issuer: {
          legalName: 'Harbor Labs',
          displayName: 'Harbor Labs',
          logoUrl: null,
          supportEmail: null,
        },
      }),
    });

    render(<InvoicePrintView invoiceId="invoice-497" />);
    const issuer = screen.getByTestId('invoice-issuer');

    expect(screen.getAllByText('Harbor Labs')).toHaveLength(1);
    expect(issuer.querySelector('img')).toBeNull();
  });
});

it('prints the persisted discount as a deduction with authoritative tax and total', () => {
  mocks.useQuery.mockReturnValue({
    isLoading: false,
    data: invoice({ discount: '125.50', tax: '10.25', total: '884.75' }),
  });
  render(<InvoicePrintView invoiceId="invoice-497" />);
  expect(screen.getByText('Discount').nextElementSibling).toHaveTextContent('-$125.5');
  expect(screen.getByText('Tax').nextElementSibling).toHaveTextContent('$10.25');
  expect(screen.getByText('Total').nextElementSibling).toHaveTextContent('$884.75');
});

it('omits a zero discount for older invoices', () => {
  mocks.useQuery.mockReturnValue({ isLoading: false, data: invoice({ discount: 0 }) });
  render(<InvoicePrintView invoiceId="invoice-497" />);
  expect(screen.queryByText('Discount')).not.toBeInTheDocument();
});
