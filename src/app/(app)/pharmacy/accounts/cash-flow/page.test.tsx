import { renderToStaticMarkup } from 'react-dom/server';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  createTRPCContext: vi.fn(),
  financialStatements: vi.fn(),
  loadCashFlowProjection: vi.fn(),
}));

vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/server/trpc', () => ({ createTRPCContext: mocks.createTRPCContext }));
vi.mock('@/server/routers/pharmacy-finance', () => ({
  pharmacyFinanceRouter: { createCaller: () => ({ financialStatements: mocks.financialStatements }) },
}));
vi.mock('@/lib/pharmacy/accounts/cash-flow', () => ({
  loadCashFlowProjection: mocks.loadCashFlowProjection,
}));

import CashFlowPage from './page';

const params = Promise.resolve({ branch: 'branch-a', from: '2026-10-01', to: '2026-11-01' });

describe('CashFlowPage authorization and metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTenantActor.mockResolvedValue({
      session: { user: { id: 'owner', organizationId: 'org-a' } },
      organization: { id: 'org-a' },
      support: null,
    });
    mocks.createTRPCContext.mockResolvedValue({ db: { marker: 'scoped' } });
  });

  it.each(['FORBIDDEN', 'UNAUTHORIZED'] as const)(
    'renders no financial data when the report gate returns %s',
    async (code) => {
      mocks.financialStatements.mockRejectedValue(new TRPCError({ code }));

      const markup = renderToStaticMarkup(await CashFlowPage({ searchParams: params }));

      expect(markup).toContain('active in-scope branch are required');
      expect(markup).not.toContain('Opening-to-closing reconciliation');
      expect(markup).not.toContain('SECRET_FINANCIAL_VALUE');
      expect(mocks.loadCashFlowProjection).not.toHaveBeenCalled();
    }
  );

  it('does not create an authorization context or read data without a tenant actor', async () => {
    mocks.resolveTenantActor.mockResolvedValue(null);

    const markup = renderToStaticMarkup(await CashFlowPage({ searchParams: params }));

    expect(markup).toContain('active in-scope branch are required');
    expect(mocks.createTRPCContext).not.toHaveBeenCalled();
    expect(mocks.financialStatements).not.toHaveBeenCalled();
    expect(mocks.loadCashFlowProjection).not.toHaveBeenCalled();
  });

  it('fails closed when the authorized projection read fails', async () => {
    mocks.financialStatements.mockResolvedValue({
      scope: { organizationId: 'org-a', branchId: 'branch-a' },
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-11-01T00:00:00Z'),
      accounts: [],
      cashflow: [],
      freshness: { retrievedAt: new Date('2026-11-01T01:00:00Z') },
    });
    mocks.loadCashFlowProjection.mockRejectedValue(new Error('database unavailable'));

    const markup = renderToStaticMarkup(await CashFlowPage({ searchParams: params }));

    expect(markup).toContain('The projection could not be read');
    expect(markup).not.toContain('Opening-to-closing reconciliation');
    expect(markup).not.toContain('No scoped cash or bank postings before the cutoff');
  });

  it('shows per-currency source freshness and completeness returned by the projection', async () => {
    mocks.financialStatements.mockResolvedValue({
      scope: { organizationId: 'org-a', branchId: 'branch-a' },
      from: new Date('2026-10-01T00:00:00Z'),
      to: new Date('2026-11-01T00:00:00Z'),
      accounts: [],
      cashflow: [],
      freshness: { retrievedAt: new Date('2026-11-01T01:00:00Z') },
    });
    mocks.loadCashFlowProjection.mockResolvedValue([
      {
        currency: 'PKR',
        openingMinor: '0',
        operatingMinor: '125',
        investingMinor: '0',
        financingMinor: '0',
        unclassifiedMinor: '0',
        movementMinor: '125',
        closingMinor: '125',
        canonicalControlMatches: false,
        canonicalOpeningDiscrepancyMinor: null,
        canonicalMovementDiscrepancyMinor: null,
        canonicalClosingDiscrepancyMinor: null,
        evidence: [],
        metadata: {
          latestPostingAt: new Date('2026-10-15T12:00:00Z'),
          classifiedCompleteness: 'unknown',
          completenessReason: 'Completeness reason from projection.',
        },
      },
    ]);

    const markup = renderToStaticMarkup(await CashFlowPage({ searchParams: params }));

    expect(markup).toContain('PKR source status');
    expect(markup).toContain('2026-10-15T12:00:00.000Z');
    expect(markup).toContain('Classified completeness: unknown');
    expect(markup).toContain('Completeness reason from projection.');
  });
});
