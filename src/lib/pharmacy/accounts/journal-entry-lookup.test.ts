import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  branch: vi.fn(),
  assignments: vi.fn(),
  journal: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
}));
vi.mock('@/server/audit', () => ({
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: mocks.audit,
}));

import { hasModule } from '@/lib/entitlements';
import type { TRPCContext } from '@/server/trpc';
import { journalEntryLookupRouter } from './journal-entry-lookup';

const input = {
  branchId: '!',
  entryId: '.',
  from: '2026-08-01T00:00:00Z',
  to: '2026-08-02T00:00:00Z',
};
function caller(overrides: Partial<TRPCContext> = {}) {
  return journalEntryLookupRouter.createCaller({
    db: {
      pharmacyBranchAssignment: { findMany: mocks.assignments },
      pharmacyBranch: { findFirst: mocks.branch },
      financeJournalEntry: { findFirst: mocks.journal },
    },
    entitlements: { organizationId: 'org_1', enabledModules: ['pharmacy-reports'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'admin', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org_1' },
    },
    organization: { id: 'org_1' },
    support: null,
    requestMeta: { ip: '127.0.0.1', userAgent: null },
    audit: { detail: {} },
    ...overrides,
  } as unknown as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasModule).mockReturnValue(true);
  mocks.can.mockResolvedValue(true);
  mocks.audit.mockResolvedValue(undefined);
  mocks.branch.mockResolvedValue({ id: '!' });
  mocks.journal.mockResolvedValue(null);
});

