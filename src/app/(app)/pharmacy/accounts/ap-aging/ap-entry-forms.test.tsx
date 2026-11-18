import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ record: vi.fn(), pay: vi.fn() }));
vi.mock('./ap-entry-actions', () => ({
  recordApInvoiceFromForm: mocks.record,
  payApInvoiceFromForm: mocks.pay,
}));

import { PayApInvoiceForm, RecordApInvoiceForm } from './ap-entry-forms';

const hidden = (container: HTMLElement, name: string) =>
  (container.querySelector(`input[name="${name}"]`) as HTMLInputElement).value;

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('DEV-103 supplier expense invoice entry form', () => {
  it('keeps typed values and the command key after a refusal, then rotates both after a save', async () => {
    mocks.record.mockResolvedValueOnce({ status: 'error', message: 'Already recorded.' });
    const { container } = render(
      <RecordApInvoiceForm
        branchId="branch_1"
        initialKey="ap-invoice:first-key"
        today="2026-11-15"
      />
    );
    const payee = screen.getByLabelText('Payee') as HTMLInputElement;
    fireEvent.change(payee, { target: { value: 'K-Electric' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Record invoice' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Already recorded.');
    const sent = mocks.record.mock.calls[0]?.[1] as FormData;
    expect(sent.get('branchId')).toBe('branch_1');
    expect(sent.get('createKey')).toBe('ap-invoice:first-key');
    expect(sent.get('payeeName')).toBe('K-Electric');
    expect((screen.getByLabelText('Payee') as HTMLInputElement).value).toBe('K-Electric');
    expect(hidden(container, 'createKey')).toBe('ap-invoice:first-key');

    mocks.record.mockResolvedValueOnce({ status: 'saved', message: 'Invoice AP-1 recorded.' });
    fireEvent.submit(screen.getByRole('form', { name: 'Record invoice' }));
    await waitFor(() => expect(screen.getByText('Invoice AP-1 recorded.')).toBeInTheDocument());
    expect((mocks.record.mock.calls[1]?.[1] as FormData).get('createKey')).toBe(
      'ap-invoice:first-key'
    );
    expect(hidden(container, 'createKey')).not.toBe('ap-invoice:first-key');
    expect(hidden(container, 'createKey')).toMatch(/^ap-invoice:/);
    expect((screen.getByLabelText('Payee') as HTMLInputElement).value).toBe('');
  });
});

describe('DEV-103 supplier expense payment entry form', () => {
  it('offers only the invoices it is given and sends the chosen one', async () => {
    mocks.pay.mockResolvedValueOnce({ status: 'saved', message: 'Payment recorded.' });
    const { container } = render(
      <PayApInvoiceForm
        branchId="branch_1"
        initialKey="ap-payment:first-key"
        now="2026-11-15T10:30"
        invoices={[
          {
            invoiceId: 'inv_1',
            reference: 'AP-0001',
            payeeName: 'K-Electric',
            supplierInvoiceRef: 'KE-11',
            currency: 'PKR',
            outstanding: '1000.00',
          },
        ]}
      />
    );
    const options = screen.getAllByRole('option').map((option) => option.getAttribute('value'));
    expect(options).toEqual(['inv_1', 'CASH', 'BANK']);
    expect((screen.getByLabelText('Paid at') as HTMLInputElement).value).toBe('2026-11-15T10:30');
    fireEvent.change(screen.getByLabelText('Amount paid'), { target: { value: '250' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Record payment' }));
    await waitFor(() => expect(screen.getByText('Payment recorded.')).toBeInTheDocument());
    const sent = mocks.pay.mock.calls[0]?.[1] as FormData;
    expect(sent.get('invoiceId')).toBe('inv_1');
    expect(sent.get('amount')).toBe('250');
    expect(sent.get('commandKey')).toBe('ap-payment:first-key');
    expect(hidden(container, 'commandKey')).not.toBe('ap-payment:first-key');
  });
});
