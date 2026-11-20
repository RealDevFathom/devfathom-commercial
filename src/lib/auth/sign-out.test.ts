import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ signOut: vi.fn() }));

vi.mock('next-auth/react', () => ({ signOut: mocks.signOut }));

import {
  counterReadinessOkayKey,
  readCounterReadinessOkay,
  writeCounterReadinessOkay,
} from '@/lib/pharmacy/counter-readiness-okay';
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

  // DEV-970: the next sign-in sees the counter's ready-to-sell panel in full again.
  it('forgets every Okay given to the counter sale checks', async () => {
    const key = counterReadinessOkayKey({
      organizationId: 'org-a',
      accountId: 'account-a',
      branchId: 'branch-a',
      deviceId: 'counter-1',
    });
    writeCounterReadinessOkay(key, ['PROFILE_MISSING']);
    window.sessionStorage.setItem('unrelated', 'kept');

    await signOutEverything();

    expect(readCounterReadinessOkay(key)).toBeNull();
    expect(window.sessionStorage.getItem('unrelated')).toBe('kept');
  });
});
