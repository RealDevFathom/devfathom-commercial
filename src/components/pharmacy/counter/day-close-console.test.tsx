import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  role: 'ADMIN',
  loading: false,
  error: null as Error | null,
  close: null as Record<string, unknown> | null,
  mutate: vi.fn(),
  previewInput: vi.fn(),
  printZReport: vi.fn(),
  /** The zone the workspace has stored. */
  zone: '',
  /** Per-payment-type totals the preview returns. */
  tenderTotals: [] as {
    type: string;
    amountMinor: number;
    refundMinor: number;
    netMinor: number;
  }[],
  totals: {} as Record<string, number>,
  drawers: null as Record<string, unknown>[] | null,
}));
const OPEN_DRAWER = {
  id: 'd',
  deviceId: 'counter-0f3b9a5e-6c2d-4f1e-9a7b-2c4d6e8f0a1b',
  status: 'OPEN',
  openedAt: new Date('2026-09-29T04:12:00Z'),
  openedBy: 'Ayesha Karim',
  expectedMinor: 12500,
  countedMinor: null,
};
/**
 * The workspace's zone in these fixtures: neither Asia/Karachi (which the screen
 * used to assume) nor the zone the tests run in, so a time or a date that ignored
 * it could not come out right by accident.
 */
const WORKSPACE_ZONE = 'Asia/Tokyo';
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    status: 'authenticated',
    data: {
      user: {
        id: 'owner',
        role: mocks.role,
        organizationId: 'org',
        status: 'ACTIVE',
        sessionRevoked: false,
      },
    },
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
          data: { branches: [{ id: 'b', name: 'Main' }], currency: 'USD', timezone: mocks.zone },
          isSuccess: true,
        }),
      },
      closePreview: {
        useQuery: (input: unknown) => {
          mocks.previewInput(input);
          return {
            isLoading: mocks.loading,
            error: mocks.error,
            refetch: vi.fn(),
            data: {
              branchName: 'Main',
              timezone: mocks.zone,
              close: mocks.close,
              totals: {
                cashExpectedMinor: 12500,
                grossSalesMinor: 0,
                refundTotalMinor: 0,
                sourceHash: 'hash',
                ...mocks.totals,
              },
              tenderTotals: mocks.tenderTotals,
              drawers: mocks.drawers ?? [OPEN_DRAWER],
            },
          };
        },
      },
      closeDay: { useMutation: () => ({ mutate: mocks.mutate, reset: vi.fn() }) },
    },
  },
}));
vi.mock('@/lib/pharmacy/counter-browser-print', () => ({
  printCounterBrowserZReport: mocks.printZReport,
}));
import { workspaceToday } from '@/lib/timezone';
import {
  cashMinor,
  drawerOpenedLabel,
  LOCK_CONSEQUENCE_COPY,
  PharmacyDayCloseConsole,
  RECLOSE_ACCESS_COPY,
  REFRESH_PREVIEW_COPY,
} from './day-close-console';
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  mocks.zone = WORKSPACE_ZONE;
  mocks.role = 'ADMIN';
  mocks.loading = false;
  mocks.error = null;
  mocks.close = null;
  mocks.tenderTotals = [];
  mocks.totals = {};
  mocks.drawers = null;
  mocks.mutate.mockReset();
  mocks.previewInput.mockReset();
  mocks.printZReport.mockReset();
});
describe('day-close console', () => {
  it('uses the organization currency throughout reconciliation', () => {
    render(<PharmacyDayCloseConsole />);

    expect(screen.getByText('Pharmacy · USD')).toBeInTheDocument();
    expect(screen.getByText('Expected cash · USD')).toBeInTheDocument();
    expect(screen.getByText('Counted cash · USD')).toBeInTheDocument();
    expect(screen.getByText('Variance · USD')).toBeInTheDocument();
    expect(screen.getByText('Expected: USD 125.00')).toBeInTheDocument();
    expect(screen.getByLabelText('Counted cash for drawer 1 (USD)')).toBeInTheDocument();
    expect(screen.queryByText(/PKR/)).not.toBeInTheDocument();
  });

  it('uses the organization currency in a recorded close and the printable Z-report', () => {
    const recorded = {
      id: 'c1',
      sequence: 1,
      supersedesCloseId: null,
      reason: null,
      grossSalesMinor: 10000,
      refundTotalMinor: 0,
      netSalesMinor: 10000,
      cashExpectedMinor: 10000,
      cashCountedMinor: 10000,
      cashVarianceMinor: 0,
      isFinal: true,
    };
    mocks.close = recorded;
    render(<PharmacyDayCloseConsole />);

    expect(screen.getByText('Pharmacy · USD')).toBeInTheDocument();
    expect(screen.getByText('Expected cash · USD')).toBeInTheDocument();
    expect(screen.getByText('Counted cash · USD')).toBeInTheDocument();
    expect(screen.getByText('Variance · USD')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Print Z-report' }));
    expect(mocks.printZReport).toHaveBeenCalledWith(
      expect.objectContaining({ ...recorded, currency: 'USD' }),
      'en'
    );
    expect(screen.queryByText(/PKR/)).not.toBeInTheDocument();
  });

  it('parses exact cash minor units without rounding an invalid amount', () => {
    expect(cashMinor('125.01')).toBe(12501);
    expect(cashMinor('0')).toBe(0);
    for (const bad of ['', '-1', '1.001', '1e3', '21474836.48']) expect(cashMinor(bad)).toBeNull();
  });
  it('labels a drawer by its opener and time, never by the device identifier', () => {
    render(<PharmacyDayCloseConsole />);
    const label = screen.getByText(/^Drawer 1 ·/);
    expect(label).toHaveTextContent(
      /Drawer 1 · Opened \d{2}:\d{2} by Ayesha Karim · Drawer still open/
    );
    expect(label).not.toHaveTextContent(/counter-0f3b9a5e/);
    expect(
      drawerOpenedLabel({ openedAt: '2026-09-29T04:12:00Z', openedBy: null }, WORKSPACE_ZONE)
    ).toMatch(/^Opened \d{2}:\d{2}$/);
  });
  it('reads every time on the screen in the workspace zone, not the browser’s', () => {
    // The guard that makes this test mean something wherever it runs.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).not.toBe(WORKSPACE_ZONE);
    // 04:12 UTC is 13:12 in Tokyo, 09:12 in Karachi.
    render(<PharmacyDayCloseConsole />);
    expect(screen.getByText(/^Drawer 1 ·/)).toHaveTextContent(
      'Drawer 1 · Opened 13:12 by Ayesha Karim · Drawer still open'
    );
    expect(
      drawerOpenedLabel({ openedAt: '2026-09-29T04:12:00Z', openedBy: null }, 'America/Chicago')
    ).toBe('Opened 23:12');
  });
  it('opens on today in the workspace zone', () => {
    // 16:30 UTC on the 21st is already the 22nd in Tokyo, still the 21st in
    // Karachi and in UTC.
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-21T16:30:00.000Z') });
    expect(workspaceToday(WORKSPACE_ZONE)).toBe('2026-10-22');
    render(<PharmacyDayCloseConsole />);
    expect(screen.getByLabelText('Business date')).toHaveValue('2026-10-22');
    expect(mocks.previewInput).toHaveBeenLastCalledWith({
      branchId: 'b',
      businessDate: new Date('2026-10-22T00:00:00.000Z'),
    });
  });
  it.each(['PKT', 'UTC+5'])(
    'still renders, in UTC, for a stored zone Intl refuses (%s)',
    (zone) => {
      // Settings once saved any text; Intl throws a RangeError on such a zone.
      expect(() => new Intl.DateTimeFormat('en', { timeZone: zone })).toThrow(RangeError);
      mocks.zone = zone;
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-21T22:30:00.000Z') });
      render(<PharmacyDayCloseConsole />);
      // 04:12 UTC; and 22:30 UTC on the 21st is still the 21st in UTC.
      expect(screen.getByText(/^Drawer 1 ·/)).toHaveTextContent(
        'Drawer 1 · Opened 04:12 by Ayesha Karim · Drawer still open'
      );
      expect(screen.getByLabelText('Business date')).toHaveValue('2026-10-21');
      expect(screen.getByRole('button', { name: 'Close and lock day' })).toBeInTheDocument();
      expect(drawerOpenedLabel({ openedAt: '2026-09-29T04:12:00Z', openedBy: null }, zone)).toBe(
        'Opened 04:12'
      );
    }
  );
  it('shows permission denial for a non-administrator', () => {
    mocks.role = 'MEMBER';
    render(<PharmacyDayCloseConsole />);
    expect(screen.getByText(/Sign in as a pharmacy administrator/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close and lock day' })).not.toBeInTheDocument();
  });
  it('shows loading and retryable errors', () => {
    mocks.loading = true;
    const view = render(<PharmacyDayCloseConsole />);
    expect(screen.getByText(/Loading cash movements/)).toBeInTheDocument();
    mocks.loading = false;
    mocks.error = new Error('Network unavailable');
    view.rerender(<PharmacyDayCloseConsole />);
    expect(screen.getByRole('alert')).toHaveTextContent('Network unavailable');
    expect(screen.getByRole('button', { name: 'Retry preview' })).toBeInTheDocument();
  });
  it('labels a re-close reason as the reopen reason, and a first close reason as the variance note', () => {
    const recorded = { cashExpectedMinor: 12500, cashCountedMinor: 12400, isFinal: true };
    mocks.close = { ...recorded, id: 'c1', sequence: 1, supersedesCloseId: null, reason: 'Short' };
    const view = render(<PharmacyDayCloseConsole />);
    expect(screen.getByText('Variance note: Short')).toBeInTheDocument();
    mocks.close = { ...recorded, id: 'c1', sequence: 1, supersedesCloseId: null, reason: null };
    view.rerender(<PharmacyDayCloseConsole />);
    expect(screen.getByText('Variance note: No variance recorded.')).toBeInTheDocument();
    mocks.close = {
      ...recorded,
      id: 'c2',
      sequence: 2,
      supersedesCloseId: 'c1',
      reason: 'Late refund',
    };
    view.rerender(<PharmacyDayCloseConsole />);
    expect(screen.getByText('Reopen reason: Late refund')).toBeInTheDocument();
    expect(screen.queryByText(/^Variance note:/)).not.toBeInTheDocument();
    mocks.close = {
      ...recorded,
      id: 'c3',
      sequence: 3,
      supersedesCloseId: null,
      reason: 'Recount',
    };
    view.rerender(<PharmacyDayCloseConsole />);
    expect(screen.getByText('Reopen reason: Recount')).toBeInTheDocument();
  });
  it('requires a count, variance note and explicit confirmation before submitting', () => {
    render(<PharmacyDayCloseConsole />);
    const submit = screen.getByRole('button', { name: 'Close and lock day' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Counted cash for drawer 1 (USD)'), {
      target: { value: '124.00' },
    });
    expect(screen.getByTestId('Variance')).toHaveTextContent('-1.00');
    fireEvent.click(screen.getByRole('checkbox'));
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Variance note/), {
      target: { value: 'Short by one dollar' },
    });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        counts: [{ drawerSessionId: 'd', countedCashMinor: 12400 }],
        varianceNote: 'Short by one dollar',
      })
    );
  });
  it('never shows a drawer as "Closed" beside an open-day badge', () => {
    mocks.drawers = [{ ...OPEN_DRAWER, status: 'CLOSED', countedMinor: 12500 }];
    render(<PharmacyDayCloseConsole />);
    expect(screen.getByText('Day not locked yet')).toBeInTheDocument();
    expect(screen.getByText(/^Drawer 1 ·/)).toHaveTextContent(
      'Drawer already counted and closed at the counter'
    );
    expect(screen.queryByText('Open day')).not.toBeInTheDocument();
    expect(screen.queryByText(/· Closed$/)).not.toBeInTheDocument();
  });
  it('lists why Close and lock day is disabled and ties the reasons to the button', () => {
    render(<PharmacyDayCloseConsole />);
    const submit = screen.getByRole('button', { name: 'Close and lock day' });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAccessibleDescription(
      /Drawer 1 is still open: enter its counted cash\..*Tick the box/
    );
    fireEvent.change(screen.getByLabelText('Counted cash for drawer 1 (USD)'), {
      target: { value: '124.00' },
    });
    expect(submit).toHaveAccessibleDescription(/write a variance note/);
    expect(submit).not.toHaveAccessibleDescription(/is still open/);
    fireEvent.change(screen.getByLabelText(/Variance note/), { target: { value: 'Short' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(submit).toBeEnabled();
    expect(screen.queryByText(/is not available yet/)).not.toBeInTheDocument();
    expect(submit).toHaveAccessibleDescription(new RegExp(LOCK_CONSEQUENCE_COPY));
  });
  it('marks the variance note required only when a count differs', () => {
    render(<PharmacyDayCloseConsole />);
    const note = screen.getByLabelText(/Variance note/);
    expect(note).toHaveAttribute('aria-required', 'false');
    expect(screen.queryByText('(required)')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Counted cash for drawer 1 (USD)'), {
      target: { value: '125.00' },
    });
    expect(note).toHaveAttribute('aria-required', 'false');
    fireEvent.change(screen.getByLabelText('Counted cash for drawer 1 (USD)'), {
      target: { value: '120.00' },
    });
    expect(note).toHaveAttribute('aria-required', 'true');
    expect(note).toBeRequired();
    expect(screen.getByText('(required)')).toBeInTheDocument();
  });
  it('says the lock cannot be undone and who can issue a corrected report', () => {
    const view = render(<PharmacyDayCloseConsole />);
    expect(screen.getByText(LOCK_CONSEQUENCE_COPY)).toBeInTheDocument();
    expect(screen.getByText(RECLOSE_ACCESS_COPY)).toBeInTheDocument();
    mocks.close = { id: 'c1', sequence: 1, supersedesCloseId: null, reason: null, isFinal: true };
    view.rerender(<PharmacyDayCloseConsole />);
    expect(screen.getByText('Day locked')).toBeInTheDocument();
    expect(screen.getByText(RECLOSE_ACCESS_COPY)).toBeInTheDocument();
  });
  it('explains zero totals and what Refresh preview does', () => {
    mocks.drawers = [];
    mocks.totals = { cashExpectedMinor: 0 };
    render(<PharmacyDayCloseConsole />);
    expect(
      screen.getByText(/no completed sales, refunds or drawer cash movements/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh preview' })).toHaveAccessibleDescription(
      REFRESH_PREVIEW_COPY
    );
  });
  it('shows card, credit and returns beside cash, in the organization currency', () => {
    mocks.totals = { grossSalesMinor: 9000, refundTotalMinor: 700 };
    mocks.tenderTotals = [
      { type: 'CARD', amountMinor: 3000, refundMinor: 0, netMinor: 3000 },
      { type: 'CASH', amountMinor: 5000, refundMinor: 700, netMinor: 4300 },
      { type: 'CREDIT', amountMinor: 1000, refundMinor: 0, netMinor: 1000 },
    ];
    render(<PharmacyDayCloseConsole />);
    expect(screen.getByText('Payment types')).toBeInTheDocument();
    expect(screen.getByTestId('Cash received')).toHaveTextContent('50.00');
    expect(screen.getByTestId('Card received')).toHaveTextContent('30.00');
    expect(screen.getByTestId('Credit (khata) given')).toHaveTextContent('10.00');
    expect(screen.getByTestId('Returns refunded')).toHaveTextContent('7.00');
    expect(screen.getByText('Returns refunded · USD')).toBeInTheDocument();
    expect(screen.queryByText(/no completed sales/)).not.toBeInTheDocument();
    expect(screen.queryByText(/tender/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/PKR/)).not.toBeInTheDocument();
  });
});
