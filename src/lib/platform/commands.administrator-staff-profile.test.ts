/**
 * WHA-1181 — a RESTAURANT organization's administrator reached an activated
 * workspace with no `RestaurantStaffProfile`, so `restaurantNotifications.list`
 * answered 403 on every poll while the nav rendered normally.
 *
 * Both platform entry points are covered here: `organization.create` (the
 * administrator step of onboarding) and `organization.transition` to ACTIVE
 * (which also repairs an organization created before the onboarding fix), plus
 * idempotence across them and the agency path staying untouched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'hashed'), compare: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@/lib/platform/auth', () => ({ assertPlatformCapability: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: unknown) => Promise<unknown>) => run(platformDb)),
  // The real helper installs `app.current_organization_id` so the tenant tables'
  // column DEFAULT resolves; the id it installs is asserted separately against
  // the real implementation. Here it only has to pass the db through.
  withOrganizationDefaults: vi.fn(
    async (tx: unknown, organizationId: string, run: (db: unknown) => Promise<unknown>) => {
      organizationDefaults.push(organizationId);
      return run(tx);
    }
  ),
}));

/** Rows the command layer wrote, keyed by model, in call order. */
const staffProfiles: Record<string, unknown>[] = [];
const auditRecords: Record<string, unknown>[] = [];
const jobRoles: Record<string, unknown>[] = [];
const jobRoleHoldings: Record<string, unknown>[] = [];
const stations: Record<string, unknown>[] = [];
const organizationDefaults: string[] = [];

function passthrough(prefix: string) {
  return vi.fn(async (args: { data?: unknown }) => ({
    id: `${prefix}_1`,
    ...(args?.data as object),
  }));
}

const state = {
  /** Profiles the fake database already holds, by userId. */
  existingByUserId: new Map<string, { id: string; primaryBranchId: string | null }>(),
  branch: { id: 'branch_default' } as { id: string } | null,
  packageVertical: 'RESTAURANT',
  organizationVertical: 'RESTAURANT',
  organizationStatus: 'ONBOARDING',
  administrators: [{ id: 'user_admin', name: 'Restaurant Owner', email: 'owner@example.test' }],
  /** Job-role keys the fake database already holds. */
  existingJobRoleKeys: [] as string[],
  /** Whether the seeded `owner` role is active (an operator may deactivate it). */
  ownerRoleActive: true,
  /** Branch ids that already own at least one kitchen station. */
  branchesWithStations: [] as string[],
  /** Branches the provisioning pass iterates. */
  branches: [{ id: 'branch_default' }],
};

// The activation preflight (§9 Step 7) has to pass before the transition runs at
// all, so the fake catalog enables Restaurant Core plus one operational module
// and the default branch is complete and acknowledged.
const catalogModules = [
  { id: 'module_core', key: 'restaurant-core' },
  { id: 'module_menu', key: 'restaurant-menu' },
];

