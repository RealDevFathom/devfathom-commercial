import { selectFieldControl } from '@/lib/testing/select-field';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TenderPad, type TenderResult } from './tender-pad';
import type { TerminalRequest, TerminalRequestOptions } from './checkout-panel';

describe('TenderPad', () => {
  it('posts exact cash strings and shows split-tender balance and change', async () => {
    const calls: { path: string; options?: TerminalRequestOptions }[] = [];
    const result: TenderResult = {
      tenderId: 'tender-1',
      billId: 'bill-1',
      type: 'CASH',
      amount: '8.00',
      tipAmount: '0.00',
      changeGiven: '12.00',
      settled: false,
      receiptNumber: null,
      remainingDue: '2.00',
      replayed: false,
    };
    const request: TerminalRequest = async <T,>(path: string, options?: TerminalRequestOptions) => {
      calls.push({ path, options });
      return result as T;
    };
    const onApplied = vi.fn();

    render(<TenderPad billId="bill-1" amountDue="10.00" request={request} onApplied={onApplied} />);
    fireEvent.change(selectFieldControl(screen.getByLabelText('Amount', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: '8.00' } });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Cash received', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: '20.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply tender' }));

    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(result));
    expect(calls).toEqual([
      {
        path: '/api/restaurant/checkout/tender',
        options: {
          method: 'POST',
          body: {
            billId: 'bill-1',
            tender: { type: 'CASH', amount: '8.00', cashReceived: '20.00' },
          },
          intent: 'tender:bill-1:{"type":"CASH","amount":"8.00","cashReceived":"20.00"}',
        },
      },
    ]);
    expect(screen.getByText('Remaining balance 2.00')).toBeVisible();
    expect(screen.getByText('Change 12.00')).toBeVisible();
    expect(selectFieldControl(screen.getByLabelText('Amount', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('2.00');
    expect(selectFieldControl(screen.getByLabelText('Cash received', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('2.00');
  });

  it('refreshes a changed authoritative balance and clears the prior tender error', async () => {
    const request = vi.fn().mockRejectedValue(new Error('DRAWER_NOT_OPEN'));
    const onApplied = vi.fn();
    const view = render(
      <TenderPad billId="bill-1" amountDue="10.00" request={request} onApplied={onApplied} />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply tender' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('DRAWER_NOT_OPEN');

    view.rerender(
      <TenderPad billId="bill-1" amountDue="6.25" request={request} onApplied={onApplied} />
    );
    expect(selectFieldControl(screen.getByLabelText('Amount', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('6.25');
    expect(selectFieldControl(screen.getByLabelText('Cash received', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('6.25');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledOnce();
    expect(onApplied).not.toHaveBeenCalled();
  });

  it('clears a failed attempt on successful retry and locks the settled tender', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('DRAWER_NOT_OPEN'))
      .mockResolvedValueOnce({
        tenderId: 'tender-1',
        billId: 'bill-1',
        type: 'CASH',
        amount: '10.00',
        tipAmount: '0.00',
        changeGiven: '0.00',
        settled: true,
        receiptNumber: 1,
        remainingDue: '0.00',
        replayed: false,
      } satisfies TenderResult);
    render(<TenderPad billId="bill-1" amountDue="10.00" request={request} onApplied={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply tender' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('DRAWER_NOT_OPEN');
    fireEvent.click(screen.getByRole('button', { name: 'Apply tender' }));

    expect(await screen.findByRole('button', { name: 'Bill settled' })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(selectFieldControl(screen.getByLabelText('Amount', { selector: ':not([data-select-field-native][aria-hidden="true"])' }))).toHaveValue('0.00');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('blocks malformed decimal strings before request', () => {
    const request = vi.fn();
    render(<TenderPad billId="bill-1" amountDue="10.00" request={request} onApplied={vi.fn()} />);
    fireEvent.change(selectFieldControl(screen.getByLabelText('Amount', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: '10.001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply tender' }));

    expect(screen.getByRole('alert')).toHaveTextContent('at most two places');
    expect(request).not.toHaveBeenCalled();
  });

  it('requires the card machine approval code and reference before posting a card tender', async () => {
    const request = vi.fn(async () => ({
      tenderId: 'tender-2',
      billId: 'bill-1',
      type: 'CARD',
      amount: '10.00',
      tipAmount: '0.00',
      changeGiven: null,
      settled: true,
      receiptNumber: 7,
      remainingDue: '0.00',
      replayed: false,
    }));
    render(
      <TenderPad
        billId="bill-1"
        amountDue="10.00"
        request={request as unknown as TerminalRequest}
        onApplied={vi.fn()}
      />
    );
    fireEvent.change(selectFieldControl(screen.getByLabelText('Tender type', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'CARD' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply tender' }));
    expect(screen.getByRole('alert')).toHaveTextContent('approval code');
    expect(request).not.toHaveBeenCalled();

    fireEvent.change(selectFieldControl(screen.getByLabelText('Approval code', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: 'A1B2C3' } });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Last 4 digits or reference', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: '4111111111111111' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply tender' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Never the full card number');
    expect(request).not.toHaveBeenCalled();

    fireEvent.change(selectFieldControl(screen.getByLabelText('Last 4 digits or reference', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: '4242' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply tender' }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith(
      '/api/restaurant/checkout/tender',
      expect.objectContaining({
        body: {
          billId: 'bill-1',
          tender: {
            type: 'CARD',
            amount: '10.00',
            manualConfirmation: { approvalCode: 'A1B2C3', reference: '4242' },
          },
        },
      })
    );
  });
});
