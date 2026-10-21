import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
  userCreate: vi.fn(),
  departmentFindFirst: vi.fn(),
  roleFindFirst: vi.fn(),
  assertSeatAvailable: vi.fn(),
  annotateAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  assertSeatAvailable: mocks.assertSeatAvailable,
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
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'hashed') }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: vi.fn(async () => true) };
});

import type { TRPCContext } from '../trpc';
import { organizationAdminRouter } from './organization-admin';

const db = {
  user: { findFirst: mocks.userFindFirst, create: mocks.userCreate },
  organizationDepartment: { findFirst: mocks.departmentFindFirst },
  organizationRole: { findFirst: mocks.roleFindFirst },
};

function caller(organizationId = 'org_a', entitlements = { activeSeats: 1, seatLimit: 10 }) {
  return organizationAdminRouter.createCaller({
    db,
    entitlements: { enabledModules: [], ...entitlements },
    session: {
      expires: 'later',
      user: {
        id: 'admin_a',
        organizationId,
        role: 'ADMIN',
        department: 'COUNTER',
        status: 'ACTIVE',
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

const input = {
  name: 'Ayesha Cashier',
  email: 'Ayesha@Clifton.test',
  password: 'temporary-123456',
  title: 'Cashier',
  role: 'EMPLOYEE' as const,
  department: 'COUNTER',
  organizationRoleId: null,
};

describe('organization member creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertSeatAvailable.mockImplementation(() => {});
    mocks.departmentFindFirst.mockResolvedValue({ id: 'dept_counter' });
    mocks.roleFindFirst.mockResolvedValue({ id: 'role_cashier' });
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({ id: 'user_new', email: 'ayesha@clifton.test', name: 'Ayesha Cashier' });
  });

  it('creates an ACTIVE member scoped to the caller tenant with a hashed password', async () => {
    await caller('org_a').createMember(input);

    expect(mocks.userCreate).toHaveBeenCalledTimes(1);
    const data = mocks.userCreate.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      organizationId: 'org_a',
      email: 'ayesha@clifton.test',
      password: 'hashed',
      role: 'EMPLOYEE',
      department: 'COUNTER',
      status: 'ACTIVE',
    });
    // The duplicate check is scoped to the caller tenant, never global.
    expect(mocks.userFindFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org_a', email: 'ayesha@clifton.test' },
      select: { id: true },
    });
  });

  it('refuses before writing anything when the seat limit is reached', async () => {
    mocks.assertSeatAvailable.mockImplementation(() => {
      throw new Error('Seat limit reached (10/10).');
    });

    await expect(
      caller('org_a', { activeSeats: 10, seatLimit: 10 }).createMember(input)
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('rejects a department that is not active in the caller tenant', async () => {
    mocks.departmentFindFirst.mockResolvedValue(null);

    await expect(caller('org_a').createMember(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.departmentFindFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org_a', key: 'COUNTER', active: true },
      select: { id: true },
    });
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('rejects a custom role that belongs to another tenant', async () => {
    mocks.roleFindFirst.mockResolvedValue(null);

    await expect(
      caller('org_a').createMember({ ...input, organizationRoleId: 'role_from_org_b' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('fails closed on a duplicate email within the tenant', async () => {
    mocks.userFindFirst.mockResolvedValue({ id: 'existing' });

    await expect(caller('org_a').createMember(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });
});