const platformDb = {
  platformPackage: {
    findUnique: vi.fn(async () => ({
      id: 'pkg_1',
      active: true,
      vertical: state.packageVertical,
      name: 'Restaurant Essentials',
      defaultSeats: 25,
      moduleLinks: catalogModules.map((module) => ({ moduleId: module.id, enabled: true })),
    })),
  },
  organization: {
    create: vi.fn(async () => ({ id: 'org_new', slug: 'acme-diner' })),
    findUnique: vi.fn(async () => ({
      id: 'org_new',
      slug: 'acme-diner',
      status: state.organizationStatus,
      vertical: state.organizationVertical,
      activatedAt: null,
      packageId: 'pkg_1',
      deploymentMode: 'SHARED',
      package: {
        vertical: state.organizationVertical,
        moduleLinks: catalogModules.map((module) => ({ moduleId: module.id, enabled: true })),
      },
      modules: [],
      users: [{ id: 'user_admin' }],
      deployments: [{ id: 'deployment_1' }],
    })),
    update: vi.fn(async () => ({ id: 'org_new', slug: 'acme-diner', status: 'ACTIVE' })),
  },
  platformModule: { findMany: vi.fn(async () => catalogModules) },
  organizationRole: { create: passthrough('role') },
  organizationDepartment: { createMany: vi.fn(async () => ({ count: 6 })) },
  organizationModule: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
  $queryRaw: vi.fn(async () => []),
  user: {
    count: vi.fn(async () => 0),
    findFirst: vi.fn(async () => null),
    create: vi.fn(async () => ({
      id: 'user_admin',
      name: 'Restaurant Owner',
      email: 'owner@example.test',
    })),
    findMany: vi.fn(async () => state.administrators),
  },
  restaurantBranch: {
    create: vi.fn(async () => ({ id: 'branch_default' })),
    findFirst: vi.fn(async () => state.branch),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })),
    // The activation preflight asks for DEFAULT branches (and requires exactly
    // one); the provisioning pass asks for every ACTIVE branch. Honour the
    // filter so a second branch cannot accidentally fail the preflight.
    findMany: vi.fn(async ({ where }: { where?: { isDefault?: boolean } } = {}) =>
      (where?.isDefault ? state.branches.slice(0, 1) : state.branches).map((branch) => ({
        ...branch,
        name: 'Gulberg Flagship',
        address: '42 Main Boulevard, Lahore',
        timezone: 'Asia/Karachi',
        businessDayCutoff: '04:30',
      }))
    ),
    count: vi.fn(async () => state.branches.length),
  },
  restaurantJobRole: {
    findMany: vi.fn(async () => state.existingJobRoleKeys.map((key) => ({ key }))),
    findFirst: vi.fn(async ({ where }: { where: { key?: string } }) =>
      where.key === 'owner' && state.existingJobRoleKeys.includes('owner')
        ? { id: 'jobrole_owner', active: state.ownerRoleActive }
        : null
    ),
    // `grantJobRole` re-reads the role by id before writing the holding.
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      where.id === 'jobrole_owner'
        ? { id: 'jobrole_owner', key: 'owner', active: state.ownerRoleActive }
        : null
    ),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      jobRoles.push(data);
      state.existingJobRoleKeys.push(data.key as string);
      return { id: `jobrole_${data.key as string}`, key: data.key, capabilities: [] };
    }),
  },
  restaurantStaffJobRole: {
    findUnique: vi.fn(async ({ where }: { where: Record<string, Record<string, string>> }) => {
      const key = where.staffProfileId_jobRoleId_branchId!;
      return jobRoleHoldings.some(
        (holding) =>
          holding.staffProfileId === key.staffProfileId &&
          holding.jobRoleId === key.jobRoleId &&
          holding.branchId === key.branchId
      )
        ? { id: 'holding_existing' }
        : null;
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      jobRoleHoldings.push(data);
      return { id: `holding_${jobRoleHoldings.length}` };
    }),
  },
  restaurantStaffJobRoleAudit: { create: passthrough('jobRoleAudit') },
  restaurantKitchenStation: {
    findFirst: vi.fn(async ({ where }: { where: { branchId: string } }) =>
      state.branchesWithStations.includes(where.branchId) ? { id: 'station_existing' } : null
    ),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      stations.push(data);
      state.branchesWithStations.push(data.branchId as string);
      return {
        id: `station_${stations.length}`,
        name: data.name as string,
        branchId: data.branchId as string,
      };
    }),
  },
  restaurantBranchAssignment: { create: passthrough('assignment') },
  restaurantStaffProfile: {
    // `grantJobRole` asserts both the staff profile and the branch are in scope.
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })),
    findFirst: vi.fn(async ({ where }: { where: { userId?: string; email?: string } }) => {
      if (where.userId) return state.existingByUserId.get(where.userId) ?? null;
      return null; // no directory email clash
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      staffProfiles.push(data);
      const row = {
        id: `staff_${staffProfiles.length}`,
        primaryBranchId: (data.primaryBranchId as string | null) ?? null,
      };
      state.existingByUserId.set(data.userId as string, row);
      return row;
    }),
  },
  restaurantActivationAcknowledgement: {
    findMany: vi.fn(async () =>
      ['TAX', 'PAYMENT', 'DEVICE', 'OPERATOR'].map((kind) => ({
        kind,
        policyReference: `${kind.toLowerCase()}-policy-v1`,
      }))
    ),
  },
  organizationBrand: { create: passthrough('brand') },
  organizationEmailSettings: { create: passthrough('emailSettings') },
  organizationDeployment: { create: passthrough('deployment'), upsert: passthrough('deployment') },
  platformJob: { create: passthrough('job') },
  organizationLifecycleEvent: { create: passthrough('lifecycle') },
  platformAuditLog: {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      auditRecords.push(data);
      return { id: `audit_${auditRecords.length}` };
    }),
  },
};

