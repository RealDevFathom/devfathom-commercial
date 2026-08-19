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
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '8.00' } });
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '20.00' } });
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
  });

  it('blocks malformed decimal strings before request', () => {
    const request = vi.fn();
    render(<TenderPad billId="bill-1" amountDue="10.00" request={request} onApplied={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '10.001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply tender' }));

    expect(screen.getByRole('alert')).toHaveTextContent('at most two places');
    expect(request).not.toHaveBeenCalled();
  });
});
