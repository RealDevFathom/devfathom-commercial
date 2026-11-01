import { act, cleanup, fireEvent, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FormEvent } from 'react';
import { request, useTerminalSession } from './use-terminal-session';

const operators = [
  { staffProfileId: 'staff-1', displayName: 'Amina', role: 'Manager', canApprove: true },
];
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function transport(extra?: (path: string) => Promise<Response> | Response | undefined) {
  return vi.fn<typeof fetch>(async (input) => {
    const path = String(input);
    const result = extra?.(path);
    if (result) return result;
    if (path.endsWith('/establish'))
      return response({
        sessionToken: 'test-cookie-session',
        session: { id: 'session-1', state: 'LOCKED' },
        device: {
          id: 'device-1',
          organizationId: 'org-1',
          branchId: 'branch-1',
          name: 'Register',
          branchName: 'Main',
        },
      });
    if (path.endsWith('/operators')) return response({ operators });
    if (path.endsWith('/unlock'))
      return response({
        session: { id: 'session-1', state: 'UNLOCKED', activeStaffProfileId: 'staff-1' },
      });
    if (path.endsWith('/lock'))
      return response({
        session: { id: 'session-1', state: 'LOCKED', activeStaffProfileId: null },
      });
    if (path.endsWith('/money')) return response({ evidenceId: 'receipt-1', replayed: false });
    throw new Error(`Unexpected request: ${path}`);
  });
}
async function ready() {
  const hook = renderHook(() => useTerminalSession());
  await waitFor(() => expect(hook.result.current.operatorDirectoryState).toBe('ready'));
  act(() => hook.result.current.setOperatorPin('1234'));
  await act(() =>
    hook.result.current.unlock({ preventDefault() {} } as FormEvent<HTMLFormElement>)
  );
  expect(hook.result.current.runtime?.state).toBe('UNLOCKED');
  return hook;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Shared enrolled terminal transport', () => {
  it('automatically renews an expired online command proof and preserves the retry key and body', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ error: 'Missing or invalid POS composer proof.' }, 403))
      .mockResolvedValueOnce(response({ composerProof: 'renewed-proof' }))
      .mockResolvedValueOnce(response({ orderId: 'order-1' }, 201));
    vi.stubGlobal('fetch', fetch);
    const init = {
      method: 'POST',
      headers: {
        'X-Terminal-Session': 'session-token',
        'X-POS-Composer-Proof': 'expired-proof',
        'Idempotency-Key': 'stable-open-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel: 'TAKEAWAY' }),
    };
    await expect(request('/api/restaurant/orders/open', init)).resolves.toEqual({
      orderId: 'order-1',
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[1][0]).toBe('/api/restaurant/terminal/renew-composer-proof');
    expect(JSON.parse(String(fetch.mock.calls[1][1]!.body))).toEqual({
      originalProof: 'expired-proof',
    });
    const retry = fetch.mock.calls[2][1]!;
    expect(retry.body).toBe(init.body);
    expect(new Headers(retry.headers).get('Idempotency-Key')).toBe('stable-open-key');
    expect(new Headers(retry.headers).get('X-POS-Composer-Proof')).toBe('renewed-proof');
    expect(new Headers(retry.headers).get('X-Terminal-Session')).toBe('session-token');
    expect(retry.credentials).toBe('include');
  });

  it.each(['renewal rejected', 'retry rejected', 'unrelated denial'])(
    'does not loop or bypass a denial when %s',
    async (failure) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          response(
            {
              error:
                failure === 'unrelated denial'
                  ? 'This operator lacks permission.'
                  : 'Missing or invalid POS composer proof.',
            },
            403
          )
        );
      if (failure === 'renewal rejected')
        fetch.mockResolvedValueOnce(response({ error: 'Wrong operator.' }, 403));
      if (failure === 'retry rejected') {
        fetch.mockResolvedValueOnce(response({ composerProof: 'new-proof' }));
        fetch.mockResolvedValueOnce(
          response({ error: 'Missing or invalid POS composer proof.' }, 403)
        );
      }
      vi.stubGlobal('fetch', fetch);
      await expect(
        request('/api/restaurant/orders/open', {
          method: 'POST',
          headers: { 'X-Terminal-Session': 'session-token', 'X-POS-Composer-Proof': 'old-proof' },
          body: '{}',
        })
      ).rejects.toMatchObject({ status: 403 });
      expect(fetch).toHaveBeenCalledTimes(
        failure === 'renewal rejected' ? 2 : failure === 'retry rejected' ? 3 : 1
      );
    }
  );
  it('establishes and unlocks with cookies; only the session header reaches money commands', async () => {
    const fetch = transport();
    vi.stubGlobal('fetch', fetch);
    const { result } = await ready();
    await result.current.checkoutRequest('/api/restaurant/catering/money', {
      method: 'POST',
      body: { amount: '10' },
      idempotencyKey: 'deliberate-command',
    });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/restaurant/terminal/establish',
      '/api/restaurant/terminal/operators',
      '/api/restaurant/terminal/unlock',
      '/api/restaurant/catering/money',
    ]);
    const init = fetch.mock.calls.at(-1)![1]!;
    expect(init.credentials).toBe('include');
    expect(new Headers(init.headers).get('X-Terminal-Session')).toBe('test-cookie-session');
    expect(new Headers(init.headers).get('Authorization')).toBeNull();
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('deliberate-command');
    expect(init.body).toBe('{"amount":"10"}');
    expect(result.current.operatorPin).toBe('');
  });
  it('accepts a valid null response for a register without an open drawer', async () => {
    vi.stubGlobal(
      'fetch',
      transport((path) => (path.endsWith('/drawer/current') ? response(null) : undefined))
    );
    const { result } = await ready();
    await expect(
      result.current.checkoutRequest('/api/restaurant/cash/drawer/current')
    ).resolves.toBeNull();
    expect(result.current.runtime?.state).toBe('UNLOCKED');
  });
  it('keeps an unreadable denial definitive without inventing terminal revocation', async () => {
    vi.stubGlobal(
      'fetch',
      transport((path) =>
        path.endsWith('/money') ? new Response('broken', { status: 403 }) : undefined
      )
    );
    const { result } = await ready();
    await act(async () => {
      await expect(
        result.current.checkoutRequest('/api/restaurant/catering/money', { method: 'POST' })
      ).rejects.toMatchObject({ status: 403 });
    });
    expect(result.current.runtime?.state).toBe('UNLOCKED');
  });
  it('retains the generated money key when a command returns null JSON', async () => {
    let attempts = 0;
    const fetch = transport((path) =>
      path.endsWith('/money') && ++attempts === 1 ? response(null) : undefined
    );
    vi.stubGlobal('fetch', fetch);
    const { result } = await ready();
    const options = { method: 'POST' as const, body: { amount: '10' } };
    await expect(
      result.current.checkoutRequest('/api/restaurant/catering/money', options)
    ).rejects.toThrow('unreadable');
    await result.current.checkoutRequest('/api/restaurant/catering/money', options);
    const money = fetch.mock.calls.filter(([path]) => String(path).endsWith('/money'));
    expect(money).toHaveLength(2);
    const keys = money.map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'));
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });
  it('does no work until a catering consumer connects explicitly', () => {
    const fetch = transport();
    vi.stubGlobal('fetch', fetch);
    renderHook(() => useTerminalSession({ autoEstablish: false }));
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['offline', 'locked', 'missing operator'] as const)(
    'rejects a stale callback when %s',
    async (state) => {
      const fetch = transport();
      vi.stubGlobal('fetch', fetch);
      const { result } = await ready();
      const staleRequest = result.current.checkoutRequest;
      if (state === 'offline') {
        vi.stubGlobal('navigator', { onLine: false });
        act(() => fireEvent(window, new Event('offline')));
      } else if (state === 'locked') await act(() => result.current.lock());
      else act(() => result.current.setRuntime({ ...result.current.runtime!, operator: null }));
      await expect(
        staleRequest('/api/restaurant/catering/money', { method: 'POST' })
      ).rejects.toThrow('unlocked terminal');
      expect(fetch.mock.calls.some(([path]) => String(path).endsWith('/money'))).toBe(false);
    }
  );
  it.each([
    [401, 'Terminal session expired.'],
    [403, 'Device was revoked.'],
  ] as const)('clears denied context (%s)', async (status, message) => {
    const fetch = transport((path) =>
      path.endsWith('/money') ? response({ error: message }, status) : undefined
    );
    vi.stubGlobal('fetch', fetch);
    const { result } = await ready();
    await act(async () => {
      await expect(
        result.current.checkoutRequest('/api/restaurant/catering/money', { method: 'POST' })
      ).rejects.toThrow(message);
    });
    expect(result.current.runtime).toBeNull();
    expect(result.current.operators).toEqual([]);
  });
  it('retains the explicit key through an unreadable success and re-establishment', async () => {
    let attempts = 0;
    const fetch = transport((path) =>
      path.endsWith('/money') && ++attempts === 1
        ? new Response('broken', { status: 200 })
        : undefined
    );
    vi.stubGlobal('fetch', fetch);
    const { result } = await ready();
    const options = { method: 'POST' as const, body: { amount: '10' }, idempotencyKey: 'intent-1' };
    await expect(
      result.current.checkoutRequest('/api/restaurant/catering/money', options)
    ).rejects.toThrow('unreadable');
    await act(() => result.current.lock());
    act(() => result.current.setOperatorPin('1234'));
    await act(() => result.current.unlock({ preventDefault() {} } as FormEvent<HTMLFormElement>));
    await result.current.checkoutRequest('/api/restaurant/catering/money', options);
    const money = fetch.mock.calls.filter(([path]) => String(path).endsWith('/money'));
    expect(money).toHaveLength(2);
    expect(money.map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'))).toEqual([
      'intent-1',
      'intent-1',
    ]);
    expect(money[0][1]?.body).toBe(money[1][1]?.body);
  });
});
