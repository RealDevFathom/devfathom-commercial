import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ useQuery: vi.fn() }));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    finance: {
      getInvoiceById: {
        useQuery: mocks.useQuery,
      },
    },
  },
}));

import { InvoicePrintView } from './print-invoice';

describe('InvoicePrintView issuer', () => {
  beforeEach(() => {
    mocks.useQuery.mockReturnValue({
      isLoading: false,
      data: {
        id: 'invoice-1',
        invoiceNumber: 'INV-2026-001',
        status: 'SENT',
        items: [],
        currency: 'USD',
        subtotal: 100,
        tax: 0,
        total: 100,
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        dueDate: new Date('2026-10-31T00:00:00.000Z'),
        notes: null,
        issuer: {
          displayName: 'Northwind Studio',
          legalName: 'Northwind Studio LLC',
          primaryContactEmail: 'accounts@northwind.example',
        },
        client: { name: 'Acme Client', contacts: [] },
        project: null,
      },
    });
  });

  afterEach(cleanup);

  it('identifies the agency tenant rather than DevFathom on the printable invoice', () => {
    render(<InvoicePrintView invoiceId="invoice-1" />);

    expect(screen.getByText('Northwind Studio')).toBeInTheDocument();
    expect(screen.getByText('Northwind Studio LLC')).toBeInTheDocument();
    expect(screen.getByText('accounts@northwind.example')).toBeInTheDocument();
    expect(screen.queryByText('DevFathom')).not.toBeInTheDocument();
    expect(screen.queryByText('hub.devfathom.com')).not.toBeInTheDocument();
  });

  it('does not repeat a legal name that matches the display name', () => {
    const result = mocks.useQuery();
    mocks.useQuery.mockReturnValue({
      ...result,
      data: {
        ...result.data,
        issuer: {
          displayName: 'Northwind Studio',
          legalName: 'Northwind Studio',
          primaryContactEmail: 'accounts@northwind.example',
        },
      },
    });

    render(<InvoicePrintView invoiceId="invoice-1" />);

    expect(screen.getAllByText('Northwind Studio')).toHaveLength(1);
    expect(screen.getByText('accounts@northwind.example')).toBeInTheDocument();
  });

  it('does not render an issuer email when the organization has none', () => {
    const result = mocks.useQuery();
    mocks.useQuery.mockReturnValue({
      ...result,
      data: {
        ...result.data,
        issuer: { ...result.data.issuer, primaryContactEmail: null },
      },
    });

    render(<InvoicePrintView invoiceId="invoice-1" />);

    expect(screen.getByText('Northwind Studio LLC')).toBeInTheDocument();
    expect(screen.queryByText('accounts@northwind.example')).not.toBeInTheDocument();
  });

  it('does not render an empty legal-name line', () => {
    const result = mocks.useQuery();
    mocks.useQuery.mockReturnValue({
      ...result,
      data: {
        ...result.data,
        issuer: { ...result.data.issuer, legalName: '' },
      },
    });

    const { container } = render(<InvoicePrintView invoiceId="invoice-1" />);

    expect(screen.getByText('Northwind Studio')).toBeInTheDocument();
    expect(container.querySelectorAll('#invoice-print p:empty')).toHaveLength(0);
  });
});
