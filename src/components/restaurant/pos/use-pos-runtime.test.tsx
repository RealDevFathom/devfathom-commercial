import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChangeEvent } from 'react';

import { usePosRuntime } from './use-pos-runtime';

const operators = [
  {
    staffProfileId: 'staff-1',
    displayName: 'Amina',
    role: 'Manager',
    canComp: true,
    canApprove: true,
  },
  {
    staffProfileId: 'staff-2',
    displayName: 'Bilal',
    role: 'Cashier',
    canComp: false,
    canApprove: false,
  },
];
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
function transport(extra: (path: string, init?: RequestInit) => Promise<Response> | undefined) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input);
    const response = extra(path, init);
    if (response) return response;
    if (path === '/demo/restaurants/device-session') {
      return json({
        sessionToken: 'test-session-token',
        session: { id: 'session-1', state: 'UNLOCKED', establishedAt: '2026-08-19T00:00:00Z' },
        device: {
          id: 'device-1',
          organizationId: 'org-1',
          branchId: 'branch-1',
          name: 'Register',
          branchName: 'Main',
        },
        operator: operators[0],
      });
    }
    if (path.endsWith('/operators')) return json({ operators });
    if (path.endsWith('/layout')) return json({ floors: [], sections: [] });
    if (path.endsWith('/open-orders')) return json({ orders: [] });
    if (path.endsWith('/delivery/zones')) return json({ zones: [] });
    if (path.endsWith('/commercial-terms'))
      return json({ profiles: [], rules: [], serviceChargeRate: null });
    if (path.includes('/effective-menu'))
      return json({
        version: 'version-1',
        branchId: 'branch-1',
        channel: 'DINE_IN',
        publicationId: 'publication-1',
        channelOpen: true,
        menu: { id: 'menu-1', name: 'Dinner' },
        sections: [],
      });
    if (path.endsWith('/terminal/switch'))
      return json({
        session: { id: 'session-1', state: 'UNLOCKED', activeStaffProfileId: 'staff-2' },
      });
    throw new Error(`Unexpected request: ${path}`);
  });
}
afterEach(() => vi.unstubAllGlobals());

describe('usePosRuntime boundaries', () => {
  it('fails closed when legacy session data omits the comp capability', async () => {
    const legacyOperator = {
      staffProfileId: 'staff-1',
      displayName: 'Amina',
      role: 'Manager',
      canApprove: true,
    };
    const fetch = transport((path) => {
      if (path === '/demo/restaurants/device-session') {
        return Promise.resolve(
          json({
            sessionToken: 'test-session-token',
            session: {
              id: 'session-1',
              state: 'UNLOCKED',
              establishedAt: '2026-08-19T00:00:00Z',
            },
            device: {
              id: 'device-1',
              organizationId: 'org-1',
              branchId: 'branch-1',
              name: 'Register',
              branchName: 'Main',
            },
            operator: legacyOperator,
          })
        );
      }
      if (path.endsWith('/operators')) {
        return Promise.resolve(json({ operators: [legacyOperator] }));
      }
    });
    vi.stubGlobal('fetch', fetch);

    const { result } = renderHook(() => usePosRuntime({ demo: true }));

    await waitFor(() => expect(result.current.runtime?.state).toBe('UNLOCKED'));
    expect(result.current.workspace!.checkoutPanelProps.canComp).toBe(false);
  });

  it.each(['timeout', 'definitive rejection'] as const)(
    'preserves the checkout retry contract after %s',
    async (failure) => {
      let attempts = 0;
      const fetch = transport((path) => {
        if (path !== '/api/restaurant/bills/cut') return;
        if (++attempts === 1) {
          return failure === 'timeout'
            ? Promise.reject(new DOMException('Request timed out', 'TimeoutError'))
            : Promise.resolve(json({ error: 'Bill cannot be cut.' }, 409));
        }
        return Promise.resolve(json({ id: 'bill-1' }));
      });
      vi.stubGlobal('fetch', fetch);
      const { result } = renderHook(() => usePosRuntime({ demo: true }));
      await waitFor(() => expect(result.current.pending).toBeNull());
      await waitFor(() => expect(result.current.runtime?.state).toBe('UNLOCKED'));
      const request = () =>
        result.current.workspace!.checkoutPanelProps.request('/api/restaurant/bills/cut', {
          method: 'POST',
          intent: 'cut-order-1',
          body: { orderId: 'order-1' },
        });
      await expect(request()).rejects.toThrow();
      await request();
      await request();
      const calls = fetch.mock.calls.filter(([path]) => String(path).endsWith('/bills/cut'));
      const keys = calls.map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'));
      expect(keys[0]).toBeTruthy();
      if (failure === 'timeout') expect(keys[1]).toBe(keys[0]);
      else expect(keys[1]).not.toBe(keys[0]);
      expect(keys[2]).not.toBe(keys[1]);
      for (const [, init] of calls) {
        expect(init?.credentials).toBe('include');
        expect(new Headers(init?.headers).get('X-Terminal-Session')).toBe('test-session-token');
      }
    }
  );

  it('ignores customer search that resolves after the operator boundary changes', async () => {
    let release!: (response: Response) => void;
    const deferred = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetch = transport((path) => (path.includes('/customer/search') ? deferred : undefined));
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => usePosRuntime({ demo: true }));
    await waitFor(() => expect(result.current.runtime?.state).toBe('UNLOCKED'));
    await waitFor(() => expect(result.current.pending).toBeNull());
    expect(result.current.workspace!.checkoutPanelProps.canComp).toBe(true);
    act(() =>
      result.current.workspace!.changeCustomerQuery({
        target: { value: 'Customer' },
      } as ChangeEvent<HTMLInputElement>)
    );
    act(() => result.current.workspace!.searchCustomers());
    expect(fetch.mock.calls.some(([path]) => String(path).includes('query=Customer'))).toBe(true);
    await act(async () => {
      await result.current.workspace!.operatorSwitchProps.onSwitch({
        staffProfileId: 'staff-2',
        type: 'PIN',
        secret: '2222',
      });
    });
    expect(result.current.runtime?.operator?.staffProfileId).toBe('staff-2');
    expect(result.current.workspace!.checkoutPanelProps.canComp).toBe(false);
    await act(async () => {
      release(
        json({
          customers: [{ customerId: 'customer-1', displayName: 'Customer', identifiers: [] }],
        })
      );
      await deferred;
    });
    expect(result.current.deliveryCustomers).toEqual([]);
    expect(result.current.customerQuery).toBe('');
  });
});

