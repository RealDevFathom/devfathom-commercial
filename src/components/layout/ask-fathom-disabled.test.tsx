import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantBrand } from '@/lib/tenant-brand';
import { useAssistant } from '@/lib/assistant-store';

const mocks = vi.hoisted(() => ({
  session: {
    status: 'authenticated',
    data: { user: { organizationId: 'org-a', name: 'Amina', role: 'ADMIN' } },
  },
  settings: {
    data: undefined as { organizationId: string; askFathomEnabled: boolean } | undefined,
    dataUpdatedAt: 0,
    errorUpdatedAt: 0,
    isError: false,
    isFetchedAfterMount: false,
  },
  settingsQuery: vi.fn(),
  utils: {
    organizationAdmin: { askFathomSettings: { cancel: vi.fn().mockResolvedValue(undefined) } },
    team: { getNotifications: {} },
  },
}));
vi.mock('next-auth/react', () => ({ useSession: () => mocks.session }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('next/dynamic', async () => {
  const { useState } = await import('react');
  return {
    default: (loader: () => unknown) =>
      loader.toString().includes('assistant-panel')
        ? function Panel() {
            const [draft, setDraft] = useState('');
            return (
              <textarea
                aria-label="Chat draft"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
            );
          }
        : () => null,
  };
});
vi.mock('@/components/theme-provider', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ vertical: 'AGENCY', enabledModules: ['hr'] }),
}));
vi.mock('@/components/motion/page-transition', () => ({
  PageTransition: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('./sidebar', () => ({
  Sidebar: () => null,
  TopNavigation: () => <nav>Reports and Insights</nav>,
  // The topbar breadcrumbs read the menu labels from the sidebar's navigation list.
  navigation: [],
}));
vi.mock('@/components/restaurant/administrator-staff-profile-callout', () => ({
  AdministratorStaffProfileCallout: () => null,
}));
vi.mock('@/lib/trpc', () => {
  const empty = { useQuery: () => ({ data: [] }) };
  const mutation = { useMutation: () => ({ mutate: vi.fn() }) };
  return {
    trpc: {
      useUtils: () => mocks.utils,
      organizationAdmin: { askFathomSettings: { useQuery: mocks.settingsQuery } },
      search: { global: empty },
      team: {
        getNotifications: empty,
        getAll: empty,
        markNotificationRead: mutation,
        markAllNotificationsRead: mutation,
      },
      meetings: { getUpcoming: empty, create: mutation },
      dashboard: {
        getStats: { useQuery: () => ({ data: {} }) },
        getRecentActivity: empty,
        getUpcomingDeadlines: empty,
        getProjectCards: empty,
        getMyTasks: empty,
        getPreferences: {
          useQuery: () => ({
            data: { hiddenWidgets: ['myTasks', 'deadlines', 'activity', 'projects'] },
          }),
        },
        updatePreferences: mutation,
      },
    },
  };
});

import { AppShell } from './app-shell';
import { Topbar } from './topbar';
import { DashboardContent } from '@/app/(app)/dashboard/dashboard-content';

const brandFor = (organizationId: string): TenantBrand => ({
  organizationId,
  displayName: organizationId,
  logoUrl: null,
  markUrl: null,
  faviconUrl: null,
  primaryColor: null,
  accentColor: null,
});
const launchers = () => [
  screen.getByRole('button', { name: 'Open AI assistant' }),
  screen.getByRole('button', { name: /Ask Fathom anything/ }),
];
function shell(organizationId = 'org-a') {
  return (
    <AppShell brand={brandFor(organizationId)}>
      <DashboardContent />
    </AppShell>
  );
}
function confirm(askFathomEnabled: boolean, updatedAt: number, organizationId = 'org-a') {
  mocks.settings = {
    data: { organizationId, askFathomEnabled },
    dataUpdatedAt: updatedAt,
    errorUpdatedAt: 0,
    isError: false,
    isFetchedAfterMount: true,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useAssistant.setState(useAssistant.getInitialState());
  mocks.session = {
    status: 'authenticated',
    data: { user: { organizationId: 'org-a', name: 'Amina', role: 'ADMIN' } },
  };
  mocks.settings = {
    data: undefined,
    dataUpdatedAt: 0,
    errorUpdatedAt: 0,
    isError: false,
    isFetchedAfterMount: false,
  };
  mocks.settingsQuery.mockImplementation(() => mocks.settings);
});
afterEach(cleanup);

describe('both real Ask Fathom launch buttons and shell lifecycle', () => {
  it('disables both buttons while unknown and keeps the ordinary dashboard available', () => {
    render(shell());
    for (const button of launchers()) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(useAssistant.getState().open).toBe(false);
    expect(screen.queryByLabelText('Chat draft')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Arrange' })).toBeEnabled();
    expect(screen.getByText('Reports and Insights')).toBeInTheDocument();
    expect(mocks.settingsQuery).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        refetchOnMount: 'always',
        refetchOnWindowFocus: 'always',
        staleTime: 0,
      })
    );
    expect(mocks.settingsQuery.mock.calls[0][1]).not.toHaveProperty('refetchInterval');
  });

  it('clicks both actual buttons, clears history on confirmed off, and re-enables a fresh panel', () => {
    confirm(true, 10);
    const view = render(shell());
    fireEvent.click(launchers()[0]);
    fireEvent.change(screen.getByLabelText('Chat draft'), {
      target: { value: 'Private old chat' },
    });
    act(() => useAssistant.getState().setOpen(false));
    fireEvent.click(launchers()[1]);
    expect(useAssistant.getState().open).toBe(true);
    expect(screen.getByLabelText('Chat draft')).toHaveValue('Private old chat');
    confirm(false, 20);
    view.rerender(shell());
    for (const button of launchers()) expect(button).toBeDisabled();
    expect(screen.queryByLabelText('Chat draft')).not.toBeInTheDocument();
    confirm(true, 10);
    view.rerender(shell());
    for (const button of launchers()) expect(button).toBeDisabled();
    confirm(true, 30);
    view.rerender(shell());
    expect(screen.queryByLabelText('Chat draft')).not.toBeInTheDocument();
    fireEvent.click(launchers()[1]);
    expect(screen.getByLabelText('Chat draft')).toHaveValue('');
  });

  it('fails closed for a mismatched response and for stale cache from an earlier mount', () => {
    confirm(true, 10, 'org-b');
    const view = render(shell());
    for (const button of launchers()) expect(button).toBeDisabled();
    confirm(true, 20);
    mocks.settings.isFetchedAfterMount = false;
    view.rerender(shell());
    for (const button of launchers()) expect(button).toBeDisabled();
  });

  it('clears open and hidden prior chat when organization identity changes', () => {
    confirm(true, 10);
    const view = render(shell());
    fireEvent.click(launchers()[0]);
    fireEvent.change(screen.getByLabelText('Chat draft'), {
      target: { value: 'Organization A history' },
    });
    act(() => useAssistant.getState().setOpen(false));
    mocks.session.data.user.organizationId = 'org-b';
    view.rerender(shell());
    expect(screen.getByText('You are signed in to a different workspace')).toBeInTheDocument();
    expect(screen.queryByLabelText('Chat draft')).not.toBeInTheDocument();
    expect(useAssistant.getState()).toMatchObject({
      open: false,
      hasOpened: false,
      organizationId: null,
    });
    view.rerender(shell('org-b'));
    for (const button of launchers()) expect(button).toBeDisabled();
    confirm(true, 30, 'org-b');
    view.rerender(shell('org-b'));
    fireEvent.click(launchers()[0]);
    expect(screen.getByLabelText('Chat draft')).toHaveValue('');
  });

  it('checks the session organization in each button even before the shell effect runs', () => {
    useAssistant.getState().setOrganization('org-b');
    useAssistant
      .getState()
      .confirmSettings({ organizationId: 'org-b', askFathomEnabled: true }, 10);
    render(
      <>
        <Topbar />
        <DashboardContent />
      </>
    );
    for (const button of launchers()) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(useAssistant.getState().open).toBe(false);
  });

  it('finishes a stalled availability check with an actionable error', () => {
    vi.useFakeTimers();
    try {
      render(shell());
      act(() => vi.advanceTimersByTime(15_000));
      expect(screen.getAllByText(/availability could not be confirmed/).length).toBeGreaterThan(0);
      for (const button of launchers()) expect(button).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes on query failure and does not fetch settings without an authenticated session', () => {
    confirm(true, 10);
    const view = render(shell());
    fireEvent.click(launchers()[0]);
    mocks.settings = { ...mocks.settings, isError: true, errorUpdatedAt: 20 };
    view.rerender(shell());
    expect(screen.queryByLabelText('Chat draft')).not.toBeInTheDocument();
    for (const button of launchers()) expect(button).toBeDisabled();
    expect(screen.getAllByText(/availability could not be confirmed/).length).toBeGreaterThan(0);
    mocks.settingsQuery.mockClear();
    mocks.session.status = 'unauthenticated';
    view.rerender(shell());
    expect(mocks.settingsQuery).not.toHaveBeenCalled();
    expect(useAssistant.getState().organizationId).toBeNull();
  });
});
