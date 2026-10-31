import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvoiceManagePanel } from './invoice-manage-panel';

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), invalidate: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      finance: {
        getInvoices: { invalidate: mocks.invalidate },
        getFinancialSummary: { invalidate: mocks.invalidate },
      },
    }),
    finance: {
      getInvoices: {
        useQuery: () => ({
          data: [
            {
              id: 'invoice-1',
              invoiceNumber: 'INV-1',
              status: 'SENT',
              currency: 'USD',
              total: 0.8,
              tax: 0,
              discount: 0,
              dueDate: '2026-12-01',
              notes: null,
              items: [
                { description: 'First', quantity: 1, rate: 0.1 },
                { description: 'Second', quantity: 1, rate: 0.7 },
              ],
              client: { name: 'Acme' },
              project: null,
            },
          ],
        }),
      },
      updateInvoice: { useMutation: () => ({ mutate: mocks.mutate, isPending: false }) },
      sendInvoiceEmail: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}));

describe('invoice discount editing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts a full discount on decimal lines and previews the same tax cents as persistence', () => {
    render(<InvoiceManagePanel />);
    fireEvent.click(screen.getByRole('button', { name: /INV-1/ }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Tax (USD)' }), {
      target: { value: '0.005' },
    });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Discount (USD)' }), {
      target: { value: '0.8' },
    });
    expect(screen.getByText('Total').parentElement).toHaveTextContent('$0.01');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ discount: 0.8, tax: 0.005 })
    );
  });

  it('describes an excessive discount and blocks saving', () => {
    render(<InvoiceManagePanel />);
    fireEvent.click(screen.getByRole('button', { name: /INV-1/ }));
    const discount = screen.getByRole('spinbutton', { name: 'Discount (USD)' });
    fireEvent.change(discount, { target: { value: '0.81' } });
    expect(discount).toHaveAttribute('aria-invalid', 'true');
    expect(discount).toHaveAccessibleDescription('Discount cannot exceed the invoice subtotal');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
