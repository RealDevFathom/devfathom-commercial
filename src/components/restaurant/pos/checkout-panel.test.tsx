import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  CheckoutPanel,
  type TerminalRequest,
  type TerminalRequestOptions,
} from './checkout-panel';

const unbilled = {
  orderId: 'order-1',
  settled: false,
  blocker: 'UNBILLED_ITEMS',
  derivedOrderTotal: '24.00',
  accountedTotal: '0.00',
  unbilledItemIds: ['item-1'],
  bills: [],
};

const billed = {
  ...unbilled,
  blocker: 'OPEN_BILLS',
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

    render(
      <CheckoutPanel open orderId="order-1" request={request} onClose={vi.fn()} />
    );
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
    const request: TerminalRequest = async <T,>() => {
      throw denied;
    };
    render(
      <CheckoutPanel open orderId="order-1" request={request} onClose={vi.fn()} />
    );

    expect(await screen.findByText('Payment access denied')).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Permission denied: Missing payments:collect capability.'
    );
    expect(screen.getByRole('button', { name: 'Retry checkout' })).toBeEnabled();
  });

  it('renders an empty checkout without inventing payment actions', async () => {
    const request: TerminalRequest = async <T,>() =>
      ({ ...unbilled, blocker: null, unbilledItemIds: [] }) as T;
    render(
      <CheckoutPanel open orderId="order-1" request={request} onClose={vi.fn()} />
    );

    expect(await screen.findByText('Nothing to collect')).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Apply tender' })).not.toBeInTheDocument()
    );
  });
});