describe('exact posted-journal lookup', () => {
  it('uses one exact, tenant/window/line-scoped query with a stable 201-line bound', async () => {
    await expect(caller().lookup(input)).resolves.toEqual({ status: 'NOT_FOUND' });
    expect(mocks.branch).toHaveBeenCalledOnce();
    expect(mocks.branch).toHaveBeenCalledWith({
      where: { id: '!', organizationId: 'org_1', active: true },
      select: { id: true },
    });
    expect(mocks.journal).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'SUCCESS' }));
    expect(mocks.journal).toHaveBeenCalledWith({
      where: {
        id: '.',
        organizationId: 'org_1',
        occurredAt: { gte: new Date(input.from), lt: new Date(input.to) },
        lines: { some: { organizationId: 'org_1', branchId: '!' } },
      },
      select: expect.objectContaining({
        id: true,
        sourceKind: true,
        sourceId: true,
        currency: true,
        occurredAt: true,
        reversesEntryId: true,
        lines: {
          where: { organizationId: 'org_1', branchId: '!' },
          orderBy: { id: 'asc' },
          take: 201,
          select: { id: true, accountCode: true, side: true, amountMinor: true },
        },
      }),
    });
  });

  it('ignores the nullable header branch and returns only branch-scoped lines', async () => {
    // Header branchId is null (interbranch entry); access is decided by the branch's lines only.
    mocks.journal.mockResolvedValue({
      id: '.',
      sourceKind: 'SALE',
      sourceId: 'sale-1',
      currency: 'PKR',
      occurredAt: new Date(input.from),
      reversesEntryId: null,
      branchId: null,
      lines: [{ id: 'line-1', accountCode: 'CASH', side: 'DEBIT', amountMinor: 5 }],
    });
    const result = await caller().lookup(input);
    expect(result).toEqual({
      status: 'FOUND',
      entry: {
        id: '.',
        sourceKind: 'SALE',
        sourceId: 'sale-1',
        currency: 'PKR',
        occurredAt: new Date(input.from).toISOString(),
        reversesEntryId: null,
        lines: [{ id: 'line-1', accountCode: 'CASH', side: 'DEBIT', amountMinor: '5' }],
        debitMinor: '5',
        creditMinor: '0',
        differenceMinor: '5',
      },
    });
    const query = mocks.journal.mock.calls[0][0];
    expect(query.where).not.toHaveProperty('branchId');
    expect(query.select).not.toHaveProperty('branchId');
    expect(query.where.lines).toEqual({ some: { organizationId: 'org_1', branchId: '!' } });
    expect(query.select.lines.where).toEqual({ organizationId: 'org_1', branchId: '!' });
  });

  it('finds an original entry and its reversal independently by exact ID', async () => {
    const entry = (id: string, reversesEntryId: string | null, side: 'DEBIT' | 'CREDIT') => ({
      id,
      sourceKind: 'SALE',
      sourceId: 'sale-1',
      currency: 'PKR',
      occurredAt: new Date(input.from),
      reversesEntryId,
      lines: [{ id: `${id}-line`, accountCode: 'CASH', side, amountMinor: 7 }],
    });
    mocks.journal
      .mockResolvedValueOnce(entry('original', null, 'DEBIT'))
      .mockResolvedValueOnce(entry('reversal', 'original', 'CREDIT'));

    const original = await caller().lookup({ ...input, entryId: 'original' });
    const reversal = await caller().lookup({ ...input, entryId: 'reversal' });

    expect(mocks.journal.mock.calls[0][0].where.id).toBe('original');
    expect(mocks.journal.mock.calls[1][0].where.id).toBe('reversal');
    expect(original).toMatchObject({
      status: 'FOUND',
      entry: { id: 'original', reversesEntryId: null, debitMinor: '7', differenceMinor: '7' },
    });
    expect(reversal).toMatchObject({
      status: 'FOUND',
      entry: {
        id: 'reversal',
        reversesEntryId: 'original',
        creditMinor: '7',
        differenceMinor: '-7',
      },
    });
  });

  it('returns no details or totals for 201 rows and performs no second journal read', async () => {
    mocks.journal.mockResolvedValue({
      lines: Array.from({ length: 201 }, (_, i) => ({ id: String(i) })),
    });
    await expect(caller().lookup(input)).resolves.toEqual({ status: 'TRUNCATED' });
    expect(mocks.journal).toHaveBeenCalledOnce();
  });

  it('rejects an overlong lookup window before any database read', async () => {
    await expect(caller().lookup({ ...input, to: '2026-11-02T00:00:00Z' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.branch).not.toHaveBeenCalled();
    expect(mocks.journal).not.toHaveBeenCalled();
  });

  it('validates source rows and sums 200 maximum integers exactly with BigInt', async () => {
    mocks.journal.mockResolvedValue({
      id: '.',
      sourceKind: 'SALE',
      sourceId: '<source>',
      currency: 'PKR',
      occurredAt: new Date(input.from),
      reversesEntryId: null,
      lines: Array.from({ length: 200 }, (_, i) => ({
        id: `line-${i}`,
        accountCode: 'CASH',
        side: 'DEBIT',
        amountMinor: 2_147_483_647,
      })),
    });
    const result = await caller().lookup(input);
    expect(result.status).toBe('FOUND');
    if (result.status === 'FOUND') expect(result.entry.debitMinor).toBe('429496729400');

    mocks.journal.mockResolvedValue({
      id: '.',
      sourceKind: 'SALE',
      sourceId: 'x',
      currency: 'PKR',
      occurredAt: new Date(),
      reversesEntryId: null,
      lines: [{ id: 'same', accountCode: 'CASH', side: 'DEBIT', amountMinor: -1 }],
    });
    await expect(caller().lookup(input)).resolves.toEqual({ status: 'INVALID_SOURCE' });
  });

  it.each([
    ['blank header', { sourceKind: '' }],
    ['whitespace-only header', { sourceKind: '   ' }],
    ['invalid timestamp', { occurredAt: new Date(Number.NaN) }],
    ['empty branch slice', { lines: [] }],
    [
      'duplicate line ID',
      {
        lines: [
          { id: 'same', accountCode: 'CASH', side: 'DEBIT', amountMinor: 1 },
          { id: 'same', accountCode: 'SALES', side: 'CREDIT', amountMinor: 1 },
        ],
      },
    ],
    [
      'zero debit amount',
      {
        lines: [
          { id: 'line-1', accountCode: 'CASH', side: 'DEBIT', amountMinor: 1 },
          { id: 'line-2', accountCode: 'CASH', side: 'DEBIT', amountMinor: 0 },
        ],
      },
    ],
    [
      'zero credit amount',
      {
        lines: [
          { id: 'line-1', accountCode: 'CASH', side: 'DEBIT', amountMinor: 1 },
          { id: 'line-2', accountCode: 'SALES_REVENUE', side: 'CREDIT', amountMinor: 0 },
        ],
      },
    ],
    [
      'out-of-range amount',
      {
        lines: [{ id: 'line-1', accountCode: 'CASH', side: 'DEBIT', amountMinor: 2_147_483_648 }],
      },
    ],
  ])('returns no source detail for an invalid %s', async (_name, override) => {
    mocks.journal.mockResolvedValue({
      id: '.',
      sourceKind: 'SALE',
      sourceId: 'sale-1',
      currency: 'PKR',
      occurredAt: new Date(input.from),
      reversesEntryId: null,
      lines: [{ id: 'line-1', accountCode: 'CASH', side: 'DEBIT', amountMinor: 1 }],
      ...override,
    });

    await expect(caller().lookup(input)).resolves.toEqual({ status: 'INVALID_SOURCE' });
  });

  it.each([
    ['admin deny', () => mocks.can.mockResolvedValueOnce(false), {}],
    ['module deny', () => vi.mocked(hasModule).mockReturnValue(false), {}],
    [
      'operational report deny',
      () => mocks.can.mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      {},
    ],
    [
      'financial report deny',
      () =>
        mocks.can
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(true)
          .mockResolvedValueOnce(false),
      {},
    ],
    ['organization mismatch', () => {}, { organization: { id: 'other' } }],
    ['missing session', () => {}, { session: null }],
    [
      'inactive session',
      () => {},
      {
        session: {
          expires: 'later',
          user: { id: 'admin', role: 'ADMIN', status: 'INACTIVE', organizationId: 'org_1' },
        },
      },
    ],
  ])('fails closed before branch and journal reads: %s', async (_name, arrange, overrides) => {
    arrange();
    await expect(caller(overrides as Partial<TRPCContext>).lookup(input)).rejects.toMatchObject({
      code: expect.stringMatching(/UNAUTHORIZED|FORBIDDEN/),
    });
    expect(mocks.branch).not.toHaveBeenCalled();
    expect(mocks.journal).not.toHaveBeenCalled();
  });

  it('denies unknown branches before the journal read and awaits both report decisions', async () => {
    mocks.branch.mockResolvedValue(null);
    await expect(caller().lookup(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.can).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'admin:access',
      undefined,
      expect.objectContaining({ source: 'TRPC' })
    );
    expect(mocks.can).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'reports:operational',
      undefined,
      expect.objectContaining({ source: 'TRPC', ip: '127.0.0.1' })
    );
    expect(mocks.can).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      'reports:financial',
      undefined,
      expect.objectContaining({ source: 'TRPC', ip: '127.0.0.1' })
    );
    expect(mocks.journal).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'FAILURE' }));
  });
});

it('lets an admitted Finance employee look up a journal entry', async () => {
  mocks.can.mockImplementation(async (_subject, action) =>
    ['finance:read', 'reports:operational', 'reports:financial'].includes(action)
  );
  mocks.assignments.mockResolvedValue([{ branchId: input.branchId }]);
  await expect(
    caller({
      session: {
        expires: 'later',
        user: { id: 'accountant', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org_1' },
      } as TRPCContext['session'],
    }).lookup(input)
  ).resolves.toEqual({ status: 'NOT_FOUND' });
});
