import { selectFieldControl } from '@/lib/testing/select-field';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const query = <T,>(data: T) => ({
    data,
    error: null as unknown,
    isLoading: false,
    refetch: vi.fn(),
  });
  const freshness = {
    status: 'CURRENT' as 'CURRENT' | 'STALE',
    sourceDailyCloseId: 'close_1',
    computedAtUtc: '2026-08-20T21:00:00.000Z',
    computedAtLocal: '2026-08-20T21:00:00[Asia/Karachi]',
  };
  const preference = {
    version: 1 as const,
    defaultBranchId: 'branch_1',
    rangeDays: 7 as 7 | 30,
    widgets: [
      { key: 'performance' as const, visible: true, span: 'wide' as const },
      { key: 'trend' as const, visible: true, span: 'wide' as const },
      { key: 'exceptions' as const, visible: true, span: 'compact' as const },
      { key: 'itemMix' as const, visible: true, span: 'compact' as const },
      { key: 'labour' as const, visible: true, span: 'wide' as const },
    ],
  };
  return {
    preferences: query(preference),
    preference,
    branches: query([
      { id: 'branch_1', name: 'Main', active: true, isDefault: true },
      { id: 'branch_2', name: 'Harbour', active: true, isDefault: false },
    ]),
    financial: query([
      {
        id: 'rollup_1',
        branchId: 'branch_1',
        branchName: 'Main',
        businessDate: '2026-08-20',
        orderCount: 4,
        coverCount: 8,
        grossSales: '120.00',
        netSales: '100.00',
        compTotal: '5.00',
        refundTotal: '2.00',
        voidTotal: '3.00',
        drawerVariance: '-1.00',
        loyaltyLiability: '10.00',
        freshness: { ...freshness },
        createdAt: '2026-08-20T21:00:00.000Z',
        updatedAt: '2026-08-20T21:00:00.000Z',
      },
    ]),
    operational: query([
      {
        id: 'rollup_ops_1',
        branchId: 'branch_1',
        branchName: 'Main',
        businessDate: '2026-08-20',
        orderCount: 4,
        coverCount: 8,
        freshness: { ...freshness },
        createdAt: '2026-08-20T21:00:00.000Z',
        updatedAt: '2026-08-20T21:00:00.000Z',
      },
    ]),
    detail: query({
      id: 'rollup_1',
      branchId: 'branch_1',
      branchName: 'Main',
      businessDate: '2026-08-20',
      orderCount: 4,
      coverCount: 8,
      grossSales: '120.00',
      netSales: '100.00',
      compTotal: '5.00',
      refundTotal: '2.00',
      voidTotal: '3.00',
      drawerVariance: '-1.00',
      loyaltyLiability: '10.00',
      freshness: { ...freshness },
      createdAt: '2026-08-20T21:00:00.000Z',
      updatedAt: '2026-08-20T21:00:00.000Z',
      itemMix: [
        {
          productId: 'product_1',
          productName: 'Chicken karahi',
          quantity: 2,
          grossSales: '60.00',
          netSales: '50.00',
          compTotal: '0.00',
        },
      ],
    }),
    labour: query([
      {
        id: 'labour_1',
        branchId: 'branch_1',
        branchName: 'Main',
        businessDate: '2026-08-20',
        labourHours: '12.00',
        labourCost: '720.00',
        source: 'payroll',
        idempotencyKey: 'labour-key',
        importedAtUtc: '2026-08-20T22:00:00.000Z',
        importedAtLocal: '2026-08-20T22:00:00[Asia/Karachi]',
        createdAt: '2026-08-20T22:00:00.000Z',
      },
    ]),
    mutate: vi.fn(async (input) => input),
    setData: vi.fn(),
    calls: [] as Array<{ input: unknown; enabled: boolean }>,
  };
});

vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({
      restaurantDashboard: { getPreferences: { setData: mocks.setData } },
    }),
    restaurantDashboard: {
      getPreferences: { useQuery: () => mocks.preferences },
      updatePreferences: {
        useMutation: () => ({ mutateAsync: mocks.mutate, isPending: false, error: null }),
      },
    },
    restaurantStaff: {
      listBranches: { useQuery: () => mocks.branches },
    },
    restaurantInsights: {
      listFinancialReports: {
        useQuery: (input: unknown, options: { enabled: boolean }) => {
          mocks.calls.push({ input, enabled: options.enabled });
          return mocks.financial;
        },
      },
      listOperationalReports: {
        useQuery: (input: unknown, options: { enabled: boolean }) => {
          mocks.calls.push({ input, enabled: options.enabled });
          return mocks.operational;
        },
      },
      readOperationalReport: { useQuery: () => mocks.detail },
      listLabourCosts: { useQuery: () => mocks.labour },
    },
  },
}));

