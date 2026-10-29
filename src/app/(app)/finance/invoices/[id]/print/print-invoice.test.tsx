// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const invoice = {
  invoiceNumber: 'INV-2026-001',
  status: 'SENT',
  items: [],
  currency: 'USD',
  subtotal: 100,
  tax: 10,
  total: 110,
  createdAt: new Date('2026-10-20T00:00:00.000Z'),
  dueDate: new Date('2026-11-20T00:00:00.000Z'),
  notes: null,
  client: { name: 'Example Client', contacts: [] },
  project: null,
  issuer: {
    legalName: 'Northwind Agency LLC',
    invoiceAddress: '42 Market Street\nSeattle, WA 98101',
    taxId: 'US-12-3456789',
  },
};

vi.mock('@/lib/trpc', () => ({
  trpc: {
    finance: {
      getInvoiceById: { useQuery: vi.fn(() => ({ data: invoice, isLoading: false })) },
    },
  },
}));

import { InvoicePrintView } from './print-invoice';

describe('InvoicePrintView seller identity', () => {
  it('prints the agency legal identity instead of the platform brand', () => {
    render(<InvoicePrintView invoiceId="invoice-1" />);

    expect(screen.getByText('Northwind Agency LLC')).toBeInTheDocument();
    expect(screen.getByText(/42 Market Street/)).toBeInTheDocument();
    expect(screen.getByText('Tax ID: US-12-3456789')).toBeInTheDocument();
    expect(screen.queryByText('DevFathom')).not.toBeInTheDocument();
    expect(screen.queryByText('hub.devfathom.com')).not.toBeInTheDocument();
  });
});
