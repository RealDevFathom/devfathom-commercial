import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvoiceManagePanel } from './invoice-manage-panel';

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      finance: {
        getInvoices: { invalidate: vi.fn() },
        getFinancialSummary: { invalidate: vi.fn() },
      },
    }),
    finance: {
      getInvoices: {
        useQuery: () => ({
          data: ['invoice-1', 'invoice-2'].map((id) => ({
            id,
            invoiceNumber: id,
            status: 'DRAFT',
            currency: 'USD',
            total: 100,
            discount: 0,
            tax: 0,
            dueDate: '2026-11-30T00:00:00.000Z',
            notes: null,
            items: [{ description: 'Consulting', quantity: 1, rate: 100, amount: 100 }],
            client: { name: 'Acme' },
            project: null,
          })),
          isLoading: false,
        }),
      },
      sendInvoiceEmail: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      updateInvoice: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}));

afterEach(cleanup);

describe('invoice edit discount accessibility', () => {
  it('names each expanded invoice discount input with its own visible label', () => {
    render(<InvoiceManagePanel />);
    fireEvent.click(screen.getByRole('button', { name: /invoice-1/ }));
    fireEvent.click(screen.getByRole('button', { name: /invoice-2/ }));

    const inputs = screen.getAllByRole('spinbutton', { name: 'Discount (USD)' });
    expect(inputs).toHaveLength(2);
    expect(inputs[0].id).not.toBe(inputs[1].id);
    for (const input of inputs) {
      expect(screen.getAllByLabelText('Discount (USD)')).toContain(input);
      expect((input as HTMLInputElement).labels).toHaveLength(1);
      expect(input).not.toHaveAttribute('aria-describedby');
    }
  });

  it('associates the validation error and clears it when the discount is corrected', () => {
    render(<InvoiceManagePanel />);
    fireEvent.click(screen.getByRole('button', { name: /invoice-1/ }));
    const discount = screen.getByRole('spinbutton', { name: 'Discount (USD)' });

    fireEvent.change(discount, { target: { value: '101' } });

    expect(discount).toHaveAttribute('aria-invalid', 'true');
    expect(discount).toHaveAccessibleDescription('Discount cannot exceed the subtotal.');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();

    fireEvent.change(discount, { target: { value: '10' } });

    expect(discount).toHaveAttribute('aria-invalid', 'false');
    expect(discount).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText('Discount cannot exceed the subtotal.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });
});
