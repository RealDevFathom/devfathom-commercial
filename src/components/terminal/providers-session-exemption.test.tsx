import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ pathname: '/terminal', push: vi.fn() }));
const actor = vi.hoisted(() => ({ resolve: vi.fn() }));

vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'test.localhost' }) }));
vi.mock('@/lib/tenancy/host', () => ({
  TENANT_HOST_HEADER: 'x-tenant-host',
  resolveOrganizationByHost: async () => ({ id: 'org_terminal', status: 'ACTIVE' }),
  isTenantLifecycleAccessible: (status: string) => status === 'ACTIVE',
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: async (_org: string, fn: (db: unknown) => unknown) => fn({}),
}));
vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: async () => ({ enabledModules: ['restaurant-pos'] }),
  hasModule: (view: { enabledModules: string[] }, key: string) => view.enabledModules.includes(key),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: navigation.push }),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: actor.resolve }));
vi.mock('@/components/restaurant/pos/order-pad', () => ({
  OrderPad: () => <h1>Order pad</h1>,
}));
vi.mock('@/components/restaurant/kds/kds-board', () => ({
  KdsBoard: () => <h1>Kitchen display</h1>,
}));
vi.mock('@/components/app-providers', () => ({
  AppProviders: ({ children }: { children: ReactNode }) => (
    <div data-testid="app-providers">{children}</div>
  ),
}));

import { Providers } from '@/components/providers';
import PosPage from '@/app/(terminal)/pos/page';
import KdsPage from '@/app/(terminal)/kds/page';

afterEach(() => vi.unstubAllGlobals());

describe('terminal root providers', () => {
  it('keeps only the exact terminal route outside SessionProvider-backed app providers', () => {
    const { rerender } = render(
      <Providers>
        <span>terminal</span>
      </Providers>
    );
    expect(screen.queryByTestId('app-providers')).not.toBeInTheDocument();

    navigation.pathname = '/terminal/settings';
    rerender(
      <Providers>
        <span>terminal settings</span>
      </Providers>
    );
    expect(screen.getByTestId('app-providers')).toBeInTheDocument();
  });

  it('keeps only the exact POS route outside SessionProvider-backed app providers', () => {
    navigation.pathname = '/pos';
    const { rerender } = render(
      <Providers>
        <span>POS</span>
      </Providers>
    );
    expect(screen.queryByTestId('app-providers')).not.toBeInTheDocument();

    navigation.pathname = '/pos/settings';
    rerender(
      <Providers>
        <span>POS settings</span>
      </Providers>
    );
    expect(screen.getByTestId('app-providers')).toBeInTheDocument();
  });

  it.each([
    ['/pos', PosPage, 'cashier', 'Cashier', 'Order pad'],
    ['/kds', KdsPage, 'kitchen', 'Kitchen', 'Kitchen display'],
  ] as const)(
    'supplies the server-resolved demo session to the real toolbar on %s',
    async (pathname, Page, persona, label, heading) => {
      navigation.pathname = pathname;
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      actor.resolve.mockResolvedValue({
        organization: {
          id: 'org_demo_restaurant_seat_1',
          status: 'ACTIVE',
          isDemo: true,
          displayName: 'Sales seat one',
        },
        session: {
          expires: '2099-01-01T00:00:00Z',
          user: {
            id: `user_demo_restaurant_seat_1_${persona}`,
            email: `${persona}.seat1@demo.devfathom.invalid`,
            organizationId: 'org_demo_restaurant_seat_1',
            status: 'ACTIVE',
            role: 'EMPLOYEE',
          },
        },
      });

      render(<Providers>{await Page()}</Providers>);

      expect(screen.getByRole('heading', { name: heading })).toBeVisible();
      expect(screen.getByText(`Sales seat one · ${label}`)).toBeVisible();
      expect(screen.queryByTestId('app-providers')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reset my seat' })).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['/pos', PosPage, 'Order pad'],
    ['/kds', KdsPage, 'Kitchen display'],
  ] as const)(
    'keeps device-only %s independent of a user session',
    async (pathname, Page, heading) => {
      navigation.pathname = pathname;
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      actor.resolve.mockResolvedValue(null);

      render(<Providers>{await Page()}</Providers>);

      expect(screen.getByRole('heading', { name: heading })).toBeVisible();
      expect(
        screen.queryByRole('complementary', { name: 'Restaurant demo controls' })
      ).not.toBeInTheDocument();
      expect(screen.queryByTestId('app-providers')).not.toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});
