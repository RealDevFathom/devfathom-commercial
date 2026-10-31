import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PrepareClosePacketInput,
  RestaurantClosePacket,
} from '@/lib/restaurant/close-readiness';
import { CloseReadinessPanel } from './close-readiness-panel';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => ({ restaurantInsights: { prepareClosePacket: { fetch: mocks.fetch } } }),
  },
}));

function packet(input: PrepareClosePacketInput): RestaurantClosePacket {
  return {
    scope: { organizationId: 'org_1', branchId: input.branchId },
    period: { from: input.businessDate, to: input.businessDate, basis: 'BUSINESS_DATE' },
    status: 'UNKNOWN',
    financial: {
      status: 'READY',
      blockers: [],
      missingEvidence: [],
      data: {
        existingCloseId: null,
        closeGuards: {
          allBillsResolved: true,
          allDrawersClosed: true,
          openBillCount: 0,
          unbilledOrderCount: 0,
          openDrawerCount: 0,
        },
        currency: 'PKR',
        currencyBasis: 'Current organization currency; not historically pinned.',
        moneyUnit: 'DECIMAL_MAJOR',
        source: 'closePreview',
        amounts: {
          grossSales: {
            value: '9007199254740993.01',
            definition: 'Settled bill subtotals before discounts.',
          },
          netSales: {
            value: '24.00',
            definition: 'Net sales exclude refunds; not profit or cash.',
          },
          refundTotal: {
            value: '2.00',
            definition: 'Refund principal on processing business date.',
          },
          tipTotal: { value: '1.00', definition: 'Tips on collection business date; not sales.' },
          cashExpected: { value: '23.00', definition: 'Drawer movement ledger; not profit.' },
          cashCounted: { value: '0.00', definition: 'Explicit zero is a count.' },
          cashVariance: { value: '-23.00', definition: 'Discrepancy, not attributed loss.' },
        },
        tenders: [],
        tenderDefinition: 'Tender principal and tips on collection date, including earlier bills.',
        cashCountCoverage: {
          status: 'COMPLETE',
          drawerSessionCount: 1,
          missingCountSessionCount: 0,
          definition: 'Every observed drawer must be closed with a non-null count.',
        },
        reportFreshness: null,
      },
    },
    operational: {
      status: 'UNKNOWN',
      blockers: [],
      missingEvidence: [
        {
          code: 'TERMINAL_SYNC_UNKNOWN',
          message: 'No authoritative evidence proves every offline terminal has synchronized.',
          source: 'terminal-local offline queues',
          responsibleRole: 'SHIFT_MANAGER',
          recordIds: [],
          allowedExistingRoutes: [],
        },
      ],
      data: {
        unbilledOrders: {
          count: 0,
          recordIds: [],
          truncated: false,
          definition: 'No live bill only; partial and fractional settlement remains unproven.',
        },
        terminalSynchronization: 'UNKNOWN',
        staffClockouts: 'UNAVAILABLE',
      },
    },
    freshness: {
      status: 'LIVE_OBSERVATION',
      asOf: input.asOf,
      startedAt: input.asOf,
      completedAt: input.asOf,
      expiresAt: new Date(Date.parse(input.asOf) + 60_000).toISOString(),
      definition:
        'Sequential live readers are not an atomic snapshot; asOf is not a historical cutoff.',
    },
    unattendedCloseReady: false,
    execution: { mode: 'READ_ONLY', scheduled: false, definition: 'Preparation runs on request.' },
  };
}

function Harness({
  branchId = 'branch_1',
  available = true,
}: {
  branchId?: string;
  available?: boolean;
}) {
  const [date, setDate] = useState('2026-09-11');
  return (
    <CloseReadinessPanel
      key={`${branchId}:${available}`}
      organizationId="org_1"
      branchId={branchId}
      branchName={branchId}
      branchAvailable={available}
      businessDate={date}
      onBusinessDateChange={setDate}
    />
  );
}

function prepare() {
  fireEvent.click(screen.getByRole('button', { name: 'Prepare close packet' }));
}
async function prepared() {
  await screen.findByRole('button', { name: 'Refresh close packet' });
}

