import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  role: 'ADMIN',
  enabledModules: ['pharmacy-counter'],
  sessionStatus: 'authenticated',
  sessionRevoked: false,
  organizationId: 'org',
  branches: [{ id: 'b', name: 'Main' }],
  loading: false,
  error: null as Error | null,
  close: null as Record<string, unknown> | null,
  mutate: vi.fn(),
  previewInput: vi.fn(),
  printZReport: vi.fn(),
  /** The zone the workspace has stored. */
  zone: '',
  /** Findings the read-only cash-close check returns for a closed day. */
  checkFindings: [] as Array<{ kind: string; severity: string; explanation: string }>,
  /** The error the cash-close check query returns, if any. */
  checkError: null as { message: string; data?: { code: string } } | null,
  /** Drawers beyond the one every fixture has, e.g. a second open counter. */
  extraDrawers: [] as Array<Record<string, unknown>>,
  /** The rail capability read (DEV-127): who it answered for and what it granted. */
  accessUserId: 'owner',
  accessCapabilities: [] as string[],
  accessLoading: false,
  accessError: null as { message: string; data?: { code: string } } | null,
  accessOptions: vi.fn(),
}));
/**
 * The workspace's zone in these fixtures: neither Asia/Karachi (which the screen
 * used to assume) nor the zone the tests run in, so a time or a date that ignored
 * it could not come out right by accident.
 */
