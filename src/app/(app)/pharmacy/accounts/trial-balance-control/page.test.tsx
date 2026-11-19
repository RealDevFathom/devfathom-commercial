import { renderToStaticMarkup } from 'react-dom/server';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  financialStatements: vi.fn(),
  branches: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/server/routers/pharmacy-finance', () => ({
  pharmacyFinanceRouter: {
    createCaller: () => ({ financialStatements: mocks.financialStatements }),
  },
}));

import TrialBalanceControlPage from './page';

const actor = {
  session: { user: { id: 'user-1', organizationId: 'org-1', role: 'ADMIN' } },
  organization: { id: 'org-1' },
  support: null,
};

function report(accounts: Array<Record<string, string>> = []) {
  return {
    accounts,
    scope: { organizationId: 'org-1', branchId: 'branch-1' },
    from: new Date('2026-01-01T00:00:00.000Z'),
    to: new Date('2026-02-01T00:00:00.000Z'),
    freshness: { retrievedAt: new Date('2026-02-02T03:04:05.000Z') },
    get journal(): never {
      throw new Error('journal must not be consumed');
    },
    get cashflow(): never {
      throw new Error('cashflow must not be consumed');
    },
  };
}

const TB_QUERY = { branch: 'branch-1', from: '2026-01-01', to: '2026-02-01' };

async function html(query: Record<string, string | string[] | undefined>) {
  return renderToStaticMarkup(
    await TrialBalanceControlPage({ searchParams: Promise.resolve(query) })
  );
}

