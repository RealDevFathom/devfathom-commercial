import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  financialStatements: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: mocks.resolveTenantActor,
}));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/server/routers/pharmacy-finance', () => ({
  pharmacyFinanceRouter: {
    createCaller: () => ({ financialStatements: mocks.financialStatements }),
  },
}));

import Page from './page';

const valid = { branch: 'branch-1', from: '2026-10-01', to: '2026-10-26', page: '1' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTenantActor.mockResolvedValue({
    session: { user: { id: 'owner-1', role: 'ADMIN' } },
    organization: { id: 'org-1' },
    support: null,
  });
  mocks.createTRPCContext.mockResolvedValue({ authorized: true });
  mocks.financialStatements.mockResolvedValue({
    from: new Date('2026-10-01T00:00:00Z'),
    to: new Date('2026-10-26T00:00:00Z'),
    page: 1,
    journalCount: 26,
    journal: Array.from({ length: 25 }, (_, index) => ({
      id: `entry-${index}`,
      sourceKind: 'SALE',
      sourceId: `sale-${index}`,
      description: 'Sale',
      currency: 'PKR',
      occurredAt: new Date('2026-10-25T12:00:00Z'),
      reversesEntryId: null,
      lines: [],
    })),
  });
});

describe('journal evidence export page', () => {
  it('does not read or expose export for a denied actor', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve(valid) }));
    expect(html).toContain('Permission required');
    expect(html).not.toContain('Export this page (CSV)');
    expect(mocks.financialStatements).not.toHaveBeenCalled();
  });

  it('does not read or expose export for invalid bounds', async () => {
    const html = renderToStaticMarkup(
      await Page({ searchParams: Promise.resolve({ ...valid, page: 'not-a-page' }) })
    );
    expect(html).toContain('Invalid input is not read or exported');
    expect(html).not.toContain('Export this page (CSV)');
    expect(mocks.financialStatements).not.toHaveBeenCalled();
  });

  it('shows explicit partial coverage and export only after a successful authorized read', async () => {
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve(valid) }));
    expect(mocks.financialStatements).toHaveBeenCalledWith({
      branchId: 'branch-1',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-26T00:00:00.000Z',
      page: 1,
    });
    expect(html).toContain('Partial page coverage');
    expect(html).toContain('25 entries returned · page cap 25 · 26 entries counted');
    expect(html).toContain('Coverage unknown');
    expect(html).toContain('Export this page (CSV)');
  });

  it('suppresses export when the existing DTO read fails', async () => {
    mocks.financialStatements.mockRejectedValue(new Error('read failed'));
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve(valid) }));
    expect(html).toContain('Evidence could not be read');
    expect(html).not.toContain('Export this page (CSV)');
  });
});
