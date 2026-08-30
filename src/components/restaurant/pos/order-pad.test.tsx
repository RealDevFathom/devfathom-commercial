import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrderPad } from './order-pad';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const detail = {
  id: 'order-1',
  orderNumber: 42,
  status: 'OPEN',
  channel: 'DINE_IN',
  publicationId: 'publication-1',
  coverCount: 2,
  items: [],
  tables: [{ id: 'link-1', tableId: 'table-1', active: true }],
  totals: { subtotal: '0.00', tax: '0.00', serviceCharge: '0.00' },
};

function menu(publicationId: string, itemName: string) {
  return {
    publicationId,
    channelOpen: true,
    menu: { id: 'menu-1', name: 'Dinner' },
    sections: [
      {
        id: 'section-1',
        name: 'Drinks',
        items: [
          {
            id: 'menu-item-1',
            displayName: itemName,
            product: { name: itemName },
            price: '4.00',
            available: true,
            modifierGroups: [
              {
                id: 'group-1',
                name: 'Milk',
                minSelect: 0,
                maxSelect: 1,
                options: [
                  { id: 'option-1', name: 'Oat milk', priceDelta: '0.50' },
                  { id: 'option-2', name: 'Whole milk', priceDelta: '0.00' },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function transport({
  failedOpenAttempts = 0,
  openErrors = [],
  detailResponse = detail,
  detailGate,
  failedAddAttempts = 0,
  refreshGate,
  checkoutBillErrors = [],
}: {
  failedOpenAttempts?: number;
  openErrors?: { status: number; error: string }[];
  detailResponse?: typeof detail;
  detailGate?: Promise<void>;
  failedAddAttempts?: number;
  refreshGate?: Promise<void>;
  checkoutBillErrors?: ({ status: number; error: string } | Error)[];
} = {}) {
  let openAttempts = 0;
  let addAttempts = 0;
  let openOrderReads = 0;
  let closed = false;
  let billCut = false;
  let checkoutBillAttempts = 0;
  const fetch: typeof globalThis.fetch = async (input) => {
    const path = String(input);
    if (path.endsWith('/terminal/establish')) {
      return json(
        {
          sessionToken: 'session-token',
          session: { id: 'session-1', state: 'LOCKED', establishedAt: '2026-08-19T00:00:00Z' },
          device: { id: 'device-1', name: 'Front register', branchName: 'Clifton Flagship' },
        },
        201
      );
    }
    if (path.endsWith('/terminal/operators')) {
      return json({
        operators: [{ staffProfileId: 'staff-1', displayName: 'Amina Rahman', role: 'Shift lead' }],
      });
    }
    if (path.endsWith('/terminal/layout')) {
      return json({
        floors: [
          {
            id: 'floor-1',
            name: 'Main room',
            tables: [
              { id: 'table-1', code: 'T1', capacity: 4, occupied: false, activeOrderIds: [] },
              { id: 'table-2', code: 'T2', capacity: 2, occupied: false, activeOrderIds: [] },
            ],
          },
        ],
        sections: [{ id: 'server-section-1', name: 'Window section' }],
      });
    }
    if (path.endsWith('/terminal/unlock')) {
      return json({
        session: { id: 'session-1', state: 'UNLOCKED', activeStaffProfileId: 'staff-1' },
      });
    }
    if (path.includes('/orders/effective-menu')) {
      const publicationId = new URL(path, 'http://localhost').searchParams.get('publicationId');
      return json(
        publicationId
          ? menu(publicationId, 'Pinned coffee')
          : menu(`draft-${new URL(path, 'http://localhost').searchParams.get('channel')}`, 'Coffee')
      );
    }
    if (path.endsWith('/orders/open-orders')) {
      openOrderReads += 1;
      if (openOrderReads > 1) await refreshGate;
      return json({ orders: [] });
    }
    if (path.includes('/orders/detail')) {
      await detailGate;
      return json({
        ...detailResponse,
        status: closed ? 'PAYMENT_PENDING' : detailResponse.status,
      });
    }
    if (path.endsWith('/orders/open')) {
      openAttempts += 1;
      if (openAttempts <= failedOpenAttempts) throw new TypeError('network failed');
      const responseError = openErrors[openAttempts - failedOpenAttempts - 1];
      if (responseError) return json({ error: responseError.error }, responseError.status);
      return json({ orderId: 'order-1', orderNumber: 42 }, 201);
    }
    if (path.endsWith('/orders/add-item')) {
      addAttempts += 1;
      if (addAttempts <= failedAddAttempts) throw new TypeError('network failed');
      return json({ itemId: 'item-1' }, 201);
    }
    if (path.endsWith('/orders/close')) {
      closed = true;
      return json({ orderId: 'order-1', status: 'PAYMENT_PENDING' });
    }
    if (path.includes('/checkout/summary')) {
      return json({
        orderId: 'order-1',
        settled: false,
        blocker: billCut ? 'BILLS_OPEN' : 'ITEMS_UNBILLED',
        derivedOrderTotal: '24.00',
        accountedTotal: billCut ? '24.00' : '0.00',
        unbilledItemIds: billCut ? [] : ['item-1'],
        bills: billCut
          ? [
              {
                id: 'bill-1',
                status: 'OPEN',
                splitKind: 'NONE',
                grandTotal: '24.00',
                compTotal: '0.00',
                receiptNumber: null,
              },
            ]
          : [],
      });
    }
    if (path.endsWith('/checkout/bill')) {
      checkoutBillAttempts += 1;
      const responseError = checkoutBillErrors[checkoutBillAttempts - 1];
      if (responseError instanceof Error) throw responseError;
      if (responseError) return json({ error: responseError.error }, responseError.status);
      billCut = true;
      return json({ billIds: ['bill-1'] }, 201);
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  return vi.fn(fetch);
}

async function unlock(fetch: ReturnType<typeof transport>) {
  vi.stubGlobal('fetch', fetch);
  render(<OrderPad />);

  await screen.findByRole('heading', { name: 'Terminal locked' });
  expect(screen.getByText('Front register · Clifton Flagship')).toBeVisible();
  expect(screen.queryByText(/branch-1/)).not.toBeInTheDocument();
  await screen.findByRole('option', { name: 'Amina Rahman — Shift lead' });
  fireEvent.change(screen.getByLabelText('Operator'), {
    target: { value: 'staff-1' },
  });
  fireEvent.change(screen.getByLabelText('Operator PIN'), { target: { value: '1234' } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock terminal' }));
  await screen.findByRole('heading', { name: 'Order pad' });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Open order' })).toBeEnabled());
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OrderPad transport', () => {
  it('uses AA semantic text tokens on the initial POS screen', () => {
    render(<OrderPad />);

    expect(screen.getByText('not enrolled')).toHaveClass('!text-text-strong');
    expect(
      screen.getByText('Restaurant POS', { selector: '[data-slot="eyebrow"] span' })
    ).toHaveClass('text-text-strong');
    expect(screen.getByText(/Verifying this browser with the server/)).toHaveClass(
      'text-text-body'
    );
  });

  it('composes item taps locally without a round trip', async () => {
    const fetch = transport();
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '00000000-0000-4000-8000-000000000099'
    );
    await unlock(fetch);
    const callsBeforeTap = fetch.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: /Coffee4\.00/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Oat milk/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));

    expect(fetch).toHaveBeenCalledTimes(callsBeforeTap);
    expect(screen.getByText('1 × Coffee')).toBeVisible();
    expect(screen.getByText('Coffee added locally. No request was sent.')).toBeVisible();
  });

  it('keeps internal profile IDs out of the UI and sends the selected hidden ID', async () => {
    const fetch = transport();
    await unlock(fetch);

    expect(screen.getByText('Amina Rahman · Shift lead')).toBeVisible();
    expect(screen.getByText('Server: Amina Rahman')).toBeVisible();
    expect(screen.queryByText('staff-1')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/profile id/i)).not.toBeInTheDocument();

    const unlockCall = fetch.mock.calls.find(([input]) =>
      String(input).endsWith('/terminal/unlock')
    );
    expect(JSON.parse(String(unlockCall?.[1]?.body))).toEqual({
      staffProfileId: 'staff-1',
      type: 'PIN',
      secret: '1234',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/orders/open'))).toBe(true)
    );
    const openCall = fetch.mock.calls.find(([input]) => String(input).endsWith('/orders/open'));
    expect(JSON.parse(String(openCall?.[1]?.body))).not.toHaveProperty('serverStaffProfileId');
  });

  it('reuses an uncertain retry key, creates a fresh later key, and pins the active menu', async () => {
    const fetch = transport({ failedOpenAttempts: 1 });
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000046')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000047');
    await unlock(fetch);

    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await screen.findByText('Network request failed. Retry this action.');
    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await screen.findByText('Order 42');
    expect(screen.getByRole('button', { name: /Pinned coffee/ })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /^Coffee/ })).not.toBeInTheDocument();
    expect(
      fetch.mock.calls.some(([input]) =>
        String(input).includes('/orders/effective-menu?channel=DINE_IN&publicationId=publication-1')
      )
    ).toBe(true);

    const channel = screen.getByLabelText('Channel');
    expect(channel).toHaveValue('DINE_IN');
    expect(screen.queryByRole('option', { name: 'Delivery' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Takeaway' })).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Open order' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(([input]) => String(input).endsWith('/orders/open'))
      ).toHaveLength(3)
    );

    const opens = fetch.mock.calls.filter(([input]) => String(input).endsWith('/orders/open'));
    expect(opens.map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'))).toEqual([
      '00000000-0000-4000-8000-000000000046',
      '00000000-0000-4000-8000-000000000046',
      '00000000-0000-4000-8000-000000000047',
    ]);
    expect(new Headers(opens[0]?.[1]?.headers).get('X-Terminal-Session')).toBe('session-token');
  });

  it('omits stale tables when opening a non-dine-in order', async () => {
    const fetch = transport();
    await unlock(fetch);

    fireEvent.click(screen.getByLabelText(/T1/));
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'TAKEAWAY' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open order' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));

    await waitFor(() =>
      expect(fetch.mock.calls.some(([input]) => String(input).endsWith('/orders/open'))).toBe(true)
    );
    const open = fetch.mock.calls.find(([input]) => String(input).endsWith('/orders/open'));
    expect(JSON.parse(String(open?.[1]?.body))).toEqual({
      channel: 'TAKEAWAY',
      publicationId: 'draft-TAKEAWAY',
    });
  });

  it('reuses a mutation retry key and refreshes it after completion', async () => {
    const fetch = transport({ failedAddAttempts: 1 });
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000045')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000046')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000047');
    await unlock(fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await screen.findByText('Order 42');
    fireEvent.click(screen.getByRole('button', { name: /Pinned coffee/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));
    await screen.findByText('Network request failed. Retry this action.');
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(([input]) => String(input).endsWith('/orders/add-item'))
      ).toHaveLength(2)
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add to order' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Add to order' }));
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(([input]) => String(input).endsWith('/orders/add-item'))
      ).toHaveLength(3)
    );

    const adds = fetch.mock.calls.filter(([input]) => String(input).endsWith('/orders/add-item'));
    expect(adds.map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'))).toEqual([
      '00000000-0000-4000-8000-000000000046',
      '00000000-0000-4000-8000-000000000046',
      '00000000-0000-4000-8000-000000000047',
    ]);
  });

  it('keeps the outer command pending through detail and menu reconciliation', async () => {
    let releaseDetail = () => {};
    const detailGate = new Promise<void>((resolve) => {
      releaseDetail = resolve;
    });
    const fetch = transport({ detailGate });
    await unlock(fetch);

    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await waitFor(() =>
      expect(fetch.mock.calls.some(([input]) => String(input).includes('/orders/detail'))).toBe(
        true
      )
    );
    expect(screen.getByRole('button', { name: 'Opening…' })).toBeDisabled();
    expect(screen.getByText('Request pending. Controls are paused.')).toBeVisible();

    releaseDetail();
    await screen.findByText('Order 42');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open order' })).toBeEnabled());
  });

  it('exposes pending state for a standalone refresh', async () => {
    let releaseRefresh = () => {};
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const fetch = transport({ refreshGate });
    await unlock(fetch);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    expect(screen.getByText('Request pending. Controls are paused.')).toBeVisible();

    releaseRefresh();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
  });

  it('keeps ordinary permission denial in session but resets immediately on device revocation', async () => {
    const fetch = transport({
      openErrors: [
        { status: 403, error: 'Missing order.open capability.' },
        { status: 403, error: 'This device has been revoked.' },
      ],
    });
    await unlock(fetch);

    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await screen.findByText('Permission denied: Missing order.open capability.');
    expect(screen.getByRole('heading', { name: 'Order pad' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await screen.findByRole('heading', { name: 'Not enrolled' });
    expect(screen.getByText(/Device revoked:/)).toBeVisible();
  });

  it('opens checkout only after close refreshes the order into payment pending', async () => {
    const fetch = transport();
    await unlock(fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await screen.findByText('Order 42');

    fireEvent.click(screen.getByRole('button', { name: 'Close order' }));

    expect(await screen.findByRole('heading', { name: 'Collect payment' })).toBeVisible();
    const closeIndex = fetch.mock.calls.findIndex(([input]) =>
      String(input).endsWith('/orders/close')
    );
    const refreshedDetailIndex = fetch.mock.calls.findLastIndex(([input]) =>
      String(input).includes('/orders/detail')
    );
    const summaryIndex = fetch.mock.calls.findIndex(([input]) =>
      String(input).includes('/checkout/summary')
    );
    expect(closeIndex).toBeGreaterThan(-1);
    expect(refreshedDetailIndex).toBeGreaterThan(closeIndex);
    expect(summaryIndex).toBeGreaterThan(refreshedDetailIndex);
  });

  it('opens payment pending directly and carries auth plus idempotency to checkout bill', async () => {
    const fetch = transport({ detailResponse: { ...detail, status: 'PAYMENT_PENDING' } });
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000061')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000062');
    await unlock(fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await screen.findByText('Order 42');

    fireEvent.click(screen.getByRole('button', { name: 'Collect payment' }));
    await screen.findByRole('button', { name: 'Cut single bill' });
    expect(
      fetch.mock.calls.filter(([input]) => String(input).endsWith('/orders/close'))
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Cut single bill' }));
    await screen.findByText('Bill total');
    const bill = fetch.mock.calls.find(([input]) => String(input).endsWith('/checkout/bill'));
    expect(JSON.parse(String(bill?.[1]?.body))).toEqual({
      orderId: 'order-1',
      split: { kind: 'NONE' },
    });
    const headers = new Headers(bill?.[1]?.headers);
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('X-Terminal-Session')).toBe('session-token');
    expect(headers.get('Idempotency-Key')).toBe('00000000-0000-4000-8000-000000000062');
  });

  it('retains checkout idempotency across ambiguous failures and releases it after a client error', async () => {
    const messages = [
      'Request timed out.',
      'Rate limited.',
      'Service unavailable.',
      'network failed',
      'request timed out',
      'Invalid split.',
    ];
    const fetch = transport({
      detailResponse: { ...detail, status: 'PAYMENT_PENDING' },
      checkoutBillErrors: [
        { status: 408, error: messages[0]! },
        { status: 429, error: messages[1]! },
        { status: 503, error: messages[2]! },
        new TypeError(messages[3]),
        Object.assign(new Error(messages[4]), { name: 'TimeoutError' }),
        { status: 400, error: messages[5]! },
      ],
    });
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000061')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000062')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000063');
    await unlock(fetch);
    fireEvent.click(screen.getByRole('button', { name: 'Open order' }));
    await screen.findByText('Order 42');
    fireEvent.click(screen.getByRole('button', { name: 'Collect payment' }));
    const cut = await screen.findByRole('button', { name: 'Cut single bill' });

    for (const failureMessage of messages) {
      fireEvent.click(cut);
      await screen.findByText(failureMessage);
      await waitFor(() => expect(cut).toBeEnabled());
    }
    fireEvent.click(cut);
    await screen.findByText('Bill total');

    const bills = fetch.mock.calls.filter(([input]) => String(input).endsWith('/checkout/bill'));
    expect(bills.map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'))).toEqual([
      '00000000-0000-4000-8000-000000000062',
      '00000000-0000-4000-8000-000000000062',
      '00000000-0000-4000-8000-000000000062',
      '00000000-0000-4000-8000-000000000062',
      '00000000-0000-4000-8000-000000000062',
      '00000000-0000-4000-8000-000000000062',
      '00000000-0000-4000-8000-000000000063',
    ]);
  });
});
