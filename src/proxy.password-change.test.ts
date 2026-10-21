import { describe, expect, it, vi } from 'vitest';

const resolveTenantActor = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('Session DB unavailable');
  })
);
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor }));
import { proxy } from './proxy';

describe('API proxy transport', () => {
  it.each([
    '/api/webhooks/provider',
    '/api/cron/process',
    '/api/restaurant/orders/open',
    '/api/scim/v2/Users',
    '/api/trpc/team.changePassword',
    '/api/auth/signout',
  ])('passes %s through without resolving a tenant session', async (path) => {
    const response = await proxy(
      new Request(`http://acme.localhost${path}`, {
        headers: { host: 'acme.localhost' },
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(resolveTenantActor).not.toHaveBeenCalled();
  });
});
