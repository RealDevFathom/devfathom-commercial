import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));

import { dashboardRouter } from './dashboard';

function caller(role: 'ADMIN' | 'MEMBER') {
  const findMany = vi.fn(async () => []);
  const api = dashboardRouter.createCaller({
    db: { task: { findMany } },
    session: { user: { id: 'viewer', role, status: 'ACTIVE' } },
    entitlements: { enabledModules: [] },
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);

  return { api, findMany };
}

describe('dashboard.getMyTasks', () => {
  it('only returns tasks in projects accessible to a non-admin assignee', async () => {
    const { api, findMany } = caller('MEMBER');

    await api.getMyTasks();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          assignees: { some: { userId: 'viewer' } },
          column: {
            name: { not: 'Done' },
            board: { project: { members: { some: { userId: 'viewer' } } } },
          },
        },
      })
    );
  });

  it('keeps the administrator all-project capability', async () => {
    const { api, findMany } = caller('ADMIN');

    await api.getMyTasks();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          assignees: { some: { userId: 'viewer' } },
          column: { name: { not: 'Done' } },
        },
      })
    );
  });
});
