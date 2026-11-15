import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ComponentProps, type ComponentType } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compile } from 'tailwindcss';

const mocks = vi.hoisted(() => ({ pathname: vi.fn(() => '/dashboard') }));

vi.mock('@/components/theme-provider', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('next/navigation', () => ({ usePathname: mocks.pathname }));
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
  beforeEach(() => {
    mocks.pathname.mockReturnValue('/dashboard');
  });

  it('keeps the responsive dashboard brand link explicitly named', () => {
    const topbar = readFileSync(
      path.join(process.cwd(), 'src/components/layout/topbar.tsx'),
      'utf8'
    );
    expect(topbar).toContain('href="/dashboard"');
    expect(topbar).toContain('<span className="sr-only">Open dashboard</span>');
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
    const drawer = screen.getByRole('dialog', { name: 'Mobile navigation' });
    expect(drawer).toBeInTheDocument();
    expect(drawer).toHaveClass('start-0');
    expect(drawer).not.toHaveClass('left-0');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Mobile navigation' })).not.toBeInTheDocument();
  });

  it.each(['/dashboard', '/pharmacy/counter'])(
    'makes the skip link the first shell element and targets the main landmark on %s',
    async (pathname) => {
      mocks.pathname.mockReturnValue(pathname);
      const TestAppShell = AppShell as ComponentType<{
        brand: Parameters<typeof AppShell>[0]['brand'];
        children?: React.ReactNode;
      }>;
      const { container } = render(
        createElement(
          TestAppShell,
          {
            brand: {
              organizationId: 'org_test',
              displayName: 'Test workspace',
              logoUrl: null,
              markUrl: null,
              faviconUrl: null,
              primaryColor: null,
              accentColor: null,
            },
          },
          createElement('p', null, 'Workspace content')
        )
      );

      const viewport = container.firstElementChild;
      const skipLink = screen.getByRole('link', { name: 'Skip to content' });
      const main = screen.getByRole('main');
      expect(viewport?.firstElementChild).toBe(skipLink);
      expect(skipLink).toHaveAttribute('href', '#main-content');
      expect(main).toHaveAttribute('id', 'main-content');
      expect(main).toHaveAttribute('tabindex', '-1');

      const stylesheet = document.createElement('style');
      const compiler = await compile('@tailwind utilities;');
      stylesheet.textContent = compiler.build([...skipLink.classList]);
      document.head.append(stylesheet);
      try {
        skipLink.focus();
        expect(skipLink).toHaveFocus();
        expect(getComputedStyle(skipLink).clipPath).toBe('none');
        expect(getComputedStyle(skipLink).position).toBe('fixed');
      } finally {
        stylesheet.remove();
      }
    }
  );

  it('clearly warns when the pharmacy licence is a placeholder', () => {
    const props: ComponentProps<typeof AppShell> = {
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
      children: createElement('p', null, 'Dashboard'),
    };
    render(createElement(AppShell, props));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Licence details are PLACEHOLDER – not a real licence'
    );
  });
});
