import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CheckoutPanel, type TerminalRequest, type TerminalRequestOptions } from './checkout-panel';
import type { TenderResult } from './tender-pad';

const unbilled = {
  orderId: 'order-1',
  settled: false,
  blocker: 'ITEMS_UNBILLED',
  derivedOrderTotal: '24.00',
  accountedTotal: '0.00',
  unbilledItemIds: ['item-1'],
  bills: [],
};

const billed = {
  ...unbilled,
  blocker: 'BILLS_OPEN',
  accountedTotal: '24.00',
  unbilledItemIds: [],
  bills: [
    {
      id: 'bill-1',
      status: 'OPEN',
      splitKind: 'NONE',
      grandTotal: '24.00',
      compTotal: '0.00',
      receiptNumber: null,
    },
  ],
};

describe('CheckoutPanel', () => {
  it('loads summary and cuts one bill through the L5 endpoint', async () => {
    const calls: { path: string; options?: TerminalRequestOptions }[] = [];
    let reads = 0;
    const request: TerminalRequest = async <T,>(path: string, options?: TerminalRequestOptions) => {
      calls.push({ path, options });
      if (path.includes('/summary')) {
        reads += 1;
        return (reads === 1 ? unbilled : billed) as T;
      }
      return {} as T;
    };

    render(<CheckoutPanel open orderId="order-1" request={request} onClose={vi.fn()} />);
    expect(await screen.findByText('Some order items are not billed.')).toBeVisible();
    expect(await screen.findByRole('button', { name: 'Cut single bill' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cut single bill' }));

    await screen.findByText('Bill total');
    expect(calls[1]).toEqual({
      path: '/api/restaurant/checkout/bill',
      options: {
        method: 'POST',
        body: { orderId: 'order-1', split: { kind: 'NONE' } },
        intent: 'checkout-bill:{"orderId":"order-1","split":{"kind":"NONE"}}',
      },
    });
    expect(calls[2]?.path).toContain('/api/restaurant/checkout/summary?orderId=order-1');
  });

  it('renders permission denial with a retry action', async () => {
    const denied = Object.assign(new Error('Missing payments:collect capability.'), {
      status: 403,
    });
    const request: TerminalRequest = async () => {
      throw denied;
    };
    render(<CheckoutPanel open orderId="order-1" request={request} onClose={vi.fn()} />);

    expect(await screen.findByText('Payment access denied')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Permission denied: Missing payments:collect capability.'
    );
    expect(screen.getByRole('button', { name: 'Retry checkout' })).toBeEnabled();
  });

  it('renders an empty checkout without inventing payment actions', async () => {
    const request: TerminalRequest = async <T,>() =>
      ({ ...unbilled, blocker: null, unbilledItemIds: [] }) as T;
    render(<CheckoutPanel open orderId="order-1" request={request} onClose={vi.fn()} />);

    expect(await screen.findByText('Nothing to collect')).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Apply tender' })).not.toBeInTheDocument()
    );
  });

  it('keeps a verified partial balance through close and reopen without an unsafe prefill', async () => {
    const calls: { path: string; options?: TerminalRequestOptions }[] = [];
    let resolveTender!: (result: TenderResult) => void;
    const pendingTender = new Promise<TenderResult>((resolve) => {
      resolveTender = resolve;
    });
    const partial: TenderResult = {
      tenderId: 'tender-1',
      billId: 'bill-1',
      type: 'CASH',
      amount: '8.00',
      tipAmount: '0.00',
      changeGiven: '0.00',
      settled: false,
      receiptNumber: null,
      remainingDue: '16.00',
      replayed: false,
    };
    const request: TerminalRequest = async <T,>(path: string, options?: TerminalRequestOptions) => {
      calls.push({ path, options });
      if (path.includes('/summary')) return billed as T;
      return (await pendingTender) as T;
    };
    const onClose = vi.fn();
    const view = render(
      <CheckoutPanel open orderId="order-1" request={request} onClose={onClose} />
    );

    expect(
      await screen.findByText('Outstanding balance unavailable. Enter the exact tender amount.')
    ).toBeVisible();
    expect(screen.getByLabelText('Amount')).toHaveValue('');
    expect(screen.getByLabelText('Cash received')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '8.00' } });
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '8.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply tender' }));

    expect(screen.getByRole('button', { name: 'Close checkout' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Collect payment' })).toBeVisible();

    await act(async () => resolveTender(partial));
    expect(await screen.findByText('Remaining balance 16.00')).toBeVisible();
    expect(calls.filter(({ path }) => path.includes('/summary'))).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Close checkout' }));
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(
      <CheckoutPanel open={false} orderId="order-1" request={request} onClose={onClose} />
    );
    view.rerender(<CheckoutPanel open orderId="order-1" request={request} onClose={onClose} />);

    await waitFor(() => expect(screen.getByLabelText('Amount')).toHaveValue('16.00'));
    expect(screen.getByLabelText('Cash received')).toHaveValue('16.00');
    expect(
      screen.queryByText('Outstanding balance unavailable. Enter the exact tender amount.')
    ).not.toBeInTheDocument();
  });
});