describe('POS workspace after session extraction', () => {
  it('keeps menu and queue hydration in POS, clears the workspace on lock and reloads on unlock', async () => {
    const fetch = transport((path) => {
      if (path.endsWith('/terminal/lock'))
        return Promise.resolve(
          json({ session: { id: 'session-1', state: 'LOCKED', activeStaffProfileId: null } })
        );
      if (path.endsWith('/terminal/unlock'))
        return Promise.resolve(
          json({ session: { id: 'session-1', state: 'UNLOCKED', activeStaffProfileId: 'staff-1' } })
        );
    });
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => usePosRuntime({ demo: true }));
    await waitFor(() => expect(result.current.draftMenu?.menu.name).toBe('Dinner'));
    await waitFor(() => expect(result.current.pending).toBeNull());
    expect(result.current.queue).not.toBeNull();
    const oldRequest = result.current.workspace!.checkoutPanelProps.request;
    act(() => result.current.workspace!.lockTerminal());
    await waitFor(() => expect(result.current.runtime?.state).toBe('LOCKED'));
    expect(result.current.draftMenu).toBeNull();
    expect(result.current.layout).toBeNull();
    expect(result.current.openOrders).toEqual([]);
    await expect(oldRequest('/api/restaurant/bills/cut', { method: 'POST' })).rejects.toThrow(
      'unlocked terminal'
    );
    await waitFor(() => expect(result.current.pending).toBeNull());
    act(() =>
      result.current.workspace!.changePin({
        target: { value: '1234' },
      } as ChangeEvent<HTMLInputElement>)
    );
    await act(() => result.current.workspace!.unlock({ preventDefault() {} } as never));
    await waitFor(() => expect(result.current.draftMenu?.menu.name).toBe('Dinner'));
    expect(result.current.runtime?.operator?.staffProfileId).toBe('staff-1');
    expect(result.current.operatorPin).toBe('');
    expect(
      fetch.mock.calls.filter(([path]) => String(path).includes('/effective-menu'))
    ).toHaveLength(2);
  });
  it('preserves demo expiry recovery and clears POS workspace after terminal access ends', async () => {
    const fetch = transport((path) =>
      path.endsWith('/bills/cut')
        ? Promise.resolve(json({ error: 'Demo access has expired.' }, 401))
        : undefined
    );
    vi.stubGlobal('fetch', fetch);
    const { result } = renderHook(() => usePosRuntime({ demo: true }));
    await waitFor(() => expect(result.current.draftMenu).not.toBeNull());
    await waitFor(() => expect(result.current.pending).toBeNull());
    await act(async () => {
      await expect(
        result.current.workspace!.checkoutPanelProps.request('/api/restaurant/bills/cut', {
          method: 'POST',
        })
      ).rejects.toThrow('Demo access');
    });
    expect(result.current.runtime).toBeNull();
    expect(result.current.draftMenu).toBeNull();
    expect(result.current.workspace).toBeNull();
    expect(result.current.enrollmentState).toBe('missing');
    expect(result.current.notice?.message).toBe('Demo access expired. Reopen the restaurant demo.');
  });
});
