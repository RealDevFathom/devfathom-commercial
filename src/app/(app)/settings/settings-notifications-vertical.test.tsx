import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';
import type { OrganizationVertical } from '@/lib/vertical-catalog';

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

function entitlements(vertical: OrganizationVertical): EntitlementView {
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

function renderFor(vertical: OrganizationVertical) {
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

  it.each(['AGENCY', 'RESTAURANT', 'HOSPITALITY'] as const)(
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
