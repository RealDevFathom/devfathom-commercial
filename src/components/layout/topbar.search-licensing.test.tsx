import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  vertical: 'AGENCY' as string | undefined,
  enabledModules: [] as string[],
  searchQuery: vi.fn(),
  push: vi.fn(),
}));

vi.mock('next/dynamic', () => ({
  default: (loader: { toString(): string }) => {
    const source = loader.toString();
    if (source.includes('CommandDialog'))
      return ({ open, children }: { open: boolean; children: React.ReactNode }) =>
        open ? <div role="dialog">{children}</div> : null;
    if (source.includes('CommandInput'))
      return ({ value, onValueChange }: { value: string; onValueChange: (value: string) => void }) => (
        <input
          aria-label="Search records"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
        />
      );
    if (source.includes('CommandGroup'))
      return ({ heading, children }: { heading: string; children: React.ReactNode }) => (
        <div role="group" aria-label={heading}>
          {children}
        </div>
      );
    if (source.includes('CommandItem'))
      return ({ children, onSelect }: { children: React.ReactNode; onSelect: () => void }) => (
        <button type="button" onClick={onSelect}>
          {children}
        </button>
      );
    return ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  },
}));
vi.mock('@/components/ui/command', () => ({}));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock('@/components/theme-provider', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ vertical: mocks.vertical, enabledModules: mocks.enabledModules }),
}));
vi.mock('./topbar-breadcrumbs', () => ({ routeLabels: {}, TopbarBreadcrumbs: () => null }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({}),
    search: { global: { useQuery: mocks.searchQuery } },
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

function expectBlockedSearch() {
  expect(mocks.searchQuery).toHaveBeenLastCalledWith(
    { query: 'Matching' },
    { enabled: false, staleTime: 30_000 }
  );
  for (const group of GROUPS) expect(screen.queryByRole('group', { name: group })).toBeNull();
  expect(screen.getByText(/No results for/)).toBeInTheDocument();
}

describe('command palette aggregate search licensing', () => {
  it.each(['PHARMACY', 'RESTAURANT', 'HOSPITALITY', undefined])(
    'blocks unrelated records for %s even when agency modules are accidentally enabled',
    (vertical) => {
      mocks.vertical = vertical;
      render(<Topbar />);
      search();
      expectBlockedSearch();
      expect(mocks.searchQuery.mock.calls.every(([, options]) => !options.enabled)).toBe(true);
    }
  );

  it.each(SEARCH_MODULES)(
    'does not request an unlicensed %s group through aggregate search',
    (missing) => {
      mocks.enabledModules = SEARCH_MODULES.filter((moduleKey) => moduleKey !== missing);
      render(<Topbar />);
      search();
      expectBlockedSearch();
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
    expect(mocks.searchQuery).toHaveBeenLastCalledWith(
      { query: 'Matching' },
      { enabled: true, staleTime: 30_000 }
    );
    for (const group of GROUPS) {
      expect(screen.getByRole('group', { name: group })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Matching task Matching project' }));
    expect(mocks.push).toHaveBeenCalledWith('/projects/p1');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('hides cached groups immediately after licensing changes', () => {
    const view = render(<Topbar />);
    search();
    expect(screen.getByRole('group', { name: 'Projects' })).toBeInTheDocument();
    mocks.enabledModules = ['hr'];
    view.rerender(<Topbar />);
    expectBlockedSearch();
  });

  it('does not show a loading state for an aggregate query it cannot request', () => {
    mocks.vertical = 'PHARMACY';
    mocks.searchQuery.mockReturnValue({ data: cachedResults, isLoading: true });
    render(<Topbar />);
    search();
    expectBlockedSearch();
    expect(screen.queryByText('Searching…')).toBeNull();
  });
});
