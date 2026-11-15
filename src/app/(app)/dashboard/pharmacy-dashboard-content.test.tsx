import { render, screen, within } from '@testing-library/react';
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
    expect(screen.getAllByText(/Financial reports access is required/i).length).toBeGreaterThan(0);
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
    expect(screen.queryByText(/Financial reports access is required/i)).not.toBeInTheDocument();
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
    // Plain language, never the raw permission key.
    expect(screen.getByRole('status')).toHaveTextContent(
      'Operational reports access is required for the command centre.'
    );
    expect(screen.queryByText(/reports:operational/)).not.toBeInTheDocument();
    // DEV-594's advice card lives only inside the owner command centre.
    expect(screen.queryByRole('heading', { name: 'AI advice' })).not.toBeInTheDocument();
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

  it('labels cards and sources in plain language, never as tables or permission keys (DEV-594)', () => {
    state.catalog = query({
      metrics: [
        {
          ...CATALOG_METRICS[0],
          source: 'pharmacy_stock_signals',
        },
        {
          ...CATALOG_METRICS[1],
          source: 'pharmacy_stock_signals + pharmacy_stock_signal_actions',
        },
      ],
      reports: [],
      permissions: { operational: true, financial: false, owner: true },
    });
    state.command = query({
      freshness: { asOf: '2026-09-04T10:00:00Z', source: 'transactional pharmacy ledgers' },
      permissions: { operational: true, financial: false },
      metrics: { openStockSignals: 3, recommendedOrders: 1 },
    });
    const { container } = render(<PharmacyDashboardContent role="ADMIN" />);
    expect(screen.getByText('Based on stock alerts and linked requisitions')).toBeVisible();
    expect(screen.getAllByText('Operational reports').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Financial reports').length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/pharmacy_[a-z_]+/);
    expect(container.textContent).not.toMatch(/reports:(operational|financial)/);
  });

  it('says operational report access is required in words when branches are refused', () => {
    state.branches = query(undefined, { error: { data: { code: 'FORBIDDEN' } } });
    state.command = query(undefined);
    const { container } = render(<PharmacyDashboardContent role="EMPLOYEE" />);
    expect(screen.getByText(/Operational reports access is required/)).toBeVisible();
    expect(container.textContent).not.toMatch(/reports:operational/);
  });

  it('gives the owner one entry point to reorder, expiry and growth advice (DEV-594)', () => {
    state.enabledModules = [...WITHOUT_REPORTS, 'pharmacy-reports', 'pharmacy-crm'];
    state.catalog = query({
      metrics: CATALOG_METRICS,
      reports: [],
      permissions: { operational: true, financial: true, owner: true },
    });
    render(<PharmacyDashboardContent role="ADMIN" />);
    expect(screen.getByRole('heading', { level: 2, name: 'AI advice' })).toBeVisible();
    expect(screen.getByRole('link', { name: /Reorder advice/ })).toHaveAttribute(
      'href',
      '/pharmacy/reports/replenishment'
    );
    expect(screen.getByRole('link', { name: /Expiry advice/ })).toHaveAttribute(
      'href',
      '/pharmacy/reports#expiry-advisor'
    );
    expect(screen.getByRole('link', { name: /Growth/ })).toHaveAttribute(
      'href',
      '/pharmacy/marketing'
    );
  });

  it('offers a member only the advice their access admits (DEV-594)', () => {
    state.enabledModules = [...WITHOUT_REPORTS, 'pharmacy-reports', 'pharmacy-crm'];
    state.catalog = query({
      metrics: CATALOG_METRICS,
      reports: [],
      permissions: { operational: true, financial: false, owner: false },
    });
    render(<PharmacyDashboardContent role="EMPLOYEE" />);
    expect(screen.getByRole('link', { name: /Reorder advice/ })).toBeVisible();
    expect(screen.queryByRole('link', { name: /Expiry advice/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Growth/ })).not.toBeInTheDocument();
  });

  it('offers no advice links when report branches are refused', () => {
    state.branches = query(undefined, { error: { data: { code: 'FORBIDDEN' } } });
    state.command = query(undefined);
    render(<PharmacyDashboardContent role="EMPLOYEE" />);
    expect(screen.queryByRole('heading', { name: 'AI advice' })).not.toBeInTheDocument();
  });

  // DEV-729: a stock figure nobody has worked out must never read as "all fine".
  const stockWidget = (container: HTMLElement) =>
    within(container.querySelector<HTMLElement>('[data-widget="stock"]')!);
  const withStockMetrics = (metrics: Record<string, number | null>) => {
    state.command = query({
      freshness: { asOf: '2026-09-04T10:00:00Z', source: 'transactional pharmacy ledgers' },
      permissions: { operational: true, financial: false },
      metrics,
    });
  };

  it('says stock signals are not calculated yet instead of showing 0 (DEV-729)', () => {
    withStockMetrics({ openStockSignals: null, recommendedOrders: null });
    const { container } = render(<PharmacyDashboardContent role="ADMIN" />);
    const stock = stockWidget(container);
    expect(stock.getAllByText('Not calculated yet')).toHaveLength(2);
    expect(stock.queryByText('0')).not.toBeInTheDocument();
    expect(stock.queryByText('—')).not.toBeInTheDocument();
    expect(stock.getAllByText(/Refresh them in Inventory/)).toHaveLength(2);
  });

  it('shows a calculated zero as a zero (DEV-729)', () => {
    withStockMetrics({ openStockSignals: 0, recommendedOrders: 0 });
    const { container } = render(<PharmacyDashboardContent role="ADMIN" />);
    const stock = stockWidget(container);
    expect(stock.getAllByText('0')).toHaveLength(2);
    expect(stock.queryByText('Not calculated yet')).not.toBeInTheDocument();
  });

  it('offers one Draft POs per distributor entry to the reorder board (DEV-729)', () => {
    state.enabledModules = [...WITHOUT_REPORTS, 'pharmacy-reports', 'pharmacy-procurement'];
    const { container } = render(<PharmacyDashboardContent role="ADMIN" />);
    const links = screen.getAllByRole('link', { name: 'Draft POs per distributor' });
    expect(links).toHaveLength(1);
    expect(
      stockWidget(container).getByRole('link', { name: 'Draft POs per distributor' })
    ).toHaveAttribute('href', '/pharmacy/purchasing/reorder');
  });

  it('offers no Draft POs entry without the procurement module (DEV-729)', () => {
    render(<PharmacyDashboardContent role="ADMIN" />);
    expect(
      screen.queryByRole('link', { name: 'Draft POs per distributor' })
    ).not.toBeInTheDocument();
  });
});
