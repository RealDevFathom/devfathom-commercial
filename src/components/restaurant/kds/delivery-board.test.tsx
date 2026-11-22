import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeliveryBoard } from './delivery-board';

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

const pendingDelivery = {
  fulfillmentId: 'ful-1',
  orderNumber: 42,
  status: 'PENDING',
  customerName: 'Amina Rahman',
  addressLabel: 'Block 5',
  locality: 'Clifton',
  promisedAt: '2026-08-31T13:00:00.000Z',
  deliveryFee: '3.50',
  updatedAt: '2026-08-31T12:00:00.000Z',
  paymentMode: 'COD',
  dispatchable: true,
  rejection: null,
};

async function flush() {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DeliveryBoard', () => {
  it('renders privacy-minimized dispatch facts and confirms a connected-only transition', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).endsWith('/transition')
        ? json({ fulfillmentId: 'ful-1', status: 'DISPATCHED', paymentMode: 'COD' })
        : json({ serverTime: '2026-08-31T12:00:00.000Z', deliveries: [pendingDelivery] })
    );
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '00000000-0000-4000-8000-000000000049'
    );

    render(
      <DeliveryBoard
        sessionToken="session-token"
        operatorStaffProfileId="staff-1"
        onAuthorizationFailure={vi.fn()}
      />
    );
    await flush();

    expect(screen.getByText('Amina Rahman')).toBeVisible();
    expect(screen.getByText('Block 5 · Clifton')).toBeVisible();
    expect(document.body.textContent).not.toContain('0300');
    expect(document.body.textContent).not.toContain('addressLine');

    fireEvent.click(screen.getByRole('button', { name: 'Dispatch order 42' }));
    expect(screen.getByRole('dialog')).toBeVisible();
    const confirmation = screen.getByRole('button', { name: 'Confirm transition' });
    await waitFor(() => expect(confirmation).toHaveFocus());
    fireEvent.click(confirmation);
    await flush();

    const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe('/api/restaurant/kds/delivery/transition');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      fulfillmentId: 'ful-1',
      status: 'DISPATCHED',
      operatorStaffProfileId: 'staff-1',
    });
    expect(new Headers(post?.[1]?.headers).get('Idempotency-Key')).toBe(
      '00000000-0000-4000-8000-000000000049'
    );
  });

  it('shows actionable blocked and empty states without enabling dispatch', async () => {
    vi.useFakeTimers();
    const blocked = {
      ...pendingDelivery,
      paymentMode: null,
      dispatchable: false,
      rejection: 'Resolve partial or mixed payment before dispatch.',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ serverTime: '2026-08-31T12:00:00.000Z', deliveries: [blocked] }))
    );

    const { unmount } = render(
      <DeliveryBoard
        sessionToken="session-token"
        operatorStaffProfileId="staff-1"
        onAuthorizationFailure={vi.fn()}
      />
    );
    await flush();
    expect(screen.getByText('Resolve partial or mixed payment before dispatch.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Dispatch order 42' })).toBeDisabled();
    unmount();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ serverTime: '2026-08-31T12:00:00.000Z', deliveries: [] }))
    );
    render(
      <DeliveryBoard
        sessionToken="session-token"
        operatorStaffProfileId="staff-1"
        onAuthorizationFailure={vi.fn()}
      />
    );
    await flush();
    expect(screen.getByText('No deliveries are waiting for dispatch or completion.')).toBeVisible();
  });

  it('does not queue offline and reports forbidden authorization', async () => {
    vi.useFakeTimers();
    const onAuthorizationFailure = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'Forbidden.' }, 403, { 'X-Terminal-Access': 'denied' }))
    );
    render(
      <DeliveryBoard
        sessionToken="session-token"
        operatorStaffProfileId="staff-1"
        onAuthorizationFailure={onAuthorizationFailure}
      />
    );
    await flush();
    expect(onAuthorizationFailure).toHaveBeenCalledOnce();
    expect(onAuthorizationFailure).toHaveBeenCalledWith('Forbidden.');
    expect(screen.queryByText(/queued offline/i)).not.toBeInTheDocument();
  });
});
