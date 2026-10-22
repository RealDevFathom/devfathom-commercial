import { beforeEach, describe, expect, it, vi } from 'vitest';

const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));

vi.mock('next-auth/react', () => ({ signOut }));

import { signOutEverything } from './sign-out';

describe('signOutEverything', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  });

  it('uses the Auth.js v5 sign-out action and redirects to the tenant login', async () => {
    await signOutEverything();

    expect(signOut).toHaveBeenCalledOnce();
    expect(signOut).toHaveBeenCalledWith({ redirectTo: '/login' });
  });

  it('preserves an explicit post-sign-out destination', async () => {
    await signOutEverything('/login?reason=password-changed');

    expect(signOut).toHaveBeenCalledWith({ redirectTo: '/login?reason=password-changed' });
  });
});
