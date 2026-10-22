import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Invoice = {
  id: string;
  invoiceNumber: string;
  status: string;
  currency: string;
  total: number;
  dueDate: string;
  amountPaid: number;
  balance: number;
  client: { name: string };
  project: null;
};

const state = vi.hoisted(() => ({
  invoices: [] as Invoice[],
  statusMutate: vi.fn(),
  statusOptions: null as null | {
    onError: (error: Error, vars: unknown, ctx: { previous?: unknown }) => void;
  },
  setData: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: state.toastError, success: vi.fn() } }));
// Render every row: jsdom has no layout for the virtualizer to measure.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: 0 })),
    getTotalSize: () => count * 65,
    measureElement: () => undefined,
  }),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      finance: {
        getInvoices: { cancel: vi.fn(), getData: vi.fn(), setData: state.setData },
        getFinancialSummary: { invalidate: vi.fn() },
      },
    }),
    finance: {
      getInvoices: { useQuery: () => ({ data: state.invoices, isLoading: false }) },
      updateInvoiceStatus: {
        useMutation: (options: typeof state.statusOptions) => {
          state.statusOptions = options;
          return { mutate: state.statusMutate };
        },
      },
    },
  },
}));

import { InvoicesTab } from './invoices-tab';

const invoice = (overrides: Partial<Invoice>): Invoice => ({
  id: 'inv-1',
  invoiceNumber: 'INV-2026-007',
  status: 'SENT',
  currency: 'USD',
  total: 1000,
  dueDate: '2026-11-30T00:00:00.000Z',
  amountPaid: 0,
  balance: 1000,
  client: { name: 'Acme' },
  project: null,
  ...overrides,
});

function openMenu(status: string, onRecordPayment = vi.fn()) {
  render(<InvoicesTab onRecordPayment={onRecordPayment} />);
  fireEvent.click(screen.getByRole('button', { name: status }));
  return onRecordPayment;
}

const itemNames = () => screen.getAllByRole('menuitem').map((item) => item.textContent?.trim());

beforeEach(() => {
  vi.clearAllMocks();
  state.statusOptions = null;
});
afterEach(cleanup);

describe('invoice status menu (#398, #584)', () => {
  it('replaces the status-only "Paid" choice with "Record payment…"', () => {
    state.invoices = [invoice({ status: 'SENT' })];
    openMenu('Sent');

    expect(itemNames()).toEqual(['Overdue', 'Cancelled', 'Draft', 'Record payment…']);
    expect(screen.queryByRole('menuitem', { name: 'Paid' })).not.toBeInTheDocument();
  });

  it('opens the invoice’s payment entry instead of changing its status', () => {
    state.invoices = [invoice({ status: 'OVERDUE' })];
    const onRecordPayment = openMenu('Overdue');

    fireEvent.click(screen.getByRole('menuitem', { name: 'Record payment…' }));

    expect(onRecordPayment).toHaveBeenCalledWith('inv-1');
    expect(state.statusMutate).not.toHaveBeenCalled();
  });

  it('shows why a rejected status change was rolled back', () => {
    state.invoices = [invoice({ status: 'SENT' })];
    openMenu('Sent');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Overdue' }));
    expect(state.statusMutate).toHaveBeenCalledWith({ id: 'inv-1', status: 'OVERDUE' });

    const previous = [invoice({ status: 'SENT' })];
    state.statusOptions?.onError(
      new Error('Invoice status changed concurrently. Refresh and try again.'),
      { id: 'inv-1', status: 'OVERDUE' },
      { previous }
    );

    expect(state.setData).toHaveBeenCalledWith(undefined, previous);
    expect(state.toastError).toHaveBeenCalledWith(
      'Invoice status changed concurrently. Refresh and try again.'
    );
  });

  it('disables moves that would strand recorded payments on a draft or cancelled invoice', () => {
    state.invoices = [invoice({ status: 'SENT', amountPaid: 400, balance: 600 })];
    openMenu('Sent');

    expect(screen.getByRole('menuitem', { name: 'Overdue' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: 'Cancelled' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Draft' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Record payment…' })).toBeEnabled();
  });

  it('offers no payment entry once an invoice is paid in full', () => {
    state.invoices = [invoice({ status: 'PAID', amountPaid: 1000, balance: 0 })];
    openMenu('Paid');

    expect(itemNames()).toEqual(['Cancelled']);
    expect(screen.getByRole('menuitem', { name: 'Cancelled' })).toBeDisabled();
  });

  it('still offers payment entry for a PAID invoice whose payment was never recorded', () => {
    state.invoices = [invoice({ status: 'PAID', amountPaid: 0, balance: 1000 })];
    openMenu('Paid');

    expect(itemNames()).toEqual(['Cancelled', 'Record payment…']);
  });
});
