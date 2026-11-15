import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TenantBrand } from '@/lib/tenant-brand';

/**
 * WHA-276 — the displayed workspace identity must never diverge from
 * `session.user.organizationId`.
 *
 * The shell's brand is a server prop, resolved once when the `/(app)` layout
 * renders. The effective tenant is re-resolved from the live cookie on every
 * later request. On the shared host the Auth.js JWT is host-wide and one email
 * may hold accounts in several organizations, so a tab left open on
 * organization A can end up rendering A's name, logo and palette over
 * organization B's data. These tests pin the shell's obligation: when the two
 * disagree, render no tenant identity and no page content at all.
 */

const mocks = vi.hoisted(() => ({
  useSession: vi.fn(),
  usePathname: vi.fn(() => '/dashboard'),
  sidebar: vi.fn(),
  topbar: vi.fn(),
}));

vi.mock('next/navigation', () => ({ usePathname: mocks.usePathname }));
vi.mock('next-auth/react', () => ({ useSession: mocks.useSession }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/motion/page-transition', () => ({
  PageTransition: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
// The identity invariant is orthogonal to entitlements and to the vertical, so
// this file keeps both out of the way: every path is module-enabled, and no
// vertical is named.
vi.mock('@/lib/module-catalog', () => ({ moduleForPath: () => null }));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ vertical: 'AGENCY', enabledModules: [] }),
}));
vi.mock('@/lib/assistant-store', () => ({ useAssistant: () => false }));
vi.mock('@/components/theme-provider', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

// Stand-ins for the real chrome, which renders `brand.displayName` as the
// workspace name (`topbar.tsx` and `sidebar.tsx` both do). Rendering the same
// value here lets the assertions speak about displayed tenant identity while
// keeping the unit under test the shell's guard.
vi.mock('./topbar', () => ({
  Topbar: ({ brand }: { brand?: TenantBrand }) => {
    mocks.topbar();
    return <header>{brand?.displayName}</header>;
  },
}));
vi.mock('./sidebar', () => ({
  Sidebar: ({ brand }: { brand?: TenantBrand }) => {
    mocks.sidebar();
    return <aside>{brand?.displayName}</aside>;
  },
  TopNavigation: () => null,
}));
// WHA-1181: a self-hiding strip with its own tRPC query and its own test file.
// Stubbed for the same reason as the chrome above — the unit under test is the
// shell's tenant-identity guard.
vi.mock('@/components/restaurant/administrator-staff-profile-callout', () => ({
  AdministratorStaffProfileCallout: () => null,
}));

import { AppShell } from './app-shell';

const ACME = 'org_acme';
const BOREALIS = 'org_borealis';

function brandFor(organizationId: string, displayName: string): TenantBrand {
  return {
    organizationId,
    displayName,
    logoUrl: null,
    markUrl: null,
    faviconUrl: null,
    primaryColor: '#FF684F',
    accentColor: '#246B5A',
  };
}

function signedInTo(organizationId: string | undefined) {
  mocks.useSession.mockReturnValue({
    data: { user: { organizationId, name: 'Amina Yusuf', isSupportSession: false } },
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AppShell workspace identity invariant', () => {
  it('renders no tenant identity and no page content when the session moved to another organization', () => {
    // The shell was server-rendered for Acme; the live session is now Borealis.
    signedInTo(BOREALIS);
    render(
      <AppShell brand={brandFor(ACME, 'Acme Restaurant Group')}>
        <p>Borealis revenue for March</p>
      </AppShell>
    );

    // The other organization's name must not be on screen anywhere.
    expect(screen.queryByText('Acme Restaurant Group')).not.toBeInTheDocument();
    // Nor may the chrome that carries its logo and palette even mount.
    expect(mocks.topbar).not.toHaveBeenCalled();
    expect(mocks.sidebar).not.toHaveBeenCalled();
    // Nor the page content that would be read as belonging to Acme.
    expect(screen.queryByText('Borealis revenue for March')).not.toBeInTheDocument();
    // The user is told what happened and given the self-healing remedy.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'You are signed in to a different workspace'
    );
    expect(screen.getByRole('button', { name: 'Reload this workspace' })).toBeInTheDocument();
  });

  it('does not apply the organization brand palette while identity is in doubt', () => {
    signedInTo(BOREALIS);
    const { container } = render(
      <AppShell brand={brandFor(ACME, 'Acme Restaurant Group')}>
        <p>content</p>
      </AppShell>
    );

    // tenantBrandTokens would otherwise paint Acme's colours over Borealis.
    const viewport = container.querySelector('.studio-viewport') as HTMLElement | null;
    expect(viewport).not.toBeNull();
    expect(viewport?.style.getPropertyValue('--primary')).toBe('');
    expect(viewport?.style.getPropertyValue('--sidebar')).toBe('');
  });

  it('renders the workspace normally when the session and the chrome name the same organization', () => {
    signedInTo(ACME);
    render(
      <AppShell brand={brandFor(ACME, 'Acme Restaurant Group')}>
        <p>Acme revenue for March</p>
      </AppShell>
    );

    expect(mocks.topbar).toHaveBeenCalled();
    expect(mocks.sidebar).not.toHaveBeenCalled(); // mobile drawer stays closed
    expect(screen.getByText('Acme Restaurant Group')).toBeInTheDocument();
    expect(screen.getByText('Acme revenue for March')).toBeInTheDocument();
    expect(
      screen.queryByText('You are signed in to a different workspace')
    ).not.toBeInTheDocument();
  });

  it('treats an unresolved session organization as not-yet-known rather than a mismatch', () => {
    // The layout's server guard has already run; blocking here would blank the
    // app while the client session hydrates.
    signedInTo(undefined);
    render(
      <AppShell brand={brandFor(ACME, 'Acme Restaurant Group')}>
        <p>Acme revenue for March</p>
      </AppShell>
    );

    expect(screen.getByText('Acme revenue for March')).toBeInTheDocument();
    expect(
      screen.queryByText('You are signed in to a different workspace')
    ).not.toBeInTheDocument();
  });
});
