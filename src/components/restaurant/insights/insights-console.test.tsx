import { selectFieldControl } from '@/lib/testing/select-field';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';
import type {
  PrepareClosePacketInput,
  RestaurantClosePacket,
} from '@/lib/restaurant/close-readiness';

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
    computedAtLocal: '2026-08-20T17:00:00[America/New_York]',
  };
  return {
    closeFetch: vi.fn(),
    branches: query([
      { id: 'branch_1', name: 'Downtown', active: true, isDefault: true },
      { id: 'branch_2', name: 'Uptown', active: true, isDefault: false },
    ]),
    financialList: query([
      {
        id: 'rollup_fin_1',
        branchId: 'branch_1',
        branchName: 'Downtown',
        businessDate: '2026-08-20',
        orderCount: 42,
        coverCount: 108,
        grossSales: '4210.50',
        deliveryFeeSales: '120.00',
        deliveryFeeRefunds: '8.00',
        netSales: '3990.25',
        compTotal: '35.00',
        refundTotal: '18.00',
        voidTotal: '12.00',
        drawerVariance: '-1.50',
        loyaltyLiability: '210.75',
        freshness: { ...freshness },
        createdAt: '2026-08-20T21:00:00.000Z',
        updatedAt: '2026-08-20T21:00:00.000Z',
      },
    ]),
    operationalList: query([
      {
        id: 'rollup_ops_1',
        branchId: 'branch_1',
        branchName: 'Downtown',
        businessDate: '2026-08-20',
        orderCount: 42,
        coverCount: 108,
        freshness: { ...freshness, status: 'STALE' as const },
        createdAt: '2026-08-20T21:00:00.000Z',
        updatedAt: '2026-08-20T21:00:00.000Z',
      },
    ]),
    financialDetail: query({
      id: 'rollup_fin_1',
      branchId: 'branch_1',
      branchName: 'Downtown',
      businessDate: '2026-08-20',
      orderCount: 42,
      coverCount: 108,
      grossSales: '4210.50',
      deliveryFeeSales: '120.00',
      deliveryFeeRefunds: '8.00',
      netSales: '3990.25',
      compTotal: '35.00',
      refundTotal: '18.00',
      voidTotal: '12.00',
      drawerVariance: '-1.50',
      loyaltyLiability: '210.75',
      freshness: { ...freshness },
      createdAt: '2026-08-20T21:00:00.000Z',
      updatedAt: '2026-08-20T21:00:00.000Z',
      itemMix: [
        {
          productId: 'product_1',
          productName: 'Margherita',
          quantity: 30,
          grossSales: '360.00',
          netSales: '342.00',
          compTotal: '6.00',
        },
      ],
    }),
    operationalDetail: query({
      id: 'rollup_ops_1',
      branchId: 'branch_1',
      branchName: 'Downtown',
      businessDate: '2026-08-20',
      orderCount: 42,
      coverCount: 108,
      freshness: { ...freshness, status: 'STALE' as const },
      createdAt: '2026-08-20T21:00:00.000Z',
      updatedAt: '2026-08-20T21:00:00.000Z',
      itemMix: [{ productId: 'product_1', productName: 'Margherita', quantity: 30 }],
    }),
    labourList: query([
      {
        id: 'labour_1',
        branchId: 'branch_1',
        branchName: 'Downtown',
        businessDate: '2026-08-20',
        labourHours: '48.00',
        labourCost: '720.00',
        source: 'payroll-import',
        idempotencyKey: 'key_1',
        importedAtUtc: '2026-08-20T22:00:00.000Z',
        importedAtLocal: '2026-08-20T18:00:00[America/New_York]',
        createdAt: '2026-08-20T22:00:00.000Z',
      },
    ]),
    exportFetch: vi.fn(async () => ({
      filename: 'restaurant-financial-report.csv',
      contentType: 'text/csv; charset=utf-8',
      content: 'branchId,businessDate\nbranch_1,2026-08-20',
    })),
    calls: {
      financialList: [] as Array<{ input: unknown; enabled: boolean }>,
      operationalList: [] as Array<{ input: unknown; enabled: boolean }>,
      financialDetail: [] as Array<{ input: unknown; enabled: boolean }>,
      operationalDetail: [] as Array<{ input: unknown; enabled: boolean }>,
      labourList: [] as Array<{ input: unknown; enabled: boolean }>,
    },
  };
});

function hook<T>(
  query: T,
  calls: Array<{ input: unknown; enabled: boolean }>,
  input: unknown,
  options: { enabled: boolean }
) {
  calls.push({ input, enabled: options.enabled });
  return query;
}