import { RestaurantManagementOverview, closedDateRange } from './restaurant-management-overview';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.preferences.data = {
    ...mocks.preference,
    widgets: mocks.preference.widgets.map((widget) => ({ ...widget })),
  };
  mocks.preferences.error = null;
  mocks.financial.error = null;
  mocks.financial.isLoading = false;
  mocks.financial.data = [
    {
      id: 'rollup_1',
      branchId: 'branch_1',
      branchName: 'Main',
      businessDate: '2026-08-20',
      orderCount: 4,
      coverCount: 8,
      grossSales: '120.00',
      netSales: '100.00',
      compTotal: '5.00',
      refundTotal: '2.00',
      voidTotal: '3.00',
      drawerVariance: '-1.00',
      loyaltyLiability: '10.00',
      freshness: {
        status: 'CURRENT',
        sourceDailyCloseId: 'close_1',
        computedAtUtc: '2026-08-20T21:00:00.000Z',
        computedAtLocal: '2026-08-20T21:00:00[Asia/Karachi]',
      },
      createdAt: '2026-08-20T21:00:00.000Z',
      updatedAt: '2026-08-20T21:00:00.000Z',
    },
  ];
  mocks.operational.error = null;
  mocks.operational.isLoading = false;
  mocks.operational.data = [
    {
      id: 'rollup_ops_1',
      branchId: 'branch_1',
      branchName: 'Main',
      businessDate: '2026-08-20',
      orderCount: 4,
      coverCount: 8,
      freshness: {
        status: 'CURRENT',
        sourceDailyCloseId: 'close_1',
        computedAtUtc: '2026-08-20T21:00:00.000Z',
        computedAtLocal: '2026-08-20T21:00:00[Asia/Karachi]',
      },
      createdAt: '2026-08-20T21:00:00.000Z',
      updatedAt: '2026-08-20T21:00:00.000Z',
    },
  ];
  mocks.detail.error = null;
  mocks.labour.error = null;
});

