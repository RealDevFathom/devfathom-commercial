import { renderToStaticMarkup } from 'react-dom/server';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  financialStatements: vi.fn(),
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

async function html(query: Record<string, string | string[] | undefined>) {
  return renderToStaticMarkup(
    await TrialBalanceControlPage({ searchParams: Promise.resolve(query) })
  );
}

describe('TrialBalanceControlPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue({ session: actor.session });
    mocks.financialStatements.mockResolvedValue(report());
  });

  it('renders initial GET controls without an authentication or financial read', async () => {
    const output = await html({});
    expect(output).toContain('No financial source has been read');
    expect(output).toContain('name="branch"');
    expect(output).toContain('To, exclusive (UTC)');
    expect(mocks.resolveTenantActor).not.toHaveBeenCalled();
    expect(mocks.financialStatements).not.toHaveBeenCalled();
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
      expect(mocks.resolveTenantActor).not.toHaveBeenCalled();
      expect(mocks.createTRPCContext).not.toHaveBeenCalled();
      expect(mocks.financialStatements).not.toHaveBeenCalled();
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
});
