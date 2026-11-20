import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShellChromeProvider, type ShellChrome } from '@/components/layout/shell-chrome';

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { name: 'Test owner' } }, status: 'authenticated' }),
}));
vi.mock('@/components/layout/topbar', () => ({
  useWorkspaceRoleLabel: () => 'Workspace role: Admin',
  WorkspaceBrandLink: ({
    brand,
    subtitle,
  }: {
    brand?: { displayName: string };
    subtitle: string;
  }) => (
    <a href="/dashboard">
      {brand?.displayName} · {subtitle}
    </a>
  ),
  WorkspaceSearch: ({ compact }: { compact?: boolean }) => (
    <button type="button">{compact ? 'Search (compact)' : 'Search'}</button>
  ),
  AskFathomButton: () => <button type="button">Ask Fathom</button>,
  ThemeToggleButton: () => <button type="button">Theme</button>,
  NotificationBell: () => <button type="button">Notifications</button>,
  AccountMenu: () => <button type="button">Account</button>,
}));
vi.mock('@/components/layout/topbar-breadcrumbs', () => ({
  TopbarBreadcrumbs: () => <span>Pharmacy › Counter</span>,
}));

import { CounterActionBar, CounterFrame } from './counter-frame';
import { CounterSkeleton } from './counter-skeleton';

const openNavigation = vi.fn();
const chrome: ShellChrome = {
  brand: {
    organizationId: 'org-a',
    displayName: 'Test pharmacy',
    logoUrl: null,
    markUrl: null,
    faviconUrl: null,
    primaryColor: null,
    accentColor: null,
  },
  openNavigation,
};

function inShell(children: ReactNode) {
  return render(<ShellChromeProvider value={chrome}>{children}</ShellChromeProvider>);
}

afterEach(() => {
  cleanup();
  openNavigation.mockClear();
});

describe('DEV-977 counter frame (Counter v2)', () => {
  it('carries the workspace bar’s identity and tools inside the shell', () => {
    inShell(
      <CounterFrame statusLine="Online · Main branch">
        <p>Body</p>
      </CounterFrame>
    );
    const header = screen.getByRole('banner');
    for (const name of ['Search (compact)', 'Ask Fathom', 'Theme', 'Notifications', 'Account'])
      expect(within(header).getByRole('button', { name })).toBeInTheDocument();
    expect(
      within(header).getByRole('link', { name: 'Test pharmacy · Pharmacy workspace' })
    ).toHaveAttribute('href', '/dashboard');
    expect(within(header).getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent(
      'Pharmacy › Counter'
    );
    expect(within(header).getByText('Test owner')).toBeInTheDocument();
    expect(within(header).getByText('Workspace role: Admin')).toBeInTheDocument();
    // One page heading; the phone-width echo is not announced twice.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Counter' })).toBeInTheDocument();
    expect(screen.getByText('Online · Main branch').closest('[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByText('Body')).toBeInTheDocument();
  });

  it('opens the shell navigation from the phone menu and the action row menu', () => {
    inShell(
      <CounterFrame>
        <p>Body</p>
      </CounterFrame>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    expect(openNavigation).toHaveBeenCalledTimes(2);
  });

  it('shows no workspace tools or menu outside the shell', () => {
    render(
      <CounterFrame>
        <p>Body</p>
      </CounterFrame>
    );
    expect(screen.queryByRole('button', { name: 'Open menu' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Menu' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Account' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Counter' })).toBeInTheDocument();
  });

  it('leaves the heading to content that brings its own', () => {
    inShell(
      <CounterFrame heading={false}>
        <h1>Counter</h1>
      </CounterFrame>
    );
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Menu' })).toBeInTheDocument();
  });

  it('puts the counter’s own actions in the action row', () => {
    inShell(
      <CounterFrame
        actionBar={
          <CounterActionBar>
            <button type="button">Returns</button>
          </CounterActionBar>
        }
      >
        <p>Body</p>
      </CounterFrame>
    );
    const header = screen.getByRole('banner');
    expect(within(header).getByRole('button', { name: 'Returns' })).toBeInTheDocument();
    expect(within(header).getByRole('heading', { name: 'Counter' })).toBeInTheDocument();
  });

  it('loads inside the same frame, so navigation is reachable while it loads', () => {
    inShell(<CounterSkeleton />);
    expect(screen.getByRole('status', { name: 'Loading pharmacy counter' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Menu' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Account' })).toBeInTheDocument();
  });
});
