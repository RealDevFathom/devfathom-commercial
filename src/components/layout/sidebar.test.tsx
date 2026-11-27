import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntitlementsProvider } from '@/components/entitlements-provider';
import type { EntitlementView } from '@/lib/module-catalog';
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { Sidebar, TopNavigation } from './sidebar';

const useSessionMock = vi.hoisted(() =>
  vi.fn(() => ({ data: { user: { role: 'ADMIN', name: 'Test operator' } } }))
);
const usePathnameMock = vi.hoisted(() => vi.fn(() => '/dashboard'));
// The pharmacy rail's capability read (#979); unanswered unless a pharmacy case sets it.
const pharmacyRailQuery = vi.hoisted(() => ({
  isError: false,
  // The Pharmacy Safety and procedure reads, denied unless a case grants them.
  safety: false,
  sop: false,
  input: vi.fn(),
  data: undefined as
    undefined | { userId: string; organizationId: string | null; capabilities: string[] },
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
      access: { useQuery: () => ({ data: { allowed: pharmacyRailQuery.safety } }) },
    },
    pharmacyAccess: {
      navigation: {
        useQuery: (input: unknown) => {
          pharmacyRailQuery.input(input);
          return pharmacyRailQuery;
        },
      },
    },
    pharmacySop: {
      access: {
        useQuery: () => ({
          data: { canComplete: pharmacyRailQuery.sop, canVerify: false, canManage: false },
        }),
      },
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

it('identifies the university workspace in the mobile drawer', () => {
  render(
    <EntitlementsProvider
      value={{
        organizationId: 'uni',
        vertical: 'UNIVERSITY',
        seatLimit: 10,
        activeSeats: 1,
        enabledModules: ['university-core'],
        modules: [],
        limits: {},
      }}
    >
      <Sidebar collapsible={false} />
    </EntitlementsProvider>
  );
  expect(screen.getByText('University workspace')).toBeInTheDocument();
  expect(screen.queryByText('Company workspace')).not.toBeInTheDocument();
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
    capabilities = ['pharmacy:inventory', 'pharmacy:procurement', 'reports:operational'],
    railUserId = 'pharmacy-user-1',
    railOrganizationId = 'pharmacy-1',
    sessionOrganizationId = 'pharmacy-1',
    isError = false,
    onboarding = false,
  }: {
    role?: string;
    vertical?: EntitlementView['vertical'];
    granted?: string[];
    pathname?: string;
    capabilities?: string[];
    railUserId?: string;
    railOrganizationId?: string;
    sessionOrganizationId?: string;
    isError?: boolean;
    onboarding?: boolean;
  } = {}) {
    useSessionMock.mockReturnValue({
      data: {
        user: {
          id: 'pharmacy-user-1',
          role,
          name: 'Test operator',
          organizationId: sessionOrganizationId,
          status: 'ACTIVE',
        },
      },
    } as unknown as ReturnType<typeof useSessionMock>);
    pharmacyRailQuery.data = {
      userId: railUserId,
      organizationId: railOrganizationId,
      capabilities,
    };
    pharmacyRailQuery.isError = isError;
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
          <Sidebar collapsible={false} onNavigate={onNavigate} pharmacyOnboarding={onboarding} />
        ) : (
          <TopNavigation pharmacyOnboarding={onboarding} />
        )}
      </EntitlementsProvider>
    );
    return onNavigate;
  }

  it('renders named, focusable destinations with Chat disabled', () => {
    const onNavigate = renderNavigation();
    for (const [label, href] of destinations) {
      const link = screen.getByRole('link', { name: (name) => name.endsWith(label) });
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
      expect(
        screen.queryByRole('link', { name: (name) => name.endsWith(label) })
      ).not.toBeInTheDocument();
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
      expect(
        screen.getByRole('link', { name: (name) => name.endsWith(label) })
      ).toBeInTheDocument();
    }
    for (const label of [
      'Finance',
      'Onboarding',
      'Medicine catalog',
      'Regulatory profile',
      'Branch assignments',
    ]) {
      expect(
        screen.queryByRole('link', { name: (name) => name.endsWith(label) })
      ).not.toBeInTheDocument();
    }
  });

  it('DEV-930 offers an onboarding owner Onboarding in one click, never inside a closed menu', () => {
    renderNavigation({ onboarding: true });
    const onboarding = screen.getByRole('link', { name: /Onboarding$/ });
    expect(onboarding).toHaveAttribute('href', '/pharmacy');
    // Not in a menu panel, which stays hidden until its button is pressed.
    expect(onboarding.closest('ul.hidden, [hidden]')).toBeNull();
  });

  it('offers an inventory member without procurement or reports neither destination (#979)', () => {
    renderNavigation({ role: 'MEMBER', capabilities: ['pharmacy:inventory'] });
    expect(screen.getByRole('link', { name: /Inventory$/ })).toBeInTheDocument();
    for (const label of ['Purchasing', 'Reports & Insights', 'Day close', 'Team']) {
      expect(
        screen.queryByRole('link', { name: (name) => name.endsWith(label) })
      ).not.toBeInTheDocument();
    }
  });

  // DEV-505: the Manager template's rail is derived from the server's answer for
  // it — purchasing, inventory, day close and reports — and nothing admin-only.
  it('offers a Manager day close, purchasing, inventory and reports only', () => {
    renderNavigation({
      role: 'EMPLOYEE',
      // What the rail read answers for the Manager template (DEV-240 adds inventory/manage).
      capabilities: [
        'pharmacy:procurement',
        'reports:operational',
        'pharmacy:close',
        'pharmacy:inventory',
        'pharmacy:manage',
      ],
    });
    for (const [label, href] of [
      ['Day close', '/pharmacy/counter/close'],
      ['Purchasing', '/pharmacy/purchasing'],
      ['Inventory', '/pharmacy/inventory'],
      ['Reports & Insights', '/pharmacy/reports'],
    ]) {
      expect(screen.getByRole('link', { name: (name) => name.endsWith(label) })).toHaveAttribute(
        'href',
        href
      );
    }
    for (const label of [
      'Counter',
      'Finance',
      'Onboarding',
      'Medicine catalog',
      'Prescriptions',
      'Pharmacist queue',
      'Regulatory profile',
      'Branch assignments',
    ]) {
      expect(
        screen.queryByRole('link', { name: (name) => name.endsWith(label) })
      ).not.toBeInTheDocument();
    }
  });

  it('offers a Pharmacist granted pharmacy:close the Day close destination (DEV-127)', () => {
    renderNavigation({
      role: 'MEMBER',
      capabilities: ['pharmacy:dispense', 'pharmacy:catalogue-review', 'pharmacy:close'],
    });
    expect(screen.getByRole('link', { name: /Day close$/ })).toHaveAttribute(
      'href',
      '/pharmacy/counter/close'
    );
  });

  it('offers a catalogue reviewer the Medicine catalog destination, and a cashier not (DEV-19)', () => {
    renderNavigation({
      role: 'MEMBER',
      capabilities: ['pharmacy:dispense', 'pharmacy:catalogue-review', 'pharmacy:close'],
    });
    expect(screen.getByRole('link', { name: /Medicine catalog$/ })).toHaveAttribute(
      'href',
      '/pharmacy/medicines'
    );
    cleanup();
    renderNavigation({ role: 'MEMBER', capabilities: ['pharmacy:counter', 'pharmacy:orders'] });
    expect(screen.queryByRole('link', { name: /Medicine catalog$/ })).not.toBeInTheDocument();
  });

  // #979, PR J: the rail answer is the ABAC-resolved capability list. No role
  // that does no procurement work is offered the Purchasing destination.
  it.each([
    ['cashier', ['pharmacy:counter', 'pharmacy:orders']],
    ['pharmacist', ['pharmacy:dispense', 'pharmacy:catalogue-review', 'pharmacy:close']],
    ['default employee', []],
    ['inventory', ['pharmacy:inventory']],
    ['auditor', ['reports:operational']],
    ['finance', ['reports:financial']],
  ] as const)('offers the %s role no Purchasing destination (#979)', (_role, capabilities) => {
    renderNavigation({ role: 'MEMBER', capabilities: [...capabilities] });
    expect(screen.queryByRole('link', { name: /Purchasing$/ })).not.toBeInTheDocument();
    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href') ?? '');
    expect(hrefs.filter((href) => href.startsWith('/pharmacy/purchasing'))).toEqual([]);
  });

  // DEV-519: the Finance template's financial reports live behind the Reports
  // rail entry, so a Finance member is offered it (and still not Finance setup).
  it('offers the Finance role template the Reports destination it can open (DEV-519)', () => {
    const finance = PHARMACY_ROLE_TEMPLATES.find((role) => role.key === 'finance')!;
    renderNavigation({ role: 'MEMBER', capabilities: [...finance.capabilities] });
    expect(screen.getByRole('link', { name: /Reports & Insights$/ })).toHaveAttribute(
      'href',
      '/pharmacy/reports'
    );
    expect(screen.queryByRole('link', { name: /Purchasing$/ })).not.toBeInTheDocument();
  });

  it('ignores a cached capability answer for another signed-in identity (#979)', () => {
    renderNavigation({ role: 'MEMBER', railUserId: 'someone-else' });
    for (const label of ['Purchasing', 'Reports & Insights']) {
      expect(
        screen.queryByRole('link', { name: (name) => name.endsWith(label) })
      ).not.toBeInTheDocument();
    }
  });

  // DEV-240: a Cashier is offered cashier work, not stock, purchasing, reports,
  // the pharmacist's queues or day close.
  it('offers the Cashier role template the Counter and nothing operational beyond it', () => {
    const cashier = PHARMACY_ROLE_TEMPLATES.find((role) => role.key === 'cashier')!;
    renderNavigation({
      role: 'MEMBER',
      capabilities: [...cashier.capabilities, 'pharmacy:counter'],
    });
    expect(screen.getByRole('link', { name: /Counter$/ })).toHaveAttribute(
      'href',
      '/pharmacy/counter'
    );
    for (const label of [
      'Inventory',
      'Purchasing',
      'Reports & Insights',
      'Prescriptions',
      'Pharmacist queue',
      'Substitution',
      'Day close',
      'Finance',
    ]) {
      expect(
        screen.queryByRole('link', { name: (name) => name.endsWith(label) })
      ).not.toBeInTheDocument();
    }
  });

  it('offers a Manager the Inventory destination without an inventory grant (DEV-240)', () => {
    const manager = PHARMACY_ROLE_TEMPLATES.find((role) => role.key === 'manager')!;
    renderNavigation({ role: 'MEMBER', capabilities: [...manager.capabilities] });
    expect(screen.getByRole('link', { name: /Inventory$/ })).toHaveAttribute(
      'href',
      '/pharmacy/inventory'
    );
  });

  it.each([
    { railOrganizationId: 'previous-org' },
    { sessionOrganizationId: 'other-org' },
    { isError: true },
  ])('grants nothing from an answer that is not current for this member: %j', (state) => {
    renderNavigation({ role: 'MEMBER', ...state });
    for (const label of ['Inventory', 'Purchasing', 'Reports & Insights']) {
      expect(
        screen.queryByRole('link', { name: (name) => name.endsWith(label) })
      ).not.toBeInTheDocument();
    }
  });

  it('keys the capability read by the signed-in member and tenant (DEV-240)', () => {
    renderNavigation();
    expect(pharmacyRailQuery.input).toHaveBeenLastCalledWith({
      userId: 'pharmacy-user-1',
      organizationId: 'pharmacy-1',
    });
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
    expect(screen.getByRole('link', { name: (name) => name.endsWith(label) })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(
      screen.getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page')
    ).toHaveLength(1);
    expect(screen.getByRole('link', { name: /Onboarding$/ })).not.toHaveAttribute('aria-current');
  });

  // DEV-497: every page of the workspace, nested routes included, marks
  // exactly one destination current, and it is the one that page belongs to.
  const everyModule = [
    ...pharmacyModules,
    'pharmacy-dispensing',
    'pharmacy-safety',
    'pharmacy-crm',
  ];
  const everyCapability = [
    'pharmacy:procurement',
    'pharmacy:prescriptions',
    'pharmacy:dispense',
    'reports:operational',
    'pharmacy:counter',
    'pharmacy:close',
    'pharmacy:inventory',
    'pharmacy:manage',
  ];
  const currentLinks = () => screen.queryAllByRole('link', { current: 'page' });

  it.each([
    ['/pharmacy', 'Onboarding'],
    ['/pharmacy/settings/data-export', 'Onboarding'],
    ['/pharmacy/settings/one-pharmacist-per-shift', 'Onboarding'],
    ['/pharmacy/accounts/balance-sheet', 'Finance'],
    ['/pharmacy/orders', 'Counter'],
    ['/pharmacy/counter/close', 'Day close'],
    ['/pharmacy/settings/cameras/privacy', 'Cameras'],
    ['/pharmacy/inventory/expiry', 'Inventory'],
    ['/pharmacy/medicines/prices', 'Medicine catalog'],
    ['/pharmacy/regulatory/fbr-tier-1', 'Regulatory profile'],
  ])('marks exactly the right destination current at %s (DEV-497)', (pathname, label) => {
    renderNavigation({ pathname, granted: everyModule, capabilities: everyCapability });
    expect(currentLinks()).toHaveLength(1);
    expect(currentLinks()[0]).toHaveAccessibleName(expect.stringMatching(new RegExp(`${label}$`)));
  });

  // One test per route keeps each render well inside the default timeout when
  // the full suite runs on a busy machine; every route is still checked.
  const pharmacyPageRoutes = readdirSync(join(process.cwd(), 'src/app/(app)/pharmacy'), {
    recursive: true,
    encoding: 'utf8',
  })
    .filter((file) => file.endsWith('page.tsx'))
    .map((file) => `/pharmacy/${dirname(file)}`.replace(/\/\.$/, '').replaceAll('\\', '/'));

  it('finds every pharmacy page route (DEV-497)', () => {
    expect(pharmacyPageRoutes).toContain('/pharmacy');
    expect(pharmacyPageRoutes).toContain('/pharmacy/accounts/profit-loss');
  });

  describe.each(pharmacyPageRoutes)('pharmacy page %s', (route) => {
    beforeEach(() => {
      pharmacyRailQuery.safety = true;
      pharmacyRailQuery.sop = true;
    });
    afterEach(() => {
      pharmacyRailQuery.safety = false;
      pharmacyRailQuery.sop = false;
    });

    it('marks exactly one destination current (DEV-497)', () => {
      // DEV-502: the not-found catch-all is not a destination. Render it at a
      // real unknown address; it must mark no entry current.
      const notFound = route === '/pharmacy/[...missing]';
      const pathname = notFound ? '/pharmacy/does-not-exist' : route;
      renderNavigation({ pathname, granted: everyModule, capabilities: everyCapability });
      expect({ pathname, current: currentLinks().length }).toEqual({
        pathname,
        current: notFound ? 0 : 1,
      });
    });
  });

  it('marks the statements current under Reports for a reports reader without Finance', () => {
    renderNavigation({
      role: 'MEMBER',
      pathname: '/pharmacy/accounts/balance-sheet',
      capabilities: ['reports:operational'],
    });
    expect(currentLinks()).toHaveLength(1);
    expect(currentLinks()[0]).toHaveAttribute('href', '/pharmacy/reports');
  });

  it('labels destinations with icons and names, never numeric prefixes (DEV-497)', () => {
    renderNavigation({ granted: everyModule, capabilities: everyCapability });
    const nav = screen.getByRole('navigation', {
      name: surface === 'mobile' ? 'Main navigation' : 'Primary navigation',
    });
    expect(nav.textContent).not.toMatch(/\d/);
    for (const link of within(nav).getAllByRole('link'))
      expect(link.querySelector('svg')).not.toBeNull();
  });
});

