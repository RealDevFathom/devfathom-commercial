import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
const db = { pharmacyBranch: { findMany: mocks.branches } };

async function show(query = filters) {
  return render(await CashFlowPage({ searchParams: Promise.resolve(query) }));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue({ session: {}, organization: { id: scope.organizationId } });
  mocks.context.mockResolvedValue({ db, entitlements: { organizationId: scope.organizationId } });
  mocks.branches.mockResolvedValue([{ id: scope.branchId, name: 'Main branch' }]);
  mocks.financialStatements.mockResolvedValue({ scope });
  mocks.projection.mockResolvedValue({
    totals: [],
    evidence: [],
    metadata: { retrievedAt: new Date('2026-10-31T12:00:00Z'), completenessReason: 'Test' },
  });
});
afterEach(cleanup);

describe('cash-flow page', () => {
  it('submits the selected branch and dates when Read projection is clicked', async () => {
    await show();
    const button = screen.getByRole('button', { name: 'Read projection' });
    const form = button.closest('form')!;
    const submitted = vi.fn((event: Event) => event.preventDefault());
    form.addEventListener('submit', submitted);
    fireEvent.change(screen.getByLabelText('From (inclusive)'), {
      target: { value: '2026-10-02' },
    });

    fireEvent.click(button);

    expect(submitted).toHaveBeenCalledOnce();
    expect(form.method).toBe('get');
    expect(Object.fromEntries(new FormData(form))).toEqual({ ...filters, from: '2026-10-02' });
  });

  it('passes only the authorized scope and UTC dates to the projection loader', async () => {
    await show();
    expect(mocks.projection).toHaveBeenCalledExactlyOnceWith(db, scope, {
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-10-31T00:00:00Z'),
    });
    expect(screen.getByText(/No scoped cash postings/)).toBeVisible();
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
