import { describe, expect, it, vi } from 'vitest';
import { applyInvoiceStatusSelection } from './invoices-tab';

describe('invoice status selection', () => {
  it('records the outstanding balance when Paid is selected instead of requesting a rejected status change', () => {
    const updateStatus = vi.fn();
    const addPayment = vi.fn();

    applyInvoiceStatusSelection(
      { id: 'invoice-584', status: 'SENT', balance: 100 },
      'PAID',
      { updateStatus, addPayment }
    );

    expect(addPayment).toHaveBeenCalledWith({ invoiceId: 'invoice-584', amount: 100 });
    expect(updateStatus).not.toHaveBeenCalled();
  });
});
