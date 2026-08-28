import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  annotateAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
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

describe('organization department administration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a department only in the caller tenant', async () => {
    mocks.create.mockResolvedValue({ id: 'dept_bar', key: 'BAR', name: 'Bar' });

    await caller().upsertDepartment({ key: 'BAR', name: 'Bar', active: true, sortOrder: 2 });

    expect(mocks.create).toHaveBeenCalledWith({
      data: { organizationId: 'org_a', key: 'BAR', name: 'Bar', active: true, sortOrder: 2 },
    });
  });

  it('denies editing an id not found inside the caller tenant', async () => {
    mocks.findFirst.mockResolvedValue(null);

    await expect(
      caller('org_b').upsertDepartment({
        id: 'dept_from_org_a',
        key: 'BAR',
        name: 'Bar',
        active: true,
        sortOrder: 2,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: 'dept_from_org_a', organizationId: 'org_b' },
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('fails closed when removing an in-use department', async () => {
    mocks.findFirst.mockResolvedValue({
      id: 'dept_kitchen',
      name: 'Kitchen',
      _count: { users: 3 },
    });

    await expect(caller().removeDepartment({ id: 'dept_kitchen' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
