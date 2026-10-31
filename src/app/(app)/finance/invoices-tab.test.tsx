import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateInvoiceForm, InvoicesTab } from './invoices-tab';

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidate: vi.fn(),
  invalidateSummary: vi.fn(),
  statusMutationOptions: null as null | { onSettled?: () => void },
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      finance: {
        getInvoices: { invalidate: mocks.invalidate },
        getFinancialSummary: { invalidate: mocks.invalidateSummary },
      },
    }),
    clients: { getAll: { useQuery: () => ({ data: [{ id: 'client-1', name: 'Acme' }] }) } },
    projects: { getAll: { useQuery: () => ({ data: [] }) } },
    finance: {
      createInvoice: {
        useMutation: () => ({ mutate: mocks.mutate, isPending: false }),
      },
      getInvoices: { useQuery: () => ({ data: [], isLoading: false }) },
      updateInvoiceStatus: {
        useMutation: (options: { onSettled?: () => void }) => {
          mocks.statusMutationOptions = options;
          return { mutate: vi.fn() };
        },
      },
    },
  },
}));

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

describe('InvoicesTab status changes', () => {
  beforeEach(() => {
    mocks.invalidate.mockClear();
    mocks.invalidateSummary.mockClear();
    mocks.statusMutationOptions = null;
  });

  it('refetches invoices after a status change so Mark paid shows its recorded payment', () => {
    render(<InvoicesTab />);

    expect(mocks.statusMutationOptions?.onSettled).toBeTypeOf('function');
    mocks.statusMutationOptions?.onSettled?.();

    expect(mocks.invalidate).toHaveBeenCalledOnce();
    expect(mocks.invalidateSummary).toHaveBeenCalledOnce();
  });
});
