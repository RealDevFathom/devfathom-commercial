import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  supplierFindMany: vi.fn(),
  settlementFindMany: vi.fn(),
  queryRaw: vi.fn(),
  branchFindMany: vi.fn(),
  branchFindFirst: vi.fn(),
  reportFindFirst: vi.fn(),
  reportFindMany: vi.fn(),
  reportUpdate: vi.fn(),
  settingUpsert: vi.fn(),
  transaction: vi.fn(),
  bankLineCreate: vi.fn(),
  comparison: vi.fn(),
  valuation: vi.fn(),
  margin: vi.fn(),
  leakage: vi.fn(),
}));
vi.mock('@/lib/pharmacy/finance-reports', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/finance-reports')>(
    '@/lib/pharmacy/finance-reports'
  )),
  grossMarginComparison: mocks.comparison,
  perpetualValuation: mocks.valuation,
  grossMargin: mocks.margin,
  leakageReport: mocks.leakage,
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
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import type { TRPCContext } from '../trpc';
import { pharmacyFinanceRouter } from './pharmacy-finance';

function caller(role = 'ADMIN', context: Partial<TRPCContext> = {}) {
  return pharmacyFinanceRouter.createCaller({
    db: {
      $transaction: mocks.transaction,
      $queryRaw: mocks.queryRaw,
      pharmacyBranch: { findMany: mocks.branchFindMany, findFirst: mocks.branchFindFirst },
      pharmacyPharmacovigilanceReport: {
        findFirst: mocks.reportFindFirst,
        findMany: mocks.reportFindMany,
        update: mocks.reportUpdate,
      },
      pharmacyOwnerDigestSetting: { upsert: mocks.settingUpsert },
      pharmacyBankStatementLine: { create: mocks.bankLineCreate },
      pharmacySupplier: { findMany: mocks.supplierFindMany },
      pharmacySupplierExpenseSettlement: { findMany: mocks.settlementFindMany },
    },
    entitlements: {
      organizationId: 'org_1',
      enabledModules: ['pharmacy-reports'],
      modules: [],
    },
    session: {
      expires: 'later',
      user: { id: 'user_admin', role, status: 'ACTIVE', organizationId: 'org_1' },
    },
    organization: { id: 'org_1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
    ...context,
  } as unknown as TRPCContext);
}

import { hasModule } from '@/lib/entitlements';
const input = { branchId: 'branch_1', from: '2026-09-01T00:00:00Z', to: '2026-09-03T00:00:00Z' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.can.mockImplementation(async (subject, action) => action !== 'admin:access' || subject.role === 'ADMIN');
  vi.mocked(hasModule).mockReturnValue(true);
  mocks.branchFindFirst.mockResolvedValue({ id: 'branch_1' });
  mocks.transaction.mockImplementation(async (callback) => callback({ ledger: true }));
  mocks.comparison.mockResolvedValue({ differenceMinor: 42 });
  mocks.valuation.mockResolvedValue([
    {
      branchId: 'branch_1',
      lotId: 'lot_1',
      locationId: null,
      medicineId: null,
      manufacturingBatchId: null,
      unitCostMinor: null,
      valueMinor: 12345,
    },
  ]);
  mocks.margin.mockResolvedValue([
    { key: null, revenueMinor: -100, discountMinor: -10, cogsMinor: -60, grossMarginMinor: -30 },
  ]);
  mocks.leakage.mockResolvedValue([
    {
      branchId: 'branch_1',
      medicineId: null,
      discountMinor: 10,
      writeOffMinor: 20,
      shrinkageMinor: -40,
      totalMinor: -10,
    },
  ]);
});

