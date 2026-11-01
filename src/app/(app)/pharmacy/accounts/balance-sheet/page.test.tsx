import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PharmacyBalanceSheetPage from './page';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  branches: vi.fn(),
  createCaller: vi.fn(() => ({ financialStatements: vi.fn() })),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.actor }));
vi.mock('@/server/trpc', () => ({
  createTRPCContext: vi.fn(async () => ({
    session: { user: { role: 'ADMIN' } },
    entitlements: { organizationId: 'organization_1' },
    db: { pharmacyBranch: { findMany: mocks.branches } },
  })),
}));
vi.mock('@/server/routers/pharmacy-finance', () => ({
  pharmacyFinanceRouter: { createCaller: mocks.createCaller },
}));
vi.mock('./balance-sheet-report', () => ({
  BalanceSheetReport: ({ branchId, cutoff }: { branchId: string; cutoff: string }) => (
    <div data-testid="balance-sheet" data-branch={branchId} data-cutoff={cutoff} />
  ),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T12:00:00.000Z'));
  vi.clearAllMocks();
  mocks.actor.mockResolvedValue({
    session: { user: { role: 'ADMIN' } },
    organization: { id: 'organization_1' },
  });
  mocks.branches.mockResolvedValue([{ id: 'branch_1' }, { id: 'branch_2' }]);
});

afterEach(() => vi.useRealTimers());

describe('PharmacyBalanceSheetPage', () => {
  it('scopes branch discovery to the tenant and composes an authorized cutoff report', async () => {
    const html = renderToStaticMarkup(
      await PharmacyBalanceSheetPage({
        searchParams: Promise.resolve({ branch: 'branch_2', cutoff: '2026-10-28' }),
      })
    );

    expect(mocks.branches).toHaveBeenCalledWith({
      where: { organizationId: 'organization_1', active: true },
      orderBy: { name: 'asc' },
      select: { id: true },
    });
    expect(html).toContain('data-branch="branch_2"');
    expect(html).toContain('data-cutoff="2026-10-28"');
    expect(mocks.createCaller).toHaveBeenCalledOnce();
  });

  it('rejects an out-of-tenant branch choice and invalid cutoff without losing the report', async () => {
    const html = renderToStaticMarkup(
      await PharmacyBalanceSheetPage({
        searchParams: Promise.resolve({ branch: 'outside-tenant', cutoff: '2026-02-30' }),
      })
    );

    expect(html).toContain('data-branch="branch_1"');
    expect(html).toContain('data-cutoff="2026-10-29"');
  });

  it('fails closed before branch or report access for a non-admin actor', async () => {
    mocks.actor.mockResolvedValue(null);
    const html = renderToStaticMarkup(
      await PharmacyBalanceSheetPage({ searchParams: Promise.resolve({}) })
    );

    expect(html).toContain('Permission required');
    expect(mocks.branches).not.toHaveBeenCalled();
    expect(mocks.createCaller).not.toHaveBeenCalled();
  });
});
