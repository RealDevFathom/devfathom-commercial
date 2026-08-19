import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { KdsBoard } from './kds-board';

type TicketDisplayStatus = 'NEW' | 'COOKING' | 'READY' | 'RECALLED';
type ItemDisplayStatus = TicketDisplayStatus | 'SERVED';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ticket(ticketNumber: number, name: string, displayStatus: TicketDisplayStatus) {
  const items: Array<{
    orderItemId: string;
    name: string;
    course: number;
    seatNumber: number;
    quantity: number;
    itemStatus: string;
    displayStatus: ItemDisplayStatus;
  }> = [
    {
      orderItemId: `item-${ticketNumber}`,
      name,
      course: 1,
      seatNumber: ticketNumber,
      quantity: 1,
      itemStatus:
        displayStatus === 'NEW'
          ? 'QUEUED'
          : displayStatus === 'READY'
            ? 'PREPARED'
            : displayStatus === 'RECALLED'
              ? 'REMAKE_REQUESTED'
              : 'FIRING',
      displayStatus,
    },
  ];
  return {
    ticketId: `ticket-${ticketNumber}`,
    ticketNumber,
    orderId: `order-${ticketNumber}`,
    orderNumber: 40 + ticketNumber,
    createdAt: '2026-08-19T08:00:00.000Z',
    displayStatus,
    items,
  };
}

function queue(
  tickets: ReturnType<typeof ticket>[],
  { cursor = 1, gap = false, hasMore = false } = {}
) {
  return {
    stationId: 'station-1',
    businessDate: '2026-08-19',
    tickets,
    cursor,
    gap,
    hasMore,
    displayMapping: {
      QUEUED: 'NEW',
      FIRING: 'COOKING',
      PREPARED: 'READY',
      REMAKE_REQUESTED: 'RECALLED',
    },
  };
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

async function connect(secret = 'device-secret') {
  fireEvent.change(screen.getByLabelText('Bearer device secret'), {
    target: { value: secret },
  });
  fireEvent.change(screen.getByLabelText('Acting operator profile ID'), {
    target: { value: 'staff-1' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Connect display' }));
  await flush();
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('KdsBoard transport', () => {
  it('fully resyncs once after a cursor gap and replaces stale level state', async () => {
    vi.useFakeTimers();
    const payloads = [
      queue([ticket(1, 'Stale burger', 'NEW')], { cursor: 7 }),
      queue([ticket(2, 'Gap response', 'COOKING')], { cursor: 9, gap: true, hasMore: true }),
      queue([ticket(3, 'Fresh risotto', 'READY')], { cursor: 9 }),
    ];
    const fetchImplementation: typeof globalThis.fetch = async () => json(payloads.shift());
    const fetch = vi.fn(fetchImplementation);
    vi.stubGlobal('fetch', fetch);

    render(<KdsBoard />);
    await connect();
    expect(screen.getByText('Stale burger')).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      '/api/restaurant/kds/queue?limit=50',
      '/api/restaurant/kds/queue?sinceCursor=7&limit=50',
      '/api/restaurant/kds/queue?limit=50',
    ]);
    expect(screen.getByText('Fresh risotto')).toBeVisible();
    expect(screen.queryByText('Stale burger')).not.toBeInTheDocument();
    expect(screen.queryByText('Gap response')).not.toBeInTheDocument();
  });

  it('maps bump and recall requests and preserves only an uncertain retry key', async () => {
    vi.useFakeTimers();
    const activeQueue = queue([ticket(2, 'Burger', 'COOKING'), ticket(3, 'Soup', 'READY')]);
    let bumpAttempts = 0;
    const fetchImplementation: typeof globalThis.fetch = async (input) => {
      const path = String(input);
      if (path.includes('/queue?')) return json(activeQueue);
      if (path.endsWith('/bump')) {
        bumpAttempts += 1;
        if (bumpAttempts === 1) throw new TypeError('network failed');
        return json({ action: 'BUMP' });
      }
      if (path.endsWith('/recall')) return json({ action: 'RECALL' });
      throw new Error(`Unexpected request: ${path}`);
    };
    const fetch = vi.fn(fetchImplementation);
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000047')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000048');

    render(<KdsBoard />);
    await connect();

    fireEvent.click(screen.getByRole('button', { name: 'Mark ready Burger for order 42' }));
    await flush();
    expect(screen.getByText('Network request failed. Retry this action.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Mark ready Burger for order 42' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Recall Soup for order 43' }));
    await flush();

    const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts.map(([input]) => String(input))).toEqual([
      '/api/restaurant/kds/bump',
      '/api/restaurant/kds/bump',
      '/api/restaurant/kds/recall',
    ]);
    expect(posts.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { orderItemId: 'item-2', operatorStaffProfileId: 'staff-1' },
      { orderItemId: 'item-2', operatorStaffProfileId: 'staff-1' },
      { orderItemId: 'item-3', operatorStaffProfileId: 'staff-1' },
    ]);
    expect(posts.map(([, init]) => new Headers(init?.headers).get('Authorization'))).toEqual([
      'Bearer device-secret',
      'Bearer device-secret',
      'Bearer device-secret',
    ]);
    expect(posts.map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'))).toEqual([
      '00000000-0000-4000-8000-000000000047',
      '00000000-0000-4000-8000-000000000047',
      '00000000-0000-4000-8000-000000000048',
    ]);
    expect(screen.getByText('Item recalled.')).toBeVisible();
  });

  it('disconnects on device denial without exposing the secret', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'Forbidden device secret.' }, 403))
    );

    render(<KdsBoard />);
    await connect('top-secret-value');

    expect(screen.getByRole('heading', { name: 'Connect kitchen display' })).toBeVisible();
    expect(
      screen.getByText('Device authorization failed. Reconnect with valid KDS credentials.')
    ).toBeVisible();
    expect(screen.queryByText('top-secret-value')).not.toBeInTheDocument();
  });

  it('renders a served sibling without offering another action', async () => {
    vi.useFakeTimers();
    const mixedTicket = ticket(4, 'New pasta', 'NEW');
    mixedTicket.items.push({
      orderItemId: 'served-item',
      name: 'Served salad',
      course: 1,
      seatNumber: 4,
      quantity: 1,
      itemStatus: 'SERVED',
      displayStatus: 'SERVED',
    });
    const fetchImplementation: typeof globalThis.fetch = async () => json(queue([mixedTicket]));
    vi.stubGlobal('fetch', vi.fn(fetchImplementation));

    render(<KdsBoard />);
    await connect();

    expect(screen.getByText('Served salad')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start New pasta for order 44' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Served salad/ })).not.toBeInTheDocument();
  });
});
