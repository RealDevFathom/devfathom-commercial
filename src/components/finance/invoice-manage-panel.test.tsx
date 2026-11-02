import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ updateMutate: vi.fn(), invoices: [] as unknown[] }));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      finance: {
        getInvoices: { invalidate: vi.fn() },
        getFinancialSummary: { invalidate: vi.fn() },
      },
    }),
    finance: {
      getInvoices: { useQuery: () => ({ data: mocks.invoices, isLoading: false }) },
      sendInvoiceEmail: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      updateInvoice: {
        useMutation: () => ({ mutate: mocks.updateMutate, isPending: false, error: null }),
      },
    },
  },
}));

import { InvoiceManagePanel } from './invoice-manage-panel';

const total = (label: string) =>
  screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;

beforeEach(() => {
  mocks.updateMutate.mockClear();
  mocks.invoices = [
    {
      id: 'invoice-1',
      invoiceNumber: 'INV-2026-001',
      status: 'DRAFT',
      currency: 'USD',
      subtotal: '100.00',
      discount: '10.00',
      tax: '0.00',
      total: '90.00',
      dueDate: '2026-11-30T00:00:00.000Z',
      notes: null,
      items: [{ description: 'Work', quantity: 1, rate: 100, amount: 100 }],
      client: { name: 'Acme' },
      project: null,
    },
  ];
});

afterEach(cleanup);

function openEditor() {
  render(<InvoiceManagePanel />);
  fireEvent.click(screen.getByRole('button', { name: /INV-2026-001/ }));
}

describe('InvoiceManagePanel discount (#448)', () => {
  it('loads the stored discount and saves an edited one with the shared totals', () => {
    openEditor();

    const discount = screen.getByLabelText('Discount (USD)');
    expect(discount).toHaveValue(10);
    expect(total('Discount')).toBe('−$10');
    expect(total('Total')).toBe('$90');

    fireEvent.change(discount, { target: { value: '25.005' } });
    fireEvent.change(screen.getByLabelText('Tax (USD)'), { target: { value: '7.5' } });
    expect(total('Total')).toBe('$82.49');

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(mocks.updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'invoice-1',
        items: [{ description: 'Work', quantity: 1, rate: 100 }],
        discount: 25.01,
        tax: 7.5,
      })
    );
  });

  it('blocks saving a discount above the subtotal', () => {
    openEditor();

    fireEvent.change(screen.getByLabelText('Discount (USD)'), { target: { value: '150' } });

    expect(screen.getByText('Discount cannot be more than the subtotal.')).toBeInTheDocument();
    expect(screen.getByLabelText('Discount (USD)')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });
});