describe('CloseReadinessPanel', () => {
  beforeEach(() => {
    mocks.fetch
      .mockReset()
      .mockImplementation(async (input: PrepareClosePacketInput) => packet(input));
  });

  it('requires explicit date and active branch without automatic reads', () => {
    const view = render(<Harness available={false} />);
    expect(screen.getByRole('button', { name: 'Prepare close packet' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Selected branch is unavailable');
    view.rerender(<Harness />);
    fireEvent.change(screen.getByLabelText('Close business date'), { target: { value: '' } });
    expect(screen.getByRole('button', { name: 'Prepare close packet' })).toBeDisabled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('uses the typed request and exact decimal strings with separate readiness and non-atomic coverage', async () => {
    render(<Harness />);
    prepare();
    await prepared();
    expect(mocks.fetch).toHaveBeenCalledWith(
      { branchId: 'branch_1', businessDate: '2026-09-11', asOf: expect.any(String) },
      { staleTime: 0, retry: false }
    );
    const input = mocks.fetch.mock.calls[0][0];
    expect(new Date(input.asOf).toISOString()).toBe(input.asOf);
    expect(screen.getByRole('heading', { name: 'Financial readiness' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Operational handover' })).toBeInTheDocument();
    expect(screen.getByText('PKR 9007199254740993.01')).toBeInTheDocument();
    expect(screen.getByText('PKR 0.00')).toBeInTheDocument();
    expect(screen.getByText('Net sales exclude refunds; not profit or cash.')).toBeInTheDocument();
    expect(screen.getByText(/not an atomic snapshot/)).toBeInTheDocument();
    expect(screen.getByText(/Freshness window ends:/)).toBeInTheDocument();
    expect(screen.getByText('Not ready for unattended close')).toBeInTheDocument();
    expect(screen.getByText('Terminal synchronization: UNKNOWN')).toBeInTheDocument();
    expect(screen.getByText(/Responsible role: Shift manager/)).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('renders reader blockers, roles and only the permitted source links', async () => {
    mocks.fetch.mockImplementation(async (input: PrepareClosePacketInput) => {
      const value = packet(input);
      value.financial.status = 'BLOCKED';
      value.financial.blockers = [
        {
          code: 'UNSETTLED_BILL',
          message: 'One open bill prevents close.',
          source: 'daily-close#assertReadyToClose',
          responsibleRole: 'CASHIER',
          recordIds: ['bill_1'],
          allowedExistingRoutes: [
            {
              href: '/restaurant/money',
              procedure: 'restaurantBills.listBills',
              capability: 'money:read',
              module: 'restaurant-pos',
            },
          ],
        },
      ];
      return value;
    });
    render(<Harness />);
    prepare();
    await prepared();
    expect(screen.getByText('Blocked at observation')).toBeInTheDocument();
    expect(screen.getByText('Responsible role: Cashier')).toBeInTheDocument();
    expect(screen.getByText(/Source: daily-close#assertReadyToClose/)).toBeInTheDocument();
    expect(screen.getByText('bill_1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review bills' })).toHaveAttribute(
      'href',
      '/restaurant/money'
    );
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('keeps missing counts unavailable while preserving other returned financial evidence', async () => {
    mocks.fetch.mockImplementation(async (input: PrepareClosePacketInput) => {
      const value = packet(input);
      value.financial.status = 'UNKNOWN';
      value.financial.data!.amounts.cashCounted.value = null;
      value.financial.data!.amounts.cashVariance.value = null;
      value.financial.data!.cashCountCoverage.status = 'INCOMPLETE';
      value.financial.missingEvidence = [
        {
          code: 'CASH_COUNT_INCOMPLETE',
          message: 'Cash counts are incomplete.',
          source: 'RestaurantDrawerSession.countedCash',
          responsibleRole: 'CASHIER',
          recordIds: [],
          allowedExistingRoutes: [],
        },
      ];
      return value;
    });
    render(<Harness />);
    prepare();
    await prepared();
    expect(screen.getByText('Cash counts are incomplete.')).toBeInTheDocument();
    expect(screen.getAllByText('Unavailable', { exact: true })).toHaveLength(2);
    expect(screen.queryByText('PKR 0.00')).not.toBeInTheDocument();
    expect(screen.queryByText('PKR -23.00')).not.toBeInTheDocument();
    expect(screen.getByText('PKR 24.00')).toBeInTheDocument();
  });

  it.each(['FINANCIAL_PERMISSION_REQUIRED', 'FINANCIAL_SOURCE_UNAVAILABLE'])(
    'keeps %s amounts absent while rendering operational evidence',
    async (code) => {
      mocks.fetch.mockImplementation(async (input: PrepareClosePacketInput) => {
        const value = packet(input);
        value.financial = {
          status: 'UNKNOWN',
          data: null,
          blockers: [],
          missingEvidence: [
            {
              code,
              message: 'Financial evidence unavailable.',
              source: 'reports:financial',
              responsibleRole: 'SHIFT_MANAGER',
              recordIds: [],
              allowedExistingRoutes: [],
            },
          ],
        };
        return value;
      });
      render(<Harness />);
      prepare();
      await prepared();
      expect(
        screen.getByText('Financial data unavailable. No amounts are shown.')
      ).toBeInTheDocument();
      expect(screen.queryByText(/PKR/)).not.toBeInTheDocument();
      expect(screen.queryByText('Gross sales')).not.toBeInTheDocument();
      expect(screen.queryByText(/Financial source:/)).not.toBeInTheDocument();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(screen.getByText('Orders without a live bill: 0')).toBeInTheDocument();
    }
  );

  it('renders financial-only already-closed evidence without inferring handover counts or readiness', async () => {
    mocks.fetch.mockImplementation(async (input: PrepareClosePacketInput) => {
      const value = packet(input);
      value.financial.status = 'ALREADY_CLOSED';
      value.financial.data!.existingCloseId = 'close_1';
      value.operational = { status: 'UNKNOWN', data: null, blockers: [], missingEvidence: [] };
      return value;
    });
    render(<Harness />);
    prepare();
    await prepared();
    expect(screen.getByText('Already closed at observation')).toBeInTheDocument();
    expect(screen.getByText(/Close: close_1/)).toBeInTheDocument();
    expect(
      screen.getByText('Operational data unavailable. No order count is inferred.')
    ).toBeInTheDocument();
    expect(screen.getByText('Not ready for unattended close')).toBeInTheDocument();
  });

  it.each(['FORBIDDEN', 'UNAUTHORIZED', 'INTERNAL_SERVER_ERROR', 'BAD_REQUEST'])(
    'hides previous figures on %s, preserves input and focus, and supports explicit retry',
    async (code) => {
      render(<Harness />);
      prepare();
      await prepared();
      mocks.fetch.mockRejectedValueOnce({ data: { code }, message: 'Sensitive raw server detail' });
      const button = screen.getByRole('button', { name: 'Refresh close packet' });
      button.focus();
      fireEvent.click(button);
      await screen.findByRole('alert');
      expect(screen.queryByText(/PKR/)).not.toBeInTheDocument();
      expect(screen.queryByText('Sensitive raw server detail')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Close business date')).toHaveValue('2026-09-11');
      expect(screen.getByLabelText('Close business date')).toHaveAttribute('aria-invalid', 'false');
      expect(screen.getByLabelText('Close business date')).toHaveAttribute(
        'aria-describedby',
        'close-date-help'
      );
      expect(screen.getByRole('button', { name: 'Retry close packet' })).toHaveFocus();
      fireEvent.click(screen.getByRole('button', { name: 'Retry close packet' }));
      await prepared();
      expect(mocks.fetch).toHaveBeenCalledTimes(3);
    }
  );

  it.each([
    {
      // ClosePacketError(INVALID) is mapped to BAD_REQUEST with this exact message.
      message: 'Cannot prepare a future branch business date.',
      data: { code: 'BAD_REQUEST', validation: null },
    },
    {
      message: 'Invalid business date.',
      data: { code: 'BAD_REQUEST', validation: null },
    },
    {
      // The existing tRPC formatter publishes calendar validation under businessDate.
      message: 'Business Date: Invalid calendar date.',
      data: {
        code: 'BAD_REQUEST',
        validation: { businessDate: ['Invalid calendar date.'] },
      },
    },
  ])('associates date validation with its own message and recovers: $message', async (error) => {
    render(<Harness />);
    prepare();
    await prepared();
    const date = screen.getByLabelText('Close business date');
    fireEvent.change(date, { target: { value: '2099-01-01' } });
    mocks.fetch.mockRejectedValueOnce(error);
    prepare();
    const alert = await screen.findByRole('alert');
    const message = error.data.validation?.businessDate[0] ?? error.message;
    const description = within(alert).getByText(message, { exact: true });
    expect(description).toBeVisible();
    expect(description.id).not.toBe('close-date-help');
    expect(date.getAttribute('aria-describedby')?.split(' ')).toContain(description.id);
    expect(date).toHaveAccessibleDescription(expect.stringContaining(message));
    expect(date).toHaveAttribute('aria-invalid', 'true');
    expect(date).toHaveValue('2099-01-01');
    expect(screen.queryByText(/PKR/)).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Financial readiness' })).not.toBeInTheDocument();
    expect(screen.queryByText('Checks passed at observation')).not.toBeInTheDocument();

    date.focus();
    fireEvent.change(date, { target: { value: '2026-09-10' } });
    expect(date).toHaveFocus();
    expect(date).toHaveAttribute('aria-invalid', 'false');
    expect(date).toHaveAttribute('aria-describedby', 'close-date-help');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/PKR/)).not.toBeInTheDocument();
    prepare();
    await prepared();
    expect(mocks.fetch.mock.calls[2][0].businessDate).toBe('2026-09-10');
    expect(screen.getByText('PKR 24.00')).toBeInTheDocument();
  });

  it.each([
    { message: 'Invalid asOf timestamp.', data: { code: 'BAD_REQUEST', validation: null } },
    { message: 'Restaurant branch not found.', data: { code: 'NOT_FOUND', validation: null } },
    {
      message: 'As Of: Invalid ISO datetime',
      data: { code: 'BAD_REQUEST', validation: { asOf: ['Invalid ISO datetime'] } },
    },
    {
      message: 'Cannot prepare a future branch business date.',
      data: { code: 'INTERNAL_SERVER_ERROR', validation: null },
    },
    {
      message: 'Internal schema failure',
      data: { code: 'INTERNAL_SERVER_ERROR', validation: { businessDate: ['Internal detail'] } },
    },
    new Error('Cannot prepare a future branch business date.'),
  ])('keeps unrelated failures off the date field and supports retry: $message', async (error) => {
    render(<Harness />);
    mocks.fetch.mockRejectedValueOnce(error);
    const button = screen.getByRole('button', { name: 'Prepare close packet' });
    button.focus();
    fireEvent.click(button);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Preparation failed');
    expect(alert).not.toHaveTextContent(error.message);
    const date = screen.getByLabelText('Close business date');
    expect(date).toHaveAttribute('aria-invalid', 'false');
    expect(date).toHaveAttribute('aria-describedby', 'close-date-help');
    expect(date).toHaveValue('2026-09-11');
    expect(screen.queryByText(/PKR/)).not.toBeInTheDocument();
    expect(screen.queryByText('Checks passed at observation')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry close packet' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Retry close packet' }));
    await prepared();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByText('PKR 24.00')).toBeInTheDocument();
  });

  it('discards late date validation after the draft changes', async () => {
    let reject!: (error: unknown) => void;
    mocks.fetch.mockImplementationOnce(
      () =>
        new Promise<RestaurantClosePacket>((_resolve, fail) => {
          reject = fail;
        })
    );
    render(<Harness />);
    prepare();
    const date = screen.getByLabelText('Close business date');
    fireEvent.change(date, { target: { value: '2026-09-10' } });
    await act(async () =>
      reject({
        message: 'Cannot prepare a future branch business date.',
        data: { code: 'BAD_REQUEST', validation: null },
      })
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(date).toHaveAttribute('aria-invalid', 'false');
    expect(date).toHaveValue('2026-09-10');
    prepare();
    await prepared();
  });

  it('announces loading, ignores repeat activation, discards a late date response and keeps input focus', async () => {
    let resolve!: (value: RestaurantClosePacket) => void;
    mocks.fetch.mockImplementationOnce(
      () =>
        new Promise<RestaurantClosePacket>((done) => {
          resolve = done;
        })
    );
    render(<Harness />);
    prepare();
    expect(screen.getByRole('status')).toHaveTextContent('Reading close evidence');
    fireEvent.click(screen.getByRole('button', { name: 'Preparing close packet…' }));
    expect(mocks.fetch).toHaveBeenCalledOnce();
    const date = screen.getByLabelText('Close business date');
    date.focus();
    fireEvent.change(date, { target: { value: '2026-09-10' } });
    await act(async () => resolve(packet(mocks.fetch.mock.calls[0][0])));
    expect(date).toHaveFocus();
    expect(screen.queryByText(/PKR/)).not.toBeInTheDocument();
    prepare();
    await prepared();
    expect(mocks.fetch.mock.calls[1][0].businessDate).toBe('2026-09-10');
  });

  it.each(['branch', 'unavailable'])(
    'discards a late response when the branch becomes %s',
    async (change) => {
      let resolve!: (value: RestaurantClosePacket) => void;
      mocks.fetch.mockImplementationOnce(
        () =>
          new Promise<RestaurantClosePacket>((done) => {
            resolve = done;
          })
      );
      const view = render(<Harness />);
      prepare();
      view.rerender(
        <Harness
          branchId={change === 'branch' ? 'branch_2' : 'branch_1'}
          available={change !== 'unavailable'}
        />
      );
      await act(async () => resolve(packet(mocks.fetch.mock.calls[0][0])));
      expect(screen.queryByText(/PKR/)).not.toBeInTheDocument();
      expect(screen.getByLabelText('Close business date')).toHaveValue('2026-09-11');
    }
  );

  it.each(['organization', 'branch', 'date', 'asOf'])(
    'rejects returned evidence with mismatched %s',
    async (field) => {
      mocks.fetch.mockImplementation(async (input: PrepareClosePacketInput) => {
        const value = packet(input);
        if (field === 'organization') value.scope.organizationId = 'org_other';
        if (field === 'branch') value.scope.branchId = 'branch_other';
        if (field === 'date') value.period.to = '2026-09-09';
        if (field === 'asOf') value.freshness.asOf = '2026-09-09T00:00:00.000Z';
        return value;
      });
      render(<Harness />);
      prepare();
      await screen.findByRole('alert');
      expect(screen.queryByText(/PKR/)).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry close packet' })).toBeEnabled();
    }
  );

  it('allows refresh of unavailable freshness without showing fabricated readiness or totals', async () => {
    mocks.fetch.mockImplementationOnce(async (input: PrepareClosePacketInput) => {
      const value = packet(input);
      value.freshness.status = 'UNAVAILABLE';
      const section = {
        status: 'UNKNOWN' as const,
        data: null,
        blockers: [],
        missingEvidence: [
          {
            code: 'FRESHNESS_UNAVAILABLE',
            message: 'Request a new packet.',
            source: 'server observation clock',
            responsibleRole: 'SHIFT_MANAGER' as const,
            recordIds: [],
            allowedExistingRoutes: [],
          },
        ],
      };
      value.financial = section;
      value.operational = section;
      return value;
    });
    render(<Harness />);
    prepare();
    await prepared();
    expect(screen.queryByText(/PKR/)).not.toBeInTheDocument();
    expect(screen.queryByText('Checks passed at observation')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('status')).getByText(/Close packet prepared/)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh close packet' }));
    await waitFor(() => expect(screen.getByText('PKR 24.00')).toBeInTheDocument());
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
});
