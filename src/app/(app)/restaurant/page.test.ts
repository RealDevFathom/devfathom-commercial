import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  resolveOrganizationEntitlements: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT;${path}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  }),
}));

vi.mock('next/navigation', () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: (_organizationId: string, run: (db: unknown) => Promise<unknown>) =>
    run({ marker: 'tenant-db' }),
  withPlatformDb: vi.fn(),
}));
// The real `hasModule` and the real route→module catalog stay in play: the
// point of this suite is that the landing order agrees with them.
vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  resolveOrganizationEntitlements: mocks.resolveOrganizationEntitlements,
}));

import RestaurantIndexPage from './page';

/**
 * Entitlements are described by enabled modules alone — the landing choice is
 * made from module ownership, never from the organization's vertical.
 */
function entitlements(enabledModules: string[]): EntitlementView {
  return {
    organizationId: 'org_1',
    seatLimit: 10,
    activeSeats: 1,
    enabledModules,
    modules: [],
    limits: {},
  };
}

describe('RestaurantIndexPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTenantActor.mockResolvedValue({
      session: { user: { id: 'user_1', organizationId: 'org_1' } },
      organization: { id: 'org_1' },
      support: null,
    });
  });

  // The fixture holds every other landing module too, so this pins the ORDER —
  // orders wins over the rest rather than merely being the only candidate left.
  it('redirects the bare segment to the orders board when POS is entitled', async () => {
    mocks.resolveOrganizationEntitlements.mockResolvedValue(
      entitlements([
        'restaurant-core',
        'restaurant-pos',
        'restaurant-inventory',
        'restaurant-purchasing',
        'restaurant-sop',
        'restaurant-menu',
        'restaurant-loyalty',
        'restaurant-insights',
      ])
    );

    await expect(RestaurantIndexPage()).rejects.toThrow('NEXT_REDIRECT;/restaurant/orders');
    expect(mocks.redirect).toHaveBeenCalledWith('/restaurant/orders');
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it('falls back to the first entitled restaurant route when orders is not entitled', async () => {
    mocks.resolveOrganizationEntitlements.mockResolvedValue(
      entitlements(['restaurant-core', 'restaurant-menu'])
    );

    await expect(RestaurantIndexPage()).rejects.toThrow('NEXT_REDIRECT;/restaurant/menus');
    expect(mocks.redirect).toHaveBeenCalledWith('/restaurant/menus');
  });

  it('keeps the 404 for an organization that holds no restaurant module', async () => {
    mocks.resolveOrganizationEntitlements.mockResolvedValue(
      entitlements(['dashboard', 'projects', 'clients', 'finance'])
    );

    await expect(RestaurantIndexPage()).rejects.toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(mocks.notFound).toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
