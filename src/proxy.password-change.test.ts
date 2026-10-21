/**
 * Central PASSWORD_CHANGE_REQUIRED gate (follow-up to #164).
 *
 * `mustChangePassword` is enforced once, in the proxy, for every tenant `/api/`
 * route. A newly added handler that forgets to translate
 * `PasswordChangeRequiredError` into a response therefore still returns a clean
 * 403 with the machine-readable code instead of a 500 — the gate catches it
 * before the route runs. Unrelated errors are not swallowed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolveTenantActor: vi.fn() }));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));

import { PasswordChangeRequiredError } from '@/lib/auth/session-state';
import { proxy } from './proxy';

function tenantApiRequest(path: string) {
  return new Request(`http://acme.localhost:3000${path}`, {
    headers: { host: 'acme.localhost:3000', cookie: 'authjs.session-token=opaque' },
  });
}

beforeEach(() => {
  mocks.resolveTenantActor.mockReset();
});

describe('central password-change gate', () => {
  it('answers a flagged session with 403 PASSWORD_CHANGE_REQUIRED on any tenant /api route', async () => {
    mocks.resolveTenantActor.mockRejectedValueOnce(new PasswordChangeRequiredError());

    // A route that never learned about the error still gets the right response.
    const response = await proxy(tenantApiRequest('/api/some/brand-new/route'));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      code: 'PASSWORD_CHANGE_REQUIRED',
      error: 'PASSWORD_CHANGE_REQUIRED',
    });
  });

  it('lets a healthy session through to the route', async () => {
    mocks.resolveTenantActor.mockResolvedValueOnce({ session: {}, organization: {}, support: null });

    const response = await proxy(tenantApiRequest('/api/team/profile'));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('does not run the gate for platform APIs', async () => {
    const response = await proxy(tenantApiRequest('/api/platform/session'));

    expect(response.status).toBe(404);
    expect(mocks.resolveTenantActor).not.toHaveBeenCalled();
  });

  it('rethrows an unrelated resolver error instead of masking it as a password change', async () => {
    mocks.resolveTenantActor.mockRejectedValueOnce(new Error('database unreachable'));

    await expect(proxy(tenantApiRequest('/api/team/profile'))).rejects.toThrow(
      'database unreachable'
    );
  });
});