const WORKSPACE_ZONE = 'Asia/Tokyo';
vi.mock('next-auth/react', () => ({
  useSession: () => ({
    status: mocks.sessionStatus,
    data: {
      user: {
        id: 'owner',
        role: mocks.role,
        organizationId: mocks.organizationId,
        status: 'ACTIVE',
        sessionRevoked: mocks.sessionRevoked,
      },
    },
  }),
}));
vi.mock('@/components/entitlements-provider', () => ({
  useEntitlements: () => ({ organizationId: 'org', enabledModules: mocks.enabledModules }),
}));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    pharmacyAccess: {
      navigation: {
        useQuery: (_input: unknown, options: { enabled: boolean }) => {
          mocks.accessOptions(options);
          if (!options.enabled) return { isLoading: false, data: undefined };
          if (mocks.accessError)
            return { isLoading: false, isError: true, error: mocks.accessError, data: undefined };
          return mocks.accessLoading
            ? { isLoading: true, data: undefined }
            : {
                isLoading: false,
                data: {
                  userId: mocks.accessUserId,
                  organizationId: 'org',
                  capabilities: mocks.accessCapabilities,
                },
              };
        },
      },
    },
    pharmacySales: {
      counterBranches: {
        useQuery: () => ({
          data: { branches: mocks.branches, currency: 'USD', timezone: mocks.zone },
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
              totals: { cashExpectedMinor: 12500, sourceHash: 'hash' },
              tenderTotals: [
                { type: 'CASH', amountMinor: 13000, refundMinor: 500, netMinor: 12500 },
              ],
              drawers: [
                {
                  id: 'd',
                  deviceId: 'counter-0f3b9a5e-6c2d-4f1e-9a7b-2c4d6e8f0a1b',
                  status: 'OPEN',
                  openedAt: new Date('2026-09-29T04:12:00Z'),
                  openedBy: 'Ayesha Karim',
                  expectedMinor: 12500,
                  countedMinor: null,
                },
                ...mocks.extraDrawers,
              ],
            },
          };
        },
      },
      closeDay: { useMutation: () => ({ mutate: mocks.mutate, reset: vi.fn() }) },
      closeAnomalyCheck: {
        useQuery: () => ({
          isLoading: false,
          error: mocks.checkError,
          refetch: vi.fn(),
          data: mocks.checkError
            ? undefined
            : {
                policyVersion: 'CC01-2026-11-01',
                narrative: 'Cash-close check for 2026-09-29 (closed). No rule flagged this close.',
                findings: mocks.checkFindings,
              },
        }),
      },
    },
  },
}));
vi.mock('@/lib/pharmacy/counter-browser-print', () => ({
  printCounterBrowserZReport: mocks.printZReport,
}));
import { workspaceToday } from '@/lib/timezone';
import { cashMinor, drawerOpenedLabel, PharmacyDayCloseConsole } from './day-close-console';
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => {
  mocks.zone = WORKSPACE_ZONE;
  mocks.role = 'ADMIN';
  mocks.enabledModules = ['pharmacy-counter'];
  mocks.sessionStatus = 'authenticated';
  mocks.sessionRevoked = false;
  mocks.organizationId = 'org';
  mocks.branches = [{ id: 'b', name: 'Main' }];
  mocks.loading = false;
  mocks.error = null;
  mocks.close = null;
  mocks.checkFindings = [];
  mocks.checkError = null;
  mocks.extraDrawers = [];
  mocks.accessUserId = 'owner';
  mocks.accessCapabilities = [];
  mocks.accessLoading = false;
  mocks.accessError = null;
  mocks.accessOptions.mockReset();
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
    expect(
      screen.getByText('· Received 130.00 · Refunds 5.00 · Net 125.00 USD')
    ).toBeInTheDocument();
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
      tenderTotals: [{ type: 'CASH', amountMinor: 13000, refundMinor: 500, netMinor: 12500 }],
    };
    mocks.close = recorded;
    render(<PharmacyDayCloseConsole />);

    expect(screen.getByText('Pharmacy · USD')).toBeInTheDocument();
    expect(screen.getByText('Expected cash · USD')).toBeInTheDocument();
    expect(screen.getByText('Counted cash · USD')).toBeInTheDocument();
    expect(screen.getByText('Variance · USD')).toBeInTheDocument();
    expect(
      screen.getByText('· Received 130.00 · Refunds 5.00 · Net 125.00 USD')
    ).toBeInTheDocument();
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
    expect(label).toHaveTextContent(/Drawer 1 · Opened \d{2}:\d{2} by Ayesha Karim · Open/);
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
      'Drawer 1 · Opened 13:12 by Ayesha Karim · Open'
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
        'Drawer 1 · Opened 04:12 by Ayesha Karim · Open'
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
    mocks.accessCapabilities = ['pharmacy:dispense', 'pharmacy:counter'];
    render(<PharmacyDayCloseConsole />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'This day-close screen requires day-close permission. Ask your workspace administrator to review your day-close permission.'
    );
    expect(screen.queryByRole('button', { name: 'Close and lock day' })).not.toBeInTheDocument();
    expect(mocks.previewInput).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it('opens the close for a Pharmacist the server grants pharmacy:close (DEV-127)', () => {
    mocks.role = 'EMPLOYEE';
    mocks.accessCapabilities = ['pharmacy:dispense', 'pharmacy:close'];
    render(<PharmacyDayCloseConsole />);
    expect(mocks.accessOptions).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    expect(screen.queryByText('Day close unavailable')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close and lock day' })).toBeInTheDocument();
    expect(mocks.previewInput).toHaveBeenCalledWith(expect.objectContaining({ branchId: 'b' }));
  });
  it('keeps the owner-only cash-close check from a Pharmacist closer (DEV-127)', () => {
    mocks.role = 'EMPLOYEE';
    mocks.accessCapabilities = ['pharmacy:close'];
    mocks.close = {
      cashExpectedMinor: 12500,
      cashCountedMinor: 12500,
      isFinal: true,
      id: 'c1',
      sequence: 1,
      supersedesCloseId: null,
      reason: null,
    };
    render(<PharmacyDayCloseConsole />);
    expect(mocks.previewInput).toHaveBeenCalled();
    expect(screen.queryByText('Cash-close check')).not.toBeInTheDocument();
  });
  it('waits for the day-close grant before opening the close for a member (DEV-127)', () => {
    mocks.role = 'EMPLOYEE';
    mocks.accessLoading = true;
    render(<PharmacyDayCloseConsole />);
    expect(screen.getByRole('status')).toHaveTextContent('Checking day-close access…');
    expect(mocks.previewInput).not.toHaveBeenCalled();
  });
  it('ignores a day-close grant answered for another signed-in identity (DEV-127)', () => {
    mocks.role = 'EMPLOYEE';
    mocks.accessUserId = 'someone-else';
    mocks.accessCapabilities = ['pharmacy:close'];
    render(<PharmacyDayCloseConsole />);
    expect(screen.getByText('Day close unavailable')).toBeInTheDocument();
    expect(mocks.previewInput).not.toHaveBeenCalled();
  });
  it('does not blame permissions when the day-close grant could not be read (DEV-127)', () => {
    mocks.role = 'EMPLOYEE';
    mocks.accessError = { message: 'Network unavailable', data: { code: 'INTERNAL_SERVER_ERROR' } };
    render(<PharmacyDayCloseConsole />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Could not check day-close access. Reload the page to try again.'
    );
    expect(mocks.previewInput).not.toHaveBeenCalled();
  });
  it('treats a refused day-close grant read as a missing permission (DEV-127)', () => {
    mocks.role = 'EMPLOYEE';
    mocks.accessError = { message: 'Forbidden', data: { code: 'FORBIDDEN' } };
    render(<PharmacyDayCloseConsole />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'This day-close screen requires day-close permission.'
    );
  });
  it('retries a transient day-close grant failure but never a refusal (DEV-127)', () => {
    mocks.role = 'EMPLOYEE';
    render(<PharmacyDayCloseConsole />);
    const { retry } = mocks.accessOptions.mock.calls[0][0] as {
      retry: (failures: number, error: { data?: { code: string } }) => boolean;
    };
    expect(retry(0, { data: { code: 'INTERNAL_SERVER_ERROR' } })).toBe(true);
    expect(retry(2, { data: { code: 'INTERNAL_SERVER_ERROR' } })).toBe(false);
    expect(retry(0, { data: { code: 'FORBIDDEN' } })).toBe(false);
  });
  it('does not ask the rail read for an administrator', () => {
    render(<PharmacyDayCloseConsole />);
    expect(mocks.accessOptions).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(screen.getByRole('button', { name: 'Close and lock day' })).toBeInTheDocument();
  });
  it('names the missing counter module for an administrator', () => {
    mocks.enabledModules = [];
    render(<PharmacyDayCloseConsole />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'The Pharmacy Counter module is not enabled for this workspace. Ask your workspace administrator to enable it for day close.'
    );
    expect(mocks.previewInput).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it('preserves session recovery guidance instead of requesting a permission grant', () => {
    mocks.sessionRevoked = true;
    render(<PharmacyDayCloseConsole />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Your session has ended. Please sign in again.'
    );
    expect(mocks.previewInput).not.toHaveBeenCalled();
  });
  it('asks a signed-out operator to sign in to the pharmacy workspace', () => {
    mocks.sessionStatus = 'unauthenticated';
    render(<PharmacyDayCloseConsole />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Sign in to this pharmacy workspace to reconcile and close a day.'
    );
    expect(mocks.previewInput).not.toHaveBeenCalled();
  });
  it('does not blame permission while access is loading', () => {
    mocks.sessionStatus = 'loading';
    render(<PharmacyDayCloseConsole />);
    expect(screen.getByRole('status')).toHaveTextContent('Checking day-close access…');
    expect(mocks.previewInput).not.toHaveBeenCalled();
  });
  it('asks an operator in another workspace to sign in to this pharmacy', () => {
    mocks.organizationId = 'other-org';
    render(<PharmacyDayCloseConsole />);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Sign in to this pharmacy workspace to reconcile and close a day.'
    );
    expect(mocks.previewInput).not.toHaveBeenCalled();
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
  it('warns that locking the day is permanent and cannot be reopened, before and after the close', () => {
    const view = render(<PharmacyDayCloseConsole />);
    const warning = screen.getByRole('note', { name: 'Locking is permanent' });
    expect(warning).toHaveTextContent('Locking this day cannot be undone.');
    expect(warning).toHaveTextContent(/nobody, including the owner, can reopen/);
    // A superseding close report is a correction, not a reopen: the day stays locked.
    expect(warning).toHaveTextContent(
      /re-record the close report with a reason, but that never reopens the day/
    );
    expect(screen.getByLabelText(/locking this day is permanent/)).toBeInTheDocument();
    mocks.close = {
      id: 'c1',
      sequence: 1,
      supersedesCloseId: null,
      reason: null,
      cashExpectedMinor: 12500,
      cashCountedMinor: 12500,
      isFinal: true,
    };
    view.rerender(<PharmacyDayCloseConsole />);
    expect(
      screen.getByText(/The lock is permanent: nobody, including the owner, can reopen/)
    ).toHaveTextContent(/re-record this close report with a reason, but that never reopens the day/);
  });
  it('totals counted cash live from the drawers entered so far', () => {
    mocks.extraDrawers = [
      {
        id: 'd2',
        deviceId: 'counter-2',
        status: 'OPEN',
        openedAt: new Date('2026-09-29T05:00:00Z'),
        openedBy: 'Bilal Ahmed',
        expectedMinor: 0,
        countedMinor: null,
      },
    ];
    render(<PharmacyDayCloseConsole />);
    expect(screen.getByTestId('Counted cash')).toHaveTextContent('Awaiting count');
    fireEvent.change(screen.getByLabelText('Counted cash for drawer 1 (USD)'), {
      target: { value: '100.00' },
    });
    expect(screen.getByTestId('Counted cash')).toHaveTextContent('100.00');
    expect(screen.getByText(/1 of 2 open drawers counted/)).toBeInTheDocument();
    // The variance waits for every drawer: a partial count is not a shortfall.
    expect(screen.getByTestId('Variance')).toHaveTextContent('Awaiting count');
    fireEvent.change(screen.getByLabelText('Counted cash for drawer 2 (USD)'), {
      target: { value: '25.50' },
    });
    expect(screen.getByTestId('Counted cash')).toHaveTextContent('125.50');
    expect(screen.getByTestId('Variance')).toHaveTextContent('0.50');
    expect(screen.queryByText(/open drawers counted/)).not.toBeInTheDocument();
  });
  it('says inline why the close button is disabled, and clears the reason once it is not', () => {
    render(<PharmacyDayCloseConsole />);
    const submit = screen.getByRole('button', { name: 'Close and lock day' });
    expect(submit).toBeDisabled();
    expect(submit).toHaveAttribute('aria-describedby', 'day-close-blocked');
    const reasons = () => document.getElementById('day-close-blocked');
    expect(reasons()).toHaveTextContent('Enter the counted cash for drawer 1.');
    expect(reasons()).toHaveTextContent('Tick the confirmation');
    fireEvent.change(screen.getByLabelText('Counted cash for drawer 1 (USD)'), {
      target: { value: '124.00' },
    });
    expect(reasons()).toHaveTextContent('Add a variance note');
    expect(reasons()).not.toHaveTextContent('Enter the counted cash');
    fireEvent.change(screen.getByLabelText(/Variance note/), { target: { value: 'Short' } });
    expect(reasons()).not.toHaveTextContent('Add a variance note');
    fireEvent.click(screen.getByRole('checkbox'));
    expect(submit).toBeEnabled();
    expect(reasons()).toBeNull();
    expect(submit).not.toHaveAttribute('aria-describedby');
  });
  it('shows the read-only cash-close check only once the day is closed', () => {
    const view = render(<PharmacyDayCloseConsole />);
    expect(screen.queryByText('Cash-close check')).not.toBeInTheDocument();
    mocks.close = {
      cashExpectedMinor: 12500,
      cashCountedMinor: 12400,
      isFinal: true,
      id: 'c1',
      sequence: 1,
      supersedesCloseId: null,
      reason: 'Short',
    };
    mocks.checkFindings = [
      {
        kind: 'UNMATCHED_REFUNDS',
        severity: 'URGENT',
        explanation: '4 refunds totalling USD 900.00 have no matching stock-return record.',
      },
    ];
    view.rerender(<PharmacyDayCloseConsole />);
    expect(screen.getByText('Cash-close check')).toBeInTheDocument();
    expect(screen.getByText('1 to review')).toBeInTheDocument();
    expect(screen.getByText('Urgent')).toBeInTheDocument();
    expect(
      screen.getByText('4 refunds totalling USD 900.00 have no matching stock-return record.')
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing is posted, reopened or sent/)).toBeInTheDocument();
    // Read-only: the panel offers no action beyond the existing close controls.
    expect(screen.queryByRole('button', { name: /acknowledge|resolve|reopen/i })).toBeNull();
  });
  it('says a refused cash-close check is not permitted instead of offering a retry', () => {
    mocks.close = {
      cashExpectedMinor: 12500,
      cashCountedMinor: 12500,
      isFinal: true,
      id: 'c1',
      sequence: 1,
      supersedesCloseId: null,
      reason: null,
    };
    mocks.checkError = {
      message: 'Financial reports permission required.',
      data: { code: 'FORBIDDEN' },
    };
    render(<PharmacyDayCloseConsole />);
    expect(
      screen.getByText(/You don.t have permission to view the cash-close check/)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry check' })).toBeNull();
  });
  it('opens on the deep-linked branch and business day instead of today and the first branch', () => {
    mocks.branches = [
      { id: 'b', name: 'Main' },
      { id: 'b2', name: 'Second' },
    ];
    render(<PharmacyDayCloseConsole initial={{ branch: 'b2', date: '2026-09-20' }} />);
    expect(screen.getByLabelText('Branch')).toHaveValue('b2');
    expect(screen.getByLabelText('Business date')).toHaveValue('2026-09-20');
    expect(mocks.previewInput).toHaveBeenLastCalledWith({
      branchId: 'b2',
      businessDate: new Date('2026-09-20T00:00:00.000Z'),
    });
  });
  it('falls back to defaults for an unknown branch or malformed day in the link', () => {
    render(<PharmacyDayCloseConsole initial={{ branch: 'foreign', date: 'yesterday' }} />);
    expect(screen.getByLabelText('Branch')).toHaveValue('b');
    expect(screen.getByLabelText('Business date')).toHaveValue(workspaceToday(WORKSPACE_ZONE));
  });
});