describe('RestaurantManagementOverview', () => {
  it('renders closed-day KPIs, trend, latest item mix, labour, and responsive spans', async () => {
    render(<RestaurantManagementOverview insightsEnabled />);

    expect(await screen.findByText('Current rollups')).toBeInTheDocument();
    expect(screen.getByText('100.00')).toBeInTheDocument();
    expect(screen.getByText('25.00')).toBeInTheDocument();
    expect(
      screen.getByRole('list', { name: /daily net sales and orders trend/i })
    ).toHaveTextContent('100.00 · 4 orders');
    expect(screen.getByText('Chicken karahi')).toBeInTheDocument();
    expect(screen.getByText('720.00')).toBeInTheDocument();
    expect(screen.getByTestId('restaurant-dashboard-grid')).toHaveClass(
      'grid-cols-1',
      'lg:grid-cols-2'
    );
    expect(document.querySelector('[data-widget="performance"]')).toHaveClass('lg:col-span-2');
  });

  it('distinguishes absent rollups from a recorded numeric zero', () => {
    mocks.financial.data = [];
    mocks.operational.data = [];
    const { rerender } = render(<RestaurantManagementOverview insightsEnabled />);
    expect(screen.getAllByText('No closed-day rollups').length).toBeGreaterThan(0);
    expect(screen.queryByText('0.00')).not.toBeInTheDocument();

    mocks.financial.data = [
      {
        id: 'zero_rollup',
        branchId: 'branch_1',
        branchName: 'Main',
        businessDate: '2026-08-20',
        orderCount: 0,
        coverCount: 0,
        grossSales: '0.00',
        netSales: '0.00',
        compTotal: '0.00',
        refundTotal: '0.00',
        voidTotal: '0.00',
        drawerVariance: '0.00',
        loyaltyLiability: '0.00',
        freshness: {
          status: 'CURRENT',
          sourceDailyCloseId: 'close_zero',
          computedAtUtc: '2026-08-20T21:00:00.000Z',
          computedAtLocal: '2026-08-20T21:00:00[Asia/Karachi]',
        },
        createdAt: '2026-08-20T21:00:00.000Z',
        updatedAt: '2026-08-20T21:00:00.000Z',
      },
    ];
    mocks.operational.data = [
      {
        id: 'zero_ops_rollup',
        branchId: 'branch_1',
        branchName: 'Main',
        businessDate: '2026-08-20',
        orderCount: 0,
        coverCount: 0,
        freshness: {
          status: 'CURRENT',
          sourceDailyCloseId: 'close_zero',
          computedAtUtc: '2026-08-20T21:00:00.000Z',
          computedAtLocal: '2026-08-20T21:00:00[Asia/Karachi]',
        },
        createdAt: '2026-08-20T21:00:00.000Z',
        updatedAt: '2026-08-20T21:00:00.000Z',
      },
    ];
    rerender(<RestaurantManagementOverview insightsEnabled />);
    expect(screen.queryByText('No closed-day rollups')).not.toBeInTheDocument();
    expect(screen.getAllByText('0.00').length).toBeGreaterThan(0);
  });

  it('surfaces stale freshness and fails financial and labour values closed on denial', () => {
    mocks.financial.data[0]!.freshness.status = 'STALE';
    const view = render(<RestaurantManagementOverview insightsEnabled />);
    expect(screen.getByText('Stale rollups')).toBeInTheDocument();

    mocks.financial.error = { data: { code: 'FORBIDDEN' } };
    mocks.labour.error = { data: { code: 'FORBIDDEN' } };
    view.rerender(<RestaurantManagementOverview insightsEnabled />);
    expect(screen.getAllByText('Restricted').length).toBeGreaterThan(0);
    expect(screen.queryByText('100.00')).not.toBeInTheDocument();
    expect(screen.queryByText('720.00')).not.toBeInTheDocument();
    expect(
      screen.getByRole('list', { name: /daily net sales and orders trend/i })
    ).toHaveTextContent('Restricted · 4 orders');
    expect(screen.getByText('Chicken karahi')).toBeInTheDocument();
    expect(document.querySelector('[data-widget="labour"]')).not.toBeInTheDocument();
  });

  it('renders meaningful accessible unavailable states for all five failed widgets', () => {
    const unavailable = { data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 503 } };
    mocks.financial.error = unavailable;
    mocks.operational.error = unavailable;
    mocks.detail.error = unavailable;
    mocks.labour.error = unavailable;

    render(<RestaurantManagementOverview insightsEnabled />);

    for (const heading of [
      'Performance',
      'Net sales and orders',
      'Exceptions',
      'Item mix',
      'Imported labour',
    ]) {
      expect(screen.getByRole('heading', { name: heading })).toBeVisible();
    }
    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(5);
    for (const alert of alerts) {
      expect(alert).toHaveAccessibleName(/unavailable/i);
      expect(alert).toHaveTextContent(/could not be loaded/i);
      expect(alert).not.toBeEmptyDOMElement();
      expect(alert.querySelector('[data-slot="status-pill"]')).toHaveClass(
        'text-text-body',
        '[&>span]:bg-warning'
      );
      expect(alert.querySelector('p')).toHaveClass('text-text-body');
    }
    const retries = screen.getAllByRole('button', { name: 'Retry' });
    expect(retries).toHaveLength(5);
    retries.forEach((retry) => fireEvent.click(retry));
    expect(mocks.financial.refetch).toHaveBeenCalledTimes(2);
    expect(mocks.operational.refetch).toHaveBeenCalledTimes(2);
    expect(mocks.labour.refetch).toHaveBeenCalledOnce();
  });

  it('supports keyboard-addressable ordering, visibility, spans, restore, and save', async () => {
    const view = render(<RestaurantManagementOverview insightsEnabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit dashboard' }));
    const editor = screen.getByRole('heading', { name: 'Widget layout' }).parentElement
      ?.parentElement;
    expect(editor).toBeTruthy();

    const moveButton = screen.getByRole('button', { name: 'Move Daily trend up' });
    moveButton.focus();
    expect(moveButton).toHaveFocus();
    fireEvent.click(moveButton);
    fireEvent.click(screen.getByRole('button', { name: 'Hide Exceptions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use wide span for Exceptions' }));
    fireEvent.change(selectFieldControl(screen.getByLabelText('Saved default branch', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), {
      target: { value: 'branch_2' },
    });
    fireEvent.change(selectFieldControl(screen.getByLabelText('Saved date range', { selector: ':not([data-select-field-native][aria-hidden="true"])' })), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save dashboard' }));

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1));
    const saved = mocks.mutate.mock.calls[0]![0];
    expect(saved.widgets.map((widget: { key: string }) => widget.key).slice(0, 2)).toEqual([
      'trend',
      'performance',
    ]);
    expect(saved.widgets.find((widget: { key: string }) => widget.key === 'exceptions')).toEqual(
      expect.objectContaining({ visible: false, span: 'wide' })
    );
    expect(saved).toMatchObject({ defaultBranchId: 'branch_2', rangeDays: 30, version: 1 });

    mocks.preferences.data = saved;
    view.rerender(<RestaurantManagementOverview insightsEnabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit dashboard' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore default' }));
    const restoredEditor = screen
      .getByRole('heading', { name: 'Widget layout' })
      .closest('[data-slot="section-card"]');
    const rows = within(restoredEditor as HTMLElement).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Performance summary');
    fireEvent.click(screen.getByRole('button', { name: 'Save dashboard' }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(2));
    const defaults = { ...mocks.preference, defaultBranchId: null };
    expect(mocks.mutate.mock.calls[1]![0]).toEqual(defaults);
    expect(mocks.setData).toHaveBeenLastCalledWith(undefined, defaults);
  });

  it('renders an honest disabled state without starting insight reads', () => {
    render(<RestaurantManagementOverview insightsEnabled={false} />);
    expect(screen.getByText('Analytics module not enabled')).toBeInTheDocument();
    expect(mocks.calls.at(-1)?.enabled).toBe(false);
  });
});

describe('closedDateRange', () => {
  it('creates inclusive 7 and 30 day UTC date windows', () => {
    const now = new Date('2026-08-30T15:00:00.000Z');
    expect(closedDateRange(7, now)).toEqual({ from: '2026-08-23', to: '2026-08-29' });
    expect(closedDateRange(30, now)).toEqual({ from: '2026-07-31', to: '2026-08-29' });
  });
});
