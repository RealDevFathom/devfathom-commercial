import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = (data: unknown, overrides: Record<string, unknown> = {}) => ({
  data,
  error: null,
  isLoading: false,
  refetch: vi.fn(),
  ...overrides,
});

const state = vi.hoisted(() => ({
  branches: undefined as unknown,
  catalog: undefined as unknown,
  command: undefined as unknown,
  preferences: undefined as unknown,
  enabledModules: [] as string[],
}));

/** Every Pharmacy Reports hook the dashboard mounts, so a test can prove none was. */
const mounted = vi.hoisted(() => {
  const hooks: string[] = [];
  const record = <T,>(hook: string, value: T): T => {
    hooks.push(hook);
    return value;
  };
  return { hooks, record };
});

vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ organizationId: 'org', enabledModules: state.enabledModules }),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ pharmacyReports: { getPreferences: { setData: vi.fn() } } }),
    pharmacyReports: {
      branches: { useQuery: () => mounted.record('branches', state.branches) },
      catalog: { useQuery: () => mounted.record('catalog', state.catalog) },
      getPreferences: { useQuery: () => mounted.record('getPreferences', state.preferences) },
      updatePreferences: {
        useMutation: () =>
          mounted.record('updatePreferences', {
            mutateAsync: vi.fn(),
            isPending: false,
            error: null,
          }),
      },
      commandCentre: { useQuery: () => mounted.record('commandCentre', state.command) },
    },
  },
}));

import { PharmacyDashboardContent } from './pharmacy-dashboard-content';

const CATALOG_METRICS = [
  {
    key: 'openStockSignals',
    label: 'Open stock signals',
    source: 'ledger',
    permission: 'reports:operational',
    drillThrough: null,
  },
  {
    key: 'recommendedOrders',
    label: 'Recommended orders',
    source: 'ledger',
    permission: 'reports:operational',
    drillThrough: null,
  },
];

/** The pharmacy e2e package: every counter module, but not Pharmacy Reports. */
const WITHOUT_REPORTS = [
  'pharmacy-core',
  'pharmacy-counter',
  'pharmacy-inventory',
  'pharmacy-dispensing',
  'pharmacy-safety',
];
const REPORT_HOOKS = [
  'branches',
  'catalog',
  'getPreferences',
  'updatePreferences',
  'commandCentre',
];

beforeEach(() => {
  state.enabledModules = [...WITHOUT_REPORTS, 'pharmacy-reports'];
  mounted.hooks.length = 0;
  state.branches = query({ branches: [{ id: 'b1', name: 'Main' }] });
  state.catalog = query({
    metrics: CATALOG_METRICS,
    reports: [],
    permissions: { operational: true, financial: false },
  });
  state.preferences = query(undefined);
  state.command = query({
    freshness: { asOf: '2026-09-04T10:00:00Z', source: 'transactional pharmacy ledgers' },
    permissions: { operational: true, financial: false },
    metrics: {},
  });
});