describe('Pharmacy grouped top navigation (DEV-497)', () => {
  const everyModule = [
    'pharmacy-core',
    'pharmacy-counter',
    'pharmacy-inventory',
    'pharmacy-procurement',
    'pharmacy-finance',
    'pharmacy-reports',
    'pharmacy-dispensing',
    'pharmacy-safety',
    'pharmacy-crm',
    'hr',
    'chat',
    'notes',
    'meetings',
  ];
  const everyCapability = [
    'pharmacy:procurement',
    'pharmacy:prescriptions',
    'pharmacy:dispense',
    'reports:operational',
    'pharmacy:counter',
    'pharmacy:close',
    'pharmacy:inventory',
    'pharmacy:manage',
  ];

  function renderBar({
    role = 'ADMIN',
    pathname = '/dashboard',
    capabilities = everyCapability,
    granted = everyModule,
    onboarding = false,
  }: {
    role?: string;
    pathname?: string;
    capabilities?: string[];
    granted?: string[];
    onboarding?: boolean;
  } = {}) {
    useSessionMock.mockReturnValue({
      data: {
        user: {
          id: 'pharmacy-user-1',
          role,
          name: 'Test operator',
          organizationId: 'pharmacy-1',
          status: 'ACTIVE',
        },
      },
    } as unknown as ReturnType<typeof useSessionMock>);
    pharmacyRailQuery.data = {
      userId: 'pharmacy-user-1',
      organizationId: 'pharmacy-1',
      capabilities,
    };
    pharmacyRailQuery.isError = false;
    usePathnameMock.mockReturnValue(pathname);
    render(
      <EntitlementsProvider
        value={{
          organizationId: 'pharmacy-1',
          vertical: 'PHARMACY',
          seatLimit: 10,
          activeSeats: 1,
          enabledModules: granted,
          modules: [],
          limits: {},
        }}
      >
        <TopNavigation pharmacyOnboarding={onboarding} />
        <button type="button">Outside</button>
      </EntitlementsProvider>
    );
    return screen.getByRole('navigation', { name: 'Primary navigation' });
  }

  const menu = (label: string) => screen.getByRole('button', { name: label });
  const panel = (label: string) =>
    document.getElementById(menu(label).getAttribute('aria-controls')!)!;

  it('groups an owner’s destinations into a handful of task menus that wrap, not scroll', () => {
    const nav = renderBar();
    expect(
      within(nav)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Sell', 'Dispense', 'Stock', 'Reports', 'Settings', 'More']);
    // A menu with one destination is that destination.
    expect(
      Array.from(nav.children)
        .filter((child) => child.tagName === 'A')
        .map((link) => link.getAttribute('href'))
    ).toEqual(['/dashboard', '/pharmacy/purchasing', '/audit-logs', '/pharmacy/finance']);
    // DEV-913: the audit log is the owner's own entry, whatever the plan.
    expect(within(nav).getByRole('link', { name: 'Audit log: who did what' })).toHaveAttribute(
      'href',
      '/audit-logs'
    );
    expect(nav.children).toHaveLength(10);
    expect(nav).toHaveClass('flex-wrap');
    expect(nav).not.toHaveClass('overflow-x-auto');
    expect(
      within(panel('Sell'))
        .getAllByRole('link')
        .map((link) => link.textContent)
    ).toEqual(['Counter', 'Day close', 'Khata', 'Loyalty points', 'Marketing & growth']);
    // DEV-930: an active pharmacy keeps Onboarding in Settings, so its bar does not grow.
    expect(within(panel('Settings')).getByRole('link', { name: 'Onboarding' })).toHaveAttribute(
      'href',
      '/pharmacy'
    );
  });

  it('DEV-930 gives an onboarding owner Onboarding in the bar itself, first after Dashboard', () => {
    const nav = renderBar({ onboarding: true });
    expect(
      Array.from(nav.children)
        .filter((child) => child.tagName === 'A')
        .map((link) => link.getAttribute('href'))
    ).toEqual([
      '/dashboard',
      '/pharmacy',
      '/pharmacy/purchasing',
      '/audit-logs',
      '/pharmacy/finance',
    ]);
    expect(nav.children[1]).toHaveAccessibleName('Onboarding');
    expect(within(panel('Settings')).queryByRole('link', { name: /Onboarding$/ })).toBeNull();
    expect(nav).toHaveClass('flex-wrap');
  });

  it('offers a cashier only pages a cashier can open, with Your PIN beside Settings', () => {
    const nav = renderBar({
      role: 'MEMBER',
      capabilities: ['pharmacy:counter', 'pharmacy:orders'],
      granted: ['pharmacy-core', 'pharmacy-counter', 'pharmacy-procurement', 'pharmacy-finance'],
    });
    // DEV-931: a cashier confirms vouchers with their own PIN, so "Your PIN" is theirs too;
    // it joins Settings in the one menu a cashier has.
    expect(
      within(nav)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Settings']);
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href'))
    ).toEqual(['/dashboard', '/pharmacy/counter', '/pharmacy/settings/pin', '/settings']);
    expect(within(panel('Settings')).getByRole('link', { name: 'Your PIN' })).toHaveAttribute(
      'href',
      '/pharmacy/settings/pin'
    );
  });

  it('opens one menu at a time and closes it on Escape, outside press and navigation', () => {
    renderBar();
    for (const label of ['Sell', 'Stock']) {
      expect(menu(label)).toHaveAttribute('aria-expanded', 'false');
      expect(panel(label)).toHaveClass('hidden');
    }
    fireEvent.click(menu('Sell'));
    expect(menu('Sell')).toHaveAttribute('aria-expanded', 'true');
    expect(panel('Sell')).not.toHaveClass('hidden');

    fireEvent.click(menu('Stock'));
    expect(menu('Sell')).toHaveAttribute('aria-expanded', 'false');
    expect(panel('Stock')).not.toHaveClass('hidden');

    within(panel('Stock')).getByRole('link', { name: 'Inventory' }).focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(menu('Stock')).toHaveAttribute('aria-expanded', 'false');
    expect(menu('Stock')).toHaveFocus();

    fireEvent.click(menu('Reports'));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
    expect(menu('Reports')).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(menu('Reports'));
    fireEvent.click(within(panel('Reports')).getByRole('link', { name: 'Reports & Insights' }));
    expect(menu('Reports')).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens trailing menus toward the shell so the clipped shell never cuts them off', () => {
    renderBar();
    for (const label of ['Sell', 'Dispense', 'Stock']) {
      expect(panel(label)).toHaveClass('start-0');
      expect(panel(label)).not.toHaveClass('end-0');
    }
    for (const label of ['Reports', 'Settings', 'More']) {
      expect(panel(label)).toHaveClass('end-0');
      expect(panel(label)).not.toHaveClass('start-0');
    }
  });

  it('wears the active pill on the menu holding the current page', () => {
    renderBar({ pathname: '/pharmacy/inventory/expiry' });
    expect(menu('Stock')).toHaveAttribute('data-active', 'true');
    for (const label of ['Sell', 'Dispense', 'Reports', 'Settings', 'More'])
      expect(menu(label)).not.toHaveAttribute('data-active');
    expect(within(panel('Stock')).getByRole('link', { name: 'Inventory' })).toHaveAttribute(
      'aria-current',
      'page'
    );
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
      const link = screen.getByRole('link', { name: (name) => name.endsWith(label) });
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

// DEV-957 phase 2 (shared till): the stored offline counter page opens this drawer from its
// own bar, with the last session still in the page.
describe('menu drawer user chip with the browser offline', () => {
  const entitlements = {
    organizationId: 'org-1',
    vertical: 'PHARMACY' as const,
    seatLimit: 10,
    activeSeats: 1,
    enabledModules: ['pharmacy-core'],
    modules: [],
    limits: {},
  };
  function renderDrawer(collapsed = false) {
    useSessionMock.mockReturnValue({
      data: {
        user: {
          role: 'ADMIN',
          name: 'Ayesha Khan',
          title: 'Branch manager',
          image: 'https://example.test/avatar.png',
        },
      },
    } as never);
    return render(
      <EntitlementsProvider value={entitlements}>
        <Sidebar collapsible={false} collapsed={collapsed} />
      </EntitlementsProvider>
    );
  }
  afterEach(() => vi.restoreAllMocks());

  it.each([false, true])('names nobody offline (collapsed: %s)', (collapsed) => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const { container } = renderDrawer(collapsed);
    const chip = container.querySelector('[data-sidebar-identity="offline"]');
    expect(chip).not.toBeNull();
    expect(chip).toHaveTextContent(
      collapsed ? 'Offline. Sign-in not checked.' : 'OfflineSign-in not checked'
    );
    expect(container).not.toHaveTextContent('Ayesha Khan');
    expect(container).not.toHaveTextContent('Branch manager');
    expect(container).not.toHaveTextContent(/\bAK\b/);
    expect(container.querySelector('img[src*="avatar"]')).toBeNull();
    expect(container.querySelector('[alt="Ayesha Khan"]')).toBeNull();
  });

  it('shows the signed-in person online, as before', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const { container } = renderDrawer();
    expect(container).toHaveTextContent('Ayesha Khan');
    expect(container).toHaveTextContent('Branch manager');
    expect(container.querySelector('[data-sidebar-identity="offline"]')).toBeNull();
  });
});
