/**
 * DEV-253 — /restaurant/staff must be able to invite a brand-new waiter or
 * manager, not only link an account that already exists. The invite creates an
 * INVITED account (seat-checked) carrying the chosen role template, links a new
 * staff profile to it, and never lets a manager hand out more access than they
 * hold themselves.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true),
  resolveStaffCapabilities: vi.fn(),
  annotateAudit: vi.fn(),
  sendEmail: vi.fn(),
  raw: vi.fn(),
  staffFindMany: vi.fn(),
  staffFindFirst: vi.fn(),
  staffCreate: vi.fn(),
  staffCount: vi.fn(),
  branchFindMany: vi.fn(),
  branchFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
  userCreate: vi.fn(),
  userUpdate: vi.fn(),
  userCount: vi.fn(),
  invitationUpsert: vi.fn(),
  roleFindMany: vi.fn(),
  organizationFindUnique: vi.fn(),
  departmentFindMany: vi.fn(),
}));

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
  annotateAudit: mocks.annotateAudit,
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/email', () => ({
  appUrl: vi.fn(() => 'https://www.devfathom.com'),
  sendEmail: mocks.sendEmail,
  templates: { inviteMember: vi.fn(() => ({ subject: 's', html: 'h', text: 't' })) },
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/lib/restaurant/job-roles', async () => ({
  ...(await vi.importActual<typeof import('@/lib/restaurant/job-roles')>(
    '@/lib/restaurant/job-roles'
  )),
  resolveStaffCapabilities: mocks.resolveStaffCapabilities,
}));

import { restaurantStaffRouter } from './restaurant-staff';
import type { TRPCContext } from '../trpc';

const db = {
  $queryRaw: mocks.raw,
  $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(db),
  restaurantStaffProfile: {
    findMany: mocks.staffFindMany,
    findFirst: mocks.staffFindFirst,
    create: mocks.staffCreate,
    count: mocks.staffCount,
  },
  restaurantBranch: { findMany: mocks.branchFindMany, findUnique: mocks.branchFindUnique },
  user: {
    findFirst: mocks.userFindFirst,
    create: mocks.userCreate,
    update: mocks.userUpdate,
    count: mocks.userCount,
  },
  invitation: { upsert: mocks.invitationUpsert },
  organizationRole: { findMany: mocks.roleFindMany },
  organization: { findUnique: mocks.organizationFindUnique },
  organizationDepartment: { findMany: mocks.departmentFindMany },
};

const ROLES = [
  {
    id: 'role_owner',
    key: 'owner',
    name: 'Owner / Administrator',
    permissions: [{ capability: '*', effect: 'ALLOW' }],
  },
  {
    id: 'role_gm',
    key: 'general-manager',
    name: 'General Manager',
    permissions: [
      { capability: 'restaurant:configure', effect: 'ALLOW' },
      { capability: 'staff:manage', effect: 'ALLOW' },
    ],
  },
  {
    id: 'role_server',
    key: 'server',
    name: 'Server',
    permissions: [
      { capability: 'orders:take', effect: 'ALLOW' },
      { capability: 'payments:refund', effect: 'DENY' },
    ],
  },
];

function caller(role: 'ADMIN' | 'EMPLOYEE' = 'ADMIN') {
  return restaurantStaffRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_workspace',
      enabledModules: ['restaurant-core'],
      activeSeats: 1,
      seatLimit: 10,
      modules: [],
      limits: { 'restaurant.operators.max': 50 },
    },
    session: {
      expires: 'later',
      user: { id: 'user_actor', name: 'Owner', role, department: 'OPERATIONS', status: 'ACTIVE' },
    },
    organization: { id: 'org_workspace' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

/** A branch manager: staff:manage + orders:take at branch_1, nothing organization-wide. */
function asBranchManager() {
  mocks.can.mockImplementation(async (...args) =>
    ['staff:manage', 'orders:take'].includes(args[1] as string)
  );
  mocks.staffFindMany.mockResolvedValue([
    {
      id: 'staff_manager',
      primaryBranchId: 'branch_1',
      jobRoles: [{ branchId: 'branch_1' }],
      directCapabilityGrants: [],
    },
  ]);
  return caller('EMPLOYEE');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.resolveStaffCapabilities.mockResolvedValue(new Set(['staff:manage']));
  mocks.raw.mockResolvedValue([{ id: 'org_workspace' }]);
  mocks.staffFindMany.mockResolvedValue([]);
  mocks.staffFindFirst.mockResolvedValue(null);
  mocks.staffCount.mockResolvedValue(0);
  mocks.staffCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'staff_new',
    ...data,
  }));
  mocks.branchFindMany.mockImplementation(async (args?: { where?: { id?: { in?: string[] } } }) => {
    const ids = args?.where?.id?.in;
    return ids ? ids.map((id) => ({ id })) : [{ id: 'branch_1' }];
  });
  mocks.branchFindUnique.mockResolvedValue({ id: 'branch_1' });
  // No staff-linked account, no existing account, then the new INVITED user is in scope.
  mocks.userFindFirst.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    where.id === 'user_invited' ? { id: 'user_invited' } : null
  );
  mocks.userCount.mockResolvedValue(1);
  mocks.userCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'user_invited',
    ...data,
  }));
  mocks.invitationUpsert.mockResolvedValue({});
  mocks.roleFindMany.mockResolvedValue(ROLES);
  // The vertical's default department is absent from this tenant's catalog, so
  // the invitee is filed under the tenant's first active department.
  mocks.organizationFindUnique.mockResolvedValue({ vertical: 'AGENCY' });
  mocks.departmentFindMany.mockResolvedValue([{ key: 'FRONT_OF_HOUSE' }]);
  mocks.sendEmail.mockResolvedValue(undefined);
});

