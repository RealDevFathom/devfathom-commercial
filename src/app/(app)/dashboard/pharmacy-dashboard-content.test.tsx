import { fireEvent, render, screen } from '@testing-library/react';
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
import type { PharmacyDashboardAccess } from '@/lib/pharmacy/dashboard';

/** A report viewer (owner or auditor): the command centre, with nothing extra offered. */
const REPORTS: PharmacyDashboardAccess = { reports: true, tools: [], advice: [] };
/** The Cashier role template: counter and customer orders, no reports. */
const CASHIER: PharmacyDashboardAccess = {
  reports: false,
  tools: [
    {
      key: 'counter',
      href: '/pharmacy/counter',
      label: 'Counter',
      detail: 'Serve customers, take payment and print receipts.',
    },
    {
      key: 'orders',
      href: '/pharmacy/orders',
      label: 'Customer orders',
      detail: 'Accept and prepare orders customers placed ahead.',
    },
  ],
  advice: [],
};

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
    render(<PharmacyDashboardContent role="ADMIN" access={REPORTS} />);
    expect(screen.getAllByText('Restricted').length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(/Only people with financial report access see these figures/).length
    ).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Stock actions' })).toBeVisible();
    expect(screen.queryByText('PKR 0')).not.toBeInTheDocument();
  });

  it('shows loading, not a financial restriction, while the command query is still pending', () => {
    // The command query is disabled until branches load: no data, no error. That
    // is loading, not a denial — the owner must never be told they lack
    // reports:financial before the query has even run.
    state.command = query(undefined, { isLoading: false });
    render(<PharmacyDashboardContent role="ADMIN" access={REPORTS} />);
    expect(screen.queryByText('Restricted')).not.toBeInTheDocument();
    expect(screen.queryByText(/financial report access/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole('status', { name: /^Loading /i }).length).toBeGreaterThan(0);
  });

  it('shows a loading command centre while branches are still loading', () => {
    state.branches = query(undefined, { isLoading: true });
    render(<PharmacyDashboardContent role="ADMIN" access={REPORTS} />);
    expect(screen.getByLabelText('Loading command centre')).toBeInTheDocument();
    // The branch-comparison count must not claim zero branches before they load.
    expect(screen.queryByText('Restricted')).not.toBeInTheDocument();
  });

  it('renders catalog metric labels rather than the raw metric keys', () => {
    render(<PharmacyDashboardContent role="ADMIN" access={REPORTS} />);
    expect(screen.getByText('Open stock signals')).toBeInTheDocument();
    expect(screen.getByText('Recommended orders')).toBeInTheDocument();
    expect(screen.queryByText('openStockSignals')).not.toBeInTheDocument();
  });

  it('waits for the catalog before printing a metric key, showing loading meanwhile', () => {
    state.catalog = query(undefined, { isLoading: true });
    render(<PharmacyDashboardContent role="ADMIN" access={REPORTS} />);
    // No raw metric key leaks while the labels are still in flight.
    expect(screen.queryByText('openStockSignals')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Stock actions' })).toBeVisible();
    expect(screen.getAllByRole('status', { name: /^Loading /i }).length).toBeGreaterThan(0);
  });

  it('reads the command centre when Pharmacy Reports is licensed', () => {
    render(<PharmacyDashboardContent role="ADMIN" access={REPORTS} />);
    expect(mounted.hooks).toEqual(expect.arrayContaining(REPORT_HOOKS));
    expect(screen.getByRole('button', { name: 'Edit dashboard' })).toBeVisible();
    expect(screen.queryByText('Reports are not part of your package')).not.toBeInTheDocument();
  });

  it('asks Pharmacy Reports nothing without the module and says it is not in the package', () => {
    state.enabledModules = WITHOUT_REPORTS;
    render(<PharmacyDashboardContent role="ADMIN" access={REPORTS} />);
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
    render(<PharmacyDashboardContent role="EMPLOYEE" access={REPORTS} />);
    expect(mounted.hooks).toEqual([]);
    expect(
      screen.getByText('An organization administrator can add Pharmacy Reports to the package.')
    ).toBeVisible();
    expect(
      screen.queryByRole('link', { name: 'Review license and modules' })
    ).not.toBeInTheDocument();
  });
});