import { executePlatformCommand } from './commands';
import { RESTAURANT_JOB_ROLE_TEMPLATES } from '@/lib/vertical-catalog';

const actor = { id: 'op_1', role: 'SUPER_ADMIN' } as never;
const request = new Request('https://admin.devfathom.com/api/platform/control', { method: 'POST' });

function createPayload(vertical: 'RESTAURANT' | 'AGENCY') {
  return {
    slug: 'acme-diner',
    legalName: 'Acme Diner Ltd',
    displayName: 'Acme Diner',
    vertical,
    deploymentMode: 'SHARED',
    packageId: 'pkg_1',
    timezone: 'Asia/Karachi',
    locale: 'en-US',
    currency: 'pkr',
    seatLimit: 25,
    primaryContactName: 'Ops',
    primaryContactEmail: 'ops@acme.test',
    adminName: 'Restaurant Owner',
    adminEmail: 'owner@example.test',
    adminPassword: 'a-strong-password',
    ...(vertical === 'RESTAURANT'
      ? {
          firstBranchName: 'Gulberg Flagship',
          firstBranchAddress: '42 Main Boulevard, Lahore',
          businessDayCutoff: '04:30',
        }
      : {}),
  };
}

const activatePayload = {
  id: 'org_new',
  status: 'ACTIVE',
  reason: 'Ready for production traffic',
};

beforeEach(() => {
  vi.clearAllMocks();
  staffProfiles.length = 0;
  auditRecords.length = 0;
  jobRoles.length = 0;
  jobRoleHoldings.length = 0;
  stations.length = 0;
  organizationDefaults.length = 0;
  state.existingByUserId = new Map();
  state.branch = { id: 'branch_default' };
  state.packageVertical = 'RESTAURANT';
  state.organizationVertical = 'RESTAURANT';
  state.organizationStatus = 'ONBOARDING';
  state.administrators = [
    { id: 'user_admin', name: 'Restaurant Owner', email: 'owner@example.test' },
  ];
  state.existingJobRoleKeys = [];
  state.ownerRoleActive = true;
  state.branchesWithStations = [];
  state.branches = [{ id: 'branch_default' }];
});

