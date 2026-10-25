import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  can: vi.fn(),
  hasModule: vi.fn(),
  branchFindMany: vi.fn(),
  workspace: vi.fn(),
  recordTrpcAudit: vi.fn(),
  isDemoProcedureBlocked: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
// Keep the REAL router/adminProcedure middleware. Mock only context creation and IO leaves.
vi.mock('@/server/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/trpc')>();
  return { ...actual, createTRPCContext: mocks.createTRPCContext };
});
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/server/audit', () => ({
  recordTrpcAudit: mocks.recordTrpcAudit,
  isAuditExcludedPath: () => false,
  ipFromHeaders: () => null,
}));
vi.mock('@/lib/tenancy/demo-isolation', () => ({
  DEMO_UNAVAILABLE_MESSAGE: 'This feature is unavailable in this workspace.',
  isDemoProcedureBlocked: mocks.isDemoProcedureBlocked,
}));
vi.mock('@/lib/abac', () => ({ can: mocks.can, subjectFromSession: (user: unknown) => user }));
vi.mock('@/lib/entitlements', () => ({ hasModule: mocks.hasModule }));
vi.mock('@/server/routers/pharmacy-finance', () => ({
  pharmacyFinanceRouter: { createCaller: () => ({ workspace: mocks.workspace }) },
}));

import Page from './page';

const ctx = {
  session: { user: { id: 'user-1', role: 'ADMIN', status: 'ACTIVE' } },
  organization: { id: 'org-1' },
  entitlements: { organizationId: 'org-1' },
  requestMeta: { ip: null },
  db: { pharmacyBranch: { findMany: mocks.branchFindMany } },
};
const filters = { branch: 'branch-1', from: '2026-10-01', to: '2026-11-01' };
const cheque = {
  organizationId: 'org-1',
  branchId: 'branch-1',
  kind: 'CHEQUE',
  status: 'POSTED',
  chequeStatus: 'PDC',
  reference: 'CHQ-100',
  counterpartyName: 'Supplier One',
  chequeNumber: '100',
  amountMinor: 12345,
  currency: 'PKR',
  occurredAt: new Date('2026-09-20T00:00:00Z'),
  chequeDueAt: new Date('2026-10-15T00:00:00Z'),
  reversedAt: null,
};

async function show(query: Record<string, string | string[]> = filters) {
  return render(await Page({ searchParams: Promise.resolve(query) }));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveTenantActor.mockResolvedValue({
    session: ctx.session,
    organization: ctx.organization,
    support: null,
  });
  mocks.createTRPCContext.mockResolvedValue(ctx);
  mocks.can.mockResolvedValue(true);
  mocks.recordTrpcAudit.mockResolvedValue(undefined);
  mocks.isDemoProcedureBlocked.mockReturnValue(false);
  mocks.hasModule.mockReturnValue(true);
  mocks.branchFindMany.mockResolvedValue([{ id: 'branch-1', name: 'Main branch' }]);
  mocks.workspace.mockResolvedValue({ transactions: [cheque] });
});
afterEach(cleanup);

