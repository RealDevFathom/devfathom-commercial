import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ALL_VERTICALS } from '@/lib/vertical-catalog';

const mocks = vi.hoisted(() => ({
  vertical: 'AGENCY' as string | undefined,
  enabledModules: [] as string[],
  searchQuery: vi.fn(),
  push: vi.fn(),
  session: {
    user: {
      id: 'user-1',
      organizationId: 'org-1',
      role: 'EMPLOYEE',
      status: 'ACTIVE',
      name: 'Test member',
      email: 'member@example.test',
    },
  },
  pharmacyCapabilities: [] as string[],
  pharmacyAccessUserId: 'user-1',
  safetyAllowed: false,
  sopAllowed: false,
}));

vi.mock('next/dynamic', () => ({
  default: (loader: { toString(): string }) => {
    const source = loader.toString();
    if (source.includes('CommandDialog'))
      return function CommandDialog({
        open,
        children,
      }: {
        open: boolean;
        children: React.ReactNode;
      }) {
        return open ? <div role="dialog">{children}</div> : null;
      };
    if (source.includes('CommandInput'))
      return function CommandInput({
        value,
        onValueChange,
      }: {
        value: string;
        onValueChange: (value: string) => void;
      }) {
        return (
          <input
            aria-label="Search records"
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
          />
        );
      };
    if (source.includes('CommandGroup'))
      return function CommandGroup({
        heading,
        children,
      }: {
        heading: string;
        children: React.ReactNode;
      }) {
        return (
          <div role="group" aria-label={heading}>
            {children}
          </div>
        );
      };
    if (source.includes('CommandItem'))
      return function CommandItem({
        children,
        onSelect,
      }: {
        children: React.ReactNode;
        onSelect: () => void;
      }) {
        return (
          <button type="button" onClick={onSelect}>
            {children}
          </button>
        );
      };
    return ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  },
}));
vi.mock('@/components/ui/command', () => ({}));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: mocks.session }) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => '/dashboard',
}));
vi.mock('@/components/theme-provider', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({
    organizationId: 'org-1',
    vertical: mocks.vertical,
    enabledModules: mocks.enabledModules,
  }),
}));
vi.mock('./topbar-breadcrumbs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./topbar-breadcrumbs')>()),
  TopbarBreadcrumbs: () => null,
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({}),
    search: { global: { useQuery: mocks.searchQuery } },
    hotelProperty: {
      access: {
        propertiesByCapability: {
          useQuery: () => ({ data: undefined, refetch: vi.fn() }),
        },
      },
    },
    pharmacyAccess: {
      navigation: {
        useQuery: () => ({
          data: {
            userId: mocks.pharmacyAccessUserId,
            organizationId: 'org-1',
            capabilities: mocks.pharmacyCapabilities,
          },
        }),
      },
    },
    pharmacySafety: {
      access: { useQuery: () => ({ data: { allowed: mocks.safetyAllowed } }) },
    },
    pharmacySop: {
      access: { useQuery: () => ({ data: { canComplete: mocks.sopAllowed } }) },
    },
    team: {
      getNotifications: { useQuery: () => ({ data: [] }) },
      markNotificationRead: { useMutation: () => ({ mutate: vi.fn() }) },
      markAllNotificationsRead: { useMutation: () => ({ mutate: vi.fn() }) },
    },
    restaurantNotifications: {
      list: { useQuery: () => ({ data: { items: [] } }) },
      markRead: { useMutation: () => ({ mutate: vi.fn() }) },
      markAllRead: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));

import { Topbar } from './topbar';

