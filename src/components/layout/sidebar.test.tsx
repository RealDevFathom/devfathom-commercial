import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntitlementsProvider } from '@/components/entitlements-provider';
import type { EntitlementView } from '@/lib/module-catalog';
import { Sidebar, TopNavigation } from './sidebar';

const useSessionMock = vi.hoisted(() =>
  vi.fn(() => ({ data: { user: { role: 'ADMIN', name: 'Test operator' } } }))
);
const usePathnameMock = vi.hoisted(() => vi.fn(() => '/dashboard'));
// The pharmacy rail's capability read (#979); unanswered unless a pharmacy case sets it.
const pharmacyRailQuery = vi.hoisted(() => ({
  data: undefined as
    | undefined
    | { userId: string; organizationId: string | null; capabilities: string[] },
}));
// The hospitality rail's one read; unanswered unless a hospitality case sets it.
const railQuery = vi.hoisted(() => ({
  data: undefined as
    | undefined
    | {
        userId: string;
        organizationId: string;
        properties: { branchId: string; name: string; capabilities: string[] }[];
      },
}));

vi.mock('next/link', () => ({
  default: ({ href, children, onClick, ...props }: React.ComponentProps<'a'>) => (
    <a
      href={String(href)}
      {...props}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({ usePathname: usePathnameMock }));
vi.mock('next-auth/react', () => ({
  useSession: useSessionMock,
}));
vi.mock('motion/react', () => ({
  m: {
    span: ({ children, className, style }: React.ComponentProps<'span'>) => (
      <span className={className} style={style}>
        {children}
      </span>
    ),
    div: ({ children, className }: React.ComponentProps<'div'>) => (
      <div className={className}>{children}</div>
    ),
  },
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    hotelProperty: {
      access: {
        propertiesByCapability: {
          useQuery: () => ({
            data: railQuery.data,
            isError: false,
            isFetching: false,
            refetch: vi.fn(),
          }),
        },
      },
    },
    pharmacySafety: {
      access: { useQuery: () => ({ data: { allowed: false } }) },
    },
    pharmacyAccess: {
      navigation: { useQuery: () => ({ data: pharmacyRailQuery.data }) },
    },
  },
}));
vi.mock('@/components/preferences-provider', () => ({
  usePreferences: () => ({ icons: 'numbered' }),
}));

const enabledModules = [
  'dashboard',
  'projects',
  'clients',
  'notes',
  'meetings',
  'chat',
  'finance',
  'hr',
  'reviews',
  'audit',
];

function restaurantLinks(role = 'ADMIN') {
  vi.mocked(useSessionMock).mockReturnValue({ data: { user: { role, name: 'Test operator' } } });
  render(
    <EntitlementsProvider
      value={{
        organizationId: 'org-1',
        vertical: 'RESTAURANT',
        seatLimit: 10,
        activeSeats: 1,
        enabledModules: ['restaurant-core'],
        modules: [],
        limits: {},
      }}
    >
      <TopNavigation />
    </EntitlementsProvider>
  );
  return screen.getAllByRole('link').map((link) => link.getAttribute('href'));
}

function links(vertical?: EntitlementView['vertical'], granted: string[] = enabledModules) {
  render(
    <EntitlementsProvider
      value={{
        organizationId: 'org-1',
        vertical,
        seatLimit: 10,
        activeSeats: 1,
        enabledModules: granted,
        modules: [],
        limits: {},
      }}
    >
      <TopNavigation />
    </EntitlementsProvider>
  );
  return screen.getAllByRole('link').map((link) => link.getAttribute('href'));
}

describe('TopNavigation vertical visibility', () => {
  beforeEach(() => {
    useSessionMock.mockReturnValue({ data: { user: { role: 'ADMIN', name: 'Test operator' } } });
    usePathnameMock.mockReturnValue('/dashboard');
  });

  it('shows Delivery only to Restaurant administrators', () => {
    expect(restaurantLinks()).toContain('/restaurant/delivery');
    cleanup();
    expect(restaurantLinks('MEMBER')).not.toContain('/restaurant/delivery');
  });

  it('uses accessible body text for inactive navigation numbers', () => {
    links('AGENCY');
    expect(screen.getByText('02')).toHaveClass('text-text-body');
    expect(screen.getByText('02')).not.toHaveClass('text-text-faint');
  });

  it('keeps agency and legacy navigation identical', () => {
    const agency = links('AGENCY');
    cleanup();
    expect(links()).toEqual(agency);
    expect(agency).toContain('/projects');
  });

  // module-catalog architecture decision: a vertical never sees another
  // vertical's VERTICAL_* modules, but BASELINE is always on and PLATFORM
  // modules are sellable into any vertical's package.
  it('hides agency VERTICAL_* module navigation for restaurant organizations', () => {
    const restaurant = links('RESTAURANT');
    expect(restaurant).not.toContain('/projects');
    expect(restaurant).not.toContain('/clients');
    expect(restaurant).not.toContain('/finance');
  });

  it('keeps BASELINE navigation visible for restaurant organizations (decision: BASELINE always on)', () => {
    // `dashboard` is deliberately absent from the granted list: BASELINE is on
    // for every organization without any package, contract or override.
    expect(links('RESTAURANT', [])).toContain('/dashboard');
  });

  it('shows a PLATFORM module to a restaurant organization only when it is granted', () => {
    expect(links('RESTAURANT', ['notes'])).toContain('/notes');
    cleanup();
    expect(links('RESTAURANT', [])).not.toContain('/notes');
  });
});

describe.each(['ltr', 'rtl'])('%s mobile drawer placement', (dir) => {
  it('anchors the visible sidebar and its inner border to the workspace direction', () => {
    render(
      <div dir={dir}>
        <EntitlementsProvider
          value={{
            organizationId: 'org-1',
            vertical: 'PHARMACY',
            seatLimit: 10,
            activeSeats: 1,
            enabledModules: ['pharmacy-core'],
            modules: [],
            limits: {},
          }}
        >
          <Sidebar collapsible={false} />
        </EntitlementsProvider>
      </div>
    );

    const sidebar = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(sidebar).toHaveClass('fixed', 'start-0', 'border-e');
    expect(sidebar).not.toHaveClass('left-0', 'right-0', 'border-l', 'border-r');
  });
});

describe.each(['mobile', 'desktop'] as const)('%s Pharmacy navigation', (surface) => {
  const pharmacyModules = [
    'pharmacy-core',
    'pharmacy-counter',
    'pharmacy-inventory',
    'pharmacy-procurement',
    'pharmacy-finance',
    'pharmacy-reports',
  ];
  const destinations = [
    ['Inventory', '/pharmacy/inventory', 'pharmacy-inventory'],
    ['Purchasing', '/pharmacy/purchasing', 'pharmacy-procurement'],
    ['Finance', '/pharmacy/finance', 'pharmacy-finance'],
    ['Reports & Insights', '/pharmacy/reports', 'pharmacy-reports'],
  ] as const;

  function renderNavigation({
    role = 'ADMIN',
    vertical = 'PHARMACY',
    granted = pharmacyModules,
    pathname = '/dashboard',
    capabilities = ['pharmacy:procurement', 'reports:operational'],
    railUserId = 'pharmacy-user-1',
  }: {
    role?: string;
    vertical?: EntitlementView['vertical'];
    granted?: string[];
    pathname?: string;
    capabilities?: string[];
    railUserId?: string;
  } = {}) {
    useSessionMock.mockReturnValue({
      data: { user: { id: 'pharmacy-user-1', role, name: 'Test operator' } },
    } as unknown as ReturnType<typeof useSessionMock>);
    pharmacyRailQuery.data = { userId: railUserId, organizationId: 'pharmacy-1', capabilities };
    usePathnameMock.mockReturnValue(pathname);
    const onNavigate = vi.fn();
    render(
      <EntitlementsProvider
        value={{
          organizationId: 'pharmacy-1',
          vertical,
          seatLimit: 10,
          activeSeats: 1,
          enabledModules: granted,
          modules: [],
          limits: {},
        }}
      >
        {surface === 'mobile' ? (
          <Sidebar collapsible={false} onNavigate={onNavigate} />
        ) : (
          <TopNavigation />
        )}
      </EntitlementsProvider>
    );
    return onNavigate;
  }

  it('renders named, focusable destinations with Chat disabled', () => {
    const onNavigate = renderNavigation();
    for (const [label, href] of destinations) {
      const link = screen.getByRole('link', { name: new RegExp(`${label}$`) });
      expect(link).toHaveAttribute('href', href);
      expect(link.tabIndex).toBe(0);
      link.focus();
      expect(link).toHaveFocus();
      fireEvent.click(link);
    }
    if (surface === 'mobile') expect(onNavigate).toHaveBeenCalledTimes(destinations.length);
    expect(screen.queryByRole('link', { name: /Chat$/ })).not.toBeInTheDocument();
  });

  it.each(destinations)(
    'hides disabled %s without hiding other licensed destinations',
    (label, href, module) => {
      renderNavigation({ granted: [...pharmacyModules.filter((key) => key !== module), 'chat'] });
      expect(screen.queryByRole('link', { name: new RegExp(`${label}$`) })).not.toBeInTheDocument();
      const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
      expect(hrefs).not.toContain(href);
      for (const [, otherHref] of destinations) {
        if (otherHref !== href) expect(hrefs).toContain(otherHref);
      }
      expect(hrefs).toContain('/chat');
    }
  );

  it('keeps operational links for non-admins while finance and setup stay admin-only', () => {
    renderNavigation({ role: 'MEMBER' });
    for (const label of ['Inventory', 'Purchasing', 'Reports & Insights']) {
      expect(screen.getByRole('link', { name: new RegExp(`${label}$`) })).toBeInTheDocument();
    }
    for (const label of [
      'Finance',
      'Onboarding',
      'Medicine catalog',
      'Regulatory profile',
      'Branch assignments',
    ]) {
      expect(screen.queryByRole('link', { name: new RegExp(`${label}$`) })).not.toBeInTheDocument();
    }
  });

  it('offers a cashier without procurement or reports neither destination (#979)', () => {
    renderNavigation({ role: 'MEMBER', capabilities: [] });
    expect(screen.getByRole('link', { name: /Inventory$/ })).toBeInTheDocument();
    for (const label of ['Purchasing', 'Reports & Insights', 'Day close', 'Team']) {
      expect(screen.queryByRole('link', { name: new RegExp(`${label}$`) })).not.toBeInTheDocument();
    }
  });

  it('ignores a cached capability answer for another signed-in identity (#979)', () => {
    renderNavigation({ role: 'MEMBER', railUserId: 'someone-else' });
    for (const label of ['Purchasing', 'Reports & Insights']) {
      expect(screen.queryByRole('link', { name: new RegExp(`${label}$`) })).not.toBeInTheDocument();
    }
  });

  it('denies unlicensed Pharmacy navigation without removing baseline access', () => {
    renderNavigation({ granted: [] });
    expect(screen.getByRole('link', { name: /Dashboard$/ })).toBeInTheDocument();
    expect(
      screen.getAllByRole('link').some((link) => link.getAttribute('href')?.startsWith('/pharmacy'))
    ).toBe(false);
  });

  it.each(['RESTAURANT', 'AGENCY'] as const)(
    'isolates %s from mis-provisioned Pharmacy licenses',
    (vertical) => {
      renderNavigation({ vertical });
      expect(
        screen
          .getAllByRole('link')
          .some((link) => link.getAttribute('href')?.startsWith('/pharmacy'))
      ).toBe(false);
    }
  );

  it('isolates Pharmacy from mis-provisioned Restaurant and Agency licenses', () => {
    renderNavigation({
      granted: [
        ...pharmacyModules,
        'restaurant-core',
        'restaurant-pos',
        'restaurant-inventory',
        'projects',
        'finance',
      ],
    });
    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'));
    expect(hrefs.some((href) => href?.startsWith('/restaurant'))).toBe(false);
    for (const href of ['/pos', '/projects', '/finance']) expect(hrefs).not.toContain(href);
    expect(hrefs).toContain('/pharmacy/finance');
  });

  it.each([
    ['/pharmacy/reports/repeat-purchasing', 'Reports & Insights'],
    ['/pharmacy/purchasing/returns', 'Purchasing'],
    ['/pharmacy/finance', 'Finance'],
    ['/pharmacy/inventory', 'Inventory'],
  ])('marks only the longest matching destination current at %s', (pathname, label) => {
    renderNavigation({ pathname });
    expect(screen.getByRole('link', { name: new RegExp(`${label}$`) })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(
      screen.getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page')
    ).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Onboarding$/ })).not.toHaveAttribute('aria-current');
  });
});

