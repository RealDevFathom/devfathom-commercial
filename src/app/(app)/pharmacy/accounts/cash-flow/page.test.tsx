import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TRPCError } from '@trpc/server';
import { redirect } from 'next/navigation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  context: vi.fn(),
  branches: vi.fn(),
  financialStatements: vi.fn(),
  projection: vi.fn(),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.context }));
vi.mock('@/server/routers/pharmacy-finance', () => ({
  pharmacyFinanceRouter: {
    createCaller: () => ({ financialStatements: mocks.financialStatements }),
  },
}));
vi.mock('@/lib/pharmacy/accounts/cash-flow', () => ({
  loadCashFlowProjection: mocks.projection,
}));

import CashFlowPage from './page';

const scope = { organizationId: 'org', branchId: 'branch' };
const filters = { branch: scope.branchId, from: '2026-10-01', to: '2026-10-31' };
const tx = { transaction: true };
const db = {
  pharmacyBranch: { findMany: mocks.branches },
  $transaction: vi.fn(),
};
const accounts = [{ accountCode: 'CASH', currency: 'PKR', closingMinor: '0' }];
const evidenceRow = (index: number) => ({
  id: `entry-${index}`,
  sourceKind: 'PHARMACY_TENDER',
  sourceId: `source-${index}`,
  sourceDetail: null,
  description: `Entry ${index}`,
  currency: 'PKR',
  occurredAt: new Date('2026-10-02T00:00:00Z'),
  reversesEntryId: null,
  lines: [],
  classification: 'OPERATING',
  netMinor: BigInt(1),
  reason: 'Test',
});

async function show(query = filters) {
  return render(await CashFlowPage({ searchParams: Promise.resolve(query) }));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue({ session: {}, organization: { id: scope.organizationId } });
  mocks.context.mockResolvedValue({ db, entitlements: { organizationId: scope.organizationId } });
  mocks.branches.mockResolvedValue([{ id: scope.branchId, name: 'Main branch' }]);
  db.$transaction.mockImplementation((run: (client: unknown) => unknown) => run(tx));
  mocks.financialStatements.mockResolvedValue({ scope, accounts });
  mocks.projection.mockResolvedValue({
    totals: [],
    evidence: [],
    metadata: { retrievedAt: new Date('2026-10-31T12:00:00Z'), completenessReason: 'Test' },
  });
});
afterEach(cleanup);

