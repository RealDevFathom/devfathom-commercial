import { renderToStaticMarkup } from 'react-dom/server';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  financialStatements: vi.fn(),
  mutation: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/server/routers/pharmacy-finance', () => ({
  pharmacyFinanceRouter: {
    createCaller: () => ({
      financialStatements: mocks.financialStatements,
      postBookkeepingTransaction: mocks.mutation,
      reverseBookkeepingTransaction: mocks.mutation,
    }),
  },
}));

import LiquidityKpiPage from './page';

const actor = {
  session: { user: { id: 'user-1', organizationId: 'org-1', role: 'ADMIN' } },
  organization: { id: 'org-1' },
  support: null,
};

function account(accountCode: string, currency: string, closingMinor: string) {
  return {
    accountCode,
    currency,
    openingMinor: '0',
    debitMinor: '0',
    creditMinor: '0',
    closingMinor,
  };
}

function report(accounts: unknown = [], overrides: Record<string, unknown> = {}) {
  return {
    accounts,
    scope: { organizationId: 'org-1', branchId: 'branch-1' },
    from: new Date('2026-01-31T00:00:00.000Z'),
    to: new Date('2026-02-01T00:00:00.000Z'),
    freshness: { retrievedAt: new Date('2026-02-02T03:04:05.000Z') },
    get journal(): never {
      throw new Error('journal must not be consumed');
    },
    ...overrides,
  };
}

const query = { branch: 'branch-1', cutoff: '2026-02-01' };

async function html(params: Record<string, string | string[] | undefined>) {
  return renderToStaticMarkup(await LiquidityKpiPage({ searchParams: Promise.resolve(params) }));
}

describe('LiquidityKpiPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.createTRPCContext.mockResolvedValue({ session: actor.session });
    mocks.financialStatements.mockResolvedValue(report());
  });

  it('renders initial controls without authenticating or reading finance', async () => {
    const output = await html({});
    expect(output).toContain('No financial source has been read');
    expect(output).toContain('name="cutoff"');
    expect(mocks.resolveTenantActor).not.toHaveBeenCalled();
    expect(mocks.financialStatements).not.toHaveBeenCalled();
  });

  it.each([
    { branch: 'branch-1' },
    { branch: ['branch-1', 'branch-2'], cutoff: '2026-02-01' },
    { branch: '  ', cutoff: '2026-02-01' },
    { branch: 'branch-1', cutoff: '2026-02-30' },
    { branch: 'x'.repeat(129), cutoff: '2026-02-01' },
  ])('rejects invalid controls before any read', async (params) => {
    expect(await html(params)).toContain('role="alert"');
    expect(mocks.resolveTenantActor).not.toHaveBeenCalled();
    expect(mocks.financialStatements).not.toHaveBeenCalled();
  });

  it('reads the guarded report once and renders per-currency exact coverage', async () => {
    mocks.financialStatements.mockResolvedValue(
      report([
        account('CASH', 'PKR', '900719925474099301'),
        account('BANK', 'PKR', '9'),
        account('ACCOUNTS_PAYABLE', 'PKR', '-300'),
        account('GOODS_RECEIVED_ACCRUAL', 'PKR', '-100'),
        account('CASH', 'USD', '50'),
        account('ACCOUNTS_PAYABLE', 'USD', '-200'),
      ])
    );
    const output = await html(query);
    expect(mocks.financialStatements).toHaveBeenCalledTimes(1);
    expect(mocks.financialStatements).toHaveBeenCalledWith({
      branchId: 'branch-1',
      from: '2026-01-31T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
      page: 1,
    });
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(output).toContain('9007199254740993.01');
    expect(output).toContain('900719925474099310 / 400');
    expect(output).toContain('2251799813685248.2750');
    expect(output).toContain('50 / 200');
    expect(output).toContain('0.2500');
    expect(output).toContain('Export KPI CSV');
    expect(output).toMatch(/Retrieved\s+2 Feb 2026, 3:04 AM UTC/);
    expect(output).not.toContain('finance_journal_lines');
    expect(output).not.toContain('Infinity');
  });

  it('shows unavailable coverage and flags for zero, missing and unusual balances', async () => {
    mocks.financialStatements.mockResolvedValue(
      report([
        account('CASH', 'PKR', '-5'),
        account('ACCOUNTS_PAYABLE', 'PKR', '7'),
        account('CASH', 'USD', '10'),
      ])
    );
    const output = await html(query);
    expect(output).toContain('Unavailable: liabilities ≤ 0');
    expect(output).toContain('Unavailable: no liabilities');
    expect(output).toContain('Negative cash');
    expect(output).toContain('Debit payables');
    expect(output).not.toContain('Infinity');
    expect(output).not.toContain('NaN');
  });

  it('renders an explicit empty state without an export', async () => {
    mocks.financialStatements.mockResolvedValue(report([account('INVENTORY', 'PKR', '10')]));
    const output = await html(query);
    expect(output).toContain('No posted cash or liability balances');
    expect(output).not.toContain('Export KPI CSV');
  });

  it('maps authorization failures to denied without showing data', async () => {
    mocks.financialStatements.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    const output = await html(query);
    expect(output).toContain('Posted cash coverage unavailable');
    expect(output).not.toContain('Coverage by recorded currency');
    mocks.resolveTenantActor.mockResolvedValue(null);
    expect(await html(query)).toContain('Posted cash coverage unavailable');
  });

  it.each([
    ['source error', () => mocks.financialStatements.mockRejectedValue(new Error('db down'))],
    [
      'invalid balance',
      () => mocks.financialStatements.mockResolvedValue(report([account('CASH', 'PKR', '1.5')])),
    ],
    [
      'foreign organization',
      () =>
        mocks.financialStatements.mockResolvedValue(
          report([], { scope: { organizationId: 'org-2', branchId: 'branch-1' } })
        ),
    ],
    [
      'other branch',
      () =>
        mocks.financialStatements.mockResolvedValue(
          report([], { scope: { organizationId: 'org-1', branchId: 'branch-2' } })
        ),
    ],
    [
      'wrong cutoff',
      () =>
        mocks.financialStatements.mockResolvedValue(
          report([], { to: new Date('2026-03-01T00:00:00.000Z') })
        ),
    ],
  ])('fails closed on %s', async (_label, arrange) => {
    arrange();
    const output = await html(query);
    expect(output).toContain('Posted-ledger source unavailable');
    expect(output).not.toContain('Coverage by recorded currency');
  });
});
