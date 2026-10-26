import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@/lib/trpc', () => ({ trpc: {} }));

import { PAID_STATUS_ERROR } from '@/lib/finance/invoice-status';
import { InvoiceRow } from './invoices-tab';

describe('InvoiceRow status menu', () => {
  it('explains that a payment is required instead of submitting a direct PAID transition', () => {
    const onUpdateStatus = vi.fn();

    render(
      <InvoiceRow
        inv={{
          id: 'invoice-1',
          invoiceNumber: 'INV-1',
          status: 'SENT',
          currency: 'USD',
          total: 125,
          dueDate: '2026-10-25T00:00:00.000Z',
          client: { name: 'Acme' },
          project: null,
        }}
        onUpdateStatus={onUpdateStatus}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sent' }));
    fireEvent.click(screen.getByRole('button', { name: 'Paid' }));

    expect(onUpdateStatus).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(PAID_STATUS_ERROR);
    expect(screen.queryByRole('button', { name: 'Paid' })).not.toBeInTheDocument();
  });
});