vi.mock('@/lib/trpc', () => ({
  trpc: {
    restaurantStaff: {
      listBranches: {
        useQuery: () => mocks.branches,
      },
    },
    restaurantInsights: {
      listFinancialReports: {
        useQuery: (input: unknown, options: { enabled: boolean }) =>
          hook(mocks.financialList, mocks.calls.financialList, input, options),
      },
      listOperationalReports: {
        useQuery: (input: unknown, options: { enabled: boolean }) =>
          hook(mocks.operationalList, mocks.calls.operationalList, input, options),
      },
      readFinancialReport: {
        useQuery: (input: unknown, options: { enabled: boolean }) =>
          hook(mocks.financialDetail, mocks.calls.financialDetail, input, options),
      },
      readOperationalReport: {
        useQuery: (input: unknown, options: { enabled: boolean }) =>
          hook(mocks.operationalDetail, mocks.calls.operationalDetail, input, options),
      },
      listLabourCosts: {
        useQuery: (input: unknown, options: { enabled: boolean }) =>
          hook(mocks.labourList, mocks.calls.labourList, input, options),
      },
    },
    useUtils: () => ({
      restaurantInsights: {
        prepareClosePacket: { fetch: mocks.closeFetch },
        exportFinancialReports: { fetch: mocks.exportFetch },
        exportOperationalReports: { fetch: mocks.exportFetch },
        exportLabourCosts: { fetch: mocks.exportFetch },
      },
    }),
  },
}));

import { EntitlementsProvider } from '@/components/entitlements-provider';
import { InsightsConsole } from './insights-console';

function entitlements(enabled: boolean): EntitlementView {
  return {
    organizationId: 'org_1',
    seatLimit: 10,
    activeSeats: 1,
    enabledModules: enabled ? ['restaurant-insights'] : [],
    modules: [
      {
        key: 'restaurant-insights',
        name: 'Restaurant Insights',
        enabled,
        source: enabled ? 'OVERRIDE' : 'NONE',
        seatLimit: null,
        expiresAt: null,
      },
    ],
    limits: {},
  };
}

function renderConsole(enabled = true) {
  return render(
    <EntitlementsProvider value={entitlements(enabled)}>
      <InsightsConsole />
    </EntitlementsProvider>
  );
}

function setBranch(value = 'branch_1') {
  fireEvent.change(
    selectFieldControl(screen.getByRole('combobox', { name: 'Branch', exact: true })),
    { target: { value } }
  );
}