describe('cash-flow page', () => {
  it('submits the selected branch and dates when Show cash flow is clicked', async () => {
    await show();
    const button = screen.getByRole('button', { name: 'Show cash flow' });
    const form = button.closest('form')!;
    const submitted = vi.fn((event: Event) => event.preventDefault());
    form.addEventListener('submit', submitted);
    fireEvent.change(screen.getByLabelText('From (5:00 AM PKT)'), {
      target: { value: '2026-10-02' },
    });

    fireEvent.click(button);

    expect(submitted).toHaveBeenCalledOnce();
    expect(form.method).toBe('get');
    expect(Object.fromEntries(new FormData(form))).toEqual({ ...filters, from: '2026-10-02' });
  });

  it('passes only the authorized scope, UTC dates and canonical controls in one snapshot', async () => {
    await show();
    expect(db.$transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
    expect(mocks.projection).toHaveBeenCalledExactlyOnceWith(
      tx,
      scope,
      { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-31T00:00:00Z') },
      accounts
    );
    expect(screen.getByText(/No cash movements were found/)).toBeVisible();
  });

  it('defaults the exclusive upper bound to tomorrow so today is included', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-31T15:00:00Z'), toFake: ['Date'] });
    try {
      await show({ branch: scope.branchId } as typeof filters);
    } finally {
      vi.useRealTimers();
    }
    expect(screen.getByLabelText('Until (5:00 AM PKT, not included)')).toHaveValue('2026-11-01');
    expect(mocks.projection.mock.calls[0][2]).toEqual({
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-11-01T00:00:00Z'),
    });
  });

  it('paginates cash-moving evidence without truncating totals', async () => {
    mocks.projection.mockResolvedValue({
      totals: [],
      evidence: Array.from({ length: 120 }, (_, index) => evidenceRow(index)),
      metadata: { retrievedAt: new Date('2026-10-31T12:00:00Z'), completenessReason: 'Test' },
    });
    await show({ ...filters, page: '2' } as typeof filters);
    expect(screen.getByText(/Showing 51–100 of 120/)).toBeVisible();
    expect(screen.getByText(/· Entry 50$/)).toBeInTheDocument();
    expect(screen.queryByText(/· Entry 49$/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Next payments' })).toHaveAttribute(
      'href',
      `?${new URLSearchParams({ ...filters, page: '3' })}`
    );
    expect(screen.getByRole('link', { name: 'Previous payments' })).toHaveAttribute(
      'href',
      `?${new URLSearchParams({ ...filters, page: '1' })}`
    );
  });

  it('names legacy tender and refund evidence instead of showing their internal IDs', async () => {
    mocks.projection.mockResolvedValue({
      totals: [],
      evidence: [
        { ...evidenceRow(0), description: 'Pharmacy tender cmvzinternaltender' },
        {
          ...evidenceRow(1),
          sourceKind: 'PHARMACY_REFUND',
          description: 'Refund of tender cmvzinternaltender',
        },
      ],
      metadata: { retrievedAt: new Date('2026-10-31T12:00:00Z'), completenessReason: 'Test' },
    });
    const { container } = await show();
    const summaries = [...container.querySelectorAll('details.mt-3 > summary')].map(
      (s) => s.textContent
    );
    expect(summaries[0]).toMatch(/· Payment received$/);
    expect(summaries[1]).toMatch(/· Refund$/);
    for (const summary of summaries) expect(summary).not.toContain('cmvz');
  });

  it('lists cash and non-cash counterpart journal lines in each evidence drilldown', async () => {
    const amountMinor = BigInt('900719925474099312');
    mocks.projection.mockResolvedValue({
      totals: [],
      evidence: [
        {
          ...evidenceRow(0),
          lines: [
            { accountCode: 'CASH', side: 'DEBIT', amountMinor },
            { accountCode: 'SALES_CLEARING', side: 'CREDIT', amountMinor },
          ],
          netMinor: amountMinor,
        },
      ],
      metadata: { retrievedAt: new Date('2026-10-31T12:00:00Z'), completenessReason: 'Test' },
    });
    await show();
    const lines = screen.getByRole('list', { name: 'Classification journal lines' });
    expect(
      within(lines)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual([
      'CASH · DEBIT · PKR 9007199254740993.12',
      'SALES_CLEARING · CREDIT · PKR 9007199254740993.12',
    ]);
  });

  it('shows date guidance for malformed dates without reading financial data', async () => {
    await show({ ...filters, from: 'invalid' });
    expect(screen.getByRole('alert')).toHaveTextContent(/valid UTC window of at most 92 days/);
    expect(mocks.financialStatements).not.toHaveBeenCalled();
    expect(mocks.projection).not.toHaveBeenCalled();
  });

  it('shows date guidance for a rejected report window', async () => {
    mocks.financialStatements.mockRejectedValue(new TRPCError({ code: 'BAD_REQUEST' }));
    await show();
    expect(screen.getByRole('alert')).toHaveTextContent(/valid UTC window of at most 92 days/);
    expect(mocks.projection).not.toHaveBeenCalled();
  });

  it.each(['branches', 'financialStatements', 'projection'] as const)(
    'shows a retryable source failure for %s without blaming the date window or leaking details',
    async (source) => {
      mocks[source].mockRejectedValue(new Error('private database detail'));
      await show();
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('The cash-flow projection could not be read. Please retry.');
      expect(alert).not.toHaveTextContent(/valid UTC window|private database detail/);
      expect(screen.queryByRole('table')).toBeNull();
    }
  );

  it.each(['FORBIDDEN', 'UNAUTHORIZED'] as const)(
    'preserves access guidance for %s without loading the projection',
    async (code) => {
      mocks.financialStatements.mockRejectedValue(new TRPCError({ code }));
      await show();
      expect(screen.getByRole('alert')).toHaveTextContent(/Owner Pharmacy Reports access/);
      expect(mocks.projection).not.toHaveBeenCalled();
    }
  );

  it('preserves Next.js redirects while resolving the actor', async () => {
    mocks.actor.mockImplementation(() => redirect('/login'));
    await expect(show()).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.projection).not.toHaveBeenCalled();
  });
});