describe('PharmacyDashboardContent states', () => {
  it('fails financial widgets closed while keeping operational widgets usable', () => {
    render(<PharmacyDashboardContent role="ADMIN" />);
    expect(screen.getAllByText('Restricted').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/reports:financial is required/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Stock actions' })).toBeVisible();
    expect(screen.queryByText('PKR 0')).not.toBeInTheDocument();
  });

  it('shows loading, not a financial restriction, while the command query is still pending', () => {
    // The command query is disabled until branches load: no data, no error. That
    // is loading, not a denial — the owner must never be told they lack
    // reports:financial before the query has even run.
    state.command = query(undefined, { isLoading: false });
    render(<PharmacyDashboardContent role="ADMIN" />);
    expect(screen.queryByText('Restricted')).not.toBeInTheDocument();
    expect(screen.queryByText(/reports:financial is required/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole('status', { name: /^Loading /i }).length).toBeGreaterThan(0);
  });

  it('shows a loading command centre while branches are still loading', () => {
    state.branches = query(undefined, { isLoading: true });
    render(<PharmacyDashboardContent role="ADMIN" />);
    expect(screen.getByLabelText('Loading command centre')).toBeInTheDocument();
    // The branch-comparison count must not claim zero branches before they load.
    expect(screen.queryByText('Restricted')).not.toBeInTheDocument();
  });

  it('renders catalog metric labels rather than the raw metric keys', () => {
    render(<PharmacyDashboardContent role="ADMIN" />);
    expect(screen.getByText('Open stock signals')).toBeInTheDocument();
    expect(screen.getByText('Recommended orders')).toBeInTheDocument();
    expect(screen.queryByText('openStockSignals')).not.toBeInTheDocument();
  });

  it('waits for the catalog before printing a metric key, showing loading meanwhile', () => {
    state.catalog = query(undefined, { isLoading: true });
    render(<PharmacyDashboardContent role="ADMIN" />);
    // No raw metric key leaks while the labels are still in flight.
    expect(screen.queryByText('openStockSignals')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Stock actions' })).toBeVisible();
    expect(screen.getAllByRole('status', { name: /^Loading /i }).length).toBeGreaterThan(0);
  });

  it('shows a refused branch read as restricted, with no Retry (DEV-95)', () => {
    state.branches = query(undefined, { error: { data: { code: 'FORBIDDEN' } } });
    // The command query stays disabled until branches load.
    state.command = query(undefined);
    render(<PharmacyDashboardContent role="EMPLOYEE" />);
    expect(screen.queryByText('Branches could not be loaded.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.getByText('Branch reports are outside your access.')).toBeInTheDocument();
    expect(screen.getByText('Restricted')).toBeInTheDocument();
  });

  it('still offers Retry when the branch read fails for another reason', () => {
    state.branches = query(undefined, { error: { data: { code: 'INTERNAL_SERVER_ERROR' } } });
    // The command query stays disabled until branches load.
    state.command = query(undefined);
    render(<PharmacyDashboardContent role="ADMIN" />);
    expect(screen.getByText('Branches could not be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('reads the command centre when Pharmacy Reports is licensed', () => {
    render(<PharmacyDashboardContent role="ADMIN" />);
    expect(mounted.hooks).toEqual(expect.arrayContaining(REPORT_HOOKS));
    expect(screen.getByRole('button', { name: 'Edit dashboard' })).toBeVisible();
    expect(screen.queryByText('Reports are not part of your package')).not.toBeInTheDocument();
  });

  it('asks Pharmacy Reports nothing without the module and says it is not in the package', () => {
    state.enabledModules = WITHOUT_REPORTS;
    render(<PharmacyDashboardContent role="ADMIN" />);
    // No report hook is even mounted, so nothing can be requested and refused with a 403.
    expect(mounted.hooks).toEqual([]);
    expect(screen.getByRole('heading', { level: 1, name: 'Owner command centre' })).toBeVisible();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Reports are not part of your package' })
    ).toBeVisible();
    expect(screen.getByText('Not in package')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(
      'The command centre is built from Pharmacy Reports, which your organization’s package does not include.'
    );
    expect(screen.getByRole('link', { name: 'Review license and modules' })).toHaveAttribute(
      'href',
      '/organization'
    );
    expect(screen.queryByRole('button', { name: 'Edit dashboard' })).not.toBeInTheDocument();
    expect(screen.queryByText('Restricted')).not.toBeInTheDocument();
  });

  it('points a member to an administrator rather than to organization settings', () => {
    state.enabledModules = WITHOUT_REPORTS;
    render(<PharmacyDashboardContent role="EMPLOYEE" />);
    expect(mounted.hooks).toEqual([]);
    expect(
      screen.getByText('An organization administrator can add Pharmacy Reports to the package.')
    ).toBeVisible();
    expect(
      screen.queryByRole('link', { name: 'Review license and modules' })
    ).not.toBeInTheDocument();
  });
  it('gives a cashier a pharmacy home with no owner title, editor or report read (DEV-602)', () => {
    render(<PharmacyDashboardContent role="EMPLOYEE" reportAccess={false} />);
    expect(mounted.hooks).toEqual([]);
    expect(screen.queryByText('Owner command centre')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Pharmacy home' })).toBeVisible();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Owner reports are outside your access' })
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit dashboard' })).not.toBeInTheDocument();
    expect(screen.queryByText('Branches could not be loaded.')).not.toBeInTheDocument();
  });

  it('keeps the command centre and its editor for a member with report access', () => {
    render(<PharmacyDashboardContent role="ADMIN" reportAccess />);
    expect(mounted.hooks).toEqual(expect.arrayContaining(REPORT_HOOKS));
    expect(screen.getByRole('heading', { level: 1, name: 'Owner command centre' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Edit dashboard' })).toBeVisible();
  });

  it('offers no layout editor once the report reads are refused (DEV-602)', () => {
    state.branches = query(undefined, { error: { data: { code: 'FORBIDDEN' } } });
    state.preferences = query(undefined, { error: { data: { code: 'FORBIDDEN' } } });
    state.command = query(undefined);
    render(<PharmacyDashboardContent role="EMPLOYEE" />);
    expect(screen.queryByRole('button', { name: 'Edit dashboard' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save dashboard' })).not.toBeInTheDocument();
  });
});