describe('restaurant administrator staff profile at the platform entry points', () => {
  it('organization.create links the bootstrap administrator to the default branch', async () => {
    await executePlatformCommand(
      actor,
      'organization.create',
      createPayload('RESTAURANT'),
      request
    );

    expect(staffProfiles).toHaveLength(1);
    expect(staffProfiles[0]).toMatchObject({
      organizationId: 'org_new',
      userId: 'user_admin',
      displayName: 'Restaurant Owner',
      primaryBranchId: 'branch_default',
      status: 'ACTIVE',
    });
  });

  it('organization.create leaves the Agency path with no restaurant profile', async () => {
    state.packageVertical = 'AGENCY';

    await executePlatformCommand(actor, 'organization.create', createPayload('AGENCY'), request);

    expect(staffProfiles).toEqual([]);
    expect(platformDb.restaurantStaffProfile.create).not.toHaveBeenCalled();
  });

  it('activation provisions an administrator an older organization never got', async () => {
    await executePlatformCommand(actor, 'organization.transition', activatePayload, request);

    expect(staffProfiles).toHaveLength(1);
    expect(staffProfiles[0]).toMatchObject({
      organizationId: 'org_new',
      userId: 'user_admin',
      primaryBranchId: 'branch_default',
      status: 'ACTIVE',
    });
    // The response shape is unchanged; only the ledger records the repair.
    const audited = auditRecords.at(-1)?.after as Record<string, unknown>;
    expect(audited.restaurantAdministratorStaffProfiles).toEqual([
      {
        created: true,
        staffProfileId: 'staff_1',
        primaryBranchId: 'branch_default',
        userId: 'user_admin',
      },
    ]);
    expect(audited.restaurantProvisioning).toMatchObject({
      administrators: [
        {
          created: true,
          staffProfileId: 'staff_1',
          primaryBranchId: 'branch_default',
          userId: 'user_admin',
          roleProfileGranted: true,
        },
      ],
    });
  });

  it('is idempotent across both entry points and across repeated activations', async () => {
    await executePlatformCommand(
      actor,
      'organization.create',
      createPayload('RESTAURANT'),
      request
    );
    expect(staffProfiles).toHaveLength(1);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await executePlatformCommand(actor, 'organization.transition', activatePayload, request);
    }

    expect(staffProfiles).toHaveLength(1);
    expect(platformDb.restaurantStaffProfile.create).toHaveBeenCalledOnce();
    // Every concern converges: no second profile, no duplicate job roles, no
    // second holding, and no extra station on the branch that already has one.
    expect(jobRoles).toHaveLength(RESTAURANT_JOB_ROLE_TEMPLATES.length);
    expect(jobRoleHoldings).toHaveLength(1);
    expect(stations).toHaveLength(1);
    const audited = auditRecords.at(-1)?.after as Record<string, unknown>;
    expect(audited.restaurantAdministratorStaffProfiles).toEqual([
      {
        created: false,
        staffProfileId: 'staff_1',
        primaryBranchId: 'branch_default',
        userId: 'user_admin',
      },
    ]);
    expect(audited.restaurantProvisioning).toEqual({
      administrators: [
        {
          created: false,
          staffProfileId: 'staff_1',
          primaryBranchId: 'branch_default',
          userId: 'user_admin',
          roleProfileGranted: false,
        },
      ],
      jobRolesCreated: [],
      stationsCreated: [],
    });
  });

  // ── WHA-1181 (5): role profiles, and access INHERITED rather than direct ────

  it('organization.create seeds the vertical job-role profiles and gives the administrator the owner role', async () => {
    await executePlatformCommand(
      actor,
      'organization.create',
      createPayload('RESTAURANT'),
      request
    );

    expect(jobRoles.map((role) => role.key)).toEqual(
      RESTAURANT_JOB_ROLE_TEMPLATES.map((template) => template.key)
    );
    // The owner template carries the enumerated capability set, so everything
    // the administrator can do resolves through a role — not as a direct
    // exception granted one capability at a time.
    const owner = jobRoles.find((role) => role.key === 'owner');
    expect(owner).toMatchObject({ isSystem: true });
    expect(jobRoleHoldings).toEqual([
      {
        staffProfileId: 'staff_1',
        jobRoleId: 'jobrole_owner',
        branchId: 'branch_default',
        grantedByStaffId: null,
      },
    ]);
  });

  it('activation seeds only the job roles an organization is missing', async () => {
    state.existingJobRoleKeys = ['cashier', 'owner'];

    await executePlatformCommand(actor, 'organization.transition', activatePayload, request);

    const created = jobRoles.map((role) => role.key);
    expect(created).not.toContain('cashier');
    expect(created).not.toContain('owner');
    expect(created).toHaveLength(RESTAURANT_JOB_ROLE_TEMPLATES.length - 2);
    // The pre-existing `owner` row is the one granted — a re-seed must never
    // duplicate it, and the grant must find it by key.
    expect(jobRoleHoldings).toHaveLength(1);
  });

  it('grants no role when an operator has deactivated the owner role', async () => {
    state.existingJobRoleKeys = ['owner'];
    state.ownerRoleActive = false;

    await executePlatformCommand(actor, 'organization.transition', activatePayload, request);

    // Reactivating a role somebody switched off is a privilege change, not a
    // repair. The staff profile is still created; only the holding is skipped.
    expect(staffProfiles).toHaveLength(1);
    expect(jobRoleHoldings).toEqual([]);
    const audited = auditRecords.at(-1)?.after as Record<string, unknown>;
    expect(
      (audited.restaurantProvisioning as { administrators: { roleProfileGranted: boolean }[] })
        .administrators[0]!.roleProfileGranted
    ).toBe(false);
  });

  it('names the tenant so the seeded rows inherit its organization id', async () => {
    await executePlatformCommand(actor, 'organization.transition', activatePayload, request);

    // The reused domain writers let `organizationId` fall to its schema default,
    // which reads a GUC the platform control plane deliberately blanks. Without
    // this the seeded roles and stations would belong to no organization.
    expect(organizationDefaults).toEqual(['org_new']);
  });

  // ── WHA-1181 (9a): the default KDS station ─────────────────────────────────

  it('gives every branch a default Kitchen station at activation', async () => {
    state.branches = [{ id: 'branch_default' }, { id: 'branch_second' }];

    await executePlatformCommand(actor, 'organization.transition', activatePayload, request);

    expect(stations).toEqual([
      { branchId: 'branch_default', name: 'Kitchen', isDefault: true },
      { branchId: 'branch_second', name: 'Kitchen', isDefault: true },
    ]);
    const audited = auditRecords.at(-1)?.after as Record<string, unknown>;
    expect(
      (audited.restaurantProvisioning as { stationsCreated: { branchId: string }[] })
        .stationsCreated
    ).toHaveLength(2);
  });

  it('leaves a branch that already has stations alone', async () => {
    state.branches = [{ id: 'branch_default' }, { id: 'branch_second' }];
    state.branchesWithStations = ['branch_default'];

    await executePlatformCommand(actor, 'organization.transition', activatePayload, request);

    // A branch with "Grill" and "Bar" is already working; adding a "Kitchen"
    // nobody asked for would start routing tickets to an unwatched screen.
    expect(stations).toEqual([{ branchId: 'branch_second', name: 'Kitchen', isDefault: true }]);
  });

  it('covers every administrator, not only the bootstrap one', async () => {
    state.administrators = [
      { id: 'user_admin', name: 'Restaurant Owner', email: 'owner@example.test' },
      { id: 'user_admin_2', name: 'Second Owner', email: 'second@example.test' },
    ];

    await executePlatformCommand(actor, 'organization.transition', activatePayload, request);

    expect(staffProfiles.map((profile) => profile.userId)).toEqual(['user_admin', 'user_admin_2']);
    expect(platformDb.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org_new', role: 'ADMIN', status: { in: ['ACTIVE', 'ON_LEAVE'] } },
      })
    );
  });

  it('writes no restaurant profile when an Agency organization activates', async () => {
    state.organizationVertical = 'AGENCY';
    state.packageVertical = 'AGENCY';

    await executePlatformCommand(actor, 'organization.transition', activatePayload, request);

    expect(staffProfiles).toEqual([]);
    expect(platformDb.user.findMany).not.toHaveBeenCalled();
    expect(auditRecords.at(-1)?.after).not.toHaveProperty('restaurantAdministratorStaffProfiles');
    expect(jobRoles).toEqual([]);
    expect(stations).toEqual([]);
    expect(auditRecords.at(-1)?.after).not.toHaveProperty('restaurantProvisioning');
  });

  it('writes no restaurant profile on a non-activating transition', async () => {
    state.organizationStatus = 'ACTIVE';

    await executePlatformCommand(
      actor,
      'organization.transition',
      { ...activatePayload, status: 'SUSPENDED', reason: 'Non-payment after grace' },
      request
    );

    expect(staffProfiles).toEqual([]);
    expect(platformDb.restaurantStaffProfile.create).not.toHaveBeenCalled();
  });
});
