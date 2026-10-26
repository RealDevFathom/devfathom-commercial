/**
 * WHA-1181 — the tenant-side repair for an organization activated before its
 * administrator was provisioned a `RestaurantStaffProfile`: the check the
 * workspace shell renders its call to action from, and the mutation behind it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true),
  annotateAudit: vi.fn(),
  staffFindFirst: vi.fn(),
  staffFindMany: vi.fn(),
  staffFindUnique: vi.fn(),
  resolveStaffCapabilities: vi.fn(),
  setStaffJobRoles: vi.fn(),
  setStaffAccess: vi.fn(),
  setStaffCapabilityOverride: vi.fn(),
  clearStaffCapabilityOverride: vi.fn(),
  staffCreate: vi.fn(),
  branchFindFirst: vi.fn(),
  branchFindMany: vi.fn(),
  jobRoleFindMany: vi.fn(),
  jobRoleCreate: vi.fn(),
  jobRoleFindFirst: vi.fn(),
  stationFindFirst: vi.fn(),
  stationCreate: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(() => ({})),
  withOrganizationDefaults: vi.fn(
    async (tx: unknown, _organizationId: string, run: (db: unknown) => Promise<unknown>) => run(tx)
  ),
}));
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
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

vi.mock('@/lib/restaurant/job-roles', async () => ({
  ...(await vi.importActual<typeof import('@/lib/restaurant/job-roles')>(
    '@/lib/restaurant/job-roles'
  )),
  resolveStaffCapabilities: mocks.resolveStaffCapabilities,
  setStaffJobRoles: mocks.setStaffJobRoles,
  setStaffAccess: mocks.setStaffAccess,
  setStaffCapabilityOverride: mocks.setStaffCapabilityOverride,
  clearStaffCapabilityOverride: mocks.clearStaffCapabilityOverride,
}));

import { restaurantStaffRouter } from './restaurant-staff';
import { RESTAURANT_JOB_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import type { TRPCContext } from '../trpc';

const db = {
  restaurantStaffProfile: {
    findFirst: mocks.staffFindFirst,
    findMany: mocks.staffFindMany,
    findUnique: mocks.staffFindUnique,
    create: mocks.staffCreate,
  },
  restaurantBranch: { findFirst: mocks.branchFindFirst, findMany: mocks.branchFindMany },
  // The self-service repair runs the same provisioning path activation does, so
  // it also converges the floor role profiles and the branch's kitchen station.
  restaurantJobRole: {
    findMany: mocks.jobRoleFindMany,
    findFirst: mocks.jobRoleFindFirst,
    create: mocks.jobRoleCreate,
  },
  restaurantKitchenStation: {
    findFirst: mocks.stationFindFirst,
    create: mocks.stationCreate,
  },
};

function caller(role = 'ADMIN', organizationId = 'org_1') {
  return restaurantStaffRouter.createCaller({
    db,
    entitlements: {
      organizationId,
      enabledModules: ['restaurant-core'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
      limits: { 'restaurant.operators.max': 50 },
    },
    session: {
      expires: 'later',
      user: {
        id: 'user_admin',
        name: 'Restaurant Owner',
        email: 'owner@example.test',
        organizationId: 'org_1',
        role,
        department: 'LEADERSHIP',
        status: 'ACTIVE',
      },
    },
    organization: { id: organizationId },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.staffFindMany.mockResolvedValue([]);
  mocks.staffFindUnique.mockResolvedValue(null);
  mocks.resolveStaffCapabilities.mockResolvedValue(new Set(['staff:manage']));
  mocks.staffFindFirst.mockResolvedValue(null);
  mocks.branchFindFirst.mockResolvedValue({ id: 'branch_default' });
  mocks.staffCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'staff_new',
    primaryBranchId: data.primaryBranchId,
  }));
  // Fully-provisioned by default: every role already seeded, the owner role
  // already held, the branch already has its station. Each test that cares
  // about one of those overrides just that mock.
  mocks.branchFindMany.mockResolvedValue([{ id: 'branch_default' }]);
  mocks.jobRoleFindMany.mockResolvedValue(
    RESTAURANT_JOB_ROLE_TEMPLATES.map((role) => ({ key: role.key }))
  );
  mocks.jobRoleFindFirst.mockResolvedValue(null);
  mocks.stationFindFirst.mockResolvedValue({ id: 'station_1' });
});

describe('restaurantStaff.mySelfProfile', () => {
  it('reports the missing profile that makes every restaurant call answer 403', async () => {
    await expect(caller().mySelfProfile()).resolves.toEqual({ hasProfile: false, status: null });
    expect(mocks.staffFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user_admin' } })
    );
  });

  it('reports a healthy workspace so the call to action never renders', async () => {
    mocks.staffFindFirst.mockResolvedValue({ id: 'staff_1', status: 'ACTIVE' });

    await expect(caller().mySelfProfile()).resolves.toEqual({
      hasProfile: true,
      status: 'ACTIVE',
    });
  });

  it('answers without a capability decision, since the caller may have no profile at all', async () => {
    await caller().mySelfProfile();
    expect(mocks.can).not.toHaveBeenCalled();
  });
});

describe('restaurantStaff.provisionMyProfile', () => {
  it('creates only the calling administrator’s own profile, against the default branch', async () => {
    const result = await caller().provisionMyProfile();

    expect(result).toEqual({
      created: true,
      staffProfileId: 'staff_new',
      primaryBranchId: 'branch_default',
      userId: 'user_admin',
      roleProfileGranted: false,
    });
    expect(mocks.staffCreate).toHaveBeenCalledOnce();
    expect(mocks.staffCreate.mock.calls[0]![0].data).toMatchObject({
      organizationId: 'org_1',
      // The session's own id — a caller cannot name someone else.
      userId: 'user_admin',
      displayName: 'Restaurant Owner',
      primaryBranchId: 'branch_default',
      status: 'ACTIVE',
    });
  });

  it('audits the repair', async () => {
    await caller().provisionMyProfile();

    expect(mocks.annotateAudit).toHaveBeenCalledWith(expect.anything(), {
      targetType: 'RestaurantStaffProfile',
      targetId: 'staff_new',
      targetLabel: 'Restaurant Owner',
      description: 'Provisioned the organization administrator’s own restaurant staff profile',
      metadata: {
        primaryBranchId: 'branch_default',
        selfProvisioned: true,
        profileCreated: true,
        roleProfileGranted: false,
        jobRolesCreated: [],
        stationsCreated: [],
      },
    });
  });

  it('is idempotent: a second call writes nothing and audits nothing', async () => {
    mocks.staffFindFirst.mockResolvedValue({ id: 'staff_1', primaryBranchId: 'branch_default' });

    const result = await caller().provisionMyProfile();

    expect(result).toEqual({
      created: false,
      staffProfileId: 'staff_1',
      primaryBranchId: 'branch_default',
      userId: 'user_admin',
      roleProfileGranted: false,
    });
    expect(mocks.staffCreate).not.toHaveBeenCalled();
    expect(mocks.jobRoleCreate).not.toHaveBeenCalled();
    expect(mocks.stationCreate).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
    expect(mocks.setStaffAccess).not.toHaveBeenCalled();
  });

  it('also repairs the missing role profiles and station the same gap left behind', async () => {
    // WHA-1181 (5)/(9a) — the owner hit all three symptoms in one organization.
    // The self-service repair converges every one of them, not just the profile.
    mocks.jobRoleFindMany.mockResolvedValue([]);
    mocks.stationFindFirst.mockResolvedValue(null);
    mocks.jobRoleCreate.mockImplementation(async ({ data }: { data: { key: string } }) => ({
      id: `jobrole_${data.key}`,
      key: data.key,
      capabilities: [],
    }));
    mocks.stationCreate.mockResolvedValue({
      id: 'station_new',
      name: 'Kitchen',
      branchId: 'branch_default',
    });

    await caller().provisionMyProfile();

    expect(mocks.jobRoleCreate).toHaveBeenCalledTimes(RESTAURANT_JOB_ROLE_TEMPLATES.length);
    expect(mocks.stationCreate.mock.calls[0]![0].data).toMatchObject({
      branchId: 'branch_default',
      name: 'Kitchen',
      isDefault: true,
    });
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          jobRolesCreated: RESTAURANT_JOB_ROLE_TEMPLATES.map((role) => role.key),
          stationsCreated: ['station_new'],
        }),
      })
    );
  });

  it('is denied when the ABAC decision withholds staff:manage', async () => {
    mocks.can.mockResolvedValue(false);

    await expect(caller().provisionMyProfile()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.staffCreate).not.toHaveBeenCalled();
  });
});

describe('administrator repair authorization before writes', () => {
  function expectNoWrites() {
    expect(mocks.staffCreate).not.toHaveBeenCalled();
    expect(mocks.jobRoleCreate).not.toHaveBeenCalled();
    expect(mocks.stationCreate).not.toHaveBeenCalled();
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
    expect(mocks.setStaffJobRoles).not.toHaveBeenCalled();
    expect(mocks.setStaffAccess).not.toHaveBeenCalled();
    expect(mocks.setStaffCapabilityOverride).not.toHaveBeenCalled();
    expect(mocks.clearStaffCapabilityOverride).not.toHaveBeenCalled();
  }
  it('denies non-ADMIN with staff:manage without provisioning writes', async () => {
    await expect(caller('EMPLOYEE').provisionMyProfile()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expectNoWrites();
  });
  it('denies branch-only ADMIN without provisioning writes', async () => {
    mocks.can.mockImplementation(
      async (_subject, capability) => capability !== 'restaurant:configure'
    );
    mocks.staffFindMany.mockResolvedValue([
      {
        id: 'staff_actor',
        primaryBranchId: 'branch_default',
        jobRoles: [{ branchId: 'branch_default' }],
        directCapabilityGrants: [],
      },
    ]);
    await expect(caller().provisionMyProfile()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expectNoWrites();
  });
  it('denies organization mismatch without provisioning writes', async () => {
    await expect(caller('ADMIN', 'org_other').provisionMyProfile()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expectNoWrites();
  });
  it('allows organization-wide ADMIN without a staff profile', async () => {
    await expect(caller().provisionMyProfile()).resolves.toMatchObject({
      created: true,
      userId: 'user_admin',
    });
    expect(mocks.staffCreate).toHaveBeenCalledOnce();
  });
  it('setStaffAccess denies branch B for a branch-A actor even when the target is valid', async () => {
    mocks.can.mockImplementation(
      async (_subject, capability) => capability !== 'restaurant:configure'
    );
    mocks.staffFindMany.mockResolvedValue([
      {
        id: 'staff_actor',
        primaryBranchId: 'branch_default',
        jobRoles: [{ branchId: 'branch_default' }],
        directCapabilityGrants: [],
      },
    ]);
    mocks.staffFindUnique.mockResolvedValue({ id: 'staff_target' });
    await expect(
      caller().setStaffAccess({
        branchId: 'branch_other',
        staffProfileId: 'staff_target',
        jobRoleIds: [],
        overrides: [],
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.resolveStaffCapabilities).toHaveBeenCalledWith(
      db,
      'staff_actor',
      'branch_default'
    );
    expect(mocks.staffFindUnique).not.toHaveBeenCalled();
    expectNoWrites();
  });
  it.each<[string, () => Promise<unknown>]>([
    [
      'setStaffJobRoles',
      () =>
        caller('EMPLOYEE').setStaffJobRoles({
          branchId: 'branch_default',
          staffProfileId: 'staff_actor',
          jobRoleIds: ['role_with_refunds'],
        }),
    ],
    [
      'setStaffAccess',
      () =>
        caller('EMPLOYEE').setStaffAccess({
          branchId: 'branch_default',
          staffProfileId: 'staff_actor',
          jobRoleIds: ['role_with_refunds'],
          overrides: [{ capability: 'payments:refund', effect: 'ALLOW' }],
        }),
    ],
    [
      'setStaffCapabilityOverride',
      () =>
        caller('EMPLOYEE').setStaffCapabilityOverride({
          branchId: 'branch_default',
          staffProfileId: 'staff_actor',
          capability: 'payments:refund',
          effect: 'ALLOW',
        }),
    ],
    [
      'clearStaffCapabilityOverride',
      () =>
        caller('EMPLOYEE').clearStaffCapabilityOverride({
          branchId: 'branch_default',
          staffProfileId: 'staff_actor',
          capability: 'payments:refund',
        }),
    ],
  ])('%s denies a branch manager from delegating access at their own branch', async (_name, run) => {
    mocks.can.mockImplementation(
      async (_subject, capability) => capability !== 'restaurant:configure'
    );
    mocks.staffFindMany.mockResolvedValue([
      {
        id: 'staff_actor',
        primaryBranchId: 'branch_default',
        jobRoles: [{ branchId: 'branch_default' }],
        directCapabilityGrants: [],
      },
    ]);
    mocks.staffFindUnique.mockResolvedValue({ id: 'staff_actor' });

    await expect(run()).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mocks.resolveStaffCapabilities).toHaveBeenCalledWith(
      db,
      'staff_actor',
      'branch_default'
    );
    expect(mocks.staffFindUnique).not.toHaveBeenCalled();
    expectNoWrites();
  });
  it.each(['staff_other_tenant', 'staff_missing'])(
    'setStaffAccess denies invisible target %s on an authorized branch without writes',
    async (staffProfileId) => {
      await expect(
        caller().setStaffAccess({
          branchId: 'branch_default',
          staffProfileId,
          jobRoleIds: [],
          overrides: [],
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.staffFindUnique).toHaveBeenCalledWith({
        where: { id: staffProfileId },
        select: { id: true },
      });
      expectNoWrites();
    }
  );
});
