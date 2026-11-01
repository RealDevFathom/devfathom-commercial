import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';
import type { OrganizationVertical } from '@/lib/vertical-catalog';

// QA batch 4/5: a pharmacy's Settings showed HR/agency content — raw ADMIN / COUNTER
// account facts, a "Leave the company" card, agency notification categories, a
// "Side rail" layout switch while a top bar is shown, and "Unknown IP" on sign-ins.

const mocks = vi.hoisted(() => ({
  session: {
    user: {
      id: 'u1',
      email: 'owner@pharmacy.pk',
      role: 'ADMIN',
      department: 'COUNTER',
      title: 'Owner (QA test login)',
    },
  } as { user: Record<string, string> },
  profile: { data: undefined as unknown, isLoading: false },
  prefs: { data: null as unknown, isLoading: false },
  updatePrefs: vi.fn(),
  resignationsQuery: vi.fn(() => ({ data: [] })),
  signIns: { data: [] as unknown[], isLoading: false },
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: mocks.session, status: 'authenticated' }),
  signOut: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/theme-provider', () => ({
  useTheme: () => ({ theme: 'light', setTheme: vi.fn() }),
}));
vi.mock('@/components/ui/switch', () => ({
  Switch: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean;
    onCheckedChange?: (value: boolean) => void;
  }) => (
    <button role="switch" aria-checked={checked} onClick={() => onCheckedChange?.(!checked)} />
  ),
}));
vi.mock('@/lib/trpc', () => {
  const query = { cancel: vi.fn(), getData: vi.fn(), setData: vi.fn(), invalidate: vi.fn() };
  return {
    trpc: {
      useUtils: () => ({
        team: { getNotificationPrefs: query, getById: query },
        resignations: { mine: query },
      }),
      team: {
        getById: { useQuery: () => mocks.profile },
        getNotificationPrefs: { useQuery: () => mocks.prefs },
        updateNotificationPrefs: { useMutation: () => ({ mutate: mocks.updatePrefs }) },
        mySignIns: { useQuery: () => mocks.signIns },
      },
      dashboard: { updateAppearance: { useMutation: () => ({ mutate: vi.fn() }) } },
      resignations: {
        mine: { useQuery: mocks.resignationsQuery },
        withdraw: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
        submit: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      },
    },
  };
});

import { EntitlementsProvider } from '@/components/entitlements-provider';
import { PreferencesProvider } from '@/components/preferences-provider';
import {
  AccountSection,
  AppearanceSection,
  GatedResignationSection,
  NotificationsSection,
  RecentSignInsSection,
} from './settings-content';

function entitlements(vertical: OrganizationVertical, enabledModules: string[]): EntitlementView {
  return {
    organizationId: 'org_1',
    vertical,
    seatLimit: 10,
    activeSeats: 1,
    enabledModules,
    modules: [],
    limits: {},
  };
}

function renderFor(
  node: React.ReactNode,
  vertical: OrganizationVertical = 'PHARMACY',
  enabledModules: string[] = ['pharmacy-core']
) {
  return render(
    <EntitlementsProvider value={entitlements(vertical, enabledModules)}>
      {node}
    </EntitlementsProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session = {
    user: {
      id: 'u1',
      email: 'owner@pharmacy.pk',
      role: 'ADMIN',
      department: 'COUNTER',
      title: 'Owner (QA test login)',
    },
  };
  mocks.profile = { data: undefined, isLoading: false };
  mocks.prefs = { data: null, isLoading: false };
  mocks.signIns = { data: [], isLoading: false };
});
afterEach(cleanup);

