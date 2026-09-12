import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EntitlementsProvider } from '@/components/entitlements-provider';
import type { EntitlementView } from '@/lib/module-catalog';
import { Sidebar, TopNavigation } from './sidebar';

const useSessionMock = vi.hoisted(() =>
  vi.fn(() => ({ data: { user: { role: 'ADMIN', name: 'Test operator' } } }))
);
const usePathnameMock = vi.hoisted(() => vi.fn(() => '/dashboard'));

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
  }: {
    role?: string;
    vertical?: EntitlementView['vertical'];
    granted?: string[];
    pathname?: string;
  } = {}) {
    useSessionMock.mockReturnValue({ data: { user: { role, name: 'Test operator' } } });
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
    for (const label of ['Finance', 'Onboarding', 'Medicine catalog', 'Regulatory profile']) {
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
