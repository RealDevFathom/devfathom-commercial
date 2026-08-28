import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ pathname: '/dashboard' }));

vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null }) }));
vi.mock('./sidebar', () => ({
  Sidebar: ({ onNavigate }: { onNavigate?: () => void }) => (
    <nav aria-label="Main navigation">
      <button type="button" onClick={onNavigate}>
        Open inventory
      </button>
    </nav>
  ),
  TopNavigation: () => null,
}));
vi.mock('./topbar', () => ({
  Topbar: ({ onMenuClick }: { onMenuClick?: () => void }) => (
    <button type="button" onClick={onMenuClick}>
      Open menu
    </button>
  ),
}));
vi.mock('@/components/motion/page-transition', () => ({
  PageTransition: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/lib/assistant-store', () => ({ useAssistant: () => false }));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ vertical: 'RESTAURANT', enabledModules: ['restaurant-core'] }),
}));
vi.mock('@/lib/tenant-brand', () => ({ tenantBrandTokens: () => ({}) }));

import { AppShell } from './app-shell';

const brand = {
  displayName: 'Restaurant',
  logoUrl: null,
  markUrl: null,
  faviconUrl: null,
  primaryColor: null,
  accentColor: null,
};

describe('AppShell mobile navigation drawer', () => {
  beforeEach(() => {
    mocks.pathname = '/dashboard';
  });

  it('opens visibly, closes with Escape, and restores focus to the menu control', async () => {
    render(<AppShell brand={brand}>Dashboard</AppShell>);
    const trigger = screen.getByRole('button', { name: 'Open menu' });

    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Main navigation' })).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('closes after navigation and removes the drawer from the current viewport', async () => {
    render(<AppShell brand={brand}>Dashboard</AppShell>);

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open inventory' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes when the operator clicks the backdrop', async () => {
    const { container } = render(<AppShell brand={brand}>Dashboard</AppShell>);

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const backdrop = container.ownerDocument.querySelector('[data-slot="sheet-overlay"]');
    expect(backdrop).not.toBeNull();
    fireEvent.mouseDown(backdrop!);
    fireEvent.mouseUp(backdrop!);
    fireEvent.click(backdrop!);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
