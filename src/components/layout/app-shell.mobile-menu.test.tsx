import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TenantBrand } from '@/lib/tenant-brand';

/**
 * DEV-507 — the mobile navigation drawer is a modal dialog. Opening it must move
 * focus inside, keep Tab / Shift+Tab inside, make the background inert, and
 * return focus to the opener on Escape or close.
 */

const mocks = vi.hoisted(() => ({
  useSession: vi.fn(),
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/pharmacy/counter' }));
vi.mock('next-auth/react', () => ({ useSession: mocks.useSession }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/motion/page-transition', () => ({
  PageTransition: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/module-catalog', () => ({ moduleForPath: () => null }));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ vertical: 'PHARMACY', enabledModules: [] }),
}));
vi.mock('@/lib/assistant-store', () => ({ useAssistant: () => false }));
vi.mock('@/components/theme-provider', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/restaurant/administrator-staff-profile-callout', () => ({
  AdministratorStaffProfileCallout: () => null,
}));
vi.mock('./topbar', () => ({
  Topbar: ({
    onMenuClick,
  }: {
    onMenuClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  }) => (
    <header>
      <button type="button" onClick={onMenuClick}>
        Open menu
      </button>
      <a href="/dashboard">Open dashboard</a>
      <button type="button">Search</button>
    </header>
  ),
}));
vi.mock('./sidebar', async () => {
  const { default: Link } = await import('next/link');
  return {
    Sidebar: ({ onNavigate, onClose }: { onNavigate?: () => void; onClose?: () => void }) => (
      <aside>
        {onClose ? (
          <button type="button" onClick={onClose}>
            Close menu
          </button>
        ) : null}
        <nav>
          <Link href="/pharmacy/counter" onClick={onNavigate}>
            Counter
          </Link>
          <Link href="/pharmacy/stock" onClick={onNavigate}>
            Stock
          </Link>
        </nav>
      </aside>
    ),
    TopNavigation: () => null,
  };
});

import { AppShell } from './app-shell';

const BRAND: TenantBrand = {
  organizationId: 'org_sehat',
  displayName: 'Sehat Cart',
  logoUrl: null,
  markUrl: null,
  faviconUrl: null,
  primaryColor: '#FF684F',
  accentColor: '#246B5A',
};

function renderShell() {
  mocks.useSession.mockReturnValue({
    data: { user: { organizationId: 'org_sehat', name: 'Owner', isSupportSession: false } },
    // Not 'authenticated': keeps the tRPC-backed assistant out of this unit.
    status: 'loading',
  });
  render(
    <AppShell brand={BRAND}>
      <button type="button">Edit dashboard</button>
    </AppShell>
  );
}

function openMenu() {
  const opener = screen.getByRole('button', { name: 'Open menu' });
  // Safari does not focus a tapped button, so focus is left on another control.
  act(() => screen.getByRole('button', { name: 'Search' }).focus());
  fireEvent.click(opener);
  return opener;
}

function press(key: string, shiftKey = false) {
  fireEvent.keyDown(document.activeElement ?? document.body, { key, shiftKey });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AppShell mobile navigation drawer focus', () => {
  it('moves focus to the first navigation item when the drawer opens', () => {
    renderShell();
    openMenu();

    const dialog = screen.getByRole('dialog', { name: 'Mobile navigation' });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Counter' }));
  });

  it('makes the background shell inert while the drawer is open', () => {
    renderShell();
    const background = screen.getByText('Edit dashboard').closest('.studio-shell');
    expect(background).not.toHaveAttribute('inert');

    openMenu();

    expect(background).toHaveAttribute('inert');
    expect(screen.getByText('Skip to content')).toHaveAttribute('inert');
  });

  it('keeps Tab and Shift+Tab inside the drawer', () => {
    renderShell();
    openMenu();
    const dialog = screen.getByRole('dialog', { name: 'Mobile navigation' });
    const close = screen.getByRole('button', { name: 'Close menu' });
    const last = screen.getByRole('link', { name: 'Stock' });

    act(() => last.focus());
    press('Tab');
    expect(document.activeElement).toBe(close);

    press('Tab', true);
    expect(document.activeElement).toBe(last);

    for (let i = 0; i < 6; i += 1) {
      press('Tab');
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it('pulls focus back inside when it escapes to the background', () => {
    renderShell();
    openMenu();
    const dialog = screen.getByRole('dialog', { name: 'Mobile navigation' });

    act(() => screen.getByRole('button', { name: 'Search' }).focus());
    press('Tab');

    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it('restores focus to the opener on Escape', () => {
    renderShell();
    const opener = openMenu();
    act(() => screen.getByRole('link', { name: 'Stock' }).focus());

    press('Escape');

    expect(screen.queryByRole('dialog', { name: 'Mobile navigation' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
    expect(screen.getByText('Edit dashboard').closest('.studio-shell')).not.toHaveAttribute(
      'inert'
    );
  });

  it('offers an accessible close control that restores focus to the opener', () => {
    renderShell();
    const opener = openMenu();

    fireEvent.click(screen.getByRole('button', { name: 'Close menu' }));

    expect(screen.queryByRole('dialog', { name: 'Mobile navigation' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });
});