describe('InsightsConsole', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.values(mocks.calls).forEach((calls) => {
      calls.length = 0;
    });
    [
      mocks.financialList,
      mocks.operationalList,
      mocks.financialDetail,
      mocks.operationalDetail,
      mocks.labourList,
    ].forEach((query) => {
      query.error = null;
      query.isLoading = false;
    });
    mocks.exportFetch.mockClear();
    mocks.branches.error = null;
    mocks.closeFetch
      .mockReset()
      .mockImplementation(
        async (input: PrepareClosePacketInput): Promise<RestaurantClosePacket> => ({
          scope: { organizationId: 'org_1', branchId: input.branchId },
          period: { from: input.businessDate, to: input.businessDate, basis: 'BUSINESS_DATE' },
          status: 'UNKNOWN',
          financial: { status: 'UNKNOWN', data: null, blockers: [], missingEvidence: [] },
          operational: { status: 'UNKNOWN', data: null, blockers: [], missingEvidence: [] },
          freshness: {
            status: 'LIVE_OBSERVATION',
            asOf: input.asOf,
            startedAt: input.asOf,
            completedAt: input.asOf,
            expiresAt: input.asOf,
            definition: 'Non-atomic live observation.',
          },
          unattendedCloseReady: false,
          execution: { mode: 'READ_ONLY', scheduled: false, definition: 'Read only.' },
        })
      );
  });

  it('disables every read until the module entitlement is present', () => {
    renderConsole(false);
    expect(mocks.calls.financialList.at(-1)?.enabled).toBe(false);
    expect(screen.getByText('Restaurant Insights module disabled')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Scenarios' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Close readiness' })).not.toBeInTheDocument();
    expect(mocks.closeFetch).not.toHaveBeenCalled();
  });

  it('prepares close evidence through ordinary navigation with only Insights enabled', async () => {
    renderConsole();
    fireEvent.click(screen.getByRole('tab', { name: 'Close readiness' }));
    expect(screen.getByRole('button', { name: 'Prepare close packet' })).toBeDisabled();
    setBranch();
    fireEvent.change(screen.getByLabelText('Close business date'), {
      target: { value: '2026-09-11' },
    });
    expect(mocks.closeFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Prepare close packet' }));
    await screen.findByRole('button', { name: 'Refresh close packet' });
    expect(mocks.closeFetch).toHaveBeenCalledWith(
      { branchId: 'branch_1', businessDate: '2026-09-11', asOf: expect.any(String) },
      { staleTime: 0, retry: false }
    );
    expect(screen.getByText('Not ready for unattended close')).toBeInTheDocument();
    for (const calls of Object.values(mocks.calls)) expect(calls.at(-1)?.enabled).toBe(false);
    expect(mocks.exportFetch).not.toHaveBeenCalled();
  });

  it('preserves close date and existing report range across tabs, invalidates packets on branch change', async () => {
    renderConsole();
    setBranch();
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-09-01' } });
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-09-10' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Close readiness' }));
    fireEvent.change(screen.getByLabelText('Close business date'), {
      target: { value: '2026-09-11' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare close packet' }));
    await screen.findByRole('button', { name: 'Refresh close packet' });
    setBranch('branch_2');
    expect(screen.queryByText('Not ready for unattended close')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Close business date')).toHaveValue('2026-09-11');
    fireEvent.click(screen.getByRole('tab', { name: 'Scenarios' }));
    expect(screen.getByRole('button', { name: 'Calculate contribution' })).toBeEnabled();
    fireEvent.click(screen.getByRole('tab', { name: 'Financial' }));
    expect(mocks.calls.financialList.at(-1)?.input).toEqual({
      branchId: 'branch_2',
      from: '2026-09-01',
      to: '2026-09-10',
      limit: 100,
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Close readiness' }));
    expect(screen.getByLabelText('Close business date')).toHaveValue('2026-09-11');
    expect(mocks.closeFetch).toHaveBeenCalledOnce();
  });

  it('hides prepared evidence and requires branch recovery after branch-list failure', async () => {
    const view = renderConsole();
    setBranch();
    fireEvent.click(screen.getByRole('tab', { name: 'Close readiness' }));
    fireEvent.change(screen.getByLabelText('Close business date'), {
      target: { value: '2026-09-11' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare close packet' }));
    await screen.findByRole('button', { name: 'Refresh close packet' });
    mocks.branches.error = new Error('Unavailable');
    view.rerender(
      <EntitlementsProvider value={entitlements(true)}>
        <InsightsConsole />
      </EntitlementsProvider>
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Selected branch is unavailable');
    expect(screen.queryByText('Not ready for unattended close')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare close packet' })).toBeDisabled();
    expect(screen.getByLabelText('Close business date')).toHaveValue('2026-09-11');
  });

  it('connects manual scenarios with only Insights enabled and no branch or AskFathom prerequisite', () => {
    renderConsole();
    fireEvent.click(screen.getByRole('tab', { name: 'Scenarios' }));
    expect(screen.getByRole('heading', { name: 'Contribution scenarios' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Calculate contribution' })).toBeEnabled();
    expect(screen.queryByText('Branch required')).not.toBeInTheDocument();
    for (const calls of Object.values(mocks.calls)) expect(calls.at(-1)?.enabled).toBe(false);
    expect(mocks.exportFetch).not.toHaveBeenCalled();
  });

  it('resets assumptions on scope changes and restores unchanged report filters', () => {
    renderConsole();
    setBranch();
    fireEvent.click(screen.getByRole('tab', { name: 'Scenarios' }));
    fireEvent.change(screen.getByLabelText('Assumed currency code'), { target: { value: 'PKR' } });
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-09-01' } });
    expect(screen.getByLabelText('Assumed currency code')).toHaveValue('');
    expect(screen.getByText(/Planning period: 2026-09-01/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Financial' }));
    expect(mocks.calls.financialList.at(-1)).toEqual({
      input: { branchId: 'branch_1', from: '2026-09-01', limit: 100 },
      enabled: true,
    });
    expect(screen.getByText('4210.50')).toBeInTheDocument();
  });

  it('gates reads by branch and active tab', () => {
    renderConsole();
    expect(mocks.calls.financialList.at(-1)?.enabled).toBe(false);

    setBranch();
    expect(mocks.calls.financialList.at(-1)).toEqual({
      input: { branchId: 'branch_1', limit: 100 },
      enabled: true,
    });
    expect(mocks.calls.operationalList.at(-1)?.enabled).toBe(false);
    expect(mocks.calls.labourList.at(-1)?.enabled).toBe(false);
    expect(mocks.calls.financialDetail.at(-1)?.enabled).toBe(false);

    fireEvent.click(screen.getByRole('tab', { name: 'Operational' }));
    expect(mocks.calls.financialList.at(-1)?.enabled).toBe(false);
    expect(mocks.calls.operationalList.at(-1)?.enabled).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: 'Labour' }));
    expect(mocks.calls.operationalList.at(-1)?.enabled).toBe(false);
    expect(mocks.calls.labourList.at(-1)?.enabled).toBe(true);
  });

  it('passes the inclusive date range to the report read', () => {
    renderConsole();
    setBranch();
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('To date'), { target: { value: '2026-08-20' } });
    expect(mocks.calls.financialList.at(-1)?.input).toEqual({
      branchId: 'branch_1',
      from: '2026-08-01',
      to: '2026-08-20',
      limit: 100,
    });
  });

  it('renders exact financial figures and reconciliation totals', () => {
    renderConsole();
    setBranch();
    expect(screen.getByText('4210.50')).toBeInTheDocument();
    expect(screen.getByText('120.00')).toBeInTheDocument();
    expect(screen.getByText('8.00')).toBeInTheDocument();
    expect(screen.getByText('210.75')).toBeInTheDocument();
    expect(screen.getByText('-1.50')).toBeInTheDocument();
    const region = screen.getByRole('region', { name: 'financial reports table' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region.className).toContain('[&_[data-slot=table-container]]:overflow-visible');
  });

  it('omits money columns from the operational report', () => {
    renderConsole();
    setBranch();
    fireEvent.click(screen.getByRole('tab', { name: 'Operational' }));
    expect(screen.queryByText('4210.50')).not.toBeInTheDocument();
    expect(screen.getByText('Stale — rebuild')).toBeInTheDocument();
    expect(screen.getByText('108')).toBeInTheDocument();
  });

  it('reads and renders the item mix on selection', () => {
    renderConsole();
    setBranch();
    expect(mocks.calls.financialDetail.at(-1)?.enabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'View 2026-08-20' }));
    expect(mocks.calls.financialDetail.at(-1)).toEqual({
      input: { branchId: 'branch_1', businessDate: '2026-08-20' },
      enabled: true,
    });
    expect(screen.getByText('Margherita')).toBeInTheDocument();
    expect(screen.getByText('360.00')).toBeInTheDocument();
  });

  it('exports the current financial report as a CSV download', async () => {
    const createObjectURL = vi.fn(() => 'blob:insights');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });

    renderConsole();
    setBranch();
    fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-08-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export financial report CSV' }));

    await waitFor(() => expect(mocks.exportFetch).toHaveBeenCalledOnce());
    expect(mocks.exportFetch).toHaveBeenCalledWith({ branchId: 'branch_1', from: '2026-08-01' });
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    vi.unstubAllGlobals();
  });

  it('renders loading and retryable generic-error states', () => {
    mocks.financialList.isLoading = true;
    const loading = renderConsole();
    setBranch();
    expect(screen.getByRole('status', { name: 'Loading financial reports' })).toBeInTheDocument();
    loading.unmount();

    mocks.financialList.isLoading = false;
    mocks.financialList.error = {
      message: 'Read unavailable',
      data: { code: 'INTERNAL_SERVER_ERROR' },
    };
    renderConsole();
    setBranch();
    expect(screen.getByText('Could not load financial reports')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.financialList.refetch).toHaveBeenCalledOnce();
  });

  it('shows a permission-denied state with no cached figures and no retry', () => {
    mocks.financialList.error = { message: 'Forbidden', data: { code: 'FORBIDDEN' } };
    renderConsole();
    setBranch();
    expect(screen.getByText('Insights access denied')).toBeInTheDocument();
    expect(screen.queryByText('4210.50')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('fails labour closed on denial: no cached labour value and no export', () => {
    mocks.labourList.error = { message: 'Forbidden', data: { code: 'FORBIDDEN' } };
    renderConsole();
    setBranch();
    fireEvent.click(screen.getByRole('tab', { name: 'Labour' }));
    expect(screen.getByText('Insights access denied')).toBeInTheDocument();
    expect(screen.queryByText('720.00')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Export labour report CSV' })
    ).not.toBeInTheDocument();
  });

  it('renders labour cost facts when both capabilities are granted', () => {
    renderConsole();
    setBranch();
    fireEvent.click(screen.getByRole('tab', { name: 'Labour' }));
    expect(screen.getByText('720.00')).toBeInTheDocument();
    expect(screen.getByText('payroll-import')).toBeInTheDocument();
  });
});
