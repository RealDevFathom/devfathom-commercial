import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ signOut: vi.fn() }));

vi.mock('next-auth/react', () => ({ signOut: mocks.signOut }));

import { signOutEverything } from './sign-out';

describe('signOutEverything', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('clears the login intent before ending the session', async () => {
    await signOutEverything('/signed-out');

    expect(fetch).toHaveBeenCalledWith('/api/login', {
      method: 'DELETE',
      credentials: 'include',
    });
    expect(mocks.signOut).toHaveBeenCalledWith({ callbackUrl: '/signed-out' });
    expect(vi.mocked(fetch).mock.invocationCallOrder[0]).toBeLessThan(
      mocks.signOut.mock.invocationCallOrder[0]
    );
  });

  it('still ends the session when login-intent cleanup fails', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network unavailable'));

    await expect(signOutEverything()).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledWith('/api/login', {
      method: 'DELETE',
      credentials: 'include',
    });
    expect(mocks.signOut).toHaveBeenCalledWith({ callbackUrl: '/login' });
  });

  it('still ends the session when login-intent cleanup returns an error response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 500 }));

    await expect(signOutEverything()).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledWith('/api/login', {
      method: 'DELETE',
      credentials: 'include',
    });
    expect(mocks.signOut).toHaveBeenCalledWith({ callbackUrl: '/login' });
  });
});
