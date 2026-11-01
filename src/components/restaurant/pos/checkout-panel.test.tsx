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
  deliveryFeeTotal: '4.00',
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
      taxTotal: '0.00',
      remainingDue: '24.00',
      deliveryFeeTotal: '4.00',
      compTotal: '0.00',
      receiptNumber: null,
      lines: [
        {
          id: 'line-1',
          name: 'Lunch special',
          quantity: 1,
          lineSubtotal: '20.00',
          compAmount: '0.00',
        },
      ],
    },
  ],
};

describe('CheckoutPanel', () => {
  it.each(['3860.00', '2860.25', '0.00'])(
    'prefills the authoritative initial balance %s, including partial and zero balances',
    async (remainingDue) => {
      const request: TerminalRequest = async <T,>() =>
        ({
          ...billed,
          derivedOrderTotal: '3860.00',
          accountedTotal: '3860.00',
          bills: [{ ...billed.bills[0], grandTotal: '3860.00', remainingDue }],
        }) as T;
      render(<CheckoutPanel open orderId="order-1" request={request} onClose={vi.fn()} />);

      expect(await screen.findByLabelText('Amount')).toHaveValue(remainingDue);
      expect(screen.getByLabelText('Cash received')).toHaveValue(remainingDue);
      expect(screen.queryByText(/Outstanding balance unavailable/)).not.toBeInTheDocument();
    }
  );

  it('discloses tax and prefills the tax remainder on an open partially paid bill', async () => {
    const request: TerminalRequest = async <T,>() =>
      ({
        ...billed,
        bills: [
          { ...billed.bills[0], grandTotal: '1115.50', taxTotal: '145.50', remainingDue: '145.50' },
        ],
      }) as T;
    render(<CheckoutPanel open orderId="order-1" request={request} onClose={vi.fn()} />);

    expect(await screen.findByText('Tax')).toBeVisible();
    expect(screen.getByText('Tax').nextElementSibling).toHaveTextContent('145.50');
    expect(screen.getByText('Bill total').nextElementSibling).toHaveTextContent('1115.50');
    expect(screen.getByLabelText('Amount')).toHaveValue('145.50');
    expect(screen.getByLabelText('Cash received')).toHaveValue('145.50');
  });

  it('keeps an absent balance unknown instead of falling back to the bill total', async () => {
    const request: TerminalRequest = async <T,>() =>
      ({ ...billed, bills: [{ ...billed.bills[0], remainingDue: undefined }] }) as T;
    render(<CheckoutPanel open orderId="order-1" request={request} onClose={vi.fn()} />);

    expect(await screen.findByText(/Outstanding balance unavailable/)).toBeVisible();
    expect(screen.getByLabelText('Amount')).toHaveValue('');
    expect(screen.getByLabelText('Cash received')).toHaveValue('');
  });

  it('does not offer another tender for a settled bill with zero remaining due', async () => {
    const request: TerminalRequest = async <T,>(path: string) => {
      if (path.includes('/receipt')) return null as T;
      return {
        ...billed,
        settled: true,
        blocker: null,
        bills: [{ ...billed.bills[0], status: 'SETTLED', remainingDue: '0.00' }],
      } as T;
    };
    render(<CheckoutPanel open orderId="order-1" request={request} onClose={vi.fn()} />);

    expect(await screen.findByText('Bill total')).toBeVisible();
    expect(screen.queryByLabelText('Amount')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply tender' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Outstanding balance unavailable/)).not.toBeInTheDocument();
  });

  it('shows the frozen delivery fee separately from order and bill totals', async () => {
    const request: TerminalRequest = async <T,>() => billed as T;
    render(<CheckoutPanel open orderId="order-1" request={request} onClose={vi.fn()} />);

    expect(await screen.findByText('Order balance')).toBeVisible();
    expect(screen.getAllByText('Delivery fee')).toHaveLength(2);
    expect(screen.getAllByText('4.00')).toHaveLength(2);
    expect(screen.getAllByText('24.00')).toHaveLength(3);
  });

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

  it('submits a comp with distinct manager approval without retaining the PIN in its intent', async () => {
    const calls: { path: string; options?: TerminalRequestOptions }[] = [];
    const request: TerminalRequest = async <T,>(path: string, options?: TerminalRequestOptions) => {
      calls.push({ path, options });
      return billed as T;
    };
    render(
      <CheckoutPanel
        open
        orderId="order-1"
        request={request}
        actingOperatorId="cashier-1"
        operators={[{ id: 'manager-1', displayName: 'Mina Manager', role: 'Manager' }]}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Comp item' }));
    fireEvent.change(screen.getByLabelText('Bill item'), { target: { value: 'line-1' } });
    fireEvent.change(screen.getByLabelText('Comp reason'), {
      target: { value: ' Guest recovery ' },
    });
    fireEvent.change(screen.getByLabelText('Approving manager'), {
      target: { value: 'manager-1' },
    });
    fireEvent.change(screen.getByLabelText('Manager PIN'), { target: { value: '5678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm comp' }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        path: '/api/restaurant/checkout/comp',
        options: {
          method: 'POST',
          body: {
            billId: 'bill-1',
            billLineId: 'line-1',
            reason: 'Guest recovery',
            approving: { staffProfileId: 'manager-1', type: 'PIN', secret: '5678' },
          },
          intent:
            'checkout-comp:{"billId":"bill-1","billLineId":"line-1","reason":"Guest recovery","approvingStaffProfileId":"manager-1"}',
        },
      })
    );
    expect(calls.find((call) => call.options?.intent)?.options?.intent).not.toContain('5678');
  });

  it('does not offer comp when no distinct approving manager is available', async () => {
    const request: TerminalRequest = async <T,>() => billed as T;
    render(
      <CheckoutPanel
        open
        orderId="order-1"
        request={request}
        actingOperatorId="manager-1"
        operators={[{ id: 'manager-1', displayName: 'Mina Manager', role: 'Manager' }]}
        onClose={vi.fn()}
      />
    );

    expect(await screen.findByRole('button', { name: 'Comp item' })).toBeDisabled();
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
      ({ ...unbilled, deliveryFeeTotal: null, blocker: null, unbilledItemIds: [] }) as T;
    render(<CheckoutPanel open orderId="order-1" request={request} onClose={vi.fn()} />);

    expect(await screen.findByText('Nothing to collect')).toBeVisible();
    expect(screen.queryByText('Delivery fee')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Apply tender' })).not.toBeInTheDocument()
    );
  });

  it('fails closed for an already-open checkout while offline, then restores connected actions', async () => {
    const request: TerminalRequest = async <T,>(path: string) => {
      if (path.includes('/summary')) return billed as T;
      throw new Error(`Unexpected request: ${path}`);
    };
    const view = render(
      <CheckoutPanel open orderId="order-1" request={request} connected onClose={vi.fn()} />
    );

    expect(await screen.findByRole('button', { name: 'Apply tender' })).toBeEnabled();
    view.rerender(
      <CheckoutPanel open orderId="order-1" request={request} connected={false} onClose={vi.fn()} />
    );
    expect(screen.getByText('Checkout unavailable offline')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Apply tender' })).not.toBeInTheDocument();
    expect(screen.getByText(/Checkout, tenders, customer and loyalty actions/)).toBeVisible();

    view.rerender(
      <CheckoutPanel open orderId="order-1" request={request} connected onClose={vi.fn()} />
    );
    expect(await screen.findByRole('button', { name: 'Apply tender' })).toBeEnabled();
  });

  it('updates a successful partial tender and uses the latest summary when reopened', async () => {
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
    let summary = billed;
    const request: TerminalRequest = async <T,>(path: string, options?: TerminalRequestOptions) => {
      calls.push({ path, options });
      if (path.includes('/summary')) return summary as T;
      return (await pendingTender) as T;
    };
    const onClose = vi.fn();
    const view = render(
      <CheckoutPanel open orderId="order-1" request={request} onClose={onClose} />
    );

    expect(await screen.findByLabelText('Amount')).toHaveValue('24.00');
    expect(screen.getByLabelText('Cash received')).toHaveValue('24.00');
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '8.00' } });
    fireEvent.change(screen.getByLabelText('Cash received'), { target: { value: '8.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply tender' }));

    expect(screen.getByRole('button', { name: 'Close checkout' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'Collect payment' })).toBeVisible();

    await act(async () => resolveTender(partial));
    expect(await screen.findByText('Remaining balance 16.00')).toBeVisible();
    expect(screen.getByLabelText('Amount')).toHaveValue('16.00');
    expect(screen.getByLabelText('Cash received')).toHaveValue('16.00');
    expect(calls.filter(({ path }) => path.includes('/summary'))).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Close checkout' }));
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(
      <CheckoutPanel open={false} orderId="order-1" request={request} onClose={onClose} />
    );
    summary = { ...billed, bills: [{ ...billed.bills[0], remainingDue: '12.50' }] };
    view.rerender(<CheckoutPanel open orderId="order-1" request={request} onClose={onClose} />);

    await waitFor(() => expect(screen.getByLabelText('Amount')).toHaveValue('12.50'));
    expect(screen.getByLabelText('Cash received')).toHaveValue('12.50');
    expect(
      screen.queryByText('Outstanding balance unavailable. Enter the exact tender amount.')
    ).not.toBeInTheDocument();
  });
});

