import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar, navigation, visibleNavigation, type HotelCapability } from './sidebar';
import { moduleForPath } from '@/lib/module-catalog';
type RailProperty = { branchId: string; name: string; capabilities: HotelCapability[] };
const h = vi.hoisted(() => ({
  session: {
    user: { id: 'user', organizationId: 'org', role: 'EMPLOYEE', status: 'ACTIVE', name: 'User' },
  },
  entitlements: { organizationId: 'org', vertical: 'HOSPITALITY', enabledModules: ['hotel-core'] },
  query: {
    data: {
      userId: 'user',
      organizationId: 'org',
      properties: [
        { branchId: 'branch', name: 'Branch', capabilities: ['hotel:property-admin'] },
      ] as RailProperty[],
    },
    isError: false,
    isFetching: false,
  },
  refetch: vi.fn(),
  queryOptions: vi.fn(),
  queryInput: vi.fn(),
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
      access: {
        propertiesByCapability: {
          useQuery: (input: unknown, options: unknown) => {
            h.queryInput(input);
            h.queryOptions(options);
            return { ...h.query, refetch: h.refetch };
          },
        },
      },
    },
    pharmacySafety: {
      access: { useQuery: () => ({ data: { allowed: false } }) },
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
  '/restaurant/menu-import',
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
  '/pharmacy/settings/branches',
  '/reviews',
  '/team/stats',
  '/hr',
  '/audit-logs',
  '/organization',
  '/settings',
];
const PROPERTY = '/hotel/settings/property';
const ROOMS = '/hotel/settings/rooms';
const MEAL_PLANS = '/hotel/settings/meal-plans';
const SPACES = '/hotel/settings/spaces';
const EXTRAS = '/hotel/settings/extras';
const GUEST_MESSAGES = '/hotel/settings/journey';
const hospitalityHrefs = [PROPERTY, ROOMS, MEAL_PLANS, SPACES, EXTRAS, GUEST_MESSAGES];
/** What the old boolean rail meant: property administration at some property. */
const PROPERTY_ADMIN: HotelCapability[] = ['hotel:property-admin'];
const EVERY_RAIL_CAPABILITY: HotelCapability[] = [
  'hotel:property-admin',
  'hotel:rates',
  'hotel:marketing',
];
/** Hotel Pro plus Banquets: every module a hospitality entry is licensed by. */
const everyHotelModule = {
  vertical: 'HOSPITALITY' as const,
  enabledModules: ['hotel-core', 'hotel-banquets', 'hotel-upsell'],
};
const hospitality = (visible: ReturnType<typeof visibleNavigation>) =>
  visible.filter((n) => n.group === 'Hospitality').map((n) => n.href);
const renderedHospitality = () =>
  hospitalityHrefs.filter((href) => document.querySelector(`a[href="${href}"]`));
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
    data: {
      userId: 'user',
      organizationId: 'org',
      properties: [{ branchId: 'branch', name: 'Branch', capabilities: ['hotel:property-admin'] }],
    },
    isError: false,
    isFetching: false,
  };
});
afterEach(cleanup);
describe('Hotel navigation composition', () => {
  it('retains every accepted link and adds exactly the six hospitality routes', () => {
    expect(priorHrefs).toHaveLength(58);
    expect(navigation).toHaveLength(64);
    const hrefs = navigation.map((n) => n.href);
    expect(new Set(hrefs).size).toBe(64);
    expect(hrefs).toEqual([...priorHrefs, ...hospitalityHrefs]);
    expect(navigation.filter((n) => n.group === 'Hospitality').map((n) => n.href)).toEqual(
      hospitalityHrefs
    );
    expect(moduleForPath('/hotel/settings/property')).toBe('hotel-core');
    expect(moduleForPath('/hotel/settings/extras')).toBe('hotel-core');
    for (const href of [ROOMS, MEAL_PLANS, SPACES, GUEST_MESSAGES])
      expect(moduleForPath(href)).toBe('hotel-core');
    expect(moduleForPath('/hotel/future')).toBeNull();
  });
  it('licenses each entry on its module and opens it on the capability its page checks', () => {
    const entry = (href: string) => navigation.find((n) => n.href === href)!;
    expect(
      hospitalityHrefs.map((href) => [
        entry(href).label,
        entry(href).module,
        entry(href).hotelCapabilities,
      ])
    ).toEqual([
      ['Property', 'hotel-core', ['hotel:property-admin']],
      ['Rooms', 'hotel-core', ['hotel:property-admin']],
      ['Meal plans', 'hotel-core', ['hotel:rates']],
      ['Function spaces', 'hotel-banquets', ['hotel:property-admin']],
      ['Extras', 'hotel-core', ['hotel:property-admin']],
      ['Guest messages', 'hotel-upsell', ['hotel:property-admin', 'hotel:marketing']],
    ]);
    // Every hospitality entry names a capability; one that named none could never show.
    for (const n of navigation.filter((item) => item.group === 'Hospitality'))
      expect(n.hotelCapabilities?.length).toBeGreaterThan(0);
    expect(navigation.filter((n) => n.group !== 'Hospitality' && n.hotelCapabilities)).toEqual([]);
    // No two hospitality entries share an icon, so the collapsed rail tells them apart.
    const icons = navigation.filter((n) => n.group === 'Hospitality').map((n) => n.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
  it('labels the property entry by what it configures, so no two entries read "Settings"', () => {
    const visible = visibleNavigation(
      { vertical: 'HOSPITALITY', enabledModules: ['hotel-core'] },
      'ADMIN',
      PROPERTY_ADMIN
    );
    const labels = visible.map((n) => n.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.filter((label) => label === 'Settings')).toEqual(['Settings']);
    expect(visible.find((n) => n.href === '/hotel/settings/property')?.label).toBe('Property');
    expect(visible.find((n) => n.href === '/settings')?.label).toBe('Settings');
  });
  it('keeps every visible label unique with every hospitality entry showing', () => {
    const visible = visibleNavigation(everyHotelModule, 'ADMIN', EVERY_RAIL_CAPABILITY);
    expect(hospitality(visible)).toEqual(hospitalityHrefs);
    const labels = visible.map((n) => n.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toEqual(
      expect.arrayContaining(['Rooms', 'Meal plans', 'Function spaces', 'Guest messages'])
    );
    expect(labels.filter((label) => label === 'Settings')).toEqual(['Settings']);
  });
  it('admits an assigned capable non-admin and rejects an unassigned admin', () => {
    const e = { vertical: 'HOSPITALITY' as const, enabledModules: ['hotel-core'] };
    expect(
      visibleNavigation(e, 'EMPLOYEE', PROPERTY_ADMIN).filter((n) => n.group === 'Hospitality')
    ).toHaveLength(3);
    expect(hospitality(visibleNavigation(e, 'EMPLOYEE', PROPERTY_ADMIN))).toEqual([
      PROPERTY,
      ROOMS,
      EXTRAS,
    ]);
    expect(visibleNavigation(e, 'ADMIN', []).filter((n) => n.group === 'Hospitality')).toHaveLength(
      0
    );
    expect(visibleNavigation(everyHotelModule, 'ADMIN')).toEqual(
      visibleNavigation(everyHotelModule, 'ADMIN', [])
    );
    expect(hospitality(visibleNavigation(everyHotelModule, 'ADMIN', []))).toEqual([]);
    expect(
      visibleNavigation(
        { vertical: 'RESTAURANT', enabledModules: ['hotel-core'] },
        'ADMIN',
        PROPERTY_ADMIN
      ).filter((n) => n.group === 'Hospitality')
    ).toHaveLength(0);
    expect(
      hospitality(
        visibleNavigation(
          { vertical: 'RESTAURANT', enabledModules: everyHotelModule.enabledModules },
          'ADMIN',
          EVERY_RAIL_CAPABILITY
        )
      )
    ).toEqual([]);
  });
  it.each([
    [
      'property administration',
      ['hotel:property-admin'],
      [PROPERTY, ROOMS, SPACES, EXTRAS, GUEST_MESSAGES],
    ],
    ['rates alone', ['hotel:rates'], [MEAL_PLANS]],
    ['marketing alone', ['hotel:marketing'], [GUEST_MESSAGES]],
    ['rates and marketing', ['hotel:rates', 'hotel:marketing'], [MEAL_PLANS, GUEST_MESSAGES]],
    ['every rail capability', EVERY_RAIL_CAPABILITY, hospitalityHrefs],
    ['a capability no entry opens', ['hotel:housekeeping'], []],
  ] as [string, HotelCapability[], string[]][])(
    'shows each entry to whoever holds its page’s capability: %s',
    (_label, held, expected) => {
      for (const role of ['ADMIN', 'EMPLOYEE'])
        expect(hospitality(visibleNavigation(everyHotelModule, role, held))).toEqual(expected);
    }
  );
  it('shows Function spaces only with Banquets and Guest messages only with Guest Journey and Upsell', () => {
    const without = (module: string) => ({
      vertical: 'HOSPITALITY' as const,
      enabledModules: everyHotelModule.enabledModules.filter((key) => key !== module),
    });
    expect(
      hospitality(visibleNavigation(without('hotel-banquets'), 'ADMIN', EVERY_RAIL_CAPABILITY))
    ).toEqual([PROPERTY, ROOMS, MEAL_PLANS, EXTRAS, GUEST_MESSAGES]);
    expect(
      hospitality(visibleNavigation(without('hotel-upsell'), 'ADMIN', EVERY_RAIL_CAPABILITY))
    ).toEqual([PROPERTY, ROOMS, MEAL_PLANS, SPACES, EXTRAS]);
    // The Venue package: Banquets but no Guest Journey and Upsell.
    expect(
      hospitality(
        visibleNavigation(
          { vertical: 'HOSPITALITY', enabledModules: ['hotel-core', 'hotel-banquets'] },
          'EMPLOYEE',
          ['hotel:marketing']
        )
      )
    ).toEqual([]);
  });
  it('renders both entries for current access and refetches when user identity changes', () => {
    const r = render(<Sidebar collapsible={false} />);
    expect(screen.getByRole('link', { name: /Extras/ })).toHaveAttribute(
      'href',
      '/hotel/settings/extras'
    );
    expect(document.querySelector('a[href="/hotel/settings/property"]')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Rooms/ })).toHaveAttribute('href', ROOMS);
    expect(renderedHospitality()).toEqual([PROPERTY, ROOMS, EXTRAS]);
    expect(h.refetch).toHaveBeenCalledTimes(1);
    h.session.user.id = 'other';
    r.rerender(<Sidebar collapsible={false} />);
    expect(h.refetch).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('link', { name: /Extras/ })).not.toBeInTheDocument();
    expect(renderedHospitality()).toEqual([]);
  });
  it('asks once, for every capability the rail names, only for a current hospitality member', () => {
    render(<Sidebar collapsible={false} />);
    expect(h.queryInput).toHaveBeenLastCalledWith({ capabilities: EVERY_RAIL_CAPABILITY });
    expect(h.queryOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true, retry: false, staleTime: 0 })
    );
    cleanup();
    h.entitlements = { ...h.entitlements, enabledModules: [] };
    render(<Sidebar collapsible={false} />);
    expect(h.queryOptions).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });
  it('renders a rates-only member the meal plans entry and nothing they cannot open', () => {
    h.query.data.properties = [
      { branchId: 'branch', name: 'Branch', capabilities: ['hotel:rates'] },
    ];
    render(<Sidebar collapsible={false} />);
    expect(screen.getByRole('link', { name: /Meal plans/ })).toHaveAttribute('href', MEAL_PLANS);
    expect(renderedHospitality()).toEqual([MEAL_PLANS]);
  });
  it('joins the capabilities held across the member’s properties', () => {
    h.entitlements = { ...h.entitlements, enabledModules: everyHotelModule.enabledModules };
    h.query.data.properties = [
      { branchId: 'branch_a', name: 'A', capabilities: ['hotel:rates'] },
      { branchId: 'branch_b', name: 'B', capabilities: ['hotel:marketing'] },
    ];
    render(<Sidebar collapsible={false} />);
    expect(screen.getByRole('link', { name: /Guest messages/ })).toHaveAttribute(
      'href',
      GUEST_MESSAGES
    );
    expect(renderedHospitality()).toEqual([MEAL_PLANS, GUEST_MESSAGES]);
  });
  it.each(['organization', 'empty', 'fetching', 'error', 'revoked'])(
    'hides both entries for %s state',
    (kind) => {
      h.entitlements = { ...h.entitlements, enabledModules: everyHotelModule.enabledModules };
      h.query.data.properties = [
        { branchId: 'branch', name: 'Branch', capabilities: [...EVERY_RAIL_CAPABILITY] },
      ];
      if (kind === 'organization') h.query.data.organizationId = 'different';
      if (kind === 'empty') h.query.data.properties = [];
      if (kind === 'fetching') h.query.isFetching = true;
      if (kind === 'error') h.query.isError = true;
      if (kind === 'revoked') h.session.user.status = 'REVOKED';
      render(<Sidebar collapsible={false} />);
      expect(document.querySelector('a[href="/hotel/settings/property"]')).not.toBeInTheDocument();
      expect(document.querySelector('a[href="/hotel/settings/extras"]')).not.toBeInTheDocument();
      expect(renderedHospitality()).toEqual([]);
    }
  );
});
