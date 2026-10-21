import { beforeEach, expect, it, vi } from 'vitest';
import type { Session } from 'next-auth';
import { resolveTenantActor } from '@/lib/tenancy/tenant-actor';

const state = vi.hoisted(() => ({
  organization: {} as Record<string, unknown>,
  enabled: true,
  persona: 'manager' as string | null,
}));
vi.mock('@/lib/demo/config', () => ({
  getDemoSeatCount: () => 5,
  isDemoEnabled: () => state.enabled,
}));
vi.mock('@/lib/demo/personas', () => ({ demoPersonaForUser: () => state.persona }));
vi.mock('@/lib/tenancy/host', () => ({
  isSharedHost: () => true,
  requestHost: () => 'shared.example.test',
  requireOrganizationForRequest: async () => state.organization,
  resolveOrganizationById: async () => state.organization,
  isTenantLifecycleAccessible: () => true,
  TENANT_HOST_HEADER: 'x-tenant-host',
  TenantHostError: class extends Error {},
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: () => {
    throw new Error('unexpected database access');
  },
}));
vi.mock('@/lib/tenancy/support-session', () => ({
  getSupportSession: () => {
    throw new Error('unexpected support-cookie access');
  },
}));
vi.mock('next/headers', () => ({
  headers: () => {
    throw new Error('explicit request required');
  },
}));
function session(expiry: unknown = Date.now() + 60_000): Session {
  return {
    expires: '',
    user: {
      id: 'actor',
      organizationId: String(state.organization.id),
      status: 'ACTIVE',
      demoAccessExpiresAt: expiry,
    },
  } as Session;
}
const request = new Request('https://shared.example.test/');
beforeEach(() => {
  state.organization = {
    id: 'org_demo_restaurant_seat_1',
    slug: 'demo-restaurant-seat-1',
    isDemo: true,
    status: 'ACTIVE',
    vertical: 'RESTAURANT',
    deploymentMode: 'SHARED',
  };
  state.enabled = true;
  state.persona = 'manager';
});
it('retains a valid demo actor', async () => {
  expect(await resolveTenantActor({ request, session: session() })).toMatchObject({
    organization: state.organization,
    support: null,
  });
});
it.each([undefined, null, NaN, Infinity, 'future', 0])(
  'rejects invalid demo expiry %s',
  async (expiry) => {
    const supplied = session();
    supplied.user.demoAccessExpiresAt = expiry as number | undefined;
    expect(await resolveTenantActor({ request, session: supplied })).toBeNull();
  }
);
it('rejects a stale marker on an ordinary organization instead of falling back', async () => {
  state.organization.isDemo = false;
  expect(await resolveTenantActor({ request, session: session() })).toBeNull();
});
it.each(['disabled', 'persona', 'canonical', 'revoked'])(
  'rejects %s demo actor',
  async (reason) => {
    const supplied = session();
    if (reason === 'disabled') state.enabled = false;
    if (reason === 'persona') state.persona = null;
    if (reason === 'canonical') state.organization.slug = 'other';
    if (reason === 'revoked') supplied.user.sessionRevoked = true;
    expect(await resolveTenantActor({ request, session: supplied })).toBeNull();
  }
);
it('preserves ordinary active sessions without a demo marker', async () => {
  state.organization = { id: 'ordinary', isDemo: false };
  const supplied = session();
  delete supplied.user.demoAccessExpiresAt;
  expect(await resolveTenantActor({ request, session: supplied })).not.toBeNull();
});
