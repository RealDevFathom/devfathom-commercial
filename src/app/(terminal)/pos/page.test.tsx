import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  actor: vi.fn(),
  host: vi.fn(),
  entitlements: vi.fn(),
  scoped: vi.fn(),
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'restaurant.localhost' }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: state.actor }));
vi.mock('@/lib/tenancy/host', () => ({
  resolveOrganizationByHost: state.host,
  isTenantLifecycleAccessible: (status: string) => status === 'ACTIVE',
  TENANT_HOST_HEADER: 'x-devfathom-host',
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: state.scoped }));
vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: state.entitlements,
  hasModule: (view: { enabledModules: string[] }, key: string) => view.enabledModules.includes(key),
}));
vi.mock('@/components/restaurant/pos/order-pad', () => ({ OrderPad: () => null }));
vi.mock('@/lib/demo/toolbar', () => ({ DemoToolbar: () => null }));
import PosPage from './page';
beforeEach(() => {
  vi.clearAllMocks();
  state.actor.mockResolvedValue(null);
  state.host.mockResolvedValue({ id: 'org_restaurant', status: 'ACTIVE' });
  state.scoped.mockImplementation(async (_id, run) => run({}));
  state.entitlements.mockResolvedValue({ enabledModules: ['restaurant-pos'] });
});
it('denies the workspace before rendering when POS is disabled', async () => {
  state.entitlements.mockResolvedValue({ enabledModules: ['restaurant-core'] });
  await expect(PosPage()).rejects.toThrow('NOT_FOUND');
});
it('allows an enabled device-only terminal without a user session', async () => {
  await expect(PosPage()).resolves.toBeTruthy();
  expect(state.host).toHaveBeenCalledWith('restaurant.localhost');
  expect(state.scoped).toHaveBeenCalledWith('org_restaurant', expect.any(Function));
});
it('uses the authenticated actor organization when a user is present', async () => {
  state.actor.mockResolvedValue({ organization: { id: 'org_session', status: 'ACTIVE' } });
  await PosPage();
  expect(state.host).not.toHaveBeenCalled();
  expect(state.scoped).toHaveBeenCalledWith('org_session', expect.any(Function));
});
it.each([null, { id: 'org_restaurant', status: 'SUSPENDED' }])(
  'denies unknown or suspended hosts',
  async (organization) => {
    state.host.mockResolvedValue(organization);
    await expect(PosPage()).rejects.toThrow('NOT_FOUND');
    expect(state.entitlements).not.toHaveBeenCalled();
  }
);
