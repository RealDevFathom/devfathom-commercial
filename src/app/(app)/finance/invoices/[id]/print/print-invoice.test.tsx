import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    finance: {
      getInvoiceById: {
        useQuery: () => ({
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
        }),
      },
    },
  },
}));

import { InvoicePrintView } from './print-invoice';

describe('InvoicePrintView issuer', () => {
  it('identifies the agency tenant rather than DevFathom on the printable invoice', () => {
    render(<InvoicePrintView invoiceId="invoice-1" />);

    expect(screen.getByText('Northwind Studio')).toBeInTheDocument();
    expect(screen.getByText('Northwind Studio LLC')).toBeInTheDocument();
    expect(screen.getByText('accounts@northwind.example')).toBeInTheDocument();
    expect(screen.queryByText('DevFathom')).not.toBeInTheDocument();
    expect(screen.queryByText('hub.devfathom.com')).not.toBeInTheDocument();
  });
});
