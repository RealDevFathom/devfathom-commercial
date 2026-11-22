import { selectFieldControl } from '@/lib/testing/select-field';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { KdsBoard } from './kds-board';

type TicketDisplayStatus = 'NEW' | 'COOKING' | 'READY' | 'RECALLED';
type ItemDisplayStatus = TicketDisplayStatus | 'HELD' | 'SERVED';

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function ticket(
  ticketNumber: number,
  name: string,
  displayStatus: TicketDisplayStatus,
  modifierNames: string[] = []
) {
  const items: Array<{
    orderItemId: string;
    name: string;
    modifierNames: string[];
    course: number;
    seatNumber: number;
    quantity: number;
    itemStatus: string;
    displayStatus: ItemDisplayStatus;
  }> = [
    {
      orderItemId: `item-${ticketNumber}`,
      name,
      modifierNames,
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
    stationName: 'Hot Kitchen',
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

function operatorDirectory() {
  return { operators: [{ staffProfileId: 'staff-1', displayName: 'Amina Rahman', role: 'Cook' }] };
}

function deliveryQueue() {
  return { serverTime: '2026-08-19T08:00:00.000Z', deliveries: [] };
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}

async function connect(enrolled = true) {
  const fetch = globalThis.fetch;
  if (enrolled) {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.endsWith('/terminal/establish')) {
          return Promise.resolve(
            json({
              sessionToken: 'session-token',
              session: { state: 'LOCKED', activeStaffProfileId: null },
              device: {
                name: 'Kitchen screen',
                branchName: 'Clifton Flagship',
                kind: 'KDS',
              },
            })
          );
        }
        if (path.endsWith('/terminal/unlock')) {
          return Promise.resolve(json({ session: { id: 'session-1', state: 'UNLOCKED' } }));
        }
        return fetch(input, init);
      })
    );
  }
  await flush();
  if (!enrolled) return;
  fireEvent.change(
    selectFieldControl(
      screen.getByLabelText('Acting operator', {
        selector: ':not([data-select-field-native][aria-hidden="true"])',
      })
    ),
    {
      target: { value: 'staff-1' },
    }
  );
  fireEvent.change(screen.getByLabelText('Operator PIN'), { target: { value: '1234' } });
  fireEvent.click(screen.getByRole('button', { name: 'Verify PIN and unlock' }));
  await flush();
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('KdsBoard transport', () => {
  it.each(['Hot Kitchen', null, undefined, '   '])(
    'shows a human station label without the raw ID (name: %s)',
    async (stationName) => {
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof globalThis.fetch>(async (input) => {
          const path = String(input);
          if (path.endsWith('/operators')) return json(operatorDirectory());
          if (path.endsWith('/delivery/queue')) return json(deliveryQueue());
          return json({ ...queue([]), stationName });
        })
      );
      const { container } = render(<KdsBoard />);
      await connect();

      expect(
        screen.getByText(
          `Kitchen screen · Clifton Flagship · ${stationName?.trim() || 'Kitchen station'} · business date 2026-08-19`
        )
      ).toBeVisible();
      expect(container).not.toHaveTextContent('station-1');
    }
  );

  it('bootstraps an unlocked demo KDS without enrollment or operator PIN setup', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = String(input);
      if (path.endsWith('/demo/restaurants/device-session')) {
        return json({
          ready: true,
          branchId: 'branch-1',
          sessionToken: 'session-token',
          session: {
            id: 'session-1',
            state: 'UNLOCKED',
            activeStaffProfileId: 'staff-1',
            establishedAt: '2026-08-19T00:00:00Z',
          },
          device: {
            id: 'device-1',
            name: 'Demo kitchen',
            branchName: 'Clifton Flagship',
            kind: 'KDS',
          },
          operator: { staffProfileId: 'staff-1', displayName: 'Demo Manager', role: 'Manager' },
        });
      }
      if (path.includes('/kds/queue?'))
        return json(queue([ticket(1, 'Demo burger', 'NEW', ['Mild'])]));
      if (path.endsWith('/delivery/queue')) return json(deliveryQueue());
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetch);

    render(
      <StrictMode>
        <KdsBoard demo />
      </StrictMode>
    );

    expect(await screen.findByText('Demo burger')).toBeVisible();
    expect(screen.getByText('Mild')).toBeVisible();
    expect(screen.queryByLabelText('Operator PIN')).not.toBeInTheDocument();
    const bootstraps = fetch.mock.calls.filter(([input]) =>
      String(input).endsWith('/demo/restaurants/device-session')
    );
    expect(bootstraps).toHaveLength(1);
    expect(bootstraps[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'KDS' }),
    });
  });

  it('shows the server reason when a session-bearing kitchen poll is refused', async () => {
    vi.useFakeTimers();
    const reason = 'This operator no longer has kitchen access at this branch.';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith('/operators')) return json(operatorDirectory());
        if (path.endsWith('/delivery/queue')) return json(deliveryQueue());
        return json({ error: reason }, 403, { 'X-Terminal-Access': 'denied' });
      })
    );
    render(<KdsBoard />);
    await connect();
    expect(screen.getByText(reason)).toBeVisible();
  });

  it('fully resyncs once after a cursor gap and replaces stale level state', async () => {
    vi.useFakeTimers();
    const payloads = [
      queue([ticket(1, 'Stale burger', 'NEW')], { cursor: 7 }),
      queue([ticket(2, 'Gap response', 'COOKING')], { cursor: 9, gap: true, hasMore: true }),
      queue([ticket(3, 'Fresh risotto', 'READY')], { cursor: 9 }),
    ];
    const fetchImplementation: typeof globalThis.fetch = async (input) => {
      const path = String(input);
      if (path.endsWith('/operators')) return json(operatorDirectory());
      if (path.endsWith('/delivery/queue')) return json(deliveryQueue());
      return json(payloads.shift());
    };
    const fetch = vi.fn(fetchImplementation);
    vi.stubGlobal('fetch', fetch);

    render(<KdsBoard />);
    await connect();
    expect(screen.getByText('Stale burger')).toBeVisible();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(
      fetch.mock.calls.map(([input]) => String(input)).filter((path) => path.includes('/queue?'))
    ).toEqual([
      '/api/restaurant/kds/queue?limit=50',
      '/api/restaurant/kds/queue?sinceCursor=7&limit=50',
      '/api/restaurant/kds/queue?limit=50',
    ]);
    expect(screen.getByText('Fresh risotto')).toBeVisible();
    expect(screen.queryByText('Stale burger')).not.toBeInTheDocument();
    expect(screen.queryByText('Gap response')).not.toBeInTheDocument();
  });

  it('fully resyncs after a cursor regression', async () => {
    vi.useFakeTimers();
    const payloads = [
      queue([ticket(1, 'Original ticket', 'NEW')], { cursor: 7 }),
      queue([ticket(2, 'Regressed ticket', 'COOKING')], { cursor: 6 }),
      queue([ticket(3, 'Replacement ticket', 'READY')], { cursor: 8 }),
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = String(input);
      if (path.endsWith('/operators')) return json(operatorDirectory());
      if (path.endsWith('/delivery/queue')) return json(deliveryQueue());
      return json(payloads.shift());
    });
    vi.stubGlobal('fetch', fetch);

    render(<KdsBoard />);
    await connect();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(
      fetch.mock.calls.map(([input]) => String(input)).filter((path) => path.includes('/queue?'))
    ).toEqual([
      '/api/restaurant/kds/queue?limit=50',
      '/api/restaurant/kds/queue?sinceCursor=7&limit=50',
      '/api/restaurant/kds/queue?limit=50',
    ]);
    expect(screen.getByText('Replacement ticket')).toBeVisible();
    expect(screen.queryByText('Regressed ticket')).not.toBeInTheDocument();
  });

  it('refreshes immediately on online and visible events', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) =>
      String(input).endsWith('/operators')
        ? json(operatorDirectory())
        : String(input).endsWith('/delivery/queue')
          ? json(deliveryQueue())
          : json(queue([]))
    );
    vi.stubGlobal('fetch', fetch);

    render(<KdsBoard />);
    await connect();
    expect(fetch.mock.calls.filter(([input]) => String(input).includes('/queue?'))).toHaveLength(1);

    window.dispatchEvent(new Event('online'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetch.mock.calls.filter(([input]) => String(input).includes('/queue?'))).toHaveLength(2);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetch.mock.calls.filter(([input]) => String(input).includes('/queue?'))).toHaveLength(3);
  });

  it('backs off degraded polling to a bounded interval and shows last confirmed sync', async () => {
    vi.useFakeTimers();
    const responses: Array<Response | Error> = [
      json(queue([ticket(1, 'Confirmed ticket', 'NEW')], { cursor: 4 })),
      new TypeError('offline'),
      new TypeError('still offline'),
      new TypeError('still offline'),
      new TypeError('still offline'),
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (String(input).endsWith('/operators')) return json(operatorDirectory());
      if (String(input).endsWith('/delivery/queue')) return json(deliveryQueue());
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response ?? json(queue([]));
    });
    vi.stubGlobal('fetch', fetch);

    render(<KdsBoard />);
    await connect();
    expect(screen.getByText(/Last synced/)).toBeVisible();

    for (const delay of [5_000, 10_000, 20_000, 30_000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay);
      });
    }

    expect(fetch.mock.calls.filter(([input]) => String(input).includes('/queue?'))).toHaveLength(5);
    expect(screen.getByText('degraded')).toBeVisible();
    expect(
      screen.getByText(/Showing the last confirmed station state while recovery continues/)
    ).toBeVisible();
    expect(screen.getByText('Confirmed ticket')).toBeVisible();
  });

  it('maps bump and recall requests and preserves only an uncertain retry key', async () => {
    vi.useFakeTimers();
    const activeQueue = queue([ticket(2, 'Burger', 'COOKING'), ticket(3, 'Soup', 'READY')]);
    let bumpAttempts = 0;
    const fetchImplementation: typeof globalThis.fetch = async (input) => {
      const path = String(input);
      if (path.endsWith('/operators')) return json(operatorDirectory());
      if (path.endsWith('/delivery/queue')) return json(deliveryQueue());
      if (path.includes('/queue?')) return json(activeQueue);
      if (path.endsWith('/bump')) {
        bumpAttempts += 1;
        if (bumpAttempts === 1) throw new TypeError('network failed');
        if (bumpAttempts === 2) return json({ error: 'Outcome not confirmed.' }, 503);
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
    expect(screen.getByText('Outcome not confirmed.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Mark ready Burger for order 42' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Recall Soup for order 43' }));
    await flush();

    const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts.map(([input]) => String(input))).toEqual([
      '/api/restaurant/kds/bump',
      '/api/restaurant/kds/bump',
      '/api/restaurant/kds/bump',
      '/api/restaurant/kds/recall',
    ]);
    expect(posts.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { orderItemId: 'item-2', operatorStaffProfileId: 'staff-1' },
      { orderItemId: 'item-2', operatorStaffProfileId: 'staff-1' },
      { orderItemId: 'item-2', operatorStaffProfileId: 'staff-1' },
      { orderItemId: 'item-3', operatorStaffProfileId: 'staff-1' },
    ]);
    expect(posts.map(([, init]) => new Headers(init?.headers).get('Authorization'))).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(posts.map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'))).toEqual([
      '00000000-0000-4000-8000-000000000047',
      '00000000-0000-4000-8000-000000000047',
      '00000000-0000-4000-8000-000000000047',
      '00000000-0000-4000-8000-000000000048',
    ]);
    expect(screen.getByText('Item recalled.')).toBeVisible();
  });

  it('queues a KOT reprint for the displayed station ticket', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = String(input);
      if (path.endsWith('/operators')) return json(operatorDirectory());
      if (path.endsWith('/delivery/queue')) return json(deliveryQueue());
      if (path.includes('/queue?')) return json(queue([ticket(2, 'Burger', 'NEW')]));
      if (path.endsWith('/orders/reprint-kot')) return json({ ticketId: 'ticket-2' });
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '00000000-0000-4000-8000-000000000049'
    );

    render(<KdsBoard />);
    await connect();
    fireEvent.click(screen.getByRole('button', { name: 'Reprint KOT 2 for order 42' }));
    await flush();

    const call = fetch.mock.calls.find(([input]) => String(input).endsWith('/orders/reprint-kot'));
    expect(call).toBeDefined();
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      orderId: 'order-2',
      ticketId: 'ticket-2',
    });
    expect(new Headers(call?.[1]?.headers).get('Idempotency-Key')).toBe(
      '00000000-0000-4000-8000-000000000049'
    );
    expect(new Headers(call?.[1]?.headers).get('X-POS-Composer-Proof')).toBeNull();
    expect(screen.getByText('KOT 2 reprint queued.')).toBeVisible();
  });

  it('keeps the station connected and shows the plain reason when only reprint is forbidden', async () => {
    vi.useFakeTimers();
    const reason = 'This operator lacks the "orders:take" capability.';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path.endsWith('/operators')) return json(operatorDirectory());
        if (path.endsWith('/delivery/queue')) return json(deliveryQueue());
        if (path.endsWith('/orders/reprint-kot')) return json({ error: reason }, 403);
        return json(queue([ticket(2, 'Burger', 'NEW')]));
      })
    );
    render(<KdsBoard />);
    await connect();
    fireEvent.click(screen.getByRole('button', { name: 'Reprint KOT 2 for order 42' }));
    await flush();
    expect(screen.getByText(reason)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reprint KOT 2 for order 42' })).toBeVisible();
  });

  it('rejects a denied device before exposing operators or the secret', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'Forbidden device secret.' }, 403))
    );

    render(<KdsBoard />);
    await connect(false);

    expect(screen.getByRole('heading', { name: 'Checking enrollment' })).toBeVisible();
    expect(
      screen.getByRole('option', {
        hidden: true,
        name: 'Operators unavailable — verify the device secret',
      })
    ).toBeVisible();
    expect(document.body.textContent).not.toContain('rdk_');
  });

  it('renders a served sibling without offering another action', async () => {
    vi.useFakeTimers();
    const mixedTicket = ticket(4, 'New pasta', 'NEW');
    mixedTicket.items.push({
      orderItemId: 'served-item',
      name: 'Served salad',
      modifierNames: [],
      course: 1,
      seatNumber: 4,
      quantity: 1,
      itemStatus: 'SERVED',
      displayStatus: 'SERVED',
    });
    mixedTicket.items.push({
      orderItemId: 'held-item',
      name: 'Held dessert',
      modifierNames: [],
      course: 3,
      seatNumber: 4,
      quantity: 1,
      itemStatus: 'HELD',
      displayStatus: 'HELD',
    });
    const fetchImplementation: typeof globalThis.fetch = async (input) =>
      String(input).endsWith('/operators')
        ? json(operatorDirectory())
        : String(input).endsWith('/delivery/queue')
          ? json(deliveryQueue())
          : json(queue([mixedTicket]));
    vi.stubGlobal('fetch', vi.fn(fetchImplementation));

    render(<KdsBoard />);
    await connect();

    expect(screen.getByText('Served salad')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start New pasta for order 44' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Served salad/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Course 3 · HOLD — DO NOT FIRE/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Held dessert/ })).not.toBeInTheDocument();
  });
});
