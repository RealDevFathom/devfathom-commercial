import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  pathname: vi.fn(() => '/dashboard'),
  session: vi.fn<() => unknown>(() => null),
}));

vi.mock('@/components/theme-provider', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('next/navigation', () => ({ usePathname: mocks.pathname }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: mocks.session() }) }));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ vertical: 'PHARMACY', enabledModules: ['pharmacy-core'] }),
}));
vi.mock('@/lib/assistant-store', () => ({ useAssistant: () => false }));
vi.mock('@/lib/tenant-brand', () => ({
  tenantBrandTokens: () => ({}),
  isTenantIdentityMismatch: () => false,
}));
vi.mock('@/components/motion/page-transition', () => ({
  PageTransition: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('./topbar', () => ({ Topbar: () => null }));
vi.mock('./sidebar', () => ({ Sidebar: () => null, TopNavigation: () => null }));
vi.mock('@/components/restaurant/administrator-staff-profile-callout', () => ({
  AdministratorStaffProfileCallout: () => null,
}));

import { AppShell } from './app-shell';

const WARNING = 'Licence details are PLACEHOLDER – not a real licence';
let member = 0;

function signIn() {
  // A fresh member per test, so one test's dismissal never leaks into another.
  member += 1;
  mocks.session.mockReturnValue({
    user: { id: `user-${member}`, organizationId: 'org-pharmacy', name: 'Owner', role: 'ADMIN' },
  });
}

function renderShell(pathname: string) {
  mocks.pathname.mockReturnValue(pathname);
  const props: ComponentProps<typeof AppShell> = {
    brand: {
      organizationId: 'org-pharmacy',
      displayName: 'Test pharmacy',
      logoUrl: null,
      markUrl: null,
      faviconUrl: null,
      primaryColor: null,
      accentColor: null,
    },
    pharmacyPlaceholder: true,
    children: <p>Page</p>,
  };
  return render(<AppShell {...props} />);
}

describe('placeholder licence notice (DEV-44)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.session.mockReturnValue(null);
  });
  afterEach(() => cleanup());

  it('lets the owner dismiss it, and keeps it dismissed on every other page and reload', () => {
    signIn();
    renderShell('/dashboard');
    expect(screen.getByRole('alert')).toHaveTextContent(WARNING);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss licence placeholder notice' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    cleanup();
    renderShell('/pharmacy/inventory');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the warning on the onboarding and regulatory pages, where the licence is replaced', () => {
    signIn();
    renderShell('/pharmacy/counter');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss licence placeholder notice' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    for (const pathname of [
      '/pharmacy',
      '/pharmacy/regulatory',
      '/pharmacy/regulatory/fbr-tier-1',
    ]) {
      cleanup();
      renderShell(pathname);
      expect(screen.getByRole('alert'), pathname).toHaveTextContent(WARNING);
      expect(
        screen.queryByRole('button', { name: 'Dismiss licence placeholder notice' }),
        pathname
      ).not.toBeInTheDocument();
    }
  });

  it('remembers the dismissal per member, not for everyone on the browser', () => {
    signIn();
    renderShell('/dashboard');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss licence placeholder notice' }));

    cleanup();
    signIn();
    renderShell('/dashboard');
    expect(screen.getByRole('alert')).toHaveTextContent(WARNING);
  });

  it('shows the warning without a dismiss control until the session is known', () => {
    renderShell('/dashboard');
    expect(screen.getByRole('alert')).toHaveTextContent(WARNING);
    expect(
      screen.queryByRole('button', { name: 'Dismiss licence placeholder notice' })
    ).not.toBeInTheDocument();
  });

  it('still hides the notice for this page view when storage is blocked', () => {
    signIn();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      renderShell('/dashboard');
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss licence placeholder notice' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      setItem.mockRestore();
    }
  });
});
