import { selectFieldControl } from '@/lib/testing/select-field';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  pay: vi.fn(),
  reverseInvoice: vi.fn(),
  reverseSettlement: vi.fn(),
}));
vi.mock('./ap-entry-actions', () => ({
  recordApInvoiceFromForm: mocks.record,
  payApInvoiceFromForm: mocks.pay,
  reverseApInvoiceFromForm: mocks.reverseInvoice,
  reverseApSettlementFromForm: mocks.reverseSettlement,
}));

import {
  PayApInvoiceForm,
  RecordApInvoiceForm,
  ReversalNoticeArea,
  ReverseApEntryForm,
} from './ap-entry-forms';

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
    const payee = screen.getByLabelText('Payee', { selector: ':not([data-select-field-native][aria-hidden="true"])' }) as HTMLInputElement;
    fireEvent.change(selectFieldControl(payee), { target: { value: 'K-Electric' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Record invoice' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Already recorded.');
    const sent = mocks.record.mock.calls[0]?.[1] as FormData;
    expect(sent.get('branchId')).toBe('branch_1');
    expect(sent.get('createKey')).toBe('ap-invoice:first-key');
    expect(sent.get('payeeName')).toBe('K-Electric');
    expect(selectFieldControl((screen.getByLabelText('Payee', { selector: ':not([data-select-field-native][aria-hidden="true"])' }) as HTMLInputElement)).value).toBe('K-Electric');
    expect(hidden(container, 'createKey')).toBe('ap-invoice:first-key');

    mocks.record.mockResolvedValueOnce({ status: 'saved', message: 'Invoice AP-1 recorded.' });
    fireEvent.submit(screen.getByRole('form', { name: 'Record invoice' }));
    await waitFor(() => expect(screen.getByText('Invoice AP-1 recorded.')).toBeInTheDocument());
    expect((mocks.record.mock.calls[1]?.[1] as FormData).get('createKey')).toBe(
      'ap-invoice:first-key'
    );
    expect(hidden(container, 'createKey')).not.toBe('ap-invoice:first-key');
    expect(hidden(container, 'createKey')).toMatch(/^ap-invoice:/);
    expect(selectFieldControl((screen.getByLabelText('Payee', { selector: ':not([data-select-field-native][aria-hidden="true"])' }) as HTMLInputElement)).value).toBe('');
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
    const options = screen.getAllByRole('option', { hidden: true }).map((option) => option.getAttribute('value'));
    expect(options).toEqual(['inv_1', 'CASH', 'BANK']);
    expect(selectFieldControl((screen.getByLabelText('Paid at', { selector: ':not([data-select-field-native][aria-hidden="true"])' }) as HTMLInputElement)).value).toBe('2026-11-15T10:30');
    fireEvent.change(selectFieldControl(screen.getByLabelText('Amount paid', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: '250' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Record payment' }));
    await waitFor(() => expect(screen.getByText('Payment recorded.')).toBeInTheDocument());
    const sent = mocks.pay.mock.calls[0]?.[1] as FormData;
    expect(sent.get('invoiceId')).toBe('inv_1');
    expect(sent.get('amount')).toBe('250');
    expect(sent.get('commandKey')).toBe('ap-payment:first-key');
    expect(hidden(container, 'commandKey')).not.toBe('ap-payment:first-key');
  });
});

describe('DEV-103 reversal form', () => {
  it('sends a payment reversal with the reason and PIN, keeps them after a refusal, and replays the same key', async () => {
    mocks.reverseSettlement.mockResolvedValueOnce({
      status: 'error',
      message: 'Nothing was reversed. Enter your manager or owner PIN.',
    });
    const { container } = render(
      <ReverseApEntryForm
        kind="payment"
        branchId="branch_1"
        targetId="set_1"
        label="234.56 against AP-0001"
        initialKey="ap-payment-rev:first-key"
      />
    );
    const form = screen.getByRole('form', { name: 'Reverse payment 234.56 against AP-0001' });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Reason to reverse', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'Paid twice' },
    });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Your manager or owner PIN', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: '2468' },
    });
    fireEvent.submit(form);
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter your manager or owner PIN');
    const sent = mocks.reverseSettlement.mock.calls[0]?.[1] as FormData;
    expect(sent.get('settlementId')).toBe('set_1');
    expect(sent.get('invoiceId')).toBeNull();
    expect(sent.get('reason')).toBe('Paid twice');
    expect(sent.get('pin')).toBe('2468');
    expect(sent.get('commandKey')).toBe('ap-payment-rev:first-key');
    expect(mocks.reverseInvoice).not.toHaveBeenCalled();
    expect(selectFieldControl((screen.getByLabelText('Reason to reverse', { selector: ':not([data-select-field-native][aria-hidden="true"])' }) as HTMLInputElement)).value).toBe(
      'Paid twice'
    );
    expect(hidden(container, 'commandKey')).toBe('ap-payment-rev:first-key');
    expect(screen.getByRole('button', { name: 'Reverse payment' })).toBeEnabled();

    mocks.reverseSettlement.mockResolvedValueOnce({
      status: 'saved',
      message: 'Payment reversed.',
    });
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByText('Payment reversed.')).toBeInTheDocument());
    expect(hidden(container, 'commandKey')).toMatch(/^ap-payment-rev:/);
    expect(hidden(container, 'commandKey')).not.toBe('ap-payment-rev:first-key');
  });

  it('targets the invoice for an invoice reversal', async () => {
    mocks.reverseInvoice.mockResolvedValueOnce({ status: 'saved', message: 'Invoice reversed.' });
    render(
      <ReverseApEntryForm
        kind="invoice"
        branchId="branch_1"
        targetId="inv_1"
        label="AP-0001"
        initialKey="ap-invoice-rev:first-key"
      />
    );
    const pin = screen.getByLabelText('Your manager or owner PIN', { selector: ':not([data-select-field-native][aria-hidden="true"])' }) as HTMLInputElement;
    expect(pin.type).toBe('password');
    expect(pin.autocomplete).toBe('off');
    fireEvent.submit(screen.getByRole('form', { name: 'Reverse invoice AP-0001' }));
    await waitFor(() => expect(screen.getByText('Invoice reversed.')).toBeInTheDocument());
    expect((mocks.reverseInvoice.mock.calls[0]?.[1] as FormData).get('invoiceId')).toBe('inv_1');
    expect(screen.getByRole('button', { name: /Reverse invoice/ })).toHaveClass('min-h-11');
  });
});

describe('DEV-103 reversal confirmation', () => {
  it('keeps the saved message in the panel after the reversed row leaves the list', async () => {
    mocks.reverseInvoice.mockResolvedValueOnce({
      status: 'saved',
      message: 'Invoice AP-0001 reversed.',
    });
    const form = (
      <ReverseApEntryForm
        kind="invoice"
        branchId="branch_1"
        targetId="inv_1"
        label="AP-0001"
        initialKey="ap-invoice-rev:first-key"
      />
    );
    const { rerender } = render(<ReversalNoticeArea>{form}</ReversalNoticeArea>);
    fireEvent.submit(screen.getByRole('form', { name: 'Reverse invoice AP-0001' }));
    await waitFor(() => expect(mocks.reverseInvoice).toHaveBeenCalled());
    // The server re-renders the list without the reversed invoice.
    rerender(
      <ReversalNoticeArea>
        <p>Nothing left to reverse.</p>
      </ReversalNoticeArea>
    );
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Invoice AP-0001 reversed.')
    );
    expect(screen.queryByRole('form')).toBeNull();
  });
});
