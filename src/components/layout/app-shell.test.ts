import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null }) }));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ vertical: 'RESTAURANT', enabledModules: ['restaurant-core'] }),
}));
vi.mock('@/lib/assistant-store', () => ({ useAssistant: () => false }));
vi.mock('@/lib/tenant-brand', () => ({ tenantBrandTokens: () => ({}) }));
vi.mock('@/components/motion/page-transition', () => ({
  PageTransition: ({ children }: { children: unknown }) => children,
}));
vi.mock('./topbar', () => ({
  Topbar: ({ onMenuClick }: { onMenuClick: () => void }) =>
    createElement('button', { type: 'button', onClick: onMenuClick }, 'Open menu'),
}));
vi.mock('./sidebar', () => ({
  Sidebar: () => createElement('nav', null, 'Restaurant drawer'),
  TopNavigation: () => createElement('nav', null, 'Desktop navigation'),
}));

import { AppShell, isPathModuleEnabled } from './app-shell';

describe('AppShell module guard', () => {
  it('uses restaurant route ownership for direct routes', () => {
    const entitlements = {
      vertical: 'RESTAURANT' as const,
      enabledModules: ['restaurant-core', 'restaurant-inventory'],
    };
    expect(isPathModuleEnabled('/dashboard', entitlements)).toBe(true);
    expect(isPathModuleEnabled('/restaurant/inventory/items', entitlements)).toBe(true);
    expect(isPathModuleEnabled('/restaurant/orders', entitlements)).toBe(false);
  });

  it('closes the mobile navigation dialog with Escape', () => {
    const TestAppShell = AppShell as ComponentType<{
      brand: Parameters<typeof AppShell>[0]['brand'];
      children?: React.ReactNode;
    }>;
    render(
      createElement(
        TestAppShell,
        {
          brand: {
            displayName: 'Test restaurant',
            logoUrl: null,
            markUrl: null,
            faviconUrl: null,
            primaryColor: null,
            accentColor: null,
          },
        },
        createElement('p', null, 'Dashboard')
      )
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(screen.getByRole('dialog', { name: 'Mobile navigation' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Mobile navigation' })).not.toBeInTheDocument();
  });
});
