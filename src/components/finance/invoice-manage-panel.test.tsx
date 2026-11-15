import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvoiceManagePanel } from './invoice-manage-panel';

const mocks = vi.hoisted(() => ({ mutate: vi.fn() }));
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
          data: [
            {
              id: 'invoice-1',
              invoiceNumber: 'INV-1',
              status: 'DRAFT',
              currency: 'PKR',
              total: 95,
              tax: 5,
              discount: 10,
              dueDate: '2026-12-01',
              notes: null,
              items: [{ description: 'Work', quantity: 1, rate: 100, amount: 100 }],
              client: { name: 'Acme' },
              project: null,
            },
          ],
          isLoading: false,
        }),
      },
      updateInvoice: { useMutation: () => ({ mutate: mocks.mutate, isPending: false }) },
      sendInvoiceEmail: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}));
afterEach(cleanup);
beforeEach(() => mocks.mutate.mockClear());

describe('invoice edit adjustments', () => {
  function open() {
    render(<InvoiceManagePanel />);
    fireEvent.click(screen.getByRole('button', { name: /INV-1/ }));
  }
  it('loads persisted adjustments and saves an edited discount with a matching preview', () => {
    open();
    expect(screen.getByLabelText('Tax (PKR)')).toHaveValue(5);
    expect(screen.getByLabelText('Discount (PKR)')).toHaveValue(10);
    fireEvent.change(screen.getByLabelText('Discount (PKR)'), { target: { value: '20' } });
    expect(screen.getByText('Total').nextElementSibling).toHaveTextContent('Rs 85');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'invoice-1', tax: 5, discount: 20 })
    );
  });
  it('blocks an excessive discount without discarding the input', () => {
    open();
    fireEvent.change(screen.getByLabelText('Discount (PKR)'), { target: { value: '101' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Discount cannot exceed the subtotal');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(screen.getByLabelText('Discount (PKR)')).toHaveValue(101);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