const SEARCH_MODULES = ['projects', 'clients', 'notes', 'hr'];
const GROUPS = ['Projects', 'Tasks', 'Clients', 'Notes', 'Team'];
const cachedResults = {
  projects: [{ id: 'p1', name: 'Matching project', type: 'INTERNAL', client: null }],
  tasks: [
    {
      id: 't1',
      title: 'Matching task',
      column: { board: { project: { id: 'p1', name: 'Matching project' } } },
    },
  ],
  clients: [{ id: 'c1', name: 'Matching client', industry: null }],
  notes: [{ id: 'n1', title: 'Matching note', visibility: 'TEAM' }],
  team: [{ id: 'u1', name: 'Matching colleague', title: null }],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.vertical = 'AGENCY';
  mocks.enabledModules = [...SEARCH_MODULES];
  mocks.session.user.role = 'EMPLOYEE';
  mocks.pharmacyCapabilities = [];
  mocks.pharmacyAccessUserId = 'user-1';
  mocks.safetyAllowed = false;
  mocks.sopAllowed = false;
  // Return cache data even for a disabled query, as React Query can do.
  mocks.searchQuery.mockReturnValue({ data: cachedResults, isLoading: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function search() {
  fireEvent.click(screen.getByRole('button', { name: 'Search company hub' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Search records' }), {
    target: { value: 'Matching' },
  });
  act(() => vi.advanceTimersByTime(100));
}

function expectSearchGroups(groups: string[]) {
  expect(mocks.searchQuery).toHaveBeenLastCalledWith(
    { query: 'Matching' },
    { enabled: groups.length > 0, staleTime: 30_000 }
  );
  for (const group of GROUPS) {
    if (groups.includes(group)) {
      expect(screen.getByRole('group', { name: group })).toBeInTheDocument();
    } else {
      expect(screen.queryByRole('group', { name: group })).toBeNull();
    }
  }
  if (groups.length === 0) expect(screen.getByText(/No results for/)).toBeInTheDocument();
}

function openNavigation() {
  fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
  return within(screen.getByRole('group', { name: 'Navigation' }));
}

describe('command palette navigation access', () => {
  // ByRole matches string names exactly; its options do not include `exact`.
  it('opens pharmacy commands with Ctrl+K and excludes incompatible and unlicensed modules', () => {
    mocks.vertical = 'PHARMACY';
    mocks.session.user.role = 'ADMIN';
    mocks.pharmacyCapabilities = ['pharmacy:counter'];
    mocks.enabledModules = [
      'pharmacy-core', 'pharmacy-counter', 'projects', 'clients', 'finance', 'hotel-core',
    ];
    render(<Topbar />);
    const nav = openNavigation();

    for (const label of ['Dashboard', 'Counter', 'Medicine catalog', 'Settings']) {
      expect(nav.getByRole('button', { name: label })).toBeInTheDocument();
    }
    for (const label of [
      'Projects', 'Import', 'Clients', 'Finance', 'HR', 'HR & Leave', 'Insights',
      'Property', 'Rooms', 'Meal plans', 'Notes', 'Procedures', 'Prescriptions',
    ]) {
      expect(nav.queryByRole('button', { name: label })).toBeNull();
    }
    fireEvent.click(nav.getByRole('button', { name: 'Counter' }));
    expect(mocks.push).toHaveBeenCalledWith('/pharmacy/counter');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('requires server capabilities for licensed pharmacy commands and updates when grants change', () => {
    mocks.vertical = 'PHARMACY';
    mocks.enabledModules = [
      'pharmacy-core', 'pharmacy-counter', 'pharmacy-procurement', 'pharmacy-dispensing',
      'pharmacy-reports', 'pharmacy-safety',
    ];
    const view = render(<Topbar />);
    const nav = openNavigation();
    const restricted = [
      'Counter', 'Purchasing', 'Prescriptions', 'Pharmacist queue', 'Substitution',
      'Reports & Insights', 'Controlled register', 'Procedures',
    ];
    for (const label of restricted) {
      expect(nav.queryByRole('button', { name: label })).toBeNull();
    }
    for (const label of ['Medicine catalog', 'Day close', 'Regulatory profile', 'Organization']) {
      expect(nav.queryByRole('button', { name: label })).toBeNull();
    }
    mocks.pharmacyCapabilities = [
      'pharmacy:counter',
      'pharmacy:procurement', 'pharmacy:prescriptions', 'pharmacy:dispense', 'reports:operational',
    ];
    mocks.safetyAllowed = true;
    mocks.sopAllowed = true;
    view.rerender(<Topbar />);
    for (const label of restricted) {
      expect(nav.getByRole('button', { name: label })).toBeInTheDocument();
    }

    mocks.enabledModules = ['pharmacy-core', 'pharmacy-counter'];
    view.rerender(<Topbar />);
    for (const label of restricted) {
      if (label === 'Counter') {
        expect(nav.getByRole('button', { name: label })).toBeInTheDocument();
        continue;
      }
      expect(nav.queryByRole('button', { name: label })).toBeNull();
    }
  });

  it('hides Counter from Procurement and reacts to server counter access being granted or revoked', () => {
    mocks.vertical = 'PHARMACY';
    mocks.enabledModules = ['pharmacy-core', 'pharmacy-counter', 'pharmacy-procurement'];
    mocks.pharmacyCapabilities = ['pharmacy:procurement'];
    const view = render(<Topbar />);
    const nav = openNavigation();
    expect(nav.getByRole('button', { name: 'Purchasing' })).toBeInTheDocument();
    expect(nav.queryByRole('button', { name: 'Counter' })).toBeNull();

    mocks.pharmacyCapabilities.push('pharmacy:counter');
    view.rerender(<Topbar />);
    expect(nav.getByRole('button', { name: 'Counter' })).toBeInTheDocument();

    mocks.pharmacyAccessUserId = 'another-member';
    view.rerender(<Topbar />);
    expect(nav.queryByRole('button', { name: 'Counter' })).toBeNull();

    mocks.pharmacyAccessUserId = 'user-1';
    mocks.pharmacyCapabilities = ['pharmacy:procurement'];
    view.rerender(<Topbar />);
    expect(nav.queryByRole('button', { name: 'Counter' })).toBeNull();
  });

  it('rejects pharmacy navigation capabilities cached for a different member', () => {
    mocks.vertical = 'PHARMACY';
    mocks.enabledModules = ['pharmacy-core', 'pharmacy-procurement'];
    mocks.pharmacyCapabilities = ['pharmacy:procurement'];
    mocks.pharmacyAccessUserId = 'another-member';
    render(<Topbar />);
    const nav = openNavigation();
    expect(nav.queryByRole('button', { name: 'Purchasing' })).toBeNull();
  });

  it('keeps licensed shared modules and applies role restrictions to their commands', () => {
    mocks.vertical = 'PHARMACY';
    mocks.enabledModules = ['hr', 'notes', 'audit'];
    const view = render(<Topbar />);
    const nav = openNavigation();
    expect(nav.getByRole('button', { name: 'Notes' })).toBeInTheDocument();
    expect(nav.getByRole('button', { name: 'Team' })).toBeInTheDocument();
    expect(nav.queryByRole('button', { name: 'HR' })).toBeNull();
    expect(nav.queryByRole('button', { name: 'Audit Log' })).toBeNull();

    mocks.session.user.role = 'HR';
    view.rerender(<Topbar />);
    expect(nav.getByRole('button', { name: 'HR' })).toBeInTheDocument();
    expect(nav.queryByRole('button', { name: 'Audit Log' })).toBeNull();

    mocks.session.user.role = 'ADMIN';
    view.rerender(<Topbar />);
    expect(nav.getByRole('button', { name: 'Audit Log' })).toBeInTheDocument();
    mocks.enabledModules = [];
    view.rerender(<Topbar />);
    for (const label of ['Notes', 'HR', 'Audit Log']) {
      expect(nav.queryByRole('button', { name: label })).toBeNull();
    }
  });
});

describe('command palette category search licensing', () => {
  it.each([
    { module: 'projects', groups: ['Projects', 'Tasks'] },
    { module: 'clients', groups: ['Clients'] },
    { module: 'notes', groups: ['Notes'] },
    { module: 'hr', groups: ['Team'] },
  ])('keeps $module search available to a partially licensed agency', ({ module, groups }) => {
    mocks.enabledModules = [module];
    render(<Topbar />);
    search();
    expectSearchGroups(groups);
  });

  it('keeps pharmacy team search while hiding mis-provisioned agency categories', () => {
    mocks.vertical = 'PHARMACY';
    mocks.enabledModules = ['hr', 'projects', 'clients'];
    render(<Topbar />);
    search();
    expectSearchGroups(['Team']);
    fireEvent.click(screen.getByRole('button', { name: 'Matching colleague' }));
    expect(mocks.push).toHaveBeenCalledWith('/team/u1');
  });

  it.each([...ALL_VERTICALS.filter((vertical) => vertical !== 'AGENCY'), undefined])(
    'allows licensed shared groups but hides agency records for %s',
    (vertical) => {
      mocks.vertical = vertical;
      render(<Topbar />);
      search();
      expectSearchGroups(['Notes', 'Team']);
    }
  );

  it.each([
    { vertical: 'AGENCY', modules: [] },
    { vertical: 'AGENCY', modules: ['dashboard'] },
    { vertical: 'PHARMACY', modules: ['projects', 'clients'] },
    { vertical: undefined, modules: ['projects', 'clients'] },
  ])(
    'does not request records when $vertical has no licensed compatible groups: $modules',
    ({ vertical, modules }) => {
      mocks.vertical = vertical;
      mocks.enabledModules = modules;
      render(<Topbar />);
      search();
      expectSearchGroups([]);
      expect(mocks.searchQuery.mock.calls.every(([, options]) => !options.enabled)).toBe(true);
    }
  );

  it('keeps all five groups and selection available for a fully licensed agency', () => {
    render(<Topbar />);
    expect(mocks.searchQuery).toHaveBeenLastCalledWith(
      { query: '' },
      { enabled: false, staleTime: 30_000 }
    );
    search();
    expectSearchGroups(GROUPS);
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Tasks' })).getByRole('button', {
        name: /Matching task/,
      })
    );
    expect(mocks.push).toHaveBeenCalledWith('/projects/p1');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('hides revoked cached groups immediately while retaining permitted search', () => {
    mocks.searchQuery.mockReturnValue({
      data: {
        ...cachedResults,
        projects: [
          { ...cachedResults.projects[0], client: { id: 'c1', name: 'Cached client label' } },
        ],
      },
      isLoading: false,
    });
    const view = render(<Topbar />);
    search();
    expectSearchGroups(GROUPS);
    expect(screen.getByText('Cached client label')).toBeInTheDocument();
    mocks.enabledModules = ['projects'];
    view.rerender(<Topbar />);
    expectSearchGroups(['Projects', 'Tasks']);
    expect(screen.queryByText('Cached client label')).toBeNull();
    mocks.enabledModules = [];
    view.rerender(<Topbar />);
    expectSearchGroups([]);
  });

  it('hides cached agency groups immediately after a vertical change', () => {
    const view = render(<Topbar />);
    search();
    expectSearchGroups(GROUPS);
    mocks.vertical = 'PHARMACY';
    view.rerender(<Topbar />);
    expectSearchGroups(['Notes', 'Team']);
  });

  it('does not show a loading state when no category can be requested', () => {
    mocks.vertical = 'PHARMACY';
    mocks.enabledModules = ['projects', 'clients'];
    mocks.searchQuery.mockReturnValue({ data: cachedResults, isLoading: true });
    render(<Topbar />);
    search();
    expectSearchGroups([]);
    expect(screen.queryByText('Searching…')).toBeNull();
  });

  it('shows the loading state for a permitted partial search', () => {
    mocks.enabledModules = ['projects'];
    mocks.searchQuery.mockReturnValue({ data: undefined, isLoading: true });
    render(<Topbar />);
    search();
    expect(mocks.searchQuery).toHaveBeenLastCalledWith(
      { query: 'Matching' },
      { enabled: true, staleTime: 30_000 }
    );
    expect(screen.getByText('Searching…')).toBeInTheDocument();
  });
});
