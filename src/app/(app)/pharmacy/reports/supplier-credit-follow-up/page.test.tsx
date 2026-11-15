import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FollowUpReturn, FollowUpCredit } from '@/lib/pharmacy/supplier-credit-follow-up';
import type { PurchasingReadPage } from '@/lib/pharmacy/purchasing-console';
import type { TRPCContext } from '@/server/trpc';

const mocks = vi.hoisted(() => ({
  tenantContext: vi.fn(),
  can: vi.fn(),
  hasModule: vi.fn(),
  branches: vi.fn(),
  purchaseReturns: vi.fn(),
  supplierCredits: vi.fn(),
}));
vi.mock('../../purchasing/_lib/console', () => ({ tenantContext: mocks.tenantContext }));
vi.mock('@/lib/abac', () => ({ can: mocks.can, subjectFromSession: (user: unknown) => user }));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.hasModule }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/server/routers/pharmacy-reports', () => ({
  pharmacyReportsRouter: { createCaller: () => ({ branches: mocks.branches }) },
}));
vi.mock('@/server/routers/pharmacy-purchasing', () => ({
  pharmacyPurchasingRouter: {
    createCaller: () => ({
      purchaseReturns: mocks.purchaseReturns,
      supplierCredits: mocks.supplierCredits,
    }),
  },
}));

import Page from './page';

const scope = { organizationId: 'org-1', branchId: 'branch-1' };
function claim(): FollowUpReturn & { createdAt: Date } {
  return {
    ...scope,
    id: 'return-1',
    reference: 'RET-ORIGINAL',
    supplierId: 'supplier-1',
    supplier: { name: 'Supplier One' },
    status: 'DISPATCHED',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    dispatchedAt: new Date('2026-09-02T12:00:00Z'),
    lines: [],
    debitNotes: [
      {
        ...scope,
        id: 'note-1',
        supplierId: 'supplier-1',
        purchaseReturnId: 'return-1',
        reference: 'DEBIT-ORIGINAL',
        status: 'PARTIALLY_SETTLED',
        cancelledAt: null,
        issuedAt: new Date('2026-09-02T12:00:00Z'),
        expectedCreditMinor: 10001,
        allocations: [
          { organizationId: scope.organizationId, debitNoteId: 'note-1', amountMinor: 2500 },
        ],
      },
    ],
  };
}
function credit(): FollowUpCredit {
  return {
    ...scope,
    id: 'credit-1',
    supplierId: 'supplier-1',
    reference: 'CREDIT-CANDIDATE',
    amountMinor: 5001,
    allocations: [],
  };
}
const filters = { branch: 'branch-1', from: '2026-09-01', to: '2026-09-03' };
const observedAt = new Date('2026-09-12T07:00:00.000Z');
function envelope<T>(
  rows: T[],
  overrides: Partial<PurchasingReadPage<T>> = {}
): PurchasingReadPage<T> {
  return {
    rows,
    observedAt,
    coverage: 'complete',
    cap: { limit: 50, max: 100 },
    truncated: false,
    nextCursor: null,
    bounds: {
      from: new Date(`${filters.from}T00:00:00.000Z`),
      to: new Date(`${filters.to}T23:59:59.999Z`),
    },
    dateBasis: 'createdAt',
    snapshot: 'live',
    ...overrides,
  };
}
const context = () => ({
  session: {
    user: { id: 'user-1', role: 'ADMIN', status: 'ACTIVE', organizationId: scope.organizationId },
  },
  entitlements: { organizationId: scope.organizationId },
  organization: { id: scope.organizationId, currency: 'PKR' },
  requestMeta: { ip: null },
  db: {},
});
async function show(query: Record<string, string | string[]> = filters) {
  return render(await Page({ searchParams: Promise.resolve(query) }));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.tenantContext.mockResolvedValue(context());
  mocks.can.mockResolvedValue(true);
  mocks.hasModule.mockReturnValue(true);
  mocks.branches.mockResolvedValue({ branches: [{ id: scope.branchId, name: 'Main branch' }] });
  mocks.purchaseReturns.mockResolvedValue(envelope([claim()]));
  mocks.supplierCredits.mockResolvedValue(
    envelope([credit()], { dateBasis: 'receivedAt', bounds: { from: null, to: null } })
  );
});
afterEach(cleanup);

