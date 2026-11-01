import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  branch: vi.fn(),
  raw: vi.fn(),
  journal: vi.fn(),
  count: vi.fn(),
  audit: vi.fn(),
  context: vi.fn(),
  branches: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: mocks.audit,
}));
vi.mock('@/server/trpc', async () => ({
  ...(await vi.importActual<typeof import('@/server/trpc')>('@/server/trpc')),
  createTRPCContext: mocks.context,
}));
vi.mock('@/server/routers/pharmacy-reports', () => ({
  pharmacyReportsRouter: { createCaller: () => ({ branches: mocks.branches }) },
}));
import { pharmacyFinanceRouter } from '@/server/routers/pharmacy-finance';
import type { TRPCContext } from '@/server/trpc';
import { hasModule } from '@/lib/entitlements';
import { projectProfitAndLoss } from '@/lib/pharmacy/financial-statements';
import ProfitAndLossPage from './page';
import Loading from './loading';
import { FinancialStatements } from '@/app/(app)/pharmacy/finance/financial-statements';
const input = { branchId: 'branch_1', from: '2026-09-01T00:00:00Z', to: '2026-09-03T00:00:00Z' };
const total = (accountCode: string, debit: bigint, credit: bigint, currency = 'PKR') => ({
  accountCode,
  currency,
  opening: BigInt(999999999999999999),
  debit,
  credit,
});
const totals = [
  total('SALES_REVENUE', BigInt(0), BigInt(10000)),
  total('SALES_DISCOUNT', BigInt(1000), BigInt(0)),
  total('COST_OF_GOODS_SOLD', BigInt(6000), BigInt(0)),
  total('OPERATING_EXPENSE', BigInt(1000), BigInt(0)),
];
function context(change: Record<string, unknown> = {}) {
  return {
    db: {
      $queryRaw: mocks.raw,
      pharmacyBranch: { findFirst: mocks.branch },
      financeJournalEntry: { findMany: mocks.journal, count: mocks.count },
    },
    entitlements: { organizationId: 'org_1', enabledModules: ['pharmacy-reports'], modules: [] },
    session: {
      user: { id: 'owner', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org_1' },
      expires: 'later',
    },
    organization: { id: 'org_1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
    ...change,
  } as unknown as TRPCContext;
}
function caller(change: Record<string, unknown> = {}) {
  return pharmacyFinanceRouter.createCaller(context(change));
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.can.mockResolvedValue(true);
  vi.mocked(hasModule).mockReturnValue(true);
  mocks.branch.mockResolvedValue({ id: 'branch_1' });
  mocks.raw.mockResolvedValueOnce(totals).mockResolvedValue([]);
  mocks.journal.mockResolvedValue([]);
  mocks.count.mockResolvedValue(77);
  mocks.context.mockResolvedValue(context());
  mocks.branches.mockResolvedValue({ branches: [{ id: 'branch_1', name: 'Main' }] });
});
it('returns the required net fixture through the authorized endpoint, independent of journal paging', async () => {
  const result = await caller().financialStatements({ ...input, page: 3 });
  expect(result.profitAndLoss[0].netProfitMinor).toBe('2000');
  expect(mocks.can.mock.calls.map((c) => c[1])).toEqual([
    'admin:access',
    'reports:operational',
    'reports:financial',
  ]);
  expect(mocks.branch).toHaveBeenCalledWith({
    where: { organizationId: 'org_1', id: 'branch_1', active: true },
    select: { id: true },
  });
  expect(mocks.journal).toHaveBeenCalledWith(expect.objectContaining({ take: 25, skip: 50 }));
  const sql = mocks.raw.mock.calls[0][0];
  expect(sql.sql).toContain('e."occurredAt" < ?');
  expect(sql.sql).toContain('e."occurredAt" >= ?');
  expect(sql.sql).toContain('GROUP BY l."accountCode", e.currency');
  expect(sql.values).toContain('org_1');
  expect(sql.values).toContain('branch_1');
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: 'SUCCESS', path: 'financialStatements' })
  );
});
it.each(['admin:access', 'reports:operational', 'reports:financial'])(
  'denies missing %s before ledger reads',
  async (action) => {
    mocks.can.mockImplementation(async (_, requested) => requested !== action);
    await expect(caller().financialStatements(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.raw).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'FAILURE' }));
  }
);
it.each(['EMPLOYEE', 'HR', 'MANAGER'])('denies %s despite mocked capabilities', async (role) => {
  await expect(
    caller({
      session: { user: { id: 'other', role, status: 'ACTIVE', organizationId: 'org_1' } },
    }).financialStatements(input)
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(mocks.raw).not.toHaveBeenCalled();
});
it('denies unauthenticated access', async () => {
  await expect(caller({ session: null }).financialStatements(input)).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  });
  expect(mocks.raw).not.toHaveBeenCalled();
});
it('denies a mismatched tenant', async () => {
  await expect(
    caller({ organization: { id: 'foreign' } }).financialStatements(input)
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(mocks.raw).not.toHaveBeenCalled();
});
it('denies foreign or inactive branches', async () => {
  mocks.branch.mockResolvedValue(null);
  await expect(caller().financialStatements(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(mocks.raw).not.toHaveBeenCalled();
});
it('denies missing reporting entitlement', async () => {
  vi.mocked(hasModule).mockReturnValue(false);
  await expect(caller().financialStatements(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  expect(mocks.raw).not.toHaveBeenCalled();
});
it.each([
  { page: 0 },
  { page: 10001 },
  { page: 1.5 },
  { from: input.to },
  { to: '2027-01-01T00:00:00Z' },
  { from: '2026-02-30T00:00:00Z' },
  { organizationId: 'foreign' },
])('validates financial statement input %j', async (change) => {
  await expect(caller().financialStatements({ ...input, ...change })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
  expect(mocks.raw).not.toHaveBeenCalled();
});
it('keeps balance-sheet transfers out, includes negative reversals and cash gains, and keeps currency isolation', () => {
  const result = projectProfitAndLoss([
    total('SALES_REVENUE', BigInt(500), BigInt(0)),
    total('INVENTORY_SHRINKAGE', BigInt(0), BigInt(100)),
    total('CASH_OVER_SHORT', BigInt(0), BigInt(50)),
    total('CASH', BigInt(999999), BigInt(0)),
    total('BANK', BigInt(0), BigInt(999999)),
    total('ACCOUNTS_RECEIVABLE', BigInt(100), BigInt(0)),
    total('ACCOUNTS_PAYABLE', BigInt(0), BigInt(100)),
    total('SALES_CLEARING', BigInt(0), BigInt(500)),
    total('OPENING_BALANCE_EQUITY', BigInt(0), BigInt(500)),
    total('OPERATING_EXPENSE', BigInt(400), BigInt(0), 'USD'),
  ]);
  expect(result.map((r) => [r.currency, r.netProfitMinor])).toEqual([
    ['PKR', '-350'],
    ['USD', '-400'],
  ]);
});
it('preserves zero net posted activity separately from no P&L postings', () => {
  expect(
    projectProfitAndLoss([total('SALES_REVENUE', BigInt(100), BigInt(100))])[0].netProfitMinor
  ).toBe('0');
  expect(projectProfitAndLoss([total('SALES_REVENUE', BigInt(0), BigInt(0))])).toEqual([]);
});
it('preserves the existing finance workspace report and its error states', async () => {
  const result = await caller().financialStatements(input);
  const loaded = renderToStaticMarkup(
    await FinancialStatements({
      caller: { financialStatements: async () => result } as never,
      branchId: 'branch_1',
    })
  );
  expect(loaded).toContain('NET PROFIT');
  expect(loaded).toContain('20.00');
  const empty = renderToStaticMarkup(
    await FinancialStatements({
      caller: { financialStatements: async () => ({ ...result, profitAndLoss: [] }) } as never,
      branchId: 'branch_1',
    })
  );
  expect(empty).toContain('No posted P&amp;L movements');
  const error = renderToStaticMarkup(
    await FinancialStatements({
      caller: {
        financialStatements: async () => {
          throw new Error('unavailable');
        },
      } as never,
      branchId: 'branch_1',
    })
  );
  expect(error).toContain('Statements could not be read');
  const { TRPCError } = await import('@trpc/server');
  const denied = renderToStaticMarkup(
    await FinancialStatements({
      caller: {
        financialStatements: async () => {
          throw new TRPCError({ code: 'FORBIDDEN' });
        },
      } as never,
      branchId: 'branch_1',
    })
  );
  expect(denied).toContain('Owner financial-report permission');
});
it('exposes required net revenue and gross profit subtotals', () => {
  expect(projectProfitAndLoss(totals)[0]).toMatchObject({
    netRevenueMinor: '9000',
    grossProfitMinor: '3000',
    netProfitMinor: '2000',
  });
});
it('preserves an unclassified period account', () => {
  const result = projectProfitAndLoss([...totals, total('NEW_EXPENSE', BigInt(500), BigInt(0))]);
  expect(JSON.stringify(result)).toContain('NEW_EXPENSE');
});

const search = { branch: 'branch_1', from: '2026-09-01', to: '2026-09-03' };
const renderPage = (query: Record<string, string | string[] | undefined> = search) =>
  ProfitAndLossPage({ searchParams: Promise.resolve(query) }).then(renderToStaticMarkup);

it('serves the isolated route with reports-only licensing, UTC filters, subtotals and metadata', async () => {
  vi.mocked(hasModule).mockImplementation((_, module) => module === 'pharmacy-reports');
  const html = await renderPage();
  expect(html).toContain('action="/pharmacy/accounts/profit-loss"');
  for (const text of [
    'Profit and loss',
    'Net revenue',
    '90.00',
    'Gross profit',
    '30.00',
    'NET PROFIT',
    '20.00',
    'finance_journal_lines',
    'completeness and cost coverage',
    'unknown',
    '2026-09-01T00:00:00.000Z',
    '2026-09-03T00:00:00.000Z',
  ]) {
    expect(html).toContain(text);
  }
  expect(mocks.raw).toHaveBeenCalledTimes(2);
  expect(mocks.journal).toHaveBeenCalledWith(expect.objectContaining({ take: 25, skip: 0 }));
  expect(mocks.audit).toHaveBeenCalledWith(
    expect.objectContaining({ path: 'financialStatements', outcome: 'SUCCESS' })
  );
});

it.each([
  'ADMIN_PERMISSION',
  'REPORT_ENTITLEMENT',
  'FINANCIAL_PERMISSION',
  'OPERATIONAL_PERMISSION',
  'EMPLOYEE',
  'NO_SESSION',
  'TENANT_MISMATCH',
  'FOREIGN_BRANCH',
  'INACTIVE_BRANCH',
])('shows no financial rows for %s', async (denial) => {
  if (denial === 'ADMIN_PERMISSION')
    mocks.can.mockImplementation(async (_, action) => action !== 'admin:access');
  if (denial === 'REPORT_ENTITLEMENT') vi.mocked(hasModule).mockReturnValue(false);
  if (denial === 'FINANCIAL_PERMISSION')
    mocks.can.mockImplementation(async (_, action) => action !== 'reports:financial');
  if (denial === 'OPERATIONAL_PERMISSION')
    mocks.can.mockImplementation(async (_, action) => action !== 'reports:operational');
  if (denial === 'EMPLOYEE')
    mocks.context.mockResolvedValue(
      context({
        session: {
          user: { id: 'employee', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org_1' },
        },
      })
    );
  if (denial === 'NO_SESSION') mocks.context.mockResolvedValue(context({ session: null }));
  if (denial === 'TENANT_MISMATCH')
    mocks.context.mockResolvedValue(context({ organization: { id: 'foreign' } }));
  if (denial === 'FOREIGN_BRANCH' || denial === 'INACTIVE_BRANCH')
    mocks.branch.mockResolvedValue(null);
  const html = await renderPage(
    denial === 'FOREIGN_BRANCH' ? { ...search, branch: 'foreign' } : search
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain('Owner financial-report permission');
  expect(html).not.toContain('NET PROFIT');
  expect(html).not.toContain('90.00');
  expect(mocks.raw).not.toHaveBeenCalled();
});

it.each([
  { from: '2026-02-30' },
  { to: '2026-09-01' },
  { to: '2027-01-01' },
  { branch: ['branch_1', 'branch_2'] },
  { from: ['2026-09-01', '2026-09-02'] },
])('allows correcting invalid filters without displaying totals: %j', async (change) => {
  const html = await renderPage({ ...search, ...change });
  expect(html).toContain('valid UTC date window');
  expect(html).toContain('Read profit and loss');
  expect(html).not.toContain('NET PROFIT');
  expect(mocks.raw).not.toHaveBeenCalled();
});

it('shows every unmapped debit and credit, including currencies with only unknown activity', async () => {
  mocks.raw
    .mockReset()
    .mockResolvedValueOnce([
      ...totals,
      total('NEW_EXPENSE', BigInt(500), BigInt(100)),
      total('NEW_ACCOUNT', BigInt(200), BigInt(200), 'USD'),
    ])
    .mockResolvedValue([]);
  const html = await renderPage();
  for (const text of [
    'Unmapped account activity',
    'incomplete classification',
    'NEW_EXPENSE',
    'debit 5.00',
    'credit 1.00',
    'NEW_ACCOUNT',
    'USD',
    'MAPPED NET PROFIT',
    'excluded from all calculated totals',
  ]) {
    expect(html).toContain(text);
  }
});

it('distinguishes no postings from a posted zero result and keeps coverage unknown', async () => {
  mocks.raw.mockReset().mockResolvedValue([]);
  const html = await renderPage();
  expect(html).toContain('No posted P&amp;L movements');
  expect(html).toContain('completeness remain unknown');
  expect(html).not.toContain('NET PROFIT');
  mocks.raw.mockResolvedValueOnce([total('SALES_REVENUE', BigInt(100), BigInt(100))]);
  const zero = await renderPage();
  expect(zero).toContain('NET PROFIT');
  expect(zero).toContain('0.00');
  expect(zero).not.toContain('No posted P&amp;L movements');
});

it('shows a useful no-branch state with disabled controls', async () => {
  mocks.branches.mockResolvedValue({ branches: [] });
  const html = await renderPage({ from: search.from, to: search.to });
  expect(html).toContain('Create an active pharmacy branch');
  expect(html).toContain('disabled=""');
  expect(mocks.raw).not.toHaveBeenCalled();
});

it('reports read errors without exposing data or internal errors', async () => {
  mocks.raw.mockReset().mockRejectedValue(new Error('private database credentials'));
  const html = await renderPage();
  expect(html).toContain('Profit and loss could not be read');
  expect(html).not.toContain('private database credentials');
  expect(html).not.toContain('NET PROFIT');
});

it('renders a labeled loading state', () => {
  const html = renderToStaticMarkup(<Loading />);
  expect(html).toContain('role="status"');
  expect(html).toContain('Loading profit and loss');
});
