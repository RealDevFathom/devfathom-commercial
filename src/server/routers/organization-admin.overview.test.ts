import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  organization: vi.fn(),
  package: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  annotateAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(() => ({})),
  withPlatformDb: (read: (db: unknown) => unknown) =>
    read({ platformPackage: { findUnique: mocks.package } }),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  assertSeatAvailable: vi.fn(),
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: mocks.annotateAudit,
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});

import type { TRPCContext } from '../trpc';
import { organizationAdminRouter } from './organization-admin';

const db = {
  organization: { findUnique: mocks.organization },
  pharmacyBranch: { findMany: vi.fn(async () => []) },
  organizationDepartment: {
    findFirst: mocks.findFirst,
    create: mocks.create,
    update: mocks.update,
    delete: mocks.remove,
  },
};

function caller(organizationId = 'org_a') {
  return organizationAdminRouter.createCaller({
    db,
    entitlements: { enabledModules: [], activeSeats: 1, seatLimit: 50 },
    session: {
      expires: 'later',
      user: {
        id: 'admin_a',
        organizationId,
        role: 'ADMIN',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('organization overview assigned package', () => {
  beforeEach(() => vi.clearAllMocks());
  it('reads only the package assigned to the session tenant through the control-plane scope', async () => {
    mocks.organization.mockResolvedValue({
      id: 'org_b',
      packageId: 'pkg_ph',
      emailSettings: null,
      users: [],
      roles: [],
    });
    mocks.package.mockResolvedValue({ name: 'Pharmacy Professional' });
    const result = await caller('org_b').overview();
    expect(mocks.organization).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'org_b' },
        select: expect.objectContaining({ packageId: true }),
      })
    );
    expect(mocks.organization.mock.calls[0][0].select).not.toHaveProperty('package');
    expect(mocks.organization.mock.calls[0][0].select.users.select.permissionOverrides).toEqual({
      where: {
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
      },
      select: { id: true, capability: true, effect: true },
    });
    expect(mocks.package).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'pkg_ph' },
      select: { name: true },
    });
    expect(result.organization.package).toEqual({ name: 'Pharmacy Professional' });
  });
  it('keeps unassigned organizations custom without reading the package catalog', async () => {
    mocks.organization.mockResolvedValue({
      id: 'org_a',
      packageId: null,
      emailSettings: null,
      users: [],
      roles: [],
    });
    expect((await caller().overview()).organization.package).toBeNull();
    expect(mocks.package).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'role grant',
      role: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }],
      overrides: [],
      granted: true,
    },
    {
      name: 'role wildcard',
      role: [{ capability: 'pharmacy:*', effect: 'ALLOW' }],
      overrides: [],
      granted: true,
    },
    {
      name: 'denied role grant',
      role: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }],
      overrides: [{ capability: 'pharmacy:procurement', effect: 'DENY' }],
      granted: false,
    },
    {
      name: 'wildcard denial over a direct grant',
      role: [],
      overrides: [
        { capability: 'pharmacy:procurement', effect: 'ALLOW' },
        { capability: 'pharmacy:*', effect: 'DENY' },
      ],
      granted: false,
    },
    {
      name: 'unrelated grant',
      role: [],
      overrides: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }],
      granted: false,
    },
    {
      name: 'direct grant',
      role: [],
      overrides: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }],
      granted: true,
    },
    ...['pharmacy:procurement', 'pharmacy:*', '*'].map((capability) => ({
      name: `role denial ${capability} over a direct grant`,
      role: [{ capability, effect: 'DENY' }],
      overrides: [{ capability: 'pharmacy:procurement', effect: 'ALLOW' }],
      granted: false,
    })),
  ])('reports effective Goods-in access for $name', async ({ role, overrides, granted }) => {
    mocks.organization.mockResolvedValue({
      id: 'org_a',
      packageId: null,
      emailSettings: null,
      roles: [{ id: 'role_a', permissions: role }],
      users: [{ id: 'member_a', organizationRoleId: 'role_a', permissionOverrides: overrides }],
    });

    const result = await caller().overview();
    expect(result.organization.users[0].goodsInAccess).toBe(granted);
  });
});

describe('organizationAdmin.overview Goods-in admin fallback', () => {
  it.each([
    { name: 'admin without a role', role: 'ADMIN', overrides: [], granted: true },
    {
      name: 'admin without a role but with a denial',
      role: 'ADMIN',
      overrides: [{ capability: 'pharmacy:procurement', effect: 'DENY' }],
      granted: false,
    },
    { name: 'employee without a role', role: 'EMPLOYEE', overrides: [], granted: false },
  ])('matches receiving authorization for $name', async ({ role, overrides, granted }) => {
    mocks.organization.mockResolvedValue({
      id: 'org_a',
      packageId: null,
      emailSettings: null,
      roles: [],
      users: [{ id: 'member_a', role, organizationRoleId: null, permissionOverrides: overrides }],
    });

    const result = await caller().overview();
    expect(result.organization.users[0].goodsInAccess).toBe(granted);
  });
});
