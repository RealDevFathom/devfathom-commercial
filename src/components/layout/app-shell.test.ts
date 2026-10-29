import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ComponentType } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null }) }));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ vertical: 'RESTAURANT', enabledModules: ['restaurant-core'] }),
}));
vi.mock('@/lib/assistant-store', () => ({ useAssistant: () => false }));
vi.mock('@/lib/tenant-brand', () => ({
  tenantBrandTokens: () => ({}),
  isTenantIdentityMismatch: () => false,
}));
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
// WHA-1181: a self-hiding strip with its own tRPC query and its own test file
// (administrator-staff-profile-callout.test.tsx). Stubbed here for the same
// reason the topbar and sidebar are — this file tests the shell.
vi.mock('@/components/restaurant/administrator-staff-profile-callout', () => ({
  AdministratorStaffProfileCallout: () => null,
}));

import { AppShell, isPathModuleEnabled } from './app-shell';

describe('AppShell module guard', () => {
  it('keeps the responsive dashboard brand link explicitly named', () => {
    const topbar = readFileSync(
      path.join(process.cwd(), 'src/components/layout/topbar.tsx'),
      'utf8'
    );
    expect(topbar).toContain('href="/dashboard"');
    expect(topbar).toContain('aria-label="Open dashboard"');
    expect(topbar).toContain('text-text-body xl:inline-flex');
  });

  it('uses restaurant route ownership for direct routes', () => {
    const entitlements = {
      vertical: 'RESTAURANT' as const,
      enabledModules: ['restaurant-core', 'restaurant-inventory'],
    };
    expect(isPathModuleEnabled('/dashboard', entitlements)).toBe(true);
    expect(isPathModuleEnabled('/restaurant/inventory/items', entitlements)).toBe(true);
    expect(isPathModuleEnabled('/restaurant/orders', entitlements)).toBe(false);
    expect(isPathModuleEnabled('/restaurant/insights', entitlements)).toBe(false);
    expect(isPathModuleEnabled('/finance', entitlements)).toBe(false);
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
            organizationId: 'org_test',
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

  it('clearly warns when the pharmacy licence is a placeholder', () => {
    const TestAppShell = AppShell as ComponentType<{
      brand: Parameters<typeof AppShell>[0]['brand'];
      children?: React.ReactNode;
      pharmacyPlaceholder?: boolean;
    }>;
    render(
      createElement(
        TestAppShell,
        {
          brand: {
            organizationId: 'org_test',
            displayName: 'Test pharmacy',
            logoUrl: null,
            markUrl: null,
            faviconUrl: null,
            primaryColor: null,
            accentColor: null,
          },
          pharmacyPlaceholder: true,
        },
        createElement('p', null, 'Dashboard')
      )
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Licence details are PLACEHOLDER – not a real licence'
    );
  });
});
