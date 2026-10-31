import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INVOICE_STATUS_VALUES } from '@/lib/finance/invoice-status';

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  mutate: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ finance: { getInvoices: { invalidate: mocks.invalidate } } }),
    clients: { getAll: { useQuery: () => ({ data: [{ id: 'client-1', name: 'Acme' }] }) } },
    projects: { getAll: { useQuery: () => ({ data: [] }) } },
    finance: {
      createInvoice: {
        useMutation: () => ({ mutate: mocks.mutate, isPending: false }),
      },
    },
  },
}));

import { CreateInvoiceForm, InvoiceRow } from './invoices-tab';

describe('InvoiceRow status menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(INVOICE_STATUS_VALUES)(
    'explains that a payment is required instead of submitting a %s → PAID transition',
    (status) => {
      const onUpdateStatus = vi.fn();

      render(
        <InvoiceRow
          inv={{
            id: 'invoice-1',
            invoiceNumber: 'INV-1',
            status,
            currency: 'USD',
            total: 125,
            dueDate: '2026-10-25T00:00:00.000Z',
            client: { name: 'Acme' },
            project: null,
          }}
          onUpdateStatus={onUpdateStatus}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: new RegExp(status, 'i') }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Paid' }));

      expect(onUpdateStatus).not.toHaveBeenCalled();
      expect(mocks.toastError).toHaveBeenCalledOnce();
      expect(mocks.toastError).toHaveBeenCalledWith(
        'Record a payment to mark an invoice as paid.'
      );
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    }
  );

  it('continues to submit valid non-paid status changes', () => {
    const onUpdateStatus = vi.fn();

    render(
      <InvoiceRow
        inv={{
          id: 'invoice-1',
          invoiceNumber: 'INV-1',
          status: 'DRAFT',
          currency: 'USD',
          total: 125,
          dueDate: '2026-10-25T00:00:00.000Z',
          client: { name: 'Acme' },
          project: null,
        }}
        onUpdateStatus={onUpdateStatus}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Draft' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sent' }));

    expect(onUpdateStatus).toHaveBeenCalledOnce();
    expect(onUpdateStatus).toHaveBeenCalledWith('invoice-1', 'SENT');
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('CreateInvoiceForm', () => {
  beforeEach(() => {
    mocks.mutate.mockClear();
  });

  it('keeps the only line item and prevents an empty invoice submission', () => {
    render(<CreateInvoiceForm onClose={vi.fn()} />);

    const removeButton = screen.getByRole('button', { name: 'Remove line item' });
    expect(removeButton).toBeDisabled();

    fireEvent.click(removeButton);
    expect(screen.getByPlaceholderText('Description')).toBeInTheDocument();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it('allows a line item to be removed when another line remains', () => {
    render(<CreateInvoiceForm onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Add line item' }));
    const removeButtons = screen.getAllByRole('button', { name: 'Remove line item' });
    expect(removeButtons).toHaveLength(2);
    expect(removeButtons[0]).toBeEnabled();

    fireEvent.click(removeButtons[0]);
    expect(screen.getAllByPlaceholderText('Description')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Remove line item' })).toBeDisabled();
  });
});