describe('supplier-credit Reports preparation', () => {
  it('connects existing readers and the real pure service without Ask Fathom', async () => {
    await show();
    expect(mocks.can).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      'reports:financial',
      undefined,
      expect.objectContaining({ db: {}, source: 'TRPC' })
    );
    expect(mocks.purchaseReturns).toHaveBeenCalledWith({
      branchId: scope.branchId,
      from: new Date('2026-09-01T00:00:00.000Z'),
      to: new Date('2026-09-03T23:59:59.999Z'),
      page: { limit: 50, after: undefined },
    });
    expect(mocks.supplierCredits).toHaveBeenCalledWith({
      branchId: scope.branchId,
      page: { limit: 50, after: undefined },
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Supplier-credit follow-up'
    );
    expect(screen.getByText('DEBIT-ORIGINAL')).toBeVisible();
    expect(screen.getByRole('link', { name: 'RET-ORIGINAL' })).toHaveAttribute(
      'href',
      '/pharmacy/purchasing/returns?branch=branch-1&return=return-1'
    );
    expect(screen.getByText('PKR 75.01')).toBeVisible();
    expect(screen.getByText('PKR 25.00 allocated')).toBeVisible();
    expect(screen.getByText('PKR 50.01 unallocated')).toBeVisible();
    expect(screen.getByText(/works without Ask Fathom/)).toBeVisible();
    expect(screen.getByLabelText('Branch')).toHaveValue('branch-1');
    expect(screen.getByLabelText('From')).toHaveValue(filters.from);
    expect(screen.getByLabelText('To')).toHaveValue(filters.to);
    expect(screen.getByRole('button', { name: 'Prepare draft' }).closest('form')).toHaveAttribute(
      'method',
      'get'
    );
    expect(screen.getByText(/Partial coverage:/)).toBeVisible();
    expect(screen.getByText(/Currency is the current organization setting/)).toBeVisible();
  });

  it.each([
    'no session',
    'missing actor ID',
    'financial denied',
    'reports unlicensed',
    'procurement unlicensed',
    'tenant mismatch',
  ])('denies %s before financial source reads', async (reason) => {
    if (reason === 'no session') mocks.tenantContext.mockResolvedValue(null);
    if (reason === 'missing actor ID')
      mocks.tenantContext.mockResolvedValue({ ...context(), session: { user: {} } });
    if (reason === 'financial denied') mocks.can.mockResolvedValue(false);
    if (reason === 'tenant mismatch')
      mocks.tenantContext.mockResolvedValue({ ...context(), organization: { id: 'other' } });
    if (reason.endsWith('unlicensed'))
      mocks.hasModule.mockImplementation(
        (_: unknown, key: string) =>
          key !== (reason.startsWith('reports') ? 'pharmacy-reports' : 'pharmacy-procurement')
      );
    await show();
    expect(screen.getByRole('heading', { name: 'Financial report access required' })).toBeVisible();
    expect(mocks.branches).not.toHaveBeenCalled();
    expect(mocks.purchaseReturns).not.toHaveBeenCalled();
    expect(mocks.supplierCredits).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Copy draft CSV' })).toBeNull();
  });

  it('handles operational permission or branch-reader denial without leaking errors', async () => {
    mocks.branches.mockRejectedValue(new Error('private backend detail'));
    await show();
    expect(
      screen.getByText(/Your session, permissions or branch scope could not be verified/)
    ).toBeVisible();
    expect(screen.queryByText(/private backend detail/)).toBeNull();
    expect(mocks.purchaseReturns).not.toHaveBeenCalled();
  });

  it.each([
    { ...filters, branch: 'foreign' },
    { ...filters, from: '2026-02-30' },
    { ...filters, to: '2026-08-31' },
    { ...filters, branch: ['branch-1', 'foreign'] },
    { ...filters, from: ['2026-09-01', '2026-09-02'] },
    { ...filters, returnsAfter: 'bad-cursor' },
    { ...filters, creditsAfter: '{"at":"2026-09-01","id":""}' },
    { ...filters, returnsAfter: ['one', 'two'] },
  ])('refuses invalid scope or dates before reads: %j', async (query) => {
    await show(query);
    expect(mocks.purchaseReturns).not.toHaveBeenCalled();
    expect(mocks.supplierCredits).not.toHaveBeenCalled();
    expect(screen.queryByText('DEBIT-ORIGINAL')).toBeNull();
  });

  it('requires branch choice for multiple branches and disables preparation for no branches', async () => {
    mocks.branches.mockResolvedValue({
      branches: [
        { id: 'branch-1', name: 'Main' },
        { id: 'branch-2', name: 'Second' },
      ],
    });
    await show({ from: filters.from, to: filters.to });
    expect(screen.getByText('Choose a branch to prepare its draft evidence packs.')).toBeVisible();
    expect(mocks.purchaseReturns).not.toHaveBeenCalled();
    cleanup();
    mocks.branches.mockResolvedValue({ branches: [] });
    await show({});
    expect(screen.getByRole('button', { name: 'Prepare draft' })).toBeDisabled();
  });

  it('filters return creation dates with an inclusive UTC end date while keeping current credits', async () => {
    const first = claim();
    const last = {
      ...claim(),
      id: 'return-last',
      reference: 'RET-LAST',
      createdAt: new Date('2026-09-03T23:59:59.999Z'),
    };
    last.debitNotes = [
      {
        ...first.debitNotes[0]!,
        id: 'note-last',
        purchaseReturnId: last.id,
        allocations: [
          { organizationId: scope.organizationId, debitNoteId: 'note-last', amountMinor: 2500 },
        ],
      },
    ];
    const outside = {
      ...claim(),
      id: 'outside',
      reference: 'OUTSIDE',
      createdAt: new Date('2026-09-04T00:00:00Z'),
    };
    mocks.purchaseReturns.mockResolvedValue(envelope([first, last, outside]));
    await show();
    expect(screen.getByRole('link', { name: 'RET-LAST' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'OUTSIDE' })).toBeNull();
    expect(screen.getAllByText('CREDIT-CANDIDATE')).toHaveLength(1);
  });

  it('defaults to and filters by the Karachi business day, not the UTC day', async () => {
    mocks.tenantContext.mockResolvedValue({
      ...context(),
      organization: { ...context().organization, timezone: 'Asia/Karachi' },
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    // 01:30 PKT on 15 November is still 14 November in UTC.
    vi.setSystemTime(new Date('2026-11-14T20:30:00.000Z'));
    try {
      render(
        await Page({
          searchParams: Promise.resolve({ branch: scope.branchId }),
        })
      );
    } finally {
      vi.useRealTimers();
    }
    // 17 Oct–15 Nov on the Karachi clock: 19:00 UTC on 16 Oct to the last instant of 15 Nov PKT.
    expect(mocks.purchaseReturns).toHaveBeenCalledWith(
      expect.objectContaining({
        from: new Date('2026-10-16T19:00:00.000Z'),
        to: new Date('2026-11-15T18:59:59.999Z'),
      })
    );
    expect(screen.getByText(/return creation dates, inclusive, in PKT/)).toBeVisible();
  });

  it('rereads changed allocations on the next preparation', async () => {
    await show();
    expect(screen.getByText('PKR 75.01')).toBeVisible();
    cleanup();
    const updated = claim();
    updated.debitNotes[0]!.allocations[0]!.amountMinor = 9000;
    mocks.purchaseReturns.mockResolvedValue(envelope([updated]));
    mocks.supplierCredits.mockResolvedValue(
      envelope([
        {
          ...credit(),
          allocations: [
            {
              organizationId: scope.organizationId,
              supplierCreditId: 'credit-1',
              amountMinor: 5001,
            },
          ],
        },
      ])
    );
    await show();
    expect(mocks.purchaseReturns).toHaveBeenCalledTimes(2);
    expect(mocks.supplierCredits).toHaveBeenCalledTimes(2);
    expect(screen.getByText('PKR 10.01')).toBeVisible();
    expect(screen.queryByText('CREDIT-CANDIDATE')).toBeNull();
  });

  it('excludes cross-scope, invalid and cancelled financial evidence using the real service', async () => {
    const cancelled = claim();
    cancelled.debitNotes[0]!.cancelledAt = new Date();
    const foreign = { ...claim(), branchId: 'other', reference: 'FOREIGN' };
    mocks.purchaseReturns.mockResolvedValue(envelope([cancelled, foreign]));
    mocks.supplierCredits.mockResolvedValue(envelope([{ ...credit(), amountMinor: 1.5 }]));
    await show();
    expect(screen.getByText(/2 records excluded/)).toBeVisible();
    expect(screen.getByRole('heading', { name: 'No qualifying follow-up records' })).toBeVisible();
    expect(screen.queryByText('FOREIGN')).toBeNull();
    expect(screen.queryByText('DEBIT-ORIGINAL')).toBeNull();
  });

  it('does not treat another supplier credit as a candidate or invent currency', async () => {
    mocks.supplierCredits.mockResolvedValue(envelope([{ ...credit(), supplierId: 'other' }]));
    mocks.tenantContext.mockResolvedValue({
      ...context(),
      organization: { id: scope.organizationId, currency: null },
    });
    await show();
    expect(screen.getByText('Currency unknown 75.01')).toBeVisible();
    expect(screen.queryByText('CREDIT-CANDIDATE')).toBeNull();
  });

  it.each(['purchaseReturns', 'supplierCredits'] as const)(
    'shows recoverable %s failure without a partial pack',
    async (reader) => {
      mocks[reader].mockRejectedValue(new Error('private supplier data'));
      await show();
      expect(screen.getByRole('heading', { name: 'Source records unavailable' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Prepare draft' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Export draft CSV' })).toBeNull();
      expect(screen.queryByText(/private supplier data/)).toBeNull();
    }
  );

  it('renders observations and independent next pages while preserving branch and period', async () => {
    const returnCursor = { at: new Date('2026-09-02T12:00:00Z'), id: 'return-50' };
    const creditCursor = { at: new Date('2026-08-15T12:00:00Z'), id: 'credit-50' };
    mocks.purchaseReturns.mockResolvedValue(
      envelope([claim()], { coverage: 'partial', truncated: true, nextCursor: returnCursor })
    );
    mocks.supplierCredits.mockResolvedValue(
      envelope([credit()], { coverage: 'partial', truncated: true, nextCursor: creditCursor })
    );
    await show();
    expect(
      screen.getAllByText('Incomplete coverage: more source records are available.')
    ).toHaveLength(2);
    expect(screen.getAllByText(/Observed: 2026-09-12T07:00:00.000Z/)).toHaveLength(2);
    const next = new URL(
      screen.getByRole('link', { name: 'Next returns page' }).getAttribute('href')!,
      'https://example.test'
    );
    expect(Object.fromEntries(next.searchParams)).toEqual({
      ...filters,
      returnsAfter: JSON.stringify(returnCursor),
    });
    cleanup();
    await show(Object.fromEntries(next.searchParams));
    expect(mocks.purchaseReturns).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: { limit: 50, after: returnCursor } })
    );
    const nextCredit = new URL(
      screen.getByRole('link', { name: 'Next credits page' }).getAttribute('href')!,
      'https://example.test'
    );
    expect(Object.fromEntries(nextCredit.searchParams)).toEqual({
      ...filters,
      returnsAfter: JSON.stringify(returnCursor),
      creditsAfter: JSON.stringify(creditCursor),
    });
    expect(screen.getByRole('link', { name: 'Back to first pages' })).toHaveAttribute(
      'href',
      `/pharmacy/reports/supplier-credit-follow-up?${new URLSearchParams(filters)}`
    );
  });

  it('shows an exhausted empty first page without claiming a complete financial pack', async () => {
    mocks.purchaseReturns.mockResolvedValue(envelope([]));
    mocks.supplierCredits.mockResolvedValue(envelope([]));
    await show();
    expect(
      screen.getAllByText('All records in this source range were returned by this read.')
    ).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'No qualifying follow-up records' })).toBeVisible();
    expect(screen.getByText(/Partial coverage:/)).toBeVisible();
    expect(screen.queryByRole('link', { name: /Next .* page/ })).toBeNull();
  });

  it('keeps terminal later-page coverage partial and permits restarting', async () => {
    mocks.purchaseReturns.mockResolvedValue(envelope([], { coverage: 'partial' }));
    await show({ ...filters, returnsAfter: JSON.stringify({ at: observedAt, id: 'previous' }) });
    expect(
      screen.getByText('Incomplete coverage: this page excludes earlier source records.')
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to first pages' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Next returns page' })).toBeNull();
  });

  it.each(['missing', 'unknown'])('does not infer full coverage from %s metadata', async (kind) => {
    mocks.purchaseReturns.mockResolvedValue(
      kind === 'missing' ? { rows: [] } : envelope([], { coverage: 'unknown' as never })
    );
    await show();
    expect(
      screen.getByText('Coverage unknown; prepare again before relying on this page.')
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Next returns page' })).toBeNull();
    expect(screen.getByText(/Partial coverage:/)).toBeVisible();
  });

  it('consumes actual router envelopes and reader projections, including current credits outside the return period', async () => {
    const { pharmacyPurchasingRouter } = await vi.importActual<
      typeof import('@/server/routers/pharmacy-purchasing')
    >('@/server/routers/pharmacy-purchasing');
    const returnsRead = vi.fn().mockResolvedValue([claim()]);
    const creditsRead = vi
      .fn()
      .mockResolvedValue([{ ...credit(), receivedAt: new Date('2026-08-01T00:00:00Z') }]);
    const assignmentRead = vi.fn().mockResolvedValue({ id: 'assignment-1' });
    const caller = pharmacyPurchasingRouter.createCaller({
      ...context(),
      db: {
        user: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'user-1',
            status: 'ACTIVE',
            organizationRole: {
              permissions: [{ capability: 'reports:financial', effect: 'ALLOW' }],
            },
            permissionOverrides: [],
          }),
        },
        pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ id: scope.branchId }) },
        pharmacyBranchAssignment: {
          findFirst: assignmentRead,
          findMany: vi.fn().mockResolvedValue([{ branchId: scope.branchId }]),
        },
        pharmacyPurchaseReturn: { findMany: returnsRead },
        pharmacySupplierCredit: { findMany: creditsRead },
      },
    } as unknown as TRPCContext);
    mocks.purchaseReturns.mockImplementation((input) => caller.purchaseReturns(input));
    mocks.supplierCredits.mockImplementation((input) => caller.supplierCredits(input));
    await show();
    expect(returnsRead).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          ...scope,
          createdAt: {
            gte: new Date('2026-09-01T00:00:00Z'),
            lte: new Date('2026-09-03T23:59:59.999Z'),
          },
        },
        take: 51,
      })
    );
    expect(creditsRead).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ...scope, receivedAt: undefined }, take: 51 })
    );
    expect(assignmentRead).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ...scope, userId: 'user-1', active: true },
      })
    );
    expect(screen.getByText('DEBIT-ORIGINAL')).toBeVisible();
    expect(screen.getByText('PKR 75.01')).toBeVisible();
    expect(screen.getByText('CREDIT-CANDIDATE')).toBeVisible();
    expect(
      screen.getAllByText('All records in this source range were returned by this read.')
    ).toHaveLength(2);
    expect(screen.queryByText(/Observed: unknown/)).toBeNull();
  });
});