describe('restaurantStaff.invite', () => {
  it('invites a new waiter: INVITED account with the role, linked profile, emailed link', async () => {
    const result = await caller().invite({
      displayName: 'Sara Waiter',
      email: ' Sara@Example.com ',
      organizationRoleId: 'role_server',
      primaryBranchId: 'branch_1',
    });

    expect(result).toEqual({
      staffProfileId: 'staff_new',
      userId: 'user_invited',
      inviteUrl: expect.stringMatching(/^https:\/\/www\.devfathom\.com\/invite\/.+/),
    });
    expect(mocks.userCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: 'sara@example.com',
        name: 'Sara Waiter',
        role: 'EMPLOYEE',
        organizationRoleId: 'role_server',
        department: 'FRONT_OF_HOUSE',
        title: 'Server',
        password: null,
        status: 'INVITED',
      }),
    });
    expect(mocks.invitationUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ userId: 'user_invited', invitedById: 'user_actor' }),
      })
    );
    // The profile links the still-INVITED account — the ordinary link path refuses it.
    expect(mocks.userFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'user_invited',
        status: { in: ['ACTIVE', 'INVITED'] },
        restaurantStaffProfiles: { none: {} },
      },
      select: { id: true },
    });
    expect(mocks.staffCreate).toHaveBeenCalledWith({
      data: {
        displayName: 'Sara Waiter',
        email: 'sara@example.com',
        userId: 'user_invited',
        primaryBranchId: 'branch_1',
        status: 'ACTIVE',
      },
    });
    expect(mocks.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: { email: 'sara@example.com', name: 'Sara Waiter' } })
    );
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetType: 'RestaurantStaffProfile',
        targetId: 'staff_new',
        metadata: expect.objectContaining({ invitedUserId: 'user_invited' }),
      })
    );
  });

  it('lets a branch manager invite a waiter at their own branch', async () => {
    await expect(
      asBranchManager().invite({
        displayName: 'Sara Waiter',
        email: 'sara@example.com',
        organizationRoleId: 'role_server',
        primaryBranchId: 'branch_1',
      })
    ).resolves.toMatchObject({ staffProfileId: 'staff_new' });
  });

  it.each(['role_gm', 'role_owner'])(
    'refuses a branch manager inviting %s, whose grants exceed their own',
    async (organizationRoleId) => {
      await expect(
        asBranchManager().invite({
          displayName: 'New Boss',
          email: 'boss@example.com',
          organizationRoleId,
          primaryBranchId: 'branch_1',
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.userCreate).not.toHaveBeenCalled();
      expect(mocks.staffCreate).not.toHaveBeenCalled();
    }
  );

  it('refuses a branch manager inviting outside their branch scope', async () => {
    mocks.branchFindMany.mockImplementation(async () => [{ id: 'branch_1' }]);
    await expect(
      asBranchManager().invite({
        displayName: 'Sara',
        email: 'sara@example.com',
        organizationRoleId: 'role_server',
        primaryBranchId: 'branch_2',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      asBranchManager().invite({
        displayName: 'Sara',
        email: 'sara@example.com',
        organizationRoleId: 'role_server',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('refuses a role outside the tenant catalog', async () => {
    await expect(
      caller().invite({
        displayName: 'Sara',
        email: 'sara@example.com',
        organizationRoleId: 'role_elsewhere',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('refuses an email already on a staff member and points at an existing account', async () => {
    mocks.userFindFirst.mockResolvedValueOnce({ id: 'user_linked' });
    await expect(
      caller().invite({
        displayName: 'Sara',
        email: 'sara@example.com',
        organizationRoleId: 'role_server',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    mocks.userFindFirst.mockImplementation(async ({ where }: { where: { email?: string } }) =>
      where.email === 'sara@example.com' && !('restaurantStaffProfiles' in where)
        ? { id: 'user_active', status: 'ACTIVE' }
        : null
    );
    await expect(
      caller().invite({
        displayName: 'Sara',
        email: 'sara@example.com',
        organizationRoleId: 'role_server',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.userCreate).not.toHaveBeenCalled();
    expect(mocks.staffCreate).not.toHaveBeenCalled();
  });

  it('enforces the organization seat limit', async () => {
    mocks.userCount.mockResolvedValue(10);
    await expect(
      caller().invite({
        displayName: 'Sara',
        email: 'sara@example.com',
        organizationRoleId: 'role_server',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.userCreate).not.toHaveBeenCalled();
  });

  it('still returns the link when the email cannot be delivered', async () => {
    mocks.sendEmail.mockRejectedValue(new Error('smtp down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      caller().invite({
        displayName: 'Sara',
        email: 'sara@example.com',
        organizationRoleId: 'role_server',
      })
    ).resolves.toMatchObject({ inviteUrl: expect.stringContaining('/invite/') });
    error.mockRestore();
  });

  it('rejects every invite when the ABAC decision denies staff:manage', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(
      caller().invite({
        displayName: 'Sara',
        email: 'sara@example.com',
        organizationRoleId: 'role_server',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().listInviteRoles()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('restaurantStaff.listInviteRoles', () => {
  it('offers an administrator every tenant role', async () => {
    await expect(caller().listInviteRoles()).resolves.toEqual([
      { id: 'role_owner', key: 'owner', name: 'Owner / Administrator' },
      { id: 'role_gm', key: 'general-manager', name: 'General Manager' },
      { id: 'role_server', key: 'server', name: 'Server' },
    ]);
    expect(mocks.roleFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org_workspace' } })
    );
  });

  it('offers a branch manager only roles within their own grants', async () => {
    await expect(asBranchManager().listInviteRoles()).resolves.toEqual([
      { id: 'role_server', key: 'server', name: 'Server' },
    ]);
  });
});