describe('cheque maturity page', () => {
  it('requires canonical admin and both report capabilities before branch and finance reads', async () => {
    await show();
    expect(mocks.can.mock.calls.map((call) => call[1])).toEqual([
      'admin:access',
      'reports:operational',
      'reports:financial',
    ]);
    expect(mocks.branchFindMany).toHaveBeenCalledExactlyOnceWith({
      where: { organizationId: 'org-1', active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
    expect(mocks.recordTrpcAudit).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'chequeMaturityBranches', type: 'query', outcome: 'SUCCESS' })
    );
    expect(mocks.workspace).toHaveBeenCalledExactlyOnceWith({ branchId: 'branch-1' });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Cheque maturity evidence');
    expect(screen.getByText('CHQ-100')).toBeVisible();
    expect(screen.getByText('PKR 123.45')).toBeVisible();
    expect(screen.getByRole('button', { name: /Download CSV/ })).toBeVisible();
    expect(screen.getByText(/Coverage unknown/)).toBeVisible();
  });

  it.each([
    'no actor',
    'not admin',
    'tenant mismatch',
    'admin capability denied',
    'operational denied',
    'financial denied',
  ])('denies %s before branch or financial DTO reads', async (reason) => {
    if (reason === 'no actor') mocks.resolveTenantActor.mockResolvedValue(null);
    if (reason === 'not admin')
      mocks.createTRPCContext.mockResolvedValue({
        ...ctx,
        session: { user: { ...ctx.session.user, role: 'MEMBER' } },
      });
    if (reason === 'tenant mismatch')
      mocks.createTRPCContext.mockResolvedValue({ ...ctx, organization: { id: 'foreign' } });
    if (reason.includes('denied'))
      mocks.can.mockImplementation(
        async (_subject: unknown, action: string) =>
          action !==
          (reason.startsWith('admin capability')
            ? 'admin:access'
            : reason.startsWith('operational')
              ? 'reports:operational'
              : 'reports:financial')
      );
    await show();
    expect(screen.getByRole('heading', { name: 'Financial report access required' })).toBeVisible();
    expect(mocks.branchFindMany).not.toHaveBeenCalled();
    expect(mocks.workspace).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Download CSV/ })).toBeNull();
  });

  it.each(['pharmacy-reports', 'pharmacy-finance'])(
    'denies %s module access with every capability allowed before branch discovery',
    async (deniedModule) => {
      // Isolate this module gate: admin and both report capabilities all ALLOW.
      mocks.can.mockResolvedValue(true);
      mocks.hasModule.mockImplementation(
        (_entitlements: unknown, module: string) => module !== deniedModule
      );
      await show();
      expect(mocks.hasModule).toHaveBeenCalledWith(ctx.entitlements, deniedModule);
      expect(mocks.can.mock.calls.map((call) => call[1])).toEqual(['admin:access']);
      expect(screen.getByRole('heading', { name: 'Financial report access required' })).toBeVisible();
      expect(mocks.branchFindMany).not.toHaveBeenCalled();
      expect(mocks.workspace).not.toHaveBeenCalled();
      expect(mocks.recordTrpcAudit).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'chequeMaturityBranches', type: 'query', outcome: 'FAILURE' })
      );
      expect(screen.queryByRole('button', { name: /Download CSV/ })).toBeNull();
    }
  );

  it('audits an explicit admin DENY despite both report ALLOWs before any branch read', async () => {
    mocks.can.mockImplementation(async (_subject: unknown, action: string) => action !== 'admin:access');
    await show();
    expect(mocks.can.mock.calls.map((call) => call[1])).toEqual(['admin:access']);
    expect(mocks.branchFindMany).not.toHaveBeenCalled();
    expect(mocks.workspace).not.toHaveBeenCalled();
    expect(mocks.recordTrpcAudit).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'chequeMaturityBranches', type: 'query', outcome: 'FAILURE' })
    );
    expect(screen.getByRole('heading', { name: 'Financial report access required' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Download CSV/ })).toBeNull();
  });

  it.each([
    { status: undefined },
    { status: 'INACTIVE' },
    { sessionRevoked: true },
    { mustChangePassword: true },
  ])('uses the canonical fail-closed session envelope: %j', async (claims) => {
    mocks.createTRPCContext.mockResolvedValue({
      ...ctx,
      session: { user: { ...ctx.session.user, ...claims } },
    });
    await show();
    expect(mocks.can).not.toHaveBeenCalled();
    expect(mocks.branchFindMany).not.toHaveBeenCalled();
    expect(mocks.workspace).not.toHaveBeenCalled();
    expect(mocks.recordTrpcAudit).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'chequeMaturityBranches', type: 'query', outcome: 'FAILURE' })
    );
    expect(screen.getByRole('heading', { name: 'Financial report access required' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Download CSV/ })).toBeNull();
  });

  it('retains canonical demo blocking before branch discovery', async () => {
    mocks.createTRPCContext.mockResolvedValue({ ...ctx, organization: { ...ctx.organization, isDemo: true } });
    mocks.isDemoProcedureBlocked.mockReturnValue(true);
    await show();
    expect(mocks.can).not.toHaveBeenCalled();
    expect(mocks.branchFindMany).not.toHaveBeenCalled();
    expect(mocks.workspace).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Download CSV/ })).toBeNull();
  });

  it.each(['policy', 'branch'])('fails closed and audits a %s lookup failure without details', async (reason) => {
    if (reason === 'policy') mocks.can.mockRejectedValue(new Error('private policy payload'));
    else mocks.branchFindMany.mockRejectedValue(new Error('private branch payload'));
    await show();
    expect(mocks.recordTrpcAudit).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'chequeMaturityBranches', type: 'query', outcome: 'FAILURE' })
    );
    expect(mocks.workspace).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Report access unavailable' })).toBeVisible();
    expect(screen.queryByText(/private .* payload/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Download CSV/ })).toBeNull();
  });

  it('denies an explicit foreign or inactive branch without falling back or fetching DTOs', async () => {
    await show({ ...filters, branch: 'foreign' });
    expect(screen.getByRole('heading', { name: 'Branch outside report scope' })).toBeVisible();
    expect(mocks.workspace).not.toHaveBeenCalled();
    expect(screen.getByText(/No financial evidence was read/)).toBeVisible();
  });

  it.each([
    { ...filters, from: '2026-10-02', to: '2026-10-02' },
    { ...filters, from: '2026-01-01', to: '2026-04-04' },
    { ...filters, branch: ['branch-1', 'foreign'] },
  ])('rejects invalid windows and duplicate inputs before DTO reads: %j', async (query) => {
    await show(query);
    expect(screen.getByRole('heading', { name: 'Invalid report period' })).toBeVisible();
    expect(mocks.workspace).not.toHaveBeenCalled();
  });

  it('handles read errors without leaking details and never exposes mutations', async () => {
    mocks.workspace.mockRejectedValue(new Error('private provider payload'));
    await show();
    expect(screen.getByRole('heading', { name: 'Cheque evidence unavailable' })).toBeVisible();
    expect(screen.queryByText(/private provider payload/)).toBeNull();
    expect(screen.getByText(/No financial data was changed/)).toBeVisible();
    expect(mocks.workspace).toHaveBeenCalledTimes(1);
    expect(Object.keys(mocks)).not.toContain('post');
  });

  it.each([0, 50])(
    'keeps full coverage unknown for a %i-transaction source read',
    async (count) => {
      mocks.workspace.mockResolvedValue({
        transactions: Array.from({ length: count }, (_, index) => ({
          ...cheque,
          reference: `CHQ-${index}`,
        })),
      });
      await show();
      expect(
        screen.getByText(
          /Recent capped current-state read \(up to 50 transactions\); full coverage is unknown/
        )
      ).toBeVisible();
      if (!count) expect(screen.getByText(/This does not prove there were none/)).toBeVisible();
    }
  );
});
