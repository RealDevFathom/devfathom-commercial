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
}));

/** Rows the command layer wrote, keyed by model, in call order. */
const staffProfiles: Record<string, unknown>[] = [];
const auditRecords: Record<string, unknown>[] = [];

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
  user: {
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
    findMany: vi.fn(async () => [
      {
        id: 'branch_default',
        name: 'Gulberg Flagship',
        address: '42 Main Boulevard, Lahore',
        timezone: 'Asia/Karachi',
        businessDayCutoff: '04:30',
      },
    ]),
    count: vi.fn(async () => 1),
  },
  restaurantBranchAssignment: { create: passthrough('assignment') },
  restaurantStaffProfile: {
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
  state.existingByUserId = new Map();
  state.branch = { id: 'branch_default' };
  state.packageVertical = 'RESTAURANT';
  state.organizationVertical = 'RESTAURANT';
  state.organizationStatus = 'ONBOARDING';
  state.administrators = [
    { id: 'user_admin', name: 'Restaurant Owner', email: 'owner@example.test' },
  ];
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
    const audited = auditRecords.at(-1)?.after as Record<string, unknown>;
    expect(audited.restaurantAdministratorStaffProfiles).toEqual([
      {
        created: false,
        staffProfileId: 'staff_1',
        primaryBranchId: 'branch_default',
        userId: 'user_admin',
      },
    ]);
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