type FinanceCaller = ReturnType<typeof caller>;
const ledgerCases = [
  {
    name: 'perpetualValuation',
    reader: mocks.valuation,
    input: { branchId: input.branchId, at: input.to },
    expectedReaderInput: new Date(input.to),
    invoke: (api: FinanceCaller, value: unknown) =>
      api.perpetualValuation(value as Parameters<FinanceCaller['perpetualValuation']>[0]),
    invalid: [
      { at: '2026-09-03' },
      { at: '2026-02-30T00:00:00Z' },
      { at: '2026-09-03T00:00:00' },
      { at: '9999-01-01T00:00:00Z' },
      { at: null },
    ],
  },
  {
    name: 'grossMargin',
    reader: mocks.margin,
    input: { ...input, by: 'branch' },
    expectedReaderInput: { from: new Date(input.from), to: new Date(input.to), by: 'branch' },
    invoke: (api: FinanceCaller, value: unknown) =>
      api.grossMargin(value as Parameters<FinanceCaller['grossMargin']>[0]),
    invalid: [
      { from: '2026-09-01' },
      { to: input.from },
      { to: '2026-08-31T00:00:00Z' },
      { to: '2026-12-02T00:00:00.001Z' },
      { by: 'arbitrary_sql' },
      { by: undefined },
    ],
  },
  {
    name: 'leakageReport',
    reader: mocks.leakage,
    input,
    expectedReaderInput: { from: new Date(input.from), to: new Date(input.to) },
    invoke: (api: FinanceCaller, value: unknown) =>
      api.leakageReport(value as Parameters<FinanceCaller['leakageReport']>[0]),
    invalid: [
      { from: '2026-09-01' },
      { to: input.from },
      { to: '2026-08-31T00:00:00Z' },
      { to: '2026-12-02T00:00:00.001Z' },
      { to: '2026-02-30T00:00:00Z' },
    ],
  },
];

