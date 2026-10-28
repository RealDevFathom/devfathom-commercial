import { cleanup, render, screen } from '@testing-library/react';
import { TRPCError } from '@trpc/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ createCaller: vi.fn(), context: vi.fn() }));
vi.mock('@/server/routers/pharmacy-finance', () => ({
  pharmacyFinanceRouter: { createCaller: mocks.createCaller },
}));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
import Page from './page';
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const report = {
  accounts: [
    {
      accountCode: 'CASH',
      currency: 'PKR',
      openingMinor: '100',
      debitMinor: '50',
      creditMinor: '20',
      closingMinor: '130',
    },
  ],
  journal: [],
  cashflow: [],
  journalCount: 0,
  page: 1,
  from: new Date('2026-09-01T00:00:00Z'),
  to: new Date('2026-10-01T00:00:00Z'),
  definition: 'posted aggregates',
  scope: { organizationId: 'org', branchId: 'branch' },
  timezone: 'UTC' as const,
  moneyUnit: 'integer_minor' as const,
  currency: null,
  currencyStatus: 'not_recorded_by_ledger_reader' as const,
  source: 'finance_journal_lines' as const,
  coverage: {
    basis: 'posted_entries_only' as const,
    completeness: 'unknown' as const,
    costCoverage: 'unknown' as const,
    refunds: 'included_only_when_posted_as_reversals' as const,
    emptyRows: 'no_matching_postings_not_proof_of_zero_activity' as const,
  },
  freshness: { retrievedAt: new Date(), latestPostingAt: null },
};

const show = async (
  financialStatements: ReturnType<typeof vi.fn>,
  params: Record<string, string | string[]> = {}
) => {
  mocks.createCaller.mockReturnValue({ financialStatements });
  mocks.context.mockResolvedValue({});
  return render(await Page({ searchParams: Promise.resolve(params) }));
};

describe('account activity bridge page', () => {
  it('does not fetch financial DTOs before an explicit branch is supplied', async () => {
    const read = vi.fn();
    await show(read);
    expect(screen.getByText('Choose an active branch')).toBeInTheDocument();
    expect(read).not.toHaveBeenCalled();
  });

  it('renders authorization denial without financial evidence', async () => {
    await show(vi.fn().mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' })), {
      branchId: 'foreign',
    });
    expect(screen.getByRole('alert')).toHaveTextContent('outside your authorized');
    expect(screen.queryByText('Download evidence CSV')).not.toBeInTheDocument();
  });

  it('renders non-authorization reader errors without financial evidence', async () => {
    const read = vi.fn().mockRejectedValue(new TRPCError({ code: 'BAD_REQUEST' }));
    await show(read, {
      branchId: 'branch',
      accountCode: 'CASH',
      currency: 'PKR',
      from: '2026-10-01',
      to: '2026-10-02',
    });
    // A valid selection and exact reader call prevent a pre-validation false PASS.
    expect(read).toHaveBeenCalledExactlyOnceWith({
      branchId: 'branch',
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-02T00:00:00Z',
      page: 1,
    });
    expect(screen.getByText('Report unavailable')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('No financial data was displayed');
    expect(screen.queryByText('Download evidence CSV')).not.toBeInTheDocument();
  });

  it('renders the exact bridge, disclosure, and safe CSV export from one authorized read', async () => {
    const read = vi.fn().mockResolvedValue(report);
    await show(read, {
      branchId: 'branch',
      accountCode: 'CASH',
      currency: 'PKR',
      from: '2026-09-01',
      to: '2026-10-01',
    });
    expect(screen.getByRole('heading', { name: 'CASH / PKR' })).toBeInTheDocument();
    expect(screen.getByText('1.30')).toBeInTheDocument();
    expect(screen.getByText(/source completeness remain unknown/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download evidence CSV' })).toHaveAttribute(
      'download',
      'account-activity-bridge.csv'
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does not silently zero an absent account or currency', async () => {
    await show(vi.fn().mockResolvedValue(report), {
      branchId: 'branch',
      accountCode: 'BANK',
      currency: 'USD',
    });
    expect(screen.getByRole('alert')).toHaveTextContent('exact account is absent');
    expect(screen.queryByText('Download evidence CSV')).not.toBeInTheDocument();
  });
});

describe('invalid explicit query refuses reads', () => {
  it.each([
    { from: ['2026-10-01', '2026-10-02'] },
    { to: ['2026-10-25', '2026-10-26'] },
    { from: '' },
    { to: '' },
    { branchId: ['branch', 'foreign'] },
    { branchId: '' },
    { from: '2026-02-30' },
    { accountCode: ['CASH', 'BANK'] },
    { currency: '' },
  ])('refuses %j without financial read/export', async (invalid) => {
    const read = vi.fn().mockResolvedValue(report);
    await show(read, { branchId: 'branch', from: '2026-10-01', to: '2026-10-26', ...invalid });
    expect(read).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('Download evidence CSV')).not.toBeInTheDocument();
  });
});