describe('Settings account card', () => {
  it('shows the pharmacy owner as Owner, not ADMIN / COUNTER', () => {
    renderFor(<AccountSection />);
    expect(screen.getByText('Owner')).toBeInTheDocument();
    expect(screen.queryByText('ADMIN')).not.toBeInTheDocument();
    expect(screen.queryByText('COUNTER')).not.toBeInTheDocument();
    expect(screen.queryByText('Department')).not.toBeInTheDocument();
  });

  it('shows a pharmacy member their assigned role and a readable department', () => {
    mocks.session.user.role = 'EMPLOYEE';
    mocks.profile = {
      data: { organizationRole: { key: 'procurement-approver', name: 'Procurement approver' } },
      isLoading: false,
    };
    renderFor(<AccountSection />);
    expect(screen.getByText('Procurement approver')).toBeInTheDocument();
    expect(screen.getByText('Counter')).toBeInTheDocument();
    expect(screen.queryByText('EMPLOYEE')).not.toBeInTheDocument();
  });

  it('falls back to the pharmacy base-role label when no role is assigned', () => {
    mocks.session.user.role = 'EMPLOYEE';
    renderFor(<AccountSection />);
    expect(screen.getByText('Staff')).toBeInTheDocument();
  });

  it('keeps agency administrators labelled Admin', () => {
    mocks.session.user.department = 'LEADERSHIP';
    renderFor(<AccountSection />, 'AGENCY', ['hr']);
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('Leadership')).toBeInTheDocument();
  });
});

describe('Settings resignation card', () => {
  it('is hidden in pharmacy, even with the HR module, and never queries resignations', () => {
    renderFor(<GatedResignationSection />, 'PHARMACY', ['pharmacy-core', 'hr']);
    expect(screen.queryByText('Leave the company')).not.toBeInTheDocument();
    expect(mocks.resignationsQuery).not.toHaveBeenCalled();
  });

  it('is hidden when the HR module is not enabled', () => {
    renderFor(<GatedResignationSection />, 'AGENCY', []);
    expect(screen.queryByText('Leave the company')).not.toBeInTheDocument();
    expect(mocks.resignationsQuery).not.toHaveBeenCalled();
  });

  it('renders with formal copy where HR self-service exists', () => {
    renderFor(<GatedResignationSection />, 'AGENCY', ['hr']);
    expect(screen.getByText('Leave the company')).toBeInTheDocument();
    expect(
      screen.getByText('To end your employment, submit a formal resignation for HR review.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/Considering moving on/)).not.toBeInTheDocument();
  });
});

describe('Settings notification categories', () => {
  it('lists stock, expiry, approvals and refunds for a pharmacy', () => {
    renderFor(<NotificationsSection />);
    for (const label of ['Stock', 'Expiry', 'Approvals', 'Refunds']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    for (const label of ['Projects', 'Clients', 'Resignations', 'Time off', 'Meetings']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
  });

  it('persists a pharmacy toggle without dropping other stored categories', () => {
    mocks.prefs = { data: { task: { inApp: false } }, isLoading: false };
    renderFor(<NotificationsSection />);
    // First switch is Stock in-app.
    fireEvent.click(screen.getAllByRole('switch')[0]!);
    expect(mocks.updatePrefs).toHaveBeenCalledWith({
      task: { inApp: false },
      stock: { inApp: false, email: true },
      expiry: { inApp: true, email: true },
      approval: { inApp: true, email: true },
      refund: { inApp: true, email: true },
    });
  });

  it('keeps the workspace categories for an agency', () => {
    renderFor(<NotificationsSection />, 'AGENCY', ['hr']);
    expect(screen.getByText('Projects')).toBeInTheDocument();
    expect(screen.queryByText('Stock')).not.toBeInTheDocument();
  });
});

describe('Settings appearance', () => {
  it('does not offer a side-rail layout the shell never shows', () => {
    renderFor(
      <PreferencesProvider>
        <AppearanceSection />
      </PreferencesProvider>
    );
    expect(screen.queryByText('Navigation layout')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Side rail' })).not.toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Nav icons' })).toBeInTheDocument();
  });
});

describe('Settings recent sign-ins', () => {
  it('omits the address line instead of printing Unknown IP', () => {
    mocks.signIns = {
      data: [
        { id: 'a', createdAt: new Date(), ip: null, userAgent: 'Chrome/1 Linux' },
        { id: 'b', createdAt: new Date(), ip: '203.0.113.7', userAgent: null },
      ],
      isLoading: false,
    };
    renderFor(<RecentSignInsSection />);
    expect(screen.queryByText('Unknown IP')).not.toBeInTheDocument();
    expect(screen.getByText('203.0.113.7')).toBeInTheDocument();
  });
});
