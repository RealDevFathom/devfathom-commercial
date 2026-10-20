import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar, navigation, visibleNavigation } from './sidebar';
import { moduleForPath } from '@/lib/module-catalog';
const h = vi.hoisted(() => ({
  session: {
    user: { id: 'user', organizationId: 'org', role: 'EMPLOYEE', status: 'ACTIVE', name: 'User' },
  },
  entitlements: { organizationId: 'org', vertical: 'HOSPITALITY', enabledModules: ['hotel-core'] },
  query: {
    data: { userId: 'user', organizationId: 'org', properties: [{ branchId: 'branch' }] },
    isError: false,
    isFetching: false,
  },
  refetch: vi.fn(),
  queryOptions: vi.fn(),
}));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: h.session }) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/hotel/settings/property' }));
vi.mock('@/components/preferences-provider', () => ({
  usePreferences: () => ({ icons: 'numeric' }),
}));
vi.mock('@/components/entitlements-provider', () => ({ useEntitlements: () => h.entitlements }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    hotelProperty: {
      extras: {
        properties: {
          useQuery: (_input: unknown, options: unknown) => {
            h.queryOptions(options);
            return { ...h.query, refetch: h.refetch };
          },
        },
      },
    },
  },
}));
vi.mock('motion/react', () => ({
  m: {
    div: ({ children, className }: { children: React.ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
    span: ({ className }: { className?: string }) => <span className={className} />,
  },
}));
const priorHrefs = [
  '/dashboard',
  '/projects',
  '/clients',
  '/notes',
  '/meetings',
  '/chat',
  '/finance',
  '/team',
  '/pos',
  '/kds',
  '/restaurant/floor',
  '/restaurant/orders',
  '/restaurant/catering',
  '/restaurant/money',
  '/restaurant/inventory',
  '/restaurant/purchasing',
  '/restaurant/sop',
  '/restaurant/sop/reports',
  '/restaurant/sop/admin',
  '/restaurant/sop/oversight',
  '/restaurant/staff',
  '/restaurant/staff/roster',
  '/restaurant/tax',
  '/restaurant/settings/branches',
  '/restaurant/delivery',
  '/restaurant/devices',
  '/restaurant/integrations/cameras',
  '/restaurant/catalog',
  '/restaurant/menus',
  '/restaurant/promotions',
  '/restaurant/notifications',
  '/restaurant/loyalty',
  '/restaurant/reports',
  '/restaurant/insights',
  '/pharmacy',
  '/pharmacy/medicines',
  '/pharmacy/counter',
  '/pharmacy/counter/close',
  '/pharmacy/inventory',
  '/pharmacy/purchasing',
  '/pharmacy/finance',
  '/pharmacy/reports',
  '/pharmacy/cameras',
  '/pharmacy/loyalty',
  '/pharmacy/marketing',
  '/pharmacy/prescriptions',
  '/pharmacy/pharmacist-queue',
  '/pharmacy/substitution',
  '/pharmacy/controlled-register',
  '/pharmacy/regulatory',
  '/reviews',
  '/team/stats',
  '/hr',
  '/audit-logs',
  '/organization',
  '/settings',
];
beforeEach(() => {
  vi.clearAllMocks();
  h.session = {
    user: { id: 'user', organizationId: 'org', role: 'EMPLOYEE', status: 'ACTIVE', name: 'User' },
  };
  h.entitlements = {
    organizationId: 'org',
    vertical: 'HOSPITALITY',
    enabledModules: ['hotel-core'],
  };
  h.query = {
    data: { userId: 'user', organizationId: 'org', properties: [{ branchId: 'branch' }] },
    isError: false,
    isFetching: false,
  };
});
afterEach(cleanup);
describe('Hotel navigation composition', () => {
  it('retains every accepted link and adds exactly two selection routes', () => {
    expect(priorHrefs).toHaveLength(56);
    expect(navigation).toHaveLength(58);
    const hrefs = navigation.map((n) => n.href);
    expect(hrefs).toEqual(expect.arrayContaining(priorHrefs));
    expect(navigation.filter((n) => n.group === 'Hospitality').map((n) => n.href)).toEqual([
      '/hotel/settings/property',
      '/hotel/settings/extras',
    ]);
    expect(moduleForPath('/hotel/settings/property')).toBe('hotel-core');
    expect(moduleForPath('/hotel/settings/extras')).toBe('hotel-core');
    expect(moduleForPath('/hotel/future')).toBeNull();
  });
  it('admits an assigned capable non-admin and rejects an unassigned admin', () => {
    const e = { vertical: 'HOSPITALITY' as const, enabledModules: ['hotel-core'] };
    expect(
      visibleNavigation(e, 'EMPLOYEE', true).filter((n) => n.group === 'Hospitality')
    ).toHaveLength(2);
    expect(
      visibleNavigation(e, 'ADMIN', false).filter((n) => n.group === 'Hospitality')
    ).toHaveLength(0);
    expect(
      visibleNavigation(
        { vertical: 'RESTAURANT', enabledModules: ['hotel-core'] },
        'ADMIN',
        true
      ).filter((n) => n.group === 'Hospitality')
    ).toHaveLength(0);
  });
  it('renders both entries for current access and refetches when user identity changes', () => {
    const r = render(<Sidebar collapsible={false} />);
    expect(screen.getByRole('link', { name: /Extras/ })).toHaveAttribute(
      'href',
      '/hotel/settings/extras'
    );
    expect(document.querySelector('a[href="/hotel/settings/property"]')).toBeInTheDocument();
    expect(h.refetch).toHaveBeenCalledTimes(1);
    h.session.user.id = 'other';
    r.rerender(<Sidebar collapsible={false} />);
    expect(h.refetch).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('link', { name: /Extras/ })).not.toBeInTheDocument();
  });
  it.each(['organization', 'empty', 'fetching', 'error', 'revoked'])(
    'hides both entries for %s state',
    (kind) => {
      if (kind === 'organization') h.query.data.organizationId = 'different';
      if (kind === 'empty') h.query.data.properties = [];
      if (kind === 'fetching') h.query.isFetching = true;
      if (kind === 'error') h.query.isError = true;
      if (kind === 'revoked') h.session.user.status = 'REVOKED';
      render(<Sidebar collapsible={false} />);
      expect(document.querySelector('a[href="/hotel/settings/property"]')).not.toBeInTheDocument();
      expect(document.querySelector('a[href="/hotel/settings/extras"]')).not.toBeInTheDocument();
    }
  );
});