describe('TrialBalanceControlPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue({
      session: actor.session,
      db: { pharmacyBranch: { findMany: mocks.branches } },
    });
    mocks.branches.mockResolvedValue([
      { id: 'branch-1', name: 'Main Branch' },
      { id: 'branch-2', name: 'Gulshan Branch' },
    ]);
    mocks.financialStatements.mockResolvedValue(report());
  });

  // DEV-103: the branch picker reads the owner's branch names, and nothing else, before a branch
  // is chosen: one actor resolution and one branch list, never a financial source.
  const expectOnlyTheBranchList = () => {
    expect(mocks.resolveTenantActor).toHaveBeenCalledTimes(1);
    expect(mocks.createTRPCContext).toHaveBeenCalledTimes(1);
    expect(mocks.branches).toHaveBeenCalledTimes(1);
    expect(mocks.branches).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    expect(mocks.financialStatements).not.toHaveBeenCalled();
  };

  it('renders initial GET controls reading only the branch list, no financial source', async () => {
    const output = await html({});
    expect(output).toContain('No financial source has been read');
    expect(output).toContain('name="branch"');
    expect(output).toContain('To, exclusive (workspace timezone)');
    expectOnlyTheBranchList();
  });

  it.each([
    { branch: 'branch-1', from: '2026-01-01' },
    { branch: ['branch-1', 'branch-2'], from: '2026-01-01', to: '2026-02-01' },
    { branch: '', from: '2026-01-01', to: '2026-02-01' },
    { branch: '   ', from: '2026-01-01', to: '2026-02-01' },
    { branch: 'branch-1', from: '2026-02-30', to: '2026-03-02' },
    { branch: 'branch-1', from: '2026-01-01', to: '2026-04-04' },
    { branch: 'branch-1', from: '2026-02-01', to: '2026-02-01' },
  ])(
    'rejects partial, repeated, empty, invalid or over-92-day controls before reading',
    async (query: Record<string, string | string[] | undefined>) => {
      expect(await html(query)).toContain('role="alert"');
      expectOnlyTheBranchList();
    }
  );

  it('calls the guarded real report contract once and renders account controls with exact precision', async () => {
    mocks.financialStatements.mockResolvedValue(
      report([
        {
          accountCode: 'UNKNOWN_RAW_CODE',
          currency: 'PKR',
          openingMinor: '900719925474099301',
          debitMinor: '9',
          creditMinor: '0',
          closingMinor: '900719925474099310',
        },
      ])
    );
    const output = await html({ branch: 'branch-1', from: '2026-01-01', to: '2026-02-01' });
    expect(mocks.createTRPCContext).toHaveBeenCalledWith({
      session: actor.session,
      organization: actor.organization,
      support: null,
    });
    expect(mocks.financialStatements).toHaveBeenCalledWith({
      branchId: 'branch-1',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
      page: 1,
    });
    expect(mocks.financialStatements).toHaveBeenCalledTimes(1);
    expect(output).toContain('Unknown raw code');
    expect(output).toContain('title="UNKNOWN_RAW_CODE"');
    expect(output).toContain('9007199254740993.01');
    expect(output).toContain('Retrieved 2 Feb 2026, 3:04 AM UTC');
    expect(output).toMatch(/Source:\s+posted accounts/);
    expect(output).not.toContain('finance_journal_lines');
    expect(output).not.toContain('journal must not be consumed');
  });

  it('distinguishes empty, all-zero, nonzero and inconsistent responses', async () => {
    expect(await html({ branch: 'branch-1', from: '2026-01-01', to: '2026-02-01' })).toContain(
      'No account totals found'
    );
    mocks.financialStatements.mockResolvedValueOnce(
      report([
        {
          accountCode: 'A',
          currency: 'PKR',
          openingMinor: '0',
          debitMinor: '0',
          creditMinor: '0',
          closingMinor: '0',
        },
      ])
    );
    expect(await html({ branch: 'branch-1', from: '2026-01-01', to: '2026-02-01' })).toContain(
      'All supplied amounts are zero'
    );
    mocks.financialStatements.mockResolvedValueOnce(
      report([
        {
          accountCode: 'A',
          currency: 'PKR',
          openingMinor: '2',
          debitMinor: '0',
          creditMinor: '0',
          closingMinor: '2',
        },
      ])
    );
    expect(await html({ branch: 'branch-1', from: '2026-01-01', to: '2026-02-01' })).toContain(
      'Totals checked'
    );
    mocks.financialStatements.mockResolvedValueOnce(
      report([
        {
          accountCode: 'A',
          currency: 'PKR',
          openingMinor: '2',
          debitMinor: '0',
          creditMinor: '0',
          closingMinor: '3',
        },
      ])
    );
    expect(await html({ branch: 'branch-1', from: '2026-01-01', to: '2026-02-01' })).toContain(
      'These totals do not match'
    );
  });

  it.each(['UNAUTHORIZED', 'FORBIDDEN'] as const)(
    'fails closed with a denied state for %s',
    async (code: 'UNAUTHORIZED' | 'FORBIDDEN') => {
      mocks.financialStatements.mockRejectedValue(new TRPCError({ code }));
      const output = await html({
        branch: 'foreign-or-inactive',
        from: '2026-01-01',
        to: '2026-02-01',
      });
      expect(output).toContain('Trial-balance control unavailable');
      expect(output).not.toContain('All account rows');
    }
  );

  it('does not query when tenant authentication is unavailable', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);
    expect(await html({ branch: 'branch-1', from: '2026-01-01', to: '2026-02-01' })).toContain(
      'Trial-balance control unavailable'
    );
    expect(mocks.createTRPCContext).not.toHaveBeenCalled();
    expect(mocks.financialStatements).not.toHaveBeenCalled();
  });

  it('shows source failure without stale rows for malformed, mismatched or failed responses', async () => {
    mocks.financialStatements.mockResolvedValueOnce(
      Object.assign(report(), { scope: { organizationId: 'org-2', branchId: 'branch-1' } })
    );
    expect(await html({ branch: 'branch-1', from: '2026-01-01', to: '2026-02-01' })).toContain(
      'Trial-balance source unavailable'
    );
    mocks.financialStatements.mockRejectedValueOnce(new Error('database detail must stay private'));
    const output = await html({ branch: 'branch-1', from: '2026-01-01', to: '2026-02-01' });
    expect(output).toContain('retry the report');
    expect(output).not.toContain('database detail');
    expect(output).not.toContain('All account rows');
  });

  it.each([
    ['branch', { scope: { organizationId: 'org-1', branchId: 'branch-2' } }],
    ['from', { from: new Date('2026-01-02T00:00:00.000Z') }],
    ['to', { to: new Date('2026-01-31T00:00:00.000Z') }],
  ])('fails closed when the source returns a mismatched %s', async (_description, mismatch) => {
    mocks.financialStatements.mockResolvedValueOnce(Object.assign(report(), mismatch));

    const output = await html({ branch: 'branch-1', from: '2026-01-01', to: '2026-02-01' });
    expect(output).toContain('Trial-balance source unavailable');
    expect(output).not.toContain('All account rows');
  });

  it.each([
    ['missing', {}],
    ['non-Date', { retrievedAt: '2026-02-02T03:04:05.000Z' }],
    ['invalid Date', { retrievedAt: new Date(Number.NaN) }],
  ])('fails closed when freshness.retrievedAt is %s', async (_description, freshness) => {
    mocks.financialStatements.mockResolvedValueOnce(Object.assign(report(), { freshness }));

    const output = await html({ branch: 'branch-1', from: '2026-01-01', to: '2026-02-01' });
    expect(output).toContain('Trial-balance source unavailable');
    expect(output).not.toContain('All account rows');
  });

  it('reads the picked days on the organization clock and names the zone', async () => {
    mocks.resolveTenantActor.mockResolvedValue({
      ...actor,
      organization: { id: 'org-1', timezone: 'Asia/Karachi' },
    });
    mocks.financialStatements.mockResolvedValue(
      Object.assign(report(), {
        from: new Date('2025-12-31T19:00:00.000Z'),
        to: new Date('2026-01-31T19:00:00.000Z'),
      })
    );
    const output = await html({ branch: 'branch-1', from: '2026-01-01', to: '2026-02-01' });
    // 1 Jan 00:00 PKT is 31 Dec 19:00 UTC.
    expect(mocks.financialStatements).toHaveBeenCalledWith({
      branchId: 'branch-1',
      from: '2025-12-31T19:00:00.000Z',
      to: '2026-01-31T19:00:00.000Z',
      page: 1,
    });
    expect(output).toContain('From (PKT)');
    expect(output).toContain('To, exclusive (PKT)');
    expect(output).toContain('Retrieved 2 Feb 2026, 8:04 AM PKT');
  });

  describe('DEV-103 branch picker', () => {
    it('offers the active branches of the signed-in organization by name, not a typed ID', async () => {
      const output = await html({});
      expect(output).toContain('<select');
      expect(output).toContain('>Main Branch</option>');
      expect(output).toContain('>Gulshan Branch</option>');
      expect(output).not.toContain('Branch ID');
      expect(output).not.toMatch(/<input[^>]*name="branch"/);
    });

    it('selects the requested branch', async () => {
      expect(await html(TB_QUERY)).toMatch(/<option value="branch-1" selected="">/);
    });

    it('shows the prompt, not another branch, for an unlisted branch and leaves it to the router', async () => {
      mocks.financialStatements.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
      const output = await html({ ...TB_QUERY, branch: 'branch-other' });
      expect(output).toContain('<option value="">Choose a branch</option>');
      expect(output).not.toMatch(/<option value="branch-[12]" selected/);
      expect(mocks.financialStatements).toHaveBeenCalledWith(
        expect.objectContaining({ branchId: 'branch-other' })
      );
      expect(output).toContain('Trial-balance control unavailable');
    });

    it('offers no branches to someone who is not an owner', async () => {
      mocks.createTRPCContext.mockResolvedValue({
        session: { user: { id: 'u', organizationId: 'org-1', role: 'EMPLOYEE' } },
        db: { pharmacyBranch: { findMany: mocks.branches } },
      });
      const output = await html({});
      expect(mocks.branches).not.toHaveBeenCalled();
      expect(output).not.toContain('Main Branch');
    });
  });
});
