import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CashShiftReport } from '@/lib/pharmacy/cash-shift-report';

const report: CashShiftReport = {
  shiftId: 'shift-1',
  sequence: 1,
  drawerSessionId: 'drawer-1',
  deviceId: 'device-1',
  businessDate: '2026-11-19',
  cashier: { id: 'cashier-a', name: 'Ayesha' },
  openedBy: { id: 'cashier-a', name: 'Ayesha' },
  openedAt: '2026-11-19T04:00:00.000Z',
  openingDifferenceMinor: 0,
  openingNote: null,
  closedBy: null,
  closedAt: null,
  countedMinor: null,
  varianceMinor: null,
  varianceNote: null,
  varianceApprovedBy: null,
  varianceApprovalPolicy: null,
  toleranceMinor: 500,
  tenders: [{ type: 'CASH', count: 2, amountMinor: 1_500 }],
  refunds: [],
  salesCount: 2,
  tenderTotalMinor: 1_500,
  refundTotalMinor: 0,
  netTakenMinor: 1_500,
  cash: {
    openingFloatMinor: 10_000,
    cashSalesMinor: 1_500,
    cashRefundsMinor: 0,
    paidInMinor: 0,
    paidOutMinor: 0,
    expectedMinor: 11_500,
  },
};

const mocks = vi.hoisted(() => ({
  closeMutate: vi.fn(),
  openMutate: vi.fn(),
  approvers: [{ id: 'manager-b', name: 'Bilal', isYou: false }],
}));

vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      shiftReport: {
        useQuery: (_input: unknown, options: { enabled?: boolean }) => ({
          data:
            options.enabled === false
              ? undefined
              : { report: { ...report, status: 'OPEN' }, toleranceMinor: 500, currency: 'PKR' },
          isLoading: false,
          error: null,
          refetch: vi.fn(),
        }),
      },
      shiftApprovers: {
        useQuery: () => ({ data: mocks.approvers, isLoading: false }),
      },
      closeShift: {
        useMutation: () => ({ mutate: mocks.closeMutate, isPending: false, error: null }),
      },
      openShift: {
        useMutation: () => ({ mutate: mocks.openMutate, isPending: false, error: null }),
      },
    },
  },
}));

import { CounterCashShiftPanel } from './counter-cash-shift-panel';
import { CashShiftReportView, shiftVarianceLabel } from './cash-shift-report-view';

const openShift = {
  id: 'shift-1',
  sequence: 1,
  cashierName: 'Ayesha',
  isYours: true,
  openedAt: '2026-11-19T04:00:00.000Z',
  countedCashMinor: null,
};

