import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import AccountActivityBridgePage from './page';

const mocks = vi.hoisted(() => ({ branches: vi.fn(), financialStatements: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: vi.fn().mockResolvedValue({
    session: { user: { role: 'ADMIN' } },
    organization: { id: 'org_1' },
  }),
}));
vi.mock('@/server/trpc', () => ({
  createTRPCContext: vi.fn().mockResolvedValue({
    session: { user: { role: 'ADMIN' } },
    entitlements: { organizationId: 'org_1' },
    db: { pharmacyBranch: { findMany: mocks.branches } },
  }),
}));
vi.mock('@/server/routers/pharmacy-finance', () => ({
  pharmacyFinanceRouter: {
    createCaller: () => ({ financialStatements: mocks.financialStatements }),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.branches.mockResolvedValue([{ id: 'branch_1', name: 'Main' }]);
});

describe('account activity bridge page failures', () => {
  it.each([
    [new TRPCError({ code: 'FORBIDDEN' }), 'Permission required', 'financial-report permission'],
    [
      new Error('database unavailable'),
      'Account activity unavailable',
      'No financial data was changed',
    ],
  ])('separates denied and read errors without exposing details', async (error, title, message) => {
    mocks.financialStatements.mockRejectedValue(error);
    const page = await AccountActivityBridgePage({
      searchParams: Promise.resolve({ from: '2026-10-01', to: '2026-10-02' }),
    });
    const html = renderToStaticMarkup(page);
    expect(html).toContain(title);
    expect(html).toContain(message);
    expect(html).not.toContain('database unavailable');
  });
});