describe.each(['mobile', 'desktop'] as const)('%s Hospitality navigation', (surface) => {
  const hotelModules = ['hotel-core', 'hotel-banquets', 'hotel-upsell'];
  const everyRailCapability = ['hotel:property-admin', 'hotel:rates', 'hotel:marketing'];
  const entries = [
    ['Property', '/hotel/settings/property'],
    ['Rooms', '/hotel/settings/rooms'],
    ['Meal plans', '/hotel/settings/meal-plans'],
    ['Function spaces', '/hotel/settings/spaces'],
    ['Extras', '/hotel/settings/extras'],
    ['Guest messages', '/hotel/settings/journey'],
  ] as const;

  /** Renders the rail for a member holding `capabilities` at one property; returns its hotel links. */
  function renderRail({
    capabilities,
    vertical = 'HOSPITALITY',
    granted = hotelModules,
    pathname = '/dashboard',
  }: {
    capabilities: string[];
    vertical?: EntitlementView['vertical'];
    granted?: string[];
    pathname?: string;
  }) {
    const user = {
      id: 'member-1',
      organizationId: 'hotel-1',
      role: 'MEMBER',
      status: 'ACTIVE',
      name: 'Test operator',
    };
    useSessionMock.mockReturnValue({ data: { user } } as unknown as ReturnType<
      typeof useSessionMock
    >);
    usePathnameMock.mockReturnValue(pathname);
    railQuery.data = {
      userId: user.id,
      organizationId: user.organizationId,
      properties: [{ branchId: 'property-1', name: 'Fathom Grand', capabilities }],
    };
    render(
      <EntitlementsProvider
        value={{
          organizationId: 'hotel-1',
          vertical,
          seatLimit: 10,
          activeSeats: 1,
          enabledModules: granted,
          modules: [],
          limits: {},
        }}
      >
        {surface === 'mobile' ? <Sidebar collapsible={false} /> : <TopNavigation />}
      </EntitlementsProvider>
    );
    return screen
      .getAllByRole('link')
      .map((link) => link.getAttribute('href'))
      .filter((href) => href?.startsWith('/hotel/'));
  }

  afterEach(() => {
    railQuery.data = undefined;
  });

  it('renders every entry, named and focusable, to a member holding every rail capability', () => {
    expect(renderRail({ capabilities: everyRailCapability })).toEqual(
      entries.map(([, href]) => href)
    );
    for (const [label, href] of entries) {
      const link = screen.getByRole('link', { name: new RegExp(`${label}$`) });
      expect(link).toHaveAttribute('href', href);
      expect(link.tabIndex).toBe(0);
    }
  });

  it.each([
    [['hotel:rates'], ['/hotel/settings/meal-plans']],
    [['hotel:marketing'], ['/hotel/settings/journey']],
    [
      ['hotel:property-admin'],
      [
        '/hotel/settings/property',
        '/hotel/settings/rooms',
        '/hotel/settings/spaces',
        '/hotel/settings/extras',
        '/hotel/settings/journey',
      ],
    ],
  ])('shows a member holding %j only the pages it opens', (capabilities, expected) => {
    expect(renderRail({ capabilities })).toEqual(expected);
  });

  it('licenses Function spaces on Banquets and Guest messages on Guest Journey and Upsell', () => {
    expect(renderRail({ capabilities: everyRailCapability, granted: ['hotel-core'] })).toEqual([
      '/hotel/settings/property',
      '/hotel/settings/rooms',
      '/hotel/settings/meal-plans',
      '/hotel/settings/extras',
    ]);
  });

  it('marks only Guest messages current on its page', () => {
    renderRail({ capabilities: ['hotel:marketing'], pathname: '/hotel/settings/journey' });
    expect(screen.getByRole('link', { name: /Guest messages$/ })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(
      screen.getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page')
    ).toHaveLength(1);
  });

  it.each(['RESTAURANT', 'PHARMACY', 'AGENCY'] as const)(
    'shows %s no hospitality entry even with every hotel module and capability',
    (vertical) => {
      expect(renderRail({ capabilities: everyRailCapability, vertical })).toEqual([]);
    }
  );
});
