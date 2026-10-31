import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ useQuery: vi.fn() }));

vi.mock('@/lib/trpc', () => ({
  trpc: { finance: { getInvoiceById: { useQuery: mocks.useQuery } } },
}));

import { InvoicePrintView } from './print-invoice';

const invoice = {
  invoiceNumber: 'INV-001',
  status: 'SENT',
  items: [],
  currency: 'USD',
  subtotal: 100,
  tax: 0,
  total: 100,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  dueDate: new Date('2026-01-31T00:00:00Z'),
  notes: null,
  client: { name: 'Client', contacts: [] },
  project: null,
  issuer: {
    displayName: 'Acme',
    legalName: 'Acme LLC',
    brand: { logoUrl: 'https://cdn.example.com/logo.png', supportEmail: 'help@example.com' },
  },
};

describe('InvoicePrintView branding', () => {
  beforeEach(() => {
    mocks.useQuery.mockReturnValue({ data: invoice, isLoading: false });
    vi.spyOn(window, 'print').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('waits for the tenant logo before printing', async () => {
    render(<InvoicePrintView invoiceId="invoice-1" />);

    const loadingButton = screen.getByRole('button', { name: 'Loading branding…' });
    expect(loadingButton).toBeDisabled();
    fireEvent.click(loadingButton);
    expect(window.print).not.toHaveBeenCalled();

    fireEvent.load(screen.getByRole('img', { name: 'Acme logo' }));
    const printButton = await screen.findByRole('button', { name: 'Print / Save as PDF' });
    expect(printButton).toBeEnabled();
    fireEvent.click(printButton);
    expect(window.print).toHaveBeenCalledOnce();
  });

  it('falls back to issuer text when the tenant logo cannot load', () => {
    render(<InvoicePrintView invoiceId="invoice-1" />);

    fireEvent.error(screen.getByRole('img', { name: 'Acme logo' }));

    expect(screen.queryByRole('img', { name: 'Acme logo' })).not.toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print / Save as PDF' })).toBeEnabled();
  });

  it('allows printing immediately when the tenant has no configured logo', () => {
    mocks.useQuery.mockReturnValue({
      data: {
        ...invoice,
        issuer: {
          ...invoice.issuer,
          brand: { ...invoice.issuer.brand, logoUrl: null },
        },
      },
      isLoading: false,
    });

    render(<InvoicePrintView invoiceId="invoice-1" />);

    expect(screen.queryByRole('img', { name: 'Acme logo' })).not.toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print / Save as PDF' })).toBeEnabled();
  });

  it('reloads branding when the configured tenant logo changes', async () => {
    const { rerender } = render(<InvoicePrintView invoiceId="invoice-1" />);
    const originalLogo = screen.getByRole('img', { name: 'Acme logo' });
    fireEvent.load(originalLogo);
    expect(await screen.findByRole('button', { name: 'Print / Save as PDF' })).toBeEnabled();

    mocks.useQuery.mockReturnValue({
      data: {
        ...invoice,
        issuer: {
          ...invoice.issuer,
          brand: { ...invoice.issuer.brand, logoUrl: 'https://cdn.example.com/new-logo.png' },
        },
      },
      isLoading: false,
    });
    rerender(<InvoicePrintView invoiceId="invoice-1" />);

    const updatedLogo = screen.getByRole('img', { name: 'Acme logo' });
    expect(updatedLogo).not.toBe(originalLogo);
    expect(updatedLogo.getAttribute('src')).not.toBe(originalLogo.getAttribute('src'));
    expect(screen.getByRole('button', { name: 'Loading branding…' })).toBeDisabled();
    fireEvent.load(updatedLogo);
    expect(await screen.findByRole('button', { name: 'Print / Save as PDF' })).toBeEnabled();
  });

  it('stacks and wraps a long seller identity without displacing invoice metadata', () => {
    const longName = 'A'.repeat(180);
    mocks.useQuery.mockReturnValue({
      data: {
        ...invoice,
        issuer: { ...invoice.issuer, displayName: longName, legalName: `${longName} Holdings LLC` },
      },
      isLoading: false,
    });

    render(<InvoicePrintView invoiceId="invoice-1" />);

    const header = screen.getByTestId('invoice-header');
    expect(header).toHaveClass('flex-col', 'sm:flex-row', 'print:flex-row');
    expect(screen.getByTestId('invoice-seller')).toHaveClass('min-w-0', 'flex-1');
    const name = screen.getByText(longName);
    expect(name.parentElement).toHaveClass('min-w-0', '[overflow-wrap:anywhere]');
    expect(screen.getByText(`${longName} Holdings LLC`)).toBeInTheDocument();
    expect(screen.getByTestId('invoice-meta')).toHaveClass('shrink-0');
    expect(screen.getByText('INV-001')).toBeInTheDocument();
  });
});
