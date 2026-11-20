import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * DEV-977 — the pharmacy counter draws its own top bar and action row. On that route
 * only, the shell leaves out the workspace bar and module row, and lends the page its
 * navigation drawer and the workspace identity through the shell chrome.
 */

const mocks = vi.hoisted(() => ({
  pathname: '/pharmacy/counter',
  moduleEnabled: true,
}));

vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname }));
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: { user: { id: 'user-a', organizationId: 'org-a', name: 'Owner' } },
    status: 'loading',
  }),
}));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/motion/page-transition', () => ({
  PageTransition: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/module-catalog', () => ({
  moduleForPath: () => 'pharmacy-counter',
  isModuleGranted: () => mocks.moduleEnabled,
  moduleDefinitionForKey: () => ({ name: 'Pharmacy counter' }),
}));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ vertical: 'PHARMACY', enabledModules: [] }),
}));
vi.mock('@/lib/assistant-store', () => ({ useAssistant: () => false }));
vi.mock('@/components/theme-provider', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('@/components/restaurant/administrator-staff-profile-callout', () => ({
  AdministratorStaffProfileCallout: () => null,
}));
vi.mock('./topbar', () => ({
  Topbar: () => <header data-testid="workspace-bar">Workspace bar</header>,
}));
vi.mock('./sidebar', async () => {
  const { default: Link } = await import('next/link');
  return {
    Sidebar: () => (
      <nav aria-label="Main navigation">
        <Link href="/pharmacy/inventory">Inventory</Link>
      </nav>
    ),
    TopNavigation: () => <nav data-testid="module-row">Module row</nav>,
  };
});

import { AppShell } from './app-shell';
import { routeOwnsChrome, useShellChrome } from './shell-chrome';

const BRAND = {
  organizationId: 'org-a',
  displayName: 'Test pharmacy',
  logoUrl: null,
  markUrl: null,
  faviconUrl: null,
  primaryColor: null,
  accentColor: null,
};

function PageBar() {
  const chrome = useShellChrome();
  return (
    <div>
      <p data-testid="lent-brand">{chrome?.brand.displayName ?? 'no chrome'}</p>
      {chrome ? (
        <button type="button" onClick={chrome.openNavigation}>
          Menu
        </button>
      ) : null}
    </div>
  );
}

function renderShell(pathname: string) {
  mocks.pathname = pathname;
  return render(
    <AppShell brand={BRAND}>
      <PageBar />
    </AppShell>
  );
}

afterEach(() => {
  cleanup();
  mocks.moduleEnabled = true;
});

describe('DEV-977 routes that draw their own bar', () => {
  it('names only the counter route', () => {
    expect(routeOwnsChrome('/pharmacy/counter')).toBe(true);
    for (const pathname of ['/pharmacy', '/pharmacy/counter/close', '/dashboard', '/chat'])
      expect(routeOwnsChrome(pathname), pathname).toBe(false);
  });

  it('leaves out the workspace bar and module row on the counter and lends its chrome', () => {
    renderShell('/pharmacy/counter');
    expect(screen.queryByTestId('workspace-bar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('module-row')).not.toBeInTheDocument();
    expect(screen.getByTestId('lent-brand')).toHaveTextContent('Test pharmacy');
    // The skip link and the main landmark stay the shell's.
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute(
      'href',
      '#main-content'
    );
    expect(screen.getByRole('main')).toContainElement(screen.getByTestId('lent-brand'));
  });

  it('keeps the workspace bar and module row on every other route', () => {
    for (const pathname of ['/dashboard', '/pharmacy/counter/close']) {
      renderShell(pathname);
      expect(screen.getByTestId('workspace-bar'), pathname).toBeInTheDocument();
      expect(screen.getByTestId('module-row'), pathname).toBeInTheDocument();
      cleanup();
    }
  });

  it('keeps the workspace bar when the counter module is not enabled', () => {
    mocks.moduleEnabled = false;
    renderShell('/pharmacy/counter');
    expect(screen.getByTestId('workspace-bar')).toBeInTheDocument();
    expect(screen.getByTestId('module-row')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'This module is not enabled' })).toBeVisible();
  });

  it('opens the same navigation drawer from the page, at every width', () => {
    const listeners: Array<(event: MediaQueryListEvent) => void> = [];
    const matchMedia = vi.fn(() => ({
      matches: true,
      addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.push(listener),
      removeEventListener: vi.fn(),
    }));
    vi.stubGlobal('matchMedia', matchMedia);
    try {
      renderShell('/pharmacy/counter');
      const opener = screen.getByRole('button', { name: 'Menu' });
      fireEvent.click(opener);
      const drawer = screen.getByRole('dialog', { name: 'Mobile navigation' });
      // Not limited to phone widths on this route, and widening does not close it.
      expect(drawer).not.toHaveClass('lg:hidden');
      expect(drawer).toContainElement(screen.getByRole('link', { name: 'Inventory' }));
      expect(listeners).toHaveLength(0);
      act(() => fireEvent.keyDown(document, { key: 'Escape' }));
      expect(screen.queryByRole('dialog', { name: 'Mobile navigation' })).not.toBeInTheDocument();
      expect(document.activeElement).toBe(opener);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still closes the phone drawer when another route widens to desktop', () => {
    const listeners: Array<(event: MediaQueryListEvent) => void> = [];
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) =>
          listeners.push(listener),
        removeEventListener: vi.fn(),
      }))
    );
    try {
      mocks.pathname = '/dashboard';
      render(
        <AppShell brand={BRAND}>
          <PageBar />
        </AppShell>
      );
      fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
      expect(screen.getByRole('dialog', { name: 'Mobile navigation' })).toHaveClass('lg:hidden');
      expect(listeners).toHaveLength(1);
      act(() => listeners[0]!({ matches: true } as MediaQueryListEvent));
      expect(screen.queryByRole('dialog', { name: 'Mobile navigation' })).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
