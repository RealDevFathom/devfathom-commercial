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
    let finishCleanup!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise((resolve) => {
        finishCleanup = resolve;
      })
    );

    const signOutPromise = signOutEverything('/signed-out');

    expect(fetch).toHaveBeenCalledWith('/api/login', {
      method: 'DELETE',
      credentials: 'include',
    });
    expect(mocks.signOut).not.toHaveBeenCalled();

    finishCleanup(new Response(null, { status: 200 }));
    await signOutPromise;

    expect(mocks.signOut).toHaveBeenCalledWith({ callbackUrl: '/signed-out' });
  });

  it('removes every day-close draft from the tab, and nothing else (DEV-739)', async () => {
    window.sessionStorage.setItem('devfathom.pharmacy.day-close.draft:org:owner:b:2026-11-06', '{}');
    window.sessionStorage.setItem('devfathom.pharmacy.day-close.draft:org:manager:a:2026-11-05', '{}');
    window.sessionStorage.setItem('unrelated', 'kept');
    await signOutEverything();
    expect(window.sessionStorage.getItem('unrelated')).toBe('kept');
    expect(
      Object.keys(window.sessionStorage).filter((key) =>
        key.startsWith('devfathom.pharmacy.day-close.draft:')
      )
    ).toEqual([]);
    window.sessionStorage.clear();
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
