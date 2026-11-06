import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  holds: {
    data: { items: [] as unknown[], nextCursor: null as string | null },
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  },
  recovery: { data: null as unknown, isFetching: false, isError: false, refetch: vi.fn() },
  resolve: vi.fn(),
}));
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    status: 'authenticated',
    data: { user: { id: 'user', organizationId: 'org', status: 'ACTIVE', sessionRevoked: false } },
  }),
}));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ organizationId: 'org', enabledModules: ['pharmacy-counter'] }),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacySales: {
      counterBranches: {
        useQuery: () => ({
          isSuccess: true,
          isLoading: false,
          isError: false,
          data: { branches: [{ id: 'branch', name: 'Test branch', code: 'A' }] },
        }),
      },
      pendingOfflinePayments: { useQuery: () => mocks.holds },
      recoverPaymentCollection: { useQuery: () => mocks.recovery },
      manualPaymentSettings: {
        useQuery: () => ({
          data: { settings: { RAAST: { destination: 'Test IBAN', allowReferenceSkip: true } } },
          isError: false,
          isFetching: false,
        }),
      },
      resolveManualCollection: {
        useMutation: () => ({ mutateAsync: mocks.resolve, isPending: false }),
      },
    },
  },
}));
import {
  OfflineHoldList,
  PendingOfflinePayments,
  type OfflineHoldRow,
} from './pending-offline-payments';
const row: OfflineHoldRow = {
  id: 'attempt',
  saleId: 'bill',
  state: 'PREPARED',
  method: 'RAAST',
  amountMinor: 950,
  currency: 'PKR',
  createdAt: new Date('2026-11-06T12:00Z'),
  canResolve: false,
};
const detail = { ...row, deviceId: 'original-device', requestKey: 'original-key', result: null };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.holds.data = { items: [row], nextCursor: null };
  mocks.holds.isError = false;
  mocks.holds.isFetching = false;
  mocks.recovery.data = detail;
  mocks.recovery.isError = false;
  mocks.recovery.isFetching = false;
});
describe('pending offline payment management', () => {
  it('withdraws cached review authority when the current hold read fails', () => {
    mocks.holds.isError = true;
    mocks.recovery.data = { ...detail, canResolve: true };
    const { rerender } = render(<PendingOfflinePayments />);
    expect(screen.queryByRole('button', { name: 'Confirm funds arrived' })).not.toBeInTheDocument();
    mocks.holds.isError = false;
    rerender(<PendingOfflinePayments />);
    fireEvent.click(screen.getByRole('button', { name: 'Review bill bill' }));
    expect(screen.getByRole('button', { name: 'Confirm funds arrived' })).toBeVisible();
    mocks.holds.isError = true;
    rerender(<PendingOfflinePayments />);
    expect(screen.queryByRole('button', { name: 'Confirm funds arrived' })).not.toBeInTheDocument();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it('lets a cashier discover and inspect a server hold without confirmation controls', () => {
    render(<PendingOfflinePayments />);
    fireEvent.click(screen.getByRole('button', { name: 'Review bill bill' }));
    expect(screen.getByText(/Only an authorized Owner or Manager/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Confirm funds arrived' })).not.toBeInTheDocument();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Open bill in counter' })).toHaveAttribute(
      'href',
      '/pharmacy/counter?branchId=branch&orderSaleId=bill'
    );
  });
  it('uses fresh server authority and resolves the original hold only with a reason and evidence', async () => {
    mocks.recovery.data = { ...detail, canResolve: true };
    mocks.resolve.mockResolvedValue({
      state: 'SETTLED',
      result: { tenderId: 'tender', settled: true, receiptNumber: 42, remainingMinor: 0 },
    });
    render(<PendingOfflinePayments />);
    fireEvent.click(screen.getByRole('button', { name: 'Review bill bill' }));
    fireEvent.change(screen.getByLabelText('Reason for decision'), {
      target: { value: 'Checked account and original counter evidence' },
    });
    fireEvent.change(screen.getByLabelText('Payer’s name for confirmation'), {
      target: { value: 'Ayesha' },
    });
    fireEvent.click(screen.getByLabelText('Skip transaction ID under branch policy'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm funds arrived' }));
    await screen.findByText(/Payment recorded after authorized review/);
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch',
      attemptId: 'attempt',
      decision: 'CONFIRM',
      reason: 'Checked account and original counter evidence',
      payerName: 'Ayesha',
      referenceSkipped: true,
    });
    expect(mocks.holds.refetch).toHaveBeenCalled();
  });
  it.each([null, { ...detail, saleId: 'foreign-bill' }])(
    'fails closed for missing or mismatched recovery (%j)',
    (data) => {
      mocks.recovery.data = data;
      render(<PendingOfflinePayments />);
      fireEvent.click(screen.getByRole('button', { name: 'Review bill bill' }));
      expect(screen.getByText(/This payment could not be verified/)).toBeVisible();
      expect(
        screen.queryByRole('button', { name: 'Confirm funds arrived' })
      ).not.toBeInTheDocument();
    }
  );
  it('does not claim completion after a malformed acknowledgement', async () => {
    mocks.recovery.data = { ...detail, canResolve: true };
    mocks.resolve.mockResolvedValue({
      state: 'SETTLED',
      result: { tenderId: 'bad', settled: true, receiptNumber: null, remainingMinor: 950 },
    });
    render(<PendingOfflinePayments />);
    fireEvent.click(screen.getByRole('button', { name: 'Review bill bill' }));
    fireEvent.change(screen.getByLabelText('Reason for decision'), {
      target: { value: 'No unrecorded funds' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Release pending claim' }));
    await screen.findByText(/Resolution could not be confirmed/);
    expect(screen.queryByText(/Payment recorded after authorized review/)).not.toBeInTheDocument();
    expect(mocks.holds.refetch).not.toHaveBeenCalled();
  });
  it('shows readable loading, empty and failed-read states with pagination', () => {
    const props = {
      items: [],
      loading: true,
      error: false,
      nextCursor: null,
      paged: false,
      disabled: false,
      onReview: vi.fn(),
      onRefresh: vi.fn(),
      onNext: vi.fn(),
      onFirst: vi.fn(),
    };
    const { rerender } = render(<OfflineHoldList {...props} />);
    expect(screen.getByText('Checking pending payments…')).toBeVisible();
    rerender(<OfflineHoldList {...props} loading={false} />);
    expect(screen.getByText(/No pending offline payments are visible/)).toBeVisible();
    rerender(<OfflineHoldList {...props} loading={false} error />);
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be read/);
    rerender(<OfflineHoldList {...props} loading={false} items={[row]} paged nextCursor="next" />);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(props.onNext).toHaveBeenCalledOnce();
  });
});
