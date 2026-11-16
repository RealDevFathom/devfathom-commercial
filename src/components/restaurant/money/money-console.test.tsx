import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EntitlementView } from '@/lib/module-catalog';

const mocks = vi.hoisted(() => {
  const query = <T,>(data: T) => ({
    data,
    error: null as unknown,
    isLoading: false,
    refetch: vi.fn(),
  });
  return {
    bills: query({
      bills: [
        {
          id: 'bill_1',
          orderId: 'order_1',
          branchId: 'branch_1',
          businessDate: '2026-08-19',
          status: 'SETTLED',
          splitKind: 'WHOLE',
          subtotal: '18.50',
          taxTotal: '1.50',
          serviceChargeTotal: '2.00',
          compTotal: '0',
          roundingAdjustment: '0',
          grandTotal: '22.00',
          receiptNumber: 7,
          settledAt: new Date('2026-08-19T12:00:00Z'),
          createdAt: new Date('2026-08-19T11:00:00Z'),
        },
      ],
      nextCursor: null as string | null,
    }),
    bill: query(null),
    tenders: query({
      tenders: [
        {
          id: 'tender_card',
          billId: 'bill_1',
          type: 'CARD',
          amount: '22.00',
          tipAmount: '2.00',
          cashReceived: null,
          changeGiven: null,
          drawerSessionId: null,
          paymentId: 'payment_1',
          businessDate: '2026-08-19',
          staffProfileId: 'staff_1',
          deviceId: 'device_1',
          createdAt: new Date('2026-08-19T12:00:00Z'),
        },
      ],
      nextCursor: null as string | null,
    }),
    refunds: query({
      refunds: [
        {
          id: 'refund_1',
          originalTenderId: 'tender_card',
          billId: 'bill_1',
          kind: 'PARTIAL',
          amount: '2.00',
          tipRefundAmount: '0',
          businessDate: '2026-08-19',
          reason: 'Item issue',
          cardMachineRefundReference: 'BANK-REF-42',
          coAuthorizationId: 'coauth_1',
          drawerSessionId: null,
          paymentId: 'payment_1',
          staffProfileId: 'staff_1',
          deviceId: 'device_1',
          createdAt: new Date('2026-08-19T13:00:00Z'),
        },
      ],
      nextCursor: null as string | null,
    }),
    totals: query({
      branchId: 'branch_1',
      businessDate: '2026-08-19',
      tenderTypes: [
        { tenderType: 'CASH', amount: '0', tipAmount: '0', count: 0 },
        { tenderType: 'CARD', amount: '22.00', tipAmount: '2.00', count: 1 },
        { tenderType: 'OTHER', amount: '0', tipAmount: '0', count: 0 },
      ],
      totals: { amount: '22.00', tipAmount: '2.00', count: 1 },
    }),
    payment: query({
      id: 'payment_1',
      billId: 'bill_1',
      provider: 'MOCK',
      capability: 'CARD_PRESENT',
      status: 'CAPTURED',
      amount: '22.00',
      tipAmount: '2.00',
      providerRef: 'provider_1',
      staffProfileId: 'staff_1',
      deviceId: 'device_1',
      createdAt: new Date('2026-08-19T12:00:00Z'),
      events: [
        {
          id: 'event_1',
          capability: 'CARD_PRESENT',
          eventType: 'CAPTURE_SUCCEEDED',
          amount: '22.00',
          providerRef: 'provider_1',
          payload: { response: 'approved' },
          createdAt: new Date('2026-08-19T12:00:00Z'),
        },
      ],
      tenders: [],
      refunds: [],
    }),
    drawers: query({
      sessions: [
        {
          id: 'drawer_1',
          branchId: 'branch_1',
          deviceId: 'device_1',
          staffProfileId: 'staff_1',
          businessDate: '2026-08-19',
          status: 'CLOSED',
          openedAt: new Date('2026-08-19T08:00:00Z'),
          closedAt: new Date('2026-08-19T20:00:00Z'),
          openingFloat: '100.00',
          expectedCash: '150.00',
          countedCash: '149.00',
          variance: '-1.00',
          movementCount: 3,
        },
      ],
      nextCursor: null as string | null,
    }),
    drawer: query({
      id: 'drawer_1',
      branchId: 'branch_1',
      deviceId: 'device_1',
      staffProfileId: 'staff_1',
      businessDate: '2026-08-19',
      status: 'CLOSED',
      openedAt: new Date('2026-08-19T08:00:00Z'),
      closedAt: new Date('2026-08-19T20:00:00Z'),
      openingFloat: '100.00',
      expectedCash: '150.00',
      countedCash: '149.00',
      variance: '-1.00',
      movements: [],
    }),
    closes: query({
      chains: [
        {
          businessDate: '2026-08-19',
          tipCloseId: 'close_1',
          closes: [
            {
              id: 'close_1',
              supersedesCloseId: null,
              isTip: true,
              correctionReason: null,
              createdAt: new Date('2026-08-19T21:00:00Z'),
              grossSales: '200.00',
              netSales: '180.00',
              refundTotal: '2.00',
              cashVariance: '-1.00',
            },
          ],
        },
      ],
    }),
    close: query({
      close: {
        id: 'close_1',
        branchId: 'branch_1',
        businessDate: '2026-08-19',
        supersedesCloseId: null,
        correctionReason: null,
        coAuthorizationId: null,
        cutByStaffProfileId: 'staff_1',
        deviceId: 'device_1',
        createdAt: new Date('2026-08-19T21:00:00Z'),
        isTip: true,
        totals: {
          grossSales: '200.00',
          netSales: '180.00',
          taxTotal: '10.00',
          serviceChargeTotal: '10.00',
          tipTotal: '2.00',
          compTotal: '0',
          discountTotal: '0',
          refundTotal: '2.00',
          voidTotal: '0',
          cashExpected: '150.00',
          cashCounted: '149.00',
          cashVariance: '-1.00',
        },
      },
      tenderTotals: [{ tenderType: 'CARD', amount: '22.00', tipAmount: '2.00', count: 1 }],
      drawerVariances: [],
      chain: [
        {
          id: 'close_1',
          supersedesCloseId: null,
          correctionReason: null,
          cutByStaffProfileId: 'staff_1',
          createdAt: new Date('2026-08-19T21:00:00Z'),
          isTip: true,
        },
      ],
    }),
    calls: {
      bills: [] as Array<{ input: unknown; enabled: boolean }>,
      bill: [] as Array<{ input: unknown; enabled: boolean }>,
      tenders: [] as Array<{ input: unknown; enabled: boolean }>,
      refunds: [] as Array<{ input: unknown; enabled: boolean }>,
      totals: [] as Array<{ input: unknown; enabled: boolean }>,
      payment: [] as Array<{ input: unknown; enabled: boolean }>,
      drawers: [] as Array<{ input: unknown; enabled: boolean }>,
      drawer: [] as Array<{ input: unknown; enabled: boolean }>,
      closes: [] as Array<{ input: unknown; enabled: boolean }>,
      close: [] as Array<{ input: unknown; enabled: boolean }>,
    },
    saveTerminalConfig: vi.fn(),
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
        useQuery: () => ({
          data: [{ id: 'branch_1', name: 'Downtown', active: true, isDefault: true }],
          error: null,
          isLoading: false,
        }),
      },
      listDirectory: {
        useQuery: () => ({
          data: [{ id: 'staff_1', displayName: 'Amina Khan', role: 'Cashier' }],
          error: null,
          isLoading: false,
        }),
      },
    },
    restaurantDevices: {
      list: {
        useQuery: () => ({
          data: [
            {
              id: 'device_1',
              name: 'Front Register',
              branch: { id: 'branch_1', name: 'Downtown' },
              status: 'ACTIVE',
            },
          ],
          error: null,
          isLoading: false,
        }),
      },
    },
    // WHA-238's terminal-provider form invalidates its own query on success.
    useUtils: () => ({
      restaurantPayments: { getTerminalConfig: { invalidate: vi.fn() } },
    }),
    restaurantBills: {
      listBills: {
        useQuery: (input: unknown, options: { enabled: boolean }) =>
          hook(mocks.bills, mocks.calls.bills, input, options),
      },
      getBill: {
        useQuery: (input: unknown, options: { enabled: boolean }) =>
          hook(mocks.bill, mocks.calls.bill, input, options),
      },
    },
    restaurantPayments: {
      listTenders: {
        useQuery: (input: unknown, options: { enabled: boolean }) =>
          hook(mocks.tenders, mocks.calls.tenders, input, options),
      },
      listRefunds: {
        useQuery: (input: unknown, options: { enabled: boolean }) =>
          hook(mocks.refunds, mocks.calls.refunds, input, options),
      },
      getTenderTypeTotals: {
        useQuery: (input: unknown, options: { enabled: boolean }) =>
          hook(mocks.totals, mocks.calls.totals, input, options),
      },
      getPayment: {
        useQuery: (input: unknown, options: { enabled: boolean }) =>
          hook(mocks.payment, mocks.calls.payment, input, options),
      },
      // WHA-238 terminal payments. The terminal tab is not exercised by these
      // read-model assertions, so an empty provider config is enough to render.
      getTerminalConfig: {
        useQuery: () => ({ data: [], error: null, isLoading: false, refetch: vi.fn() }),
      },
      listTerminalReconciliations: {
        useQuery: () => ({
          data: [],
          error: null,
          isLoading: false,
          refetch: vi.fn(),
        }),
      },
      saveTerminalConfig: {
        useMutation: () => ({ mutate: mocks.saveTerminalConfig, isPending: false, error: null }),
      },
    },
    restaurantCash: {
      listDrawerSessions: {
        useQuery: (input: unknown, options: { enabled: boolean }) =>
          hook(mocks.drawers, mocks.calls.drawers, input, options),
      },
      getDrawerSession: {
        useQuery: (input: unknown, options: { enabled: boolean }) =>
          hook(mocks.drawer, mocks.calls.drawer, input, options),
      },
      listDailyCloses: {
        useQuery: (input: unknown, options: { enabled: boolean }) =>
          hook(mocks.closes, mocks.calls.closes, input, options),
      },
      getDailyClose: {
        useQuery: (input: unknown, options: { enabled: boolean }) =>
          hook(mocks.close, mocks.calls.close, input, options),
      },
    },
  },
}));

