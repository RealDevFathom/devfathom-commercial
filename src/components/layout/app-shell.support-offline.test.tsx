import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * DEV-957 phase 2 (shared till): the audited support-access banner names the member the
 * support session acts as. The stored counter page opened with no connection cannot check
 * who is signed in, so offline the banner keeps the warning and names nobody.
 */

vi.mock('next/navigation', () => ({ usePathname: () => '/pharmacy/counter' }));
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: {
      user: {
        id: 'user-a',
        organizationId: 'org-a',
        name: 'Ayesha Khan',
        isSupportSession: true,
        supportReason: 'Ticket about Ayesha Khan',
      },
    },
    // The banner reads only the session's user; 'loading' keeps the realtime provider out.
    status: 'loading',
  }),
}));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('@/components/motion/page-transition', () => ({
  PageTransition: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/lib/module-catalog', () => ({
  moduleForPath: () => 'pharmacy-counter',
  isModuleGranted: () => true,
  moduleDefinitionForKey: () => ({ name: 'Pharmacy counter' }),
}));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ organizationId: 'org-a', vertical: 'PHARMACY', enabledModules: [] }),
}));
vi.mock('@/lib/assistant-store', () => ({ useAssistant: () => false }));
vi.mock('@/components/theme-provider', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('@/components/restaurant/administrator-staff-profile-callout', () => ({
  AdministratorStaffProfileCallout: () => null,
}));
vi.mock('./topbar', () => ({ Topbar: () => <header>Workspace bar</header> }));
vi.mock('./sidebar', () => ({
  Sidebar: () => <nav aria-label="Main navigation" />,
  TopNavigation: () => <nav />,
}));

import { AppShell } from './app-shell';

const BRAND = {
  organizationId: 'org-a',
  displayName: 'Test pharmacy',
  logoUrl: null,
  markUrl: null,
  faviconUrl: null,
  primaryColor: null,
  accentColor: null,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('audited support-access banner and the connection', () => {
  it('keeps the warning offline but names nobody', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const { container } = render(
      <AppShell brand={BRAND}>
        <p>Counter</p>
      </AppShell>
    );
    expect(
      screen.getByText(
        'Audited support access · Offline: who is signed in is checked again when the connection returns.'
      )
    ).toBeInTheDocument();
    expect(container).not.toHaveTextContent('Ayesha Khan');
    expect(container).not.toHaveTextContent('acting as');
  });

  it('names the member it acts as online, as before', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    const { container } = render(
      <AppShell brand={BRAND}>
        <p>Counter</p>
      </AppShell>
    );
    expect(container).toHaveTextContent(
      'Audited support access · acting as Ayesha Khan · Ticket about Ayesha Khan'
    );
  });
});