describe('PharmacyDashboardContent follows the viewer, not the owner (DEV-602)', () => {
  it('gives a cashier their own tools: no owner title, no edit mode, no report reads', () => {
    render(<PharmacyDashboardContent role="EMPLOYEE" access={CASHIER} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Today’s work' })).toBeVisible();
    expect(screen.queryByText('Owner command centre')).not.toBeInTheDocument();
    expect(screen.queryByText('Operations command centre')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit dashboard' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save dashboard' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restore role default' })).not.toBeInTheDocument();
    // Nothing is asked of Pharmacy Reports, so nothing is refused or reported as a load failure.
    expect(mounted.hooks).toEqual([]);
    expect(screen.queryByText(/could not be loaded/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Today's trade")).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Counter/ })).toHaveAttribute(
      'href',
      '/pharmacy/counter'
    );
    expect(screen.getByRole('link', { name: /^Customer orders/ })).toHaveAttribute(
      'href',
      '/pharmacy/orders'
    );
  });

  it('keeps a cashier off the reports frame even without the Reports module', () => {
    state.enabledModules = WITHOUT_REPORTS;
    render(<PharmacyDashboardContent role="EMPLOYEE" access={CASHIER} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Today’s work' })).toBeVisible();
    expect(screen.queryByText('Reports are not part of your package')).not.toBeInTheDocument();
    expect(mounted.hooks).toEqual([]);
  });

  it('says what to do when the role opens no pharmacy tool', () => {
    render(<PharmacyDashboardContent role="EMPLOYEE" access={{ ...CASHIER, tools: [] }} />);
    expect(
      screen.getByRole('heading', { level: 2, name: 'No pharmacy tools assigned' })
    ).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(/Ask your workspace administrator/);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('keeps the owner title and edit mode for the owner', () => {
    render(<PharmacyDashboardContent role="ADMIN" access={REPORTS} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Owner command centre' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Edit dashboard' }));
    expect(screen.getByRole('button', { name: 'Save dashboard' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Restore role default' })).toBeVisible();
  });

  it('titles a non-owner report viewer’s command centre as operations, not the owner’s', () => {
    render(<PharmacyDashboardContent role="EMPLOYEE" access={REPORTS} />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Operations command centre' })
    ).toBeVisible();
    expect(screen.queryByText('Owner command centre')).not.toBeInTheDocument();
    // Their own layout only: updatePreferences writes the caller's row and nobody else's.
    expect(screen.getByRole('button', { name: 'Edit dashboard' })).toBeVisible();
  });

  it('shows a refused branch read as restricted, not as a failed load with a retry', () => {
    state.branches = query(undefined, { error: { data: { code: 'FORBIDDEN' } } });
    // The command query stays disabled while there are no branches.
    state.command = query(undefined);
    render(<PharmacyDashboardContent role="ADMIN" access={REPORTS} />);
    expect(
      screen.getByRole('heading', { level: 2, name: 'Shop reports are not open to you' })
    ).toBeVisible();
    expect(screen.getByText('Restricted')).toBeVisible();
    expect(screen.queryByText(/could not be loaded/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit dashboard' })).not.toBeInTheDocument();
  });

  it('still offers a retry when the branch read genuinely fails', () => {
    state.branches = query(undefined, { error: { data: { code: 'INTERNAL_SERVER_ERROR' } } });
    // The command query stays disabled while there are no branches.
    state.command = query(undefined);
    render(<PharmacyDashboardContent role="ADMIN" access={REPORTS} />);
    expect(screen.getByText('Branches could not be loaded.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
  });
});

describe('PharmacyDashboardContent speaks plainly to the owner (DEV-594)', () => {
  const ADVICE = [
    {
      key: 'reorder',
      href: '/pharmacy/reports/replenishment',
      label: 'Reorder advice',
      detail: 'How much of each medicine to reorder.',
    },
    {
      key: 'expiry',
      href: '/pharmacy/reports',
      label: 'Expiry advice',
      detail: 'Stock likely to expire before it sells.',
    },
    {
      key: 'growth',
      href: '/pharmacy/marketing',
      label: 'Growth insights',
      detail: 'Suggestions for growing sales.',
    },
  ];

  it('shows plain source and access labels, never table names or permission keys', () => {
    // The real contract values for these two metrics, as the catalog delivers them.
    state.catalog = query({
      metrics: [
        { ...CATALOG_METRICS[0], source: 'pharmacy_stock_signals' },
        {
          ...CATALOG_METRICS[1],
          source: 'pharmacy_stock_signals + pharmacy_stock_signal_actions',
        },
      ],
      reports: [],
      permissions: { operational: true, financial: false },
    });
    state.command = query({
      freshness: { asOf: '2026-09-04T10:00:00Z', source: 'transactional pharmacy ledgers' },
      permissions: { operational: true, financial: false },
      metrics: { openStockSignals: 3, recommendedOrders: 1 },
    });
    const { container } = render(<PharmacyDashboardContent role="ADMIN" access={REPORTS} />);

    expect(screen.getByText('Based on stock alerts')).toBeVisible();
    expect(screen.getByText('Based on stock alerts and reorder drafts')).toBeVisible();
    expect(screen.getAllByText('Operations report').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Financial report').length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/pharmacy_[a-z_]+/);
    expect(container.textContent).not.toMatch(/reports:(operational|financial)/);
  });

  it('offers the owner the advice pages where the day starts', () => {
    render(<PharmacyDashboardContent role="ADMIN" access={{ ...REPORTS, advice: ADVICE }} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Advice for your shop' })).toBeVisible();
    expect(screen.getByRole('link', { name: /^Reorder advice/ })).toHaveAttribute(
      'href',
      '/pharmacy/reports/replenishment'
    );
    expect(screen.getByRole('link', { name: /^Expiry advice/ })).toHaveAttribute(
      'href',
      '/pharmacy/reports'
    );
    expect(screen.getByRole('link', { name: /^Growth insights/ })).toHaveAttribute(
      'href',
      '/pharmacy/marketing'
    );
  });

  it('offers only the advice the server resolved for this viewer', () => {
    render(
      <PharmacyDashboardContent role="EMPLOYEE" access={{ ...REPORTS, advice: [ADVICE[0]!] }} />
    );
    expect(screen.getByRole('link', { name: /^Reorder advice/ })).toBeVisible();
    expect(screen.queryByRole('link', { name: /^Expiry advice/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^Growth insights/ })).not.toBeInTheDocument();
  });

  it('shows no advice card when nothing is permitted', () => {
    render(<PharmacyDashboardContent role="ADMIN" access={REPORTS} />);
    expect(screen.queryByText('Advice for your shop')).not.toBeInTheDocument();
  });
});