import { EntitlementsProvider } from '@/components/entitlements-provider';
import { MoneyConsole, type MoneyTab } from './money-console';

function entitlements(enabled: boolean): EntitlementView {
  return {
    organizationId: 'org_1',
    seatLimit: 10,
    activeSeats: 1,
    enabledModules: enabled
      ? ['restaurant-core', 'restaurant-pos', 'restaurant-purchasing', 'restaurant-insights']
      : ['restaurant-core'],
    modules: [
      {
        key: 'restaurant-pos',
        name: 'Restaurant POS',
        enabled,
        source: enabled ? 'OVERRIDE' : 'NONE',
        seatLimit: null,
        expiresAt: null,
      },
    ],
    limits: {},
  };
}

function renderConsole(enabled = true, initialTab?: MoneyTab) {
  return render(
    <EntitlementsProvider value={entitlements(enabled)}>
      <MoneyConsole initialTab={initialTab} canReadFinance />
    </EntitlementsProvider>
  );
}

function setBranchAndDate() {
  fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch_1' } });
  fireEvent.change(screen.getByLabelText('Business date'), {
    target: { value: '2026-08-19' },
  });
}

describe('MoneyConsole', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.values(mocks.calls).forEach((calls) => {
      calls.length = 0;
    });
    [
      mocks.bills,
      mocks.bill,
      mocks.tenders,
      mocks.refunds,
      mocks.totals,
      mocks.payment,
      mocks.drawers,
      mocks.drawer,
      mocks.closes,
      mocks.close,
    ].forEach((query) => {
      query.error = null;
      query.isLoading = false;
    });
    mocks.bills.data.nextCursor = null;
    mocks.tenders.data.nextCursor = null;
    mocks.refunds.data.nextCursor = null;
    mocks.drawers.data.nextCursor = null;
    mocks.close.data.tenderTotals = [
      { tenderType: 'CARD', amount: '22.00', tipAmount: '2.00', count: 1 },
    ];
    mocks.close.data.drawerVariances = [];
  });

  it('renders an immediate denial without mounting branch or protected ledger queries', () => {
    render(
      <EntitlementsProvider value={entitlements(true)}>
        <MoneyConsole canReadFinance={false} />
      </EntitlementsProvider>
    );

    expect(screen.getByRole('heading', { name: 'Restaurant Finance' })).toBeInTheDocument();
    expect(screen.getByText('Restaurant Finance access denied')).toBeInTheDocument();
    expect(screen.queryByLabelText('Branch')).not.toBeInTheDocument();
    expect(Object.values(mocks.calls).every((calls) => calls.length === 0)).toBe(true);
  });

  it('gates every read by entitlement, branch, active tab, date, and detail selection', () => {
    const disabled = renderConsole(false);
    expect(mocks.calls.bills.at(-1)?.enabled).toBe(false);
    expect(mocks.calls.tenders.at(-1)?.enabled).toBe(false);
    expect(screen.getByText('Restaurant POS module disabled')).toBeInTheDocument();
    expect(screen.getByLabelText('Branch')).toBeDisabled();
    expect(screen.getByLabelText('Business date')).toBeDisabled();
    expect(
      screen.queryByRole('tablist', { name: 'Restaurant Finance ledgers' })
    ).not.toBeInTheDocument();
    disabled.unmount();

    renderConsole();
    expect(mocks.calls.bills.at(-1)?.enabled).toBe(false);
    setBranchAndDate();
    expect(mocks.calls.bills.at(-1)).toEqual({
      input: { branchId: 'branch_1', businessDate: '2026-08-19', limit: 100 },
      enabled: true,
    });
    expect(mocks.calls.bill.at(-1)?.enabled).toBe(false);
    expect(mocks.calls.tenders.at(-1)?.enabled).toBe(false);

    fireEvent.click(screen.getByRole('tab', { name: 'Payments' }));
    expect(mocks.calls.bills.at(-1)?.enabled).toBe(false);
    expect(mocks.calls.tenders.at(-1)?.enabled).toBe(true);
    expect(mocks.calls.refunds.at(-1)?.enabled).toBe(true);
    expect(mocks.calls.totals.at(-1)?.enabled).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: 'Drawers' }));
    expect(mocks.calls.tenders.at(-1)?.enabled).toBe(false);
    expect(mocks.calls.drawers.at(-1)?.enabled).toBe(true);
    expect(mocks.calls.drawer.at(-1)?.enabled).toBe(false);

    fireEvent.click(screen.getByRole('tab', { name: 'Daily close' }));
    expect(mocks.calls.drawers.at(-1)?.enabled).toBe(false);
    expect(mocks.calls.closes.at(-1)?.enabled).toBe(true);
    expect(mocks.calls.close.at(-1)?.enabled).toBe(false);
  });

  it('opens the requested read-only ledger while preserving the denied state', () => {
    const console = renderConsole(true, 'daily-close');
    expect(screen.getByRole('tab', { name: 'Daily close' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(mocks.calls.closes.at(-1)?.enabled).toBe(false);
    console.unmount();

    renderConsole(false, 'daily-close');
    expect(screen.getByText('Restaurant POS module disabled')).toBeInTheDocument();
    expect(
      screen.queryByRole('tablist', { name: 'Restaurant Finance ledgers' })
    ).not.toBeInTheDocument();
  });

  it('creates the first provider terminal configuration when the branch has none', () => {
    renderConsole(true, 'terminal');
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch_1' } });
    fireEvent.change(screen.getByLabelText('Provider source'), {
      target: { value: 'stripe-terminal' },
    });
    fireEvent.change(screen.getByLabelText('Terminal ID'), {
      target: { value: 'tmr_front_counter' },
    });
    fireEvent.change(screen.getByLabelText('Device'), { target: { value: 'device_1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save terminal configuration' }));

    expect(mocks.saveTerminalConfig).toHaveBeenCalledWith({
      branchId: 'branch_1',
      source: 'stripe-terminal',
      externalTerminalId: 'tmr_front_counter',
      deviceId: 'device_1',
      mode: 'DISABLED',
    });
  });

  it('renders one server read model on every tab', () => {
    renderConsole();
    setBranchAndDate();
    expect(screen.getByText('bill_1')).toBeInTheDocument();
    expect(screen.getByText('22.00')).toBeInTheDocument();
    const billsRegion = screen.getByRole('region', { name: 'Bills table' });
    expect(billsRegion).toHaveAttribute('tabindex', '0');
    expect(billsRegion.className).toContain('[&_[data-slot=table-container]]:overflow-visible');

    fireEvent.click(screen.getByRole('tab', { name: 'Payments' }));
    expect(screen.getAllByText('tender_card').length).toBeGreaterThan(0);
    expect(screen.getByText('refund_1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Drawers' }));
    expect(screen.getByText('drawer_1')).toBeInTheDocument();
    expect(screen.getByText('Amina Khan')).toBeVisible();
    expect(screen.getByText('Front Register')).toBeVisible();
    expect(screen.queryByText('staff_1')).not.toBeInTheDocument();
    expect(screen.queryByText('device_1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Daily close' }));
    expect(screen.getAllByText('close_1').length).toBeGreaterThan(0);
    expect(screen.getByText('Authoritative tip')).toBeInTheDocument();
  });

  it('enables a card payment selection and renders its event trail', () => {
    renderConsole();
    setBranchAndDate();
    fireEvent.click(screen.getByRole('tab', { name: 'Payments' }));
    expect(mocks.calls.payment.at(-1)?.enabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'View payment payment_1' }));
    expect(mocks.calls.payment.at(-1)).toEqual({
      input: { paymentId: 'payment_1' },
      enabled: true,
    });
    expect(screen.getByText('CAPTURE SUCCEEDED')).toBeInTheDocument();
    expect(screen.getByText('{"response":"approved"}')).toBeInTheDocument();
  });

  it('paginates bills, tenders, refunds, and drawers independently and resets cursors', () => {
    mocks.bills.data.nextCursor = 'bill_cursor_2';
    mocks.tenders.data.nextCursor = 'tender_cursor_2';
    mocks.refunds.data.nextCursor = 'refund_cursor_2';
    mocks.drawers.data.nextCursor = 'drawer_cursor_2';

    renderConsole();
    setBranchAndDate();
    fireEvent.click(screen.getByRole('button', { name: 'View bill bill_1' }));
    expect(mocks.calls.bill.at(-1)?.enabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Next bills page' }));
    expect(mocks.calls.bills.at(-1)?.input).toEqual({
      branchId: 'branch_1',
      businessDate: '2026-08-19',
      limit: 100,
      cursor: 'bill_cursor_2',
    });
    expect(mocks.calls.bill.at(-1)?.enabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Previous bills page' }));
    expect(mocks.calls.bills.at(-1)?.input).not.toHaveProperty('cursor');

    fireEvent.click(screen.getByRole('tab', { name: 'Payments' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next tenders page' }));
    expect(mocks.calls.tenders.at(-1)?.input).toHaveProperty('cursor', 'tender_cursor_2');
    expect(mocks.calls.refunds.at(-1)?.input).not.toHaveProperty('cursor');

    fireEvent.click(screen.getByRole('button', { name: 'Next refunds page' }));
    expect(mocks.calls.tenders.at(-1)?.input).toHaveProperty('cursor', 'tender_cursor_2');
    expect(mocks.calls.refunds.at(-1)?.input).toHaveProperty('cursor', 'refund_cursor_2');

    fireEvent.click(screen.getByRole('tab', { name: 'Drawers' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next drawers page' }));
    expect(mocks.calls.drawers.at(-1)?.input).toHaveProperty('cursor', 'drawer_cursor_2');

    fireEvent.change(screen.getByLabelText('Business date'), {
      target: { value: '2026-08-20' },
    });
    expect(mocks.calls.drawers.at(-1)?.input).not.toHaveProperty('cursor');
  });

  it('renders explicit empty daily-close detail states', () => {
    mocks.close.data.tenderTotals = [];
    mocks.close.data.drawerVariances = [];
    renderConsole();
    setBranchAndDate();
    fireEvent.click(screen.getByRole('tab', { name: 'Daily close' }));
    fireEvent.click(screen.getByRole('button', { name: 'View close close_1' }));

    expect(screen.getByText('No tender totals')).toBeInTheDocument();
    expect(screen.getByText('No drawer variances')).toBeInTheDocument();
  });

  it('renders list loading and retryable generic-error states', () => {
    mocks.bills.isLoading = true;
    const loading = renderConsole();
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch_1' } });
    expect(screen.getByRole('status', { name: 'Loading bills' })).toBeInTheDocument();
    loading.unmount();

    mocks.bills.isLoading = false;
    mocks.bills.error = { message: 'Read unavailable', data: { code: 'INTERNAL_SERVER_ERROR' } };
    renderConsole();
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch_1' } });
    expect(screen.getByText('Could not load bills')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.bills.refetch).toHaveBeenCalledOnce();
  });

  it('renders a distinct permission-denied state', () => {
    mocks.bills.error = {
      message: 'Forbidden',
      data: { code: 'FORBIDDEN' },
    };
    renderConsole();
    fireEvent.change(screen.getByLabelText('Branch'), { target: { value: 'branch_1' } });
    expect(screen.getByText('Restaurant Finance access denied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('links only entitled Restaurant Finance companion surfaces', () => {
    const enabled = renderConsole();
    expect(screen.getByRole('link', { name: 'Tax' })).toHaveAttribute('href', '/restaurant/tax');
    expect(screen.getByRole('link', { name: 'Purchasing' })).toHaveAttribute(
      'href',
      '/restaurant/purchasing'
    );
    expect(screen.getByRole('link', { name: 'Advanced Insights' })).toHaveAttribute(
      'href',
      '/restaurant/insights'
    );
    enabled.unmount();

    renderConsole(false);
    expect(screen.getByRole('link', { name: 'Tax' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Purchasing' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Advanced Insights' })).not.toBeInTheDocument();
  });
});

it('shows the stored card machine refund reference in the refunds ledger', async () => {
  renderConsole(true, 'payments');
  setBranchAndDate();
  expect(await screen.findByText('Card machine refund reference: BANK-REF-42')).toBeVisible();
});