function panel(status: Parameters<typeof CounterCashShiftPanel>[0]['status']) {
  return render(
    <CounterCashShiftPanel
      branchId="branch-a"
      drawerSessionId="drawer-1"
      status={status}
      currency="PKR"
      timeZone="Asia/Karachi"
      actorIsManager={false}
      currentUserId="cashier-a"
      onChanged={vi.fn()}
    />
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('DEV-958B counter cash shift panel', () => {
  it('closes a balanced shift with the count alone', () => {
    panel({ openShift, lastClosedShift: null, currency: 'PKR' });
    fireEvent.click(screen.getByRole('button', { name: 'Close shift' }));
    expect(screen.getByText(/Cash expected in the drawer/)).toHaveTextContent('PKR 115.00');
    fireEvent.change(screen.getByLabelText('Cash counted (PKR)'), { target: { value: '115' } });
    expect(screen.getByText('Balanced')).toBeInTheDocument();
    expect(screen.queryByLabelText('Why the count differs')).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Close shift' }).at(-1)!);
    expect(mocks.closeMutate).toHaveBeenCalledWith(
      { branchId: 'branch-a', shiftId: 'shift-1', countedCashMinor: 11_500 },
      expect.anything()
    );
  });

  it('asks for a note within the tolerance, and a manager and PIN above it', () => {
    panel({ openShift, lastClosedShift: null, currency: 'PKR' });
    fireEvent.click(screen.getByRole('button', { name: 'Close shift' }));
    const count = screen.getByLabelText('Cash counted (PKR)');
    fireEvent.change(count, { target: { value: '112' } });
    expect(screen.getByText('Short PKR 3.00')).toBeInTheDocument();
    expect(screen.getByLabelText('Why the count differs')).toBeInTheDocument();
    expect(screen.queryByText('Manager approval')).not.toBeInTheDocument();
    // Not sent without the note.
    fireEvent.click(screen.getAllByRole('button', { name: 'Close shift' }).at(-1)!);
    expect(mocks.closeMutate).not.toHaveBeenCalled();

    fireEvent.change(count, { target: { value: '105' } });
    const approval = screen.getByRole('group', { name: 'Manager approval' });
    fireEvent.change(screen.getByLabelText('Why the count differs'), {
      target: { value: 'Ten short' },
    });
    fireEvent.change(within(approval).getByLabelText('Approved by'), {
      target: { value: 'manager-b' },
    });
    fireEvent.change(within(approval).getByLabelText('Their PIN'), { target: { value: '4826' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Close shift' }).at(-1)!);
    expect(mocks.closeMutate).toHaveBeenCalledWith(
      {
        branchId: 'branch-a',
        shiftId: 'shift-1',
        countedCashMinor: 10_500,
        varianceNote: 'Ten short',
        approval: { approverId: 'manager-b', approverPin: '4826' },
      },
      expect.anything()
    );
  });

  it("says who may close another cashier's shift, and offers no close", () => {
    panel({
      openShift: { ...openShift, isYours: false, cashierName: 'Bilal' },
      lastClosedShift: null,
      currency: 'PKR',
    });
    expect(screen.queryByRole('button', { name: 'Close shift' })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Only Bilal or a manager or owner can close this shift/)
    ).toBeInTheDocument();
  });

  it('opens the next shift, with a note when the count differs from what was left', () => {
    panel({
      openShift: null,
      lastClosedShift: { ...openShift, isYours: false, countedCashMinor: 11_500 },
      currency: 'PKR',
    });
    const count = screen.getByLabelText('Cash counted in the drawer (PKR)');
    fireEvent.change(count, { target: { value: '115.20' } });
    expect(screen.getByText('More than the last shift left by PKR 0.20.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open shift' }));
    expect(mocks.openMutate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Why the count differs'), {
      target: { value: 'Coins under the tray' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open shift' }));
    expect(mocks.openMutate).toHaveBeenCalledWith(
      {
        branchId: 'branch-a',
        drawerSessionId: 'drawer-1',
        openingFloatMinor: 11_520,
        openingNote: 'Coins under the tray',
      },
      expect.anything()
    );
  });
});

describe('DEV-958B shift report', () => {
  it('shows sales by payment, cash in and out, the count and the over or short in words', () => {
    render(
      <CashShiftReportView
        report={{
          ...report,
          closedBy: { id: 'manager-b', name: 'Bilal' },
          closedAt: '2026-11-19T12:00:00.000Z',
          countedMinor: 11_450,
          varianceMinor: -50,
          varianceNote: 'Fifty short',
          varianceApprovedBy: { id: 'manager-b', name: 'Bilal' },
        }}
        status="CLOSED"
        currency="PKR"
        timeZone="Asia/Karachi"
      />
    );
    expect(screen.getByRole('heading', { name: 'Shift 1 · Ayesha' })).toBeInTheDocument();
    expect(screen.getByText(/Opened 09:00 by Ayesha · closed 17:00 by Bilal/)).toBeInTheDocument();
    expect(screen.getAllByText('Short PKR 0.50').length).toBeGreaterThan(0);
    expect(screen.getByText('Note: Fifty short')).toBeInTheDocument();
    expect(
      screen.getByText(/approved by Bilal \(their own close, with their PIN\)/)
    ).toBeInTheDocument();
    expect(screen.getByText('No refunds in this shift.')).toBeInTheDocument();
  });

  it('DEV-977B: shows the lines taken off bills in the shift, and nothing for an older report', () => {
    const { unmount } = render(
      <CashShiftReportView
        report={{ ...report, lineVoids: { count: 2, valueMinor: 2_100 } }}
        status="OPEN"
        currency="PKR"
        timeZone="Asia/Karachi"
      />
    );
    const voids = screen.getByLabelText('Shift 1 lines taken off bills');
    expect(within(voids).getByText('Lines taken off bills (2)')).toBeInTheDocument();
    expect(within(voids).getByText('PKR 21.00')).toBeInTheDocument();
    unmount();
    render(
      <CashShiftReportView report={report} status="OPEN" currency="PKR" timeZone="Asia/Karachi" />
    );
    expect(screen.queryByText(/Lines taken off bills/)).not.toBeInTheDocument();
  });

  it("offline, never says whose shift it is on the stored session's word", () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      mocks.approvers = [{ id: 'cashier-a', name: 'Ayesha', isYou: true }];
      panel({ openShift, lastClosedShift: null, currency: 'PKR' });
      expect(screen.queryByText(/Your shift/)).not.toBeInTheDocument();
      expect(screen.getByText(/Ayesha's shift/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Close shift' }));
      fireEvent.change(screen.getByLabelText('Cash counted (PKR)'), { target: { value: '100' } });
      expect(screen.queryByText(/\(you\)/)).not.toBeInTheDocument();
    } finally {
      online.mockRestore();
      mocks.approvers = [{ id: 'manager-b', name: 'Bilal', isYou: false }];
    }
  });

  it('never uses the sign alone', () => {
    expect(shiftVarianceLabel(0, 'PKR')).toBe('Balanced');
    expect(shiftVarianceLabel(25, 'PKR')).toBe('Over PKR 0.25');
    expect(shiftVarianceLabel(-125, 'PKR')).toBe('Short PKR 1.25');
  });
});