/**
 * M9-L2 — the CONNECTED guest/loyalty flow on an open bill: masked-only search results, the
 * attach and redeem round-trips (with their idempotency intents), and the server-authoritative
 * permission model. Nothing here may cache PII or gate a capability client-side.
 */
describe('CheckoutPanel guest and loyalty', () => {
  const noGuest = {
    billId: 'bill-1',
    orderId: 'order-1',
    billStatus: 'OPEN',
    customerId: null,
    accountId: null,
    accountActive: false,
    balance: 0,
    redemptionValue: '0.50',
    outstanding: '24.00',
    maxRedeemablePoints: 0,
    redeemedValue: '0',
  };

  const enrolled = {
    ...noGuest,
    customerId: 'cust-1',
    accountId: 'acct-1',
    accountActive: true,
    balance: 1000,
    maxRedeemablePoints: 48,
  };

  const match = {
    customerId: 'cust-1',
    displayName: 'Ali Raza',
    identifiers: [
      { id: 'i1', kind: 'EMAIL' as const, masked: 'a••@example.com' },
      { id: 'i2', kind: 'PHONE' as const, masked: '•••• 4567' },
    ],
  };

  /** Route each terminal call to a scripted reply and record what was sent. */
  function router(script: {
    loyalty?: () => unknown;
    search?: () => unknown;
    attach?: () => unknown;
    redeem?: () => unknown;
  }) {
    const calls: { path: string; options?: TerminalRequestOptions }[] = [];
    const request: TerminalRequest = async <T,>(path: string, options?: TerminalRequestOptions) => {
      calls.push({ path, options });
      if (path.includes('/summary')) return billed as T;
      if (path.includes('/customer/search')) return (script.search?.() ?? { customers: [] }) as T;
      if (path.includes('/customer/attach')) return (script.attach?.() ?? {}) as T;
      if (path.includes('/checkout/loyalty')) {
        if (options?.method === 'POST') return (script.redeem?.() ?? {}) as T;
        return (script.loyalty?.() ?? noGuest) as T;
      }
      return {} as T;
    };
    return { calls, request };
  }

  it('reads the loyalty snapshot for the open bill and offers guest search', async () => {
    const { calls, request } = router({});
    render(<CheckoutPanel open orderId="order-1" request={request} onClose={vi.fn()} />);

    expect(await screen.findByLabelText('Find guest')).toBeVisible();
    expect(
      calls.some(({ path }) => path === '/api/restaurant/checkout/loyalty?billId=bill-1')
    ).toBe(true);
  });

  it('shows only MASKED identifiers for a search hit — never a contactable address', async () => {
    const { request } = router({ search: () => ({ customers: [match] }) });
    render(<CheckoutPanel open orderId="order-1" request={request} onClose={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText('Find guest'), { target: { value: 'ali' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    expect(await screen.findByText('Ali Raza')).toBeVisible();
    expect(screen.getByText('a••@example.com · •••• 4567')).toBeVisible();
    expect(screen.queryByText(/ali@example\.com/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\+92300/)).not.toBeInTheDocument();
  });

  it('will not search on a single character, so the customer book cannot be dumped', async () => {
    const { calls, request } = router({});
    render(<CheckoutPanel open orderId="order-1" request={request} onClose={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText('Find guest'), { target: { value: 'a' } });
    expect(screen.getByRole('button', { name: 'Search' })).toBeDisabled();
    expect(calls.some(({ path }) => path.includes('/customer/search'))).toBe(false);
  });

  it('attaches the chosen guest and drops the masked results from the pad', async () => {
    let snapshot: unknown = noGuest;
    const { calls, request } = router({
      search: () => ({ customers: [match] }),
      attach: () => {
        snapshot = enrolled;
        return {};
      },
      loyalty: () => snapshot,
    });
    render(<CheckoutPanel open orderId="order-1" request={request} onClose={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText('Find guest'), { target: { value: 'ali' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Attach' }));

    expect(await screen.findByText('Points balance')).toBeVisible();
    expect(screen.getByText('1000')).toBeVisible();
    expect(screen.queryByText('a••@example.com · •••• 4567')).not.toBeInTheDocument();
    expect(calls.find(({ path }) => path.includes('/customer/attach'))?.options).toEqual({
      method: 'POST',
      body: { orderId: 'order-1', customerId: 'cust-1' },
      intent: 'customer-attach:{"orderId":"order-1","customerId":"cust-1"}',
    });
  });

  it('redeems POINTS (never an amount) and carries a stable idempotency intent', async () => {
    const { calls, request } = router({
      loyalty: () => enrolled,
      redeem: () => ({ value: '20.00', balance: 960 }),
    });
    render(<CheckoutPanel open orderId="order-1" request={request} onClose={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText('Points to redeem (up to 48)'), {
      target: { value: '40' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Redeem' }));

    expect(await screen.findByText('Redeemed 20.00 off this bill.')).toBeVisible();
    const redeem = calls.find(
      ({ path, options }) =>
        path === '/api/restaurant/checkout/loyalty' && options?.method === 'POST'
    );
    expect(redeem?.options).toEqual({
      method: 'POST',
      body: { billId: 'bill-1', accountId: 'acct-1', points: 40 },
      intent: 'loyalty-redeem:{"billId":"bill-1","accountId":"acct-1","points":40}',
    });
    // No money field is ever sent — the server prices the discount.
    expect(JSON.stringify(redeem?.options?.body)).not.toContain('amount');
    expect(JSON.stringify(redeem?.options?.body)).not.toContain('value');
  });

  it('refuses a fractional point entry without troubling the server', async () => {
    const { calls, request } = router({ loyalty: () => enrolled });
    render(<CheckoutPanel open orderId="order-1" request={request} onClose={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText('Points to redeem (up to 48)'), {
      target: { value: '2.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Redeem' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a whole number of points to redeem.'
    );
    expect(
      calls.some(({ path, options }) => path.includes('/loyalty') && options?.method === 'POST')
    ).toBe(false);
  });

  it('surfaces a server 403 rather than hiding the control client-side', async () => {
    const denied = Object.assign(
      new Error('This operator lacks the "loyalty:redeem" capability.'),
      {
        status: 403,
      }
    );
    const { request } = router({
      loyalty: () => {
        throw denied;
      },
    });
    render(<CheckoutPanel open orderId="order-1" request={request} onClose={vi.fn()} />);

    // The section still renders and reports the SERVER's decision; it never pretends to
    // enforce the capability itself, and offers no retry that would loop on a hard denial.
    expect(await screen.findByText('Guest & loyalty')).toBeVisible();
    expect(
      screen.getByText('Permission denied: This operator lacks the "loyalty:redeem" capability.')
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry loyalty' })).not.toBeInTheDocument();
  });

  it('says nothing is redeemable when the bill is already covered', async () => {
    const { request } = router({
      loyalty: () => ({ ...enrolled, maxRedeemablePoints: 0, outstanding: '0' }),
    });
    render(<CheckoutPanel open orderId="order-1" request={request} onClose={vi.fn()} />);

    expect(await screen.findByText('Nothing is redeemable against the remaining 0.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Redeem' })).toBeDisabled();
  });

  it('reports an unenrolled guest instead of offering a redemption keypad', async () => {
    const { request } = router({
      loyalty: () => ({ ...enrolled, accountId: null, accountActive: false, balance: 0 }),
    });
    render(<CheckoutPanel open orderId="order-1" request={request} onClose={vi.fn()} />);

    expect(
      await screen.findByText('This guest has no active loyalty balance to redeem.')
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Redeem' })).not.toBeInTheDocument();
  });
});
