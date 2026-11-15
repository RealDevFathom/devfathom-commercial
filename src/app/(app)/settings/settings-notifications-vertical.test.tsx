import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';
import { ALL_VERTICALS } from '@/lib/vertical-catalog';

type Vertical = (typeof ALL_VERTICALS)[number];

// Regression (#980): agency/HR notification categories (Tasks, Meetings, Time off, Invoices,
// Projects, Clients, Resignations, Notes) leaked into pharmacy Settings.
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'authenticated' }),
  signOut: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      team: {
        getNotificationPrefs: {
          cancel: vi.fn(),
          getData: vi.fn(),
          setData: vi.fn(),
          invalidate: vi.fn(),
        },
      },
    }),
    team: {
      getNotificationPrefs: { useQuery: () => ({ data: {}, isLoading: false }) },
      updateNotificationPrefs: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));

import { EntitlementsProvider } from '@/components/entitlements-provider';
import { WorkspaceNotificationsSection } from './settings-content';

function entitlements(vertical: Vertical): EntitlementView {
  return {
    organizationId: 'org_1',
    vertical,
    seatLimit: 10,
    activeSeats: 1,
    enabledModules: [],
    modules: [],
    limits: {},
  };
}

function renderFor(vertical: Vertical) {
  return render(
    <EntitlementsProvider value={entitlements(vertical)}>
      <WorkspaceNotificationsSection />
    </EntitlementsProvider>
  );
}

afterEach(cleanup);

const AGENCY_CATEGORIES = [
  'Tasks',
  'Meetings',
  'Time off',
  'Invoices',
  'Projects',
  'Clients',
  'Resignations',
  'Notes',
];

describe('Settings notification preferences vertical gate', () => {
  it('hides the agency and HR notification categories for pharmacy members', () => {
    renderFor('PHARMACY');
    expect(screen.queryByText('Notifications')).not.toBeInTheDocument();
    for (const label of AGENCY_CATEGORIES) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it.each(ALL_VERTICALS.filter((vertical) => vertical !== 'PHARMACY'))(
    'keeps the notification preferences for the %s vertical',
    (vertical) => {
      renderFor(vertical);
      expect(screen.getByText('Notifications')).toBeInTheDocument();
      for (const label of AGENCY_CATEGORIES) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
    }
  );
});

describe('Settings notification switches accessible names (#1233)', () => {
  it('names every switch with its category and channel', () => {
    renderFor('AGENCY');
    const switches = screen.getAllByRole('switch');
    expect(switches.length).toBeGreaterThan(0);
    for (const control of switches) {
      expect(control).toHaveAccessibleName(/ (in-app|email) notifications$/);
    }
    for (const label of AGENCY_CATEGORIES) {
      expect(
        screen.getByRole('switch', { name: `${label} in-app notifications` })
      ).toBeInTheDocument();
      expect(
        screen.getByRole('switch', { name: `${label} email notifications` })
      ).toBeInTheDocument();
    }
  });
});
