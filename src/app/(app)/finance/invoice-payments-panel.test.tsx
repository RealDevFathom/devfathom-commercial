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
  payments: Array<{
    id: string;
    amount: number;
    currency: string;
    method: string | null;
    note: string | null;
    paidAt: string;
  }>;
};

const mutation = () => ({
  mutate: vi.fn(),
  reset: vi.fn(),
  isPending: false,
  error: null as null | { message: string },
});

const state = vi.hoisted(() => ({
  invoices: [] as Invoice[],
  addPayment: null as null | ReturnType<typeof mutation>,
  markPaid: null as null | ReturnType<typeof mutation>,
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('./invoices-tab', () => ({ InvoicesTab: () => null }));
vi.mock('@/components/finance/invoice-manage-panel', () => ({ InvoiceManagePanel: () => null }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      finance: {
        getInvoices: { invalidate: vi.fn() },
        getFinancialSummary: { invalidate: vi.fn() },
      },
    }),
    finance: {
      getInvoices: { useQuery: () => ({ data: state.invoices, isLoading: false }) },
      markOverdueInvoices: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      addPayment: { useMutation: () => state.addPayment },
      markInvoicePaid: { useMutation: () => state.markPaid },
      deletePayment: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    },
  },
}));

import { InvoicePaymentsPanel } from './finance-content';

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
  payments: [],
  ...overrides,
});

const expand = () => fireEvent.click(screen.getByRole('button', { name: /INV-2026-007/ }));

beforeEach(() => {
  state.addPayment = mutation();
  state.markPaid = mutation();
});
afterEach(cleanup);

describe('invoice payments panel (#398)', () => {
  it('keeps payment entry open for a PAID invoice whose payment was never recorded', () => {
    state.invoices = [invoice({ status: 'PAID', amountPaid: 0, balance: 1000 })];
    render(<InvoicePaymentsPanel />);
    expand();

    expect(screen.getByRole('status')).toHaveTextContent('has no recorded payment');
    expect(screen.getByText('Record a payment')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark paid in full ($1,000)' })).toBeInTheDocument();
  });

  it('hides payment entry once the invoice is paid in full', () => {
    state.invoices = [
      invoice({
        status: 'PAID',
        amountPaid: 1000,
        balance: 0,
        payments: [
          {
            id: 'pay-1',
            amount: 1000,
            currency: 'USD',
            method: 'Bank transfer',
            note: null,
            paidAt: '2026-10-20T00:00:00.000Z',
          },
        ],
      }),
    ];
    render(<InvoicePaymentsPanel />);
    expand();

    expect(screen.queryByText('Record a payment')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('marks paid in full through the mark-paid workflow, which records the balance', () => {
    state.invoices = [invoice({ status: 'SENT', amountPaid: 250, balance: 750 })];
    render(<InvoicePaymentsPanel />);
    expand();
    fireEvent.change(screen.getByPlaceholderText('Bank transfer'), {
      target: { value: 'Wire' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Mark paid in full ($750)' }));

    expect(state.markPaid?.mutate).toHaveBeenCalledWith({
      id: 'inv-1',
      method: 'Wire',
      note: undefined,
      paidAt: expect.any(Date),
    });
    expect(state.addPayment?.mutate).not.toHaveBeenCalled();
  });

  it('opens and focuses the payment entry the invoice list asked for', () => {
    state.invoices = [
      invoice({ id: 'inv-0', invoiceNumber: 'INV-2026-006' }),
      invoice({ status: 'OVERDUE' }),
    ];
    render(<InvoicePaymentsPanel paymentRequest={{ invoiceId: 'inv-1', requestedAt: 1 }} />);

    const amount = screen.getByLabelText('Amount (USD) *');
    expect(amount).toHaveFocus();
    // Only the requested invoice opened.
    expect(screen.getAllByText('Record a payment')).toHaveLength(1);
  });
});
