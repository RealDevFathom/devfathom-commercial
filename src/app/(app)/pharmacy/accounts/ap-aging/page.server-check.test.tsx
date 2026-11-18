/**
 * DEV-103: URL tamper through the REAL AP router. Only the database, licence, permission
 * check and the aging read are mocked, so removing the router's branch authorization makes
 * the "typed branch" test fail.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveTenantActor: vi.fn(),
  can: vi.fn(),
  hasModule: vi.fn(),
  branchFindMany: vi.fn(),
  branchFindFirst: vi.fn(),
  readApAging: vi.fn(),
  readDrafts: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: mocks.resolveTenantActor }));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.hasModule,
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  recordAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/accounts/ap-aging', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/accounts/ap-aging')>(
    '@/lib/pharmacy/accounts/ap-aging'
  )),
  readApAging: mocks.readApAging,
}));
vi.mock('@/lib/pharmacy/accounts/ap-invoices', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/accounts/ap-invoices')>(
    '@/lib/pharmacy/accounts/ap-invoices'
  )),
  listApInvoices: mocks.readDrafts,
}));
// Real tRPC; only the page's context factory is replaced with an in-memory tenant context.
vi.mock('@/server/trpc', async () => ({
  ...(await vi.importActual<typeof import('@/server/trpc')>('@/server/trpc')),
  createTRPCContext: vi.fn(async ({ session, organization }) => ({
    db: {
      pharmacyBranch: { findMany: mocks.branchFindMany, findFirst: mocks.branchFindFirst },
    },
    entitlements: { organizationId: 'org_1', enabledModules: ['pharmacy-finance'], modules: [] },
    session,
    organization,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  })),
}));

import ApAgingPage from './page';

const actor = {
  session: {
    expires: 'later',
    user: { id: 'owner_1', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org_1' },
  },
  organization: { id: 'org_1', timezone: 'UTC' },
  support: null,
};

async function html(query: Record<string, string>) {
  return renderToStaticMarkup(await ApAgingPage({ searchParams: Promise.resolve(query) }));
}

describe('ApAgingPage with the real AP router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTenantActor.mockResolvedValue(actor);
    mocks.can.mockResolvedValue(true);
    mocks.hasModule.mockReturnValue(true);
    mocks.branchFindMany.mockResolvedValue([{ id: 'branch_1', name: 'Main Branch' }]);
    // The server's branch check: only the organization's own active branch exists.
    mocks.branchFindFirst.mockImplementation(
      async ({ where }: { where: { organizationId: string; id: string; active: boolean } }) =>
        where.organizationId === 'org_1' && where.id === 'branch_1' && where.active
          ? { id: 'branch_1' }
          : null
    );
  });

  it('refuses a branch typed into the URL that is not the organization’s, and never reads aging', async () => {
    const output = await html({ branch: 'branch_of_another_org', asOf: '2026-11-15' });
    expect(mocks.branchFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org_1', id: 'branch_of_another_org' }),
      })
    );
    expect(output).toContain('Aging unavailable');
    expect(output).not.toContain('AP-0001');
    expect(mocks.readApAging).not.toHaveBeenCalled();
    expect(mocks.readDrafts).not.toHaveBeenCalled();
  });

  it('reads aging for a branch the server accepts', async () => {
    mocks.readApAging.mockRejectedValue(new Error('stop after the authorized read'));
    await html({ branch: 'branch_1', asOf: '2026-11-15' });
    expect(mocks.readApAging).toHaveBeenCalledTimes(1);
  });
});