describe.each(ledgerCases)(
  '$name ledger boundary',
  ({ reader, input: valid, invoke, invalid, expectedReaderInput }) => {
    it('delegates once with server organization, active branch and exact dates; preserves raw rows', async () => {
      const result = await invoke(caller(), valid);
      expect(reader).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ pharmacyBranch: expect.any(Object) }),
        { organizationId: 'org_1', branchId: 'branch_1' },
        expectedReaderInput
      );
      expect(mocks.branchFindFirst).toHaveBeenCalledWith({
        where: { organizationId: 'org_1', id: 'branch_1', active: true },
        select: { id: true },
      });
      expect(result.rows).toBe(await reader.mock.results[0].value);
      expect(result).toMatchObject({
        scope: { organizationId: 'org_1', branchId: 'branch_1' },
        timezone: 'UTC',
        moneyUnit: 'integer_minor',
        currency: null,
        currencyStatus: 'not_recorded_by_ledger_reader',
        definition: expect.any(String),
        source: 'finance_journal_lines',
        coverage: {
          completeness: 'unknown',
          costCoverage: 'unknown',
          refunds: 'included_only_when_posted_as_reversals',
        },
        freshness: { retrievedAt: expect.any(Date), latestPostingAt: null },
        period:
          'at' in valid && typeof valid.at === 'string'
            ? { at: new Date(valid.at), bounds: 'through_inclusive' }
            : { from: new Date(input.from), to: new Date(input.to), bounds: '[from,to)' },
      });
      expect(mocks.can.mock.calls.map((call) => call[1])).toEqual([
        'admin:access',
        'reports:operational',
        'reports:financial',
      ]);
    });

    it.each(['admin:access', 'reports:operational', 'reports:financial'])(
      'denies missing %s before scope reads',
      async (action) => {
        mocks.can.mockImplementation(async (_subject, requested) => requested !== action);
        await expect(invoke(caller(), valid)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(mocks.branchFindFirst).not.toHaveBeenCalled();
        expect(reader).not.toHaveBeenCalled();
      }
    );

    it.each(['EMPLOYEE', 'HR', 'MANAGER'])(
      'denies %s even with allowed capabilities',
      async (role) => {
        mocks.can.mockResolvedValue(true);
        await expect(invoke(caller(role), valid)).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(mocks.branchFindFirst).not.toHaveBeenCalled();
        expect(reader).not.toHaveBeenCalled();
      }
    );

    it('denies unauthenticated requests', async () => {
      await expect(invoke(caller('ADMIN', { session: null }), valid)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      expect(reader).not.toHaveBeenCalled();
    });

    it('denies missing licensed reports', async () => {
      vi.mocked(hasModule).mockReturnValue(false);
      await expect(invoke(caller(), valid)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.branchFindFirst).not.toHaveBeenCalled();
      expect(reader).not.toHaveBeenCalled();
    });

    it('denies mismatched organization context', async () => {
      await expect(
        invoke(
          caller('ADMIN', { organization: { id: 'foreign_org' } as TRPCContext['organization'] }),
          valid
        )
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.branchFindFirst).not.toHaveBeenCalled();
      expect(reader).not.toHaveBeenCalled();
    });

    it('denies foreign, inactive or absent branch', async () => {
      mocks.branchFindFirst.mockResolvedValue(null);
      await expect(invoke(caller(), valid)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(reader).not.toHaveBeenCalled();
    });

    it.each([
      ...invalid,
      { branchId: '' },
      { branchId: 'x'.repeat(129) },
      { organizationId: 'foreign_org' },
    ])('refuses invalid input %j before ledger access', async (change) => {
      await expect(invoke(caller(), { ...valid, ...change })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(reader).not.toHaveBeenCalled();
    });

    it('keeps empty coverage unknown', async () => {
      reader.mockResolvedValue([]);
      const result = await invoke(caller(), valid);
      expect(result.rows).toEqual([]);
      expect(result.coverage).toMatchObject({
        completeness: 'unknown',
        emptyRows: 'no_matching_postings_not_proof_of_zero_activity',
      });
    });

    it('propagates reader failures without fallback results or writes', async () => {
      reader.mockRejectedValue(new Error('ledger unavailable'));
      await expect(invoke(caller(), valid)).rejects.toThrow('ledger unavailable');
      expect(mocks.transaction).not.toHaveBeenCalled();
    });
  }
);

describe('ledger date and dimension delegation', () => {
  it.each(['line', 'batch', 'product', 'branch'] as const)(
    'accepts margin dimension %s and exact 92-day boundary',
    async (by) => {
      const result = await caller().grossMargin({ ...input, to: '2026-12-02T00:00:00Z', by });
      expect(result.by).toBe(by);
      expect(mocks.margin.mock.calls[0][2]).toEqual({
        from: new Date(input.from),
        to: new Date('2026-12-02T00:00:00Z'),
        by,
      });
    }
  );

  it('normalizes offset instants without changing elapsed period bounds', async () => {
    await caller().leakageReport({
      ...input,
      from: '2026-09-01T05:00:00+05:00',
      to: '2026-12-02T05:00:00+05:00',
    });
    expect(mocks.leakage.mock.calls[0][2]).toEqual({
      from: new Date(input.from),
      to: new Date('2026-12-02T00:00:00Z'),
    });
  });

  it('preserves historic valuation instead of substituting current time', async () => {
    await caller().perpetualValuation({ branchId: 'branch_1', at: '2020-01-01T05:00:00+05:00' });
    expect(mocks.valuation.mock.calls[0][2]).toEqual(new Date('2020-01-01T00:00:00Z'));
  });

  it('keeps simultaneous branch requests isolated', async () => {
    mocks.branchFindFirst.mockImplementation(async ({ where }) => ({ id: where.id }));
    await Promise.all([
      caller().grossMargin({ ...input, by: 'branch' }),
      caller().grossMargin({ ...input, branchId: 'branch_2', by: 'product' }),
    ]);
    expect(mocks.margin.mock.calls.map((call) => [call[1], call[2].by])).toEqual([
      [{ organizationId: 'org_1', branchId: 'branch_1' }, 'branch'],
      [{ organizationId: 'org_1', branchId: 'branch_2' }, 'product'],
    ]);
  });
});
describe('finance comparison boundary', () => {
  it('requires ADMIN plus operational and financial capability', async () => {
    await caller().marginComparison(input);
    expect(mocks.can.mock.calls.map((call) => call[1])).toEqual([
      'admin:access',
      'reports:operational',
      'reports:financial',
    ]);
  });
  it.each([0, 1, 2])('denies failed capability %i before branch reads', async (index) => {
    mocks.can.mockImplementation(
      async (_subject, action) =>
        action !== ['admin:access', 'reports:operational', 'reports:financial'][index]
    );
    await expect(caller().marginComparison(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branchFindFirst).not.toHaveBeenCalled();
    expect(mocks.comparison).not.toHaveBeenCalled();
  });
  it('enforces owner role even when capability mock allows', async () => {
    mocks.can.mockResolvedValue(true);
    await expect(caller('EMPLOYEE').marginComparison(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.comparison).not.toHaveBeenCalled();
  });
  it('requires Pharmacy reports entitlement', async () => {
    vi.mocked(hasModule).mockReturnValue(false);
    await expect(caller().marginComparison(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branchFindFirst).not.toHaveBeenCalled();
  });
  it('rejects foreign, inactive or absent branch', async () => {
    mocks.branchFindFirst.mockResolvedValue(null);
    await expect(caller().marginComparison(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branchFindFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', id: 'branch_1', active: true },
      select: { id: true },
    });
    expect(mocks.comparison).not.toHaveBeenCalled();
  });
  it('passes tenant-scoped arguments to the single-statement read', async () => {
    await expect(caller().marginComparison(input)).resolves.toEqual({ differenceMinor: 42 });
    expect(mocks.comparison).toHaveBeenCalledWith(
      expect.objectContaining({ pharmacyBranch: expect.any(Object) }),
      { organizationId: 'org_1', branchId: 'branch_1' },
      { from: new Date(input.from), to: new Date(input.to) }
    );
  });
  it('refuses a bookkeeping write when the branch is missing, inactive, or outside the workspace', async () => {
    mocks.branchFindMany.mockResolvedValue([]);
    await expect(
      caller().post({
        branchId: 'branch_1',
        reference: 'PAY-1',
        kind: 'SUPPLIER_PAYMENT',
        amountMinor: 100,
        occurredAt: new Date('2026-09-01T00:00:00Z'),
        idempotencyKey: 'key-1',
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That record is not in this workspace.',
    });
    expect(mocks.branchFindMany).toHaveBeenCalledWith({
      where: { id: { in: ['branch_1'] }, organizationId: 'org_1', active: true },
      select: { id: true },
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('refuses a bank-line import when the branch is missing, inactive, or outside the workspace', async () => {
    mocks.branchFindMany.mockResolvedValue([]);
    await expect(
      caller().importBankLine({
        branchId: 'branch_1',
        statementRef: 'stmt_1',
        lineReference: 'line_1',
        bookedAt: new Date('2026-09-01T00:00:00Z'),
        amountMinor: 100,
        description: 'Deposit',
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That record is not in this workspace.',
    });
    expect(mocks.branchFindMany).toHaveBeenCalledWith({
      where: { id: { in: ['branch_1'] }, organizationId: 'org_1', active: true },
      select: { id: true },
    });
    expect(mocks.bankLineCreate).not.toHaveBeenCalled();
  });

  it.each([
    { from: '2026-09-01' },
    { to: '2027-09-01T00:00:00Z' },
    { to: input.from },
    { branchId: '' },
  ])('rejects invalid bounds/scope %j', async (change) => {
    await expect(caller().marginComparison({ ...input, ...change })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.comparison).not.toHaveBeenCalled();
  });
});

describe('native AP supplier choices', () => {
  it('returns only named active authorized suppliers inside the validated workspace', async () => {
    mocks.branchFindMany.mockResolvedValue([{ id: 'branch_1' }]);
    mocks.supplierFindMany.mockResolvedValue([{ id: 'supplier_1', name: 'Utilities' }]);
    await expect(caller().expenseSuppliers({ branchId: 'branch_1' })).resolves.toEqual([{ id: 'supplier_1', name: 'Utilities' }]);
    expect(mocks.supplierFindMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', active: true, authorized: true },
      select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
  });

  it('rejects a branch outside the workspace before reading suppliers', async () => {
    mocks.branchFindMany.mockResolvedValue([]);
    await expect(caller().expenseSuppliers({ branchId: 'foreign' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.supplierFindMany).not.toHaveBeenCalled();
  });

  it('requires the Finance entitlement before reading suppliers', async () => {
    vi.mocked(hasModule).mockReturnValue(false);
    await expect(caller().expenseSuppliers({ branchId: 'branch_1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.supplierFindMany).not.toHaveBeenCalled();
  });

  it('requires an administrator before reading suppliers', async () => {
    await expect(caller('EMPLOYEE').expenseSuppliers({ branchId: 'branch_1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.supplierFindMany).not.toHaveBeenCalled();
  });
});

describe('native AP read boundaries', () => {
  it.each([
    { from: '2026-10-27T00:00:00Z', asOf: '2026-10-26T00:00:00Z' },
    { from: '2024-01-01T00:00:00Z', asOf: '2026-10-26T00:00:00Z' },
    { asOf: '2026-10-28T00:00:00Z' },
  ])('maps invalid aging windows to BAD_REQUEST: %j', async window => {
    mocks.branchFindMany.mockResolvedValue([{ id: 'branch_1' }]);
    mocks.queryRaw.mockResolvedValue([{ now: new Date('2026-10-26T12:00:00Z') }]);
    await expect(caller().expenseAging({ branchId: 'branch_1', ...window })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'INVALID_STATE' });
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
  });

  it('pages posted payments in the validated branch, including fully paid invoices', async () => {
    mocks.branchFindMany.mockResolvedValue([{ id: 'branch_1' }]);
    mocks.settlementFindMany.mockResolvedValue(Array.from({ length: 51 }, (_, index) => ({ id: `payment-${index}` })));
    const result = await caller().expenseSettlements({ branchId: 'branch_1', offset: 50 });
    expect(result.rows).toHaveLength(50);
    expect(result.hasMore).toBe(true);
    expect(mocks.settlementFindMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', invoice: { branchId: 'branch_1' }, status: 'POSTED' },
      select: { id: true, reference: true, amountMinor: true, occurredAt: true, invoice: { select: { supplierInvoiceRef: true } } },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], take: 51, skip: 50,
    });
  });

  it('refuses payment reads outside the validated branch', async () => {
    mocks.branchFindMany.mockResolvedValue([]);
    await expect(caller().expenseSettlements({ branchId: 'foreign' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.settlementFindMany).not.toHaveBeenCalled();
  });

  it('requires administrator capability and Finance licensing for payment reads', async () => {
    await expect(caller('EMPLOYEE').expenseSettlements({ branchId: 'branch_1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    vi.mocked(hasModule).mockReturnValue(false);
    await expect(caller().expenseSettlements({ branchId: 'branch_1' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.settlementFindMany).not.toHaveBeenCalled();
  });
});

describe('cash-flow forecast boundary', () => {
  const forecastInput = {
    branchId: 'branch_1',
    asOfDate: '2026-10-29',
    openingCashMinor: 1_000,
    minimumCashReserveMinor: 100,
    annualCashValueBps: 1_200,
    salesCashEstimates: [],
    khataCollectionEstimates: [],
    payables: [{ id: 'bill_1', dueDate: '2026-11-08', amountMinor: 200 }],
  };

  it('checks report permissions and active tenant branch without writing to the ledger', async () => {
    const result = await caller().cashFlowForecast(forecastInput);
    expect(result).toMatchObject({
      status: 'ESTIMATE',
      windows: [
        { days: 30, closingCashMinor: 800 },
        { days: 60, closingCashMinor: 800 },
        { days: 90, closingCashMinor: 800 },
      ],
    });
    expect(mocks.can.mock.calls.map((call) => call[1])).toEqual([
      'admin:access',
      'reports:operational',
      'reports:financial',
    ]);
    expect(mocks.branchFindFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', id: 'branch_1', active: true },
      select: { id: true },
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each(['admin:access', 'reports:operational', 'reports:financial'])(
    'denies a missing %s capability',
    async (action) => {
      mocks.can.mockImplementation(async (_subject, requested) => requested !== action);
      await expect(caller().cashFlowForecast(forecastInput)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(mocks.branchFindFirst).not.toHaveBeenCalled();
    }
  );

  it.each(['EMPLOYEE', 'HR', 'MANAGER'])('denies the %s role', async (role) => {
    await expect(caller(role).cashFlowForecast(forecastInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('denies unauthenticated requests', async () => {
    await expect(
      caller('ADMIN', { session: null }).cashFlowForecast(forecastInput)
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('requires a reports license', async () => {
    vi.mocked(hasModule).mockReturnValue(false);
    await expect(caller().cashFlowForecast(forecastInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.branchFindFirst).not.toHaveBeenCalled();
  });

  it('denies a mismatched organization', async () => {
    await expect(
      caller('ADMIN', {
        organization: { id: 'foreign_org' } as TRPCContext['organization'],
      }).cashFlowForecast(forecastInput)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.branchFindFirst).not.toHaveBeenCalled();
  });

  it('denies a foreign, inactive or absent branch', async () => {
    mocks.branchFindFirst.mockResolvedValue(null);
    await expect(caller().cashFlowForecast(forecastInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it.each([
    { dueDate: '2026-10-29' },
    { dueDate: '2026-10-28' },
    { earlyPayDate: '2026-10-29' },
    { earlyPayDate: '2026-11-08' },
    { earlyPayDate: '2026-11-09' },
  ])('returns BAD_REQUEST for invalid payment dates %j', async (change) => {
    await expect(
      caller().cashFlowForecast({
        ...forecastInput,
        payables: [{ ...forecastInput.payables[0], ...change }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('returns BAD_REQUEST when forecast totals exceed safe integer precision', async () => {
    await expect(
      caller().cashFlowForecast({
        ...forecastInput,
        openingCashMinor: Number.MAX_SAFE_INTEGER,
        salesCashEstimates: [{ id: 'sales', date: '2026-10-30', amountMinor: 1 }],
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
