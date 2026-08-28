import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  findMany: vi.fn(),
  create: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
  userCount: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
  assertSeatAvailable: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

import type { TRPCContext } from '../trpc';
import { organizationAdminRouter } from './organization-admin';

const db = {
  organizationDepartment: {
    findMany: mocks.findMany,
    create: mocks.create,
    updateMany: mocks.updateMany,
    deleteMany: mocks.deleteMany,
  },
  user: { count: mocks.userCount },
};

function caller(organizationId = 'org_a') {
  return organizationAdminRouter.createCaller({
    db,
    entitlements: { enabledModules: [], modules: [], activeSeats: 1, seatLimit: 50 },
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

describe('organization department administration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
  });

  it('lists and creates departments only in the admin tenant', async () => {
    mocks.findMany.mockResolvedValue([]);
    mocks.create.mockResolvedValue({ key: 'BAR', label: 'Bar' });

    await caller().departments();
    await caller().createDepartment({ key: 'BAR', label: 'Bar' });

    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_a' },
      orderBy: [{ label: 'asc' }, { key: 'asc' }],
    });
    expect(mocks.create).toHaveBeenCalledWith({
      data: { organizationId: 'org_a', key: 'BAR', label: 'Bar' },
    });
  });

  it('does not relabel a department belonging to another tenant', async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      caller('org_a').updateDepartment({ key: 'KITCHEN', label: 'Galley' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_a', key: 'KITCHEN' },
      data: { label: 'Galley' },
    });
  });

  it('rejects removal while tenant members still reference the department', async () => {
    mocks.userCount.mockResolvedValue(2);

    await expect(caller().removeDepartment({ key: 'KITCHEN' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(mocks.userCount).toHaveBeenCalledWith({
      where: { organizationId: 'org_a', department: 'KITCHEN' },
    });
    expect(mocks.deleteMany).not.toHaveBeenCalled();
  });
});
