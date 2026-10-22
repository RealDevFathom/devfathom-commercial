import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ signOut: vi.fn() }));

vi.mock('@/lib/auth', () => ({ signOut: mocks.signOut }));

import { tenantSignOut } from './tenant-sign-out';

describe('tenantSignOut', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the Auth.js sign-out action and redirects to the tenant login path', async () => {
    await tenantSignOut();

    expect(mocks.signOut).toHaveBeenCalledOnce();
    expect(mocks.signOut).toHaveBeenCalledWith({ redirectTo: '/login' });
  });
});
