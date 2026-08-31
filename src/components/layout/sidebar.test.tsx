import { cleanup, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EntitlementsProvider } from '@/components/entitlements-provider';
import type { EntitlementView } from '@/lib/module-catalog';
import { TopNavigation } from './sidebar';

const useSessionMock = vi.hoisted(() => vi.fn(() => ({ data: { user: { role: 'ADMIN' } } })));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.ComponentProps<'a'>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));
vi.mock('next-auth/react', () => ({
  useSession: useSessionMock,
}));
vi.mock('motion/react', () => ({
  m: {
    span: ({ children, ...props }: React.ComponentProps<'span'>) => (
      <span {...props}>{children}</span>
    ),
  },
}));
vi.mock('@/components/preferences-provider', () => ({
  usePreferences: () => ({ icons: 'numbered' }),
}));

const enabledModules = [
  'dashboard',
  'projects',
  'clients',
  'notes',
  'meetings',
  'chat',
  'finance',
  'hr',
  'reviews',
  'audit',
];

function restaurantLinks(role = 'ADMIN') {
  vi.mocked(useSessionMock).mockReturnValue({ data: { user: { role } } });
  render(
    <EntitlementsProvider
      value={{
        organizationId: 'org-1',
        vertical: 'RESTAURANT',
        seatLimit: 10,
        activeSeats: 1,
        enabledModules: ['restaurant-core'],
        modules: [],
        limits: {},
      }}
    >
      <TopNavigation />
    </EntitlementsProvider>
  );
  return screen.getAllByRole('link').map((link) => link.getAttribute('href'));
}

function links(vertical?: EntitlementView['vertical']) {
  render(
    <EntitlementsProvider
      value={{
        organizationId: 'org-1',
        vertical,
        seatLimit: 10,
        activeSeats: 1,
        enabledModules,
        modules: [],
        limits: {},
      }}
    >
      <TopNavigation />
    </EntitlementsProvider>
  );
  return screen.getAllByRole('link').map((link) => link.getAttribute('href'));
}

describe('TopNavigation vertical visibility', () => {
  beforeEach(() => {
    useSessionMock.mockReturnValue({ data: { user: { role: 'ADMIN' } } });
  });

  it('shows Delivery only to Restaurant administrators', () => {
    expect(restaurantLinks()).toContain('/restaurant/delivery');
    cleanup();
    expect(restaurantLinks('MEMBER')).not.toContain('/restaurant/delivery');
  });

  it('uses accessible body text for inactive navigation numbers', () => {
    links('AGENCY');
    expect(screen.getByText('02')).toHaveClass('text-text-body');
    expect(screen.getByText('02')).not.toHaveClass('text-text-faint');
  });

  it('keeps agency and legacy navigation identical', () => {
    const agency = links('AGENCY');
    cleanup();
    expect(links()).toEqual(agency);
    expect(agency).toContain('/projects');
  });

  it('hides agency module navigation for restaurant organizations', () => {
    const restaurant = links('RESTAURANT');
    expect(restaurant).toEqual(['/organization', '/settings']);
  });
});
