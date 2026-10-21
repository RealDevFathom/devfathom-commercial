import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), can: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  assertSeatAvailable: vi.fn(),
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));

import type { TRPCContext } from '@/server/trpc';
import { organizationAdminRouter } from '@/server/routers/organization-admin';

function caller(organizationId: string | undefined, authenticated = true) {
  return organizationAdminRouter.createCaller({
    db: { organizationDepartment: { findMany: mocks.findMany } },
    entitlements: { enabledModules: [], modules: [] },
    session: authenticated
      ? {
          expires: 'later',
          user: {
            id: 'inviter',
            organizationId,
            role: 'ADMIN',
            department: 'COUNTER',
            status: 'ACTIVE',
          },
        }
      : null,
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
});

describe('invite picker department read contract', () => {
  it('uses only the active session tenant and the existing admin capability', async () => {
    const departments = [{ key: 'COUNTER', name: 'Counter', active: true }];
    mocks.findMany.mockResolvedValue(departments);
    expect(await caller('pharmacy_a').departments()).toEqual(departments);
    expect(mocks.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { organizationId: 'pharmacy_a' },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.any(Object),
      'admin:access',
      undefined,
      expect.any(Object)
    );
  });
  it('does not read when the existing invite capability denies access', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller('pharmacy_a').departments()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
  it('does not read for an anonymous session', async () => {
    await expect(caller('pharmacy_a', false).departments()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
  it('does not guess a tenant when the session has none', async () => {
    await expect(caller(undefined).departments()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});
