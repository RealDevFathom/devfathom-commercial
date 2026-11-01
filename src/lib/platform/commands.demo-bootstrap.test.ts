import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hash: vi.fn(async () => 'ordinary-password-hash'),
  ensureAdministratorStaffProfile: vi.fn(),
  assertPlatformCapability: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: mocks.hash, compare: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn() }));
vi.mock('@/lib/platform/auth', () => ({
  assertPlatformCapability: mocks.assertPlatformCapability,
}));
vi.mock('@/lib/restaurant/administrator-staff-profile', () => ({
  ensureAdministratorStaffProfile: mocks.ensureAdministratorStaffProfile,
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: unknown) => Promise<unknown>) => run(platformDb)),
}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  RESTAURANT_CAPABILITIES,
  RESTAURANT_MODULES,
  roleTemplatesForVertical,
} from '@/lib/vertical-catalog';
import { demoSeatIdentity } from '@/lib/demo/seed-data';
import {
  activateDemoRestaurantOrganizationInTransaction,
  bootstrapDemoRestaurantOrganizationInTransaction,
  DEMO_APPROVER_ORGANIZATION_ROLE_KEY,
  demoRestaurantApproverUserId,
  executePlatformCommand,
} from './commands';

type OrganizationState = Record<string, unknown> & {
  id: string;
  slug: string;
  isDemo: boolean;
};
type UserState = Record<string, unknown> & {
  id: string;
  organizationId: string;
  email: string;
};
type RoleState = {
  id: string;
  key: string;
  permissions: Array<{ capability: string; effect: 'ALLOW' | 'DENY' }>;
};

const identity = demoSeatIdentity(1);
const now = new Date('2026-09-04T12:00:00.000Z');
let organization: OrganizationState | null;
let users: UserState[];
let roles: RoleState[];
let deployment: Record<string, unknown> | null;
let defaultBranches: Record<string, unknown>[];
let packageVertical: 'AGENCY' | 'RESTAURANT';

const organizationCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
  organization = {
    id: (data.id as string | undefined) ?? 'org_generated',
    slug: data.slug as string,
    legalName: data.legalName,
    displayName: data.displayName,
    vertical: data.vertical,
    status: data.status,
    deploymentMode: data.deploymentMode,
    packageId: data.packageId,
    isDemo: (data.isDemo as boolean | undefined) ?? false,
  };
  return organization;
});

const organizationRoleCreate = vi.fn(
  async ({ data }: { data: Record<string, unknown> & { key: string } }) => {
    const permissions = (data.permissions as { create: RoleState['permissions'] }).create;
    const role = { id: `role_${data.key}`, key: data.key, permissions };
    roles.push(role);
    return role;
  }
);

const userCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
  const user = {
    id: (data.id as string | undefined) ?? 'user_generated',
    organizationId: data.organizationId as string,
    organizationRoleId: data.organizationRoleId,
    name: data.name,
    email: data.email as string,
    role: data.role,
    status: data.status,
    password: data.password,
    tokenVersion: 0,
  };
  users.push(user);
  return user;
});

const organizationDeploymentCreate = vi.fn(async ({ data }: { data: unknown }) => ({
  id: 'deployment_1',
  ...(data as object),
}));
const organizationDeploymentUpsert = vi.fn(
  async ({
    create,
    update,
  }: {
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }) => {
    deployment = deployment ? { ...deployment, ...update } : { id: 'deployment_demo', ...create };
    return deployment;
  }
);
const platformJobCreate = vi.fn(async ({ data }: { data: unknown }) => ({
  id: 'job_1',
  ...(data as object),
}));

const platformDb = {
  // Seat lock: `FOR UPDATE` row read + occupied-seat count on the shared helper.
  $queryRaw: vi.fn(async () => []),
  platformPackage: {
    findUnique: vi.fn(async () => ({
      id: packageVertical === 'RESTAURANT' ? 'pkg_restaurant_enterprise' : 'pkg_agency',
      key: packageVertical === 'RESTAURANT' ? 'restaurant-enterprise' : 'agency-suite',
      name: 'Package',
      active: true,
      vertical: packageVertical,
      defaultSeats: 25,
      moduleLinks:
        packageVertical === 'RESTAURANT'
          ? RESTAURANT_MODULES.map((module) => ({
              enabled: true,
              moduleId: `module_${module.key}`,
              module: { key: module.key, active: true },
            }))
          : [],
    })),
  },
  organization: {
    findUnique: vi.fn(
      async ({ where, include }: { where: { id?: string; slug?: string }; include?: unknown }) => {
        const found = where.id
          ? organization?.id === where.id
            ? organization
            : null
          : organization?.slug === where.slug
            ? organization
            : null;
        if (!found || !include) return found;
        return {
          ...found,
          package: {
            vertical: packageVertical,
            moduleLinks: RESTAURANT_MODULES.map((module) => ({
              moduleId: `module_${module.key}`,
            })),
          },
          modules: [],
          users: users.filter((user) => user.role === 'ADMIN' && user.status === 'ACTIVE'),
          deployments: deployment?.status === 'READY' ? [deployment] : [],
        };
      }
    ),
    create: organizationCreate,
    update: vi.fn(async ({ data }) => {
      organization = { ...organization!, ...data };
      return organization;
    }),
  },
  organizationRole: {
    create: organizationRoleCreate,
    findMany: vi.fn(async () => roles),
  },
  organizationDepartment: { createMany: vi.fn(async () => ({ count: 1 })) },
  user: {
    count: vi.fn(async () => 0),
    findUnique: vi.fn(
      async ({ where }: { where: { id: string } }) =>
        users.find((user) => user.id === where.id) ?? null
    ),
    findFirst: vi.fn(async ({ where }: { where: { email?: string; organizationId?: string } }) => {
      const user = users.find((candidate) => candidate.email === where.email);
      if (!user) return null;
      return where.organizationId && user.organizationId !== where.organizationId ? null : user;
    }),
    create: userCreate,
    update: vi.fn(),
  },
  platformModule: {
    findMany: vi.fn(async () =>
      RESTAURANT_MODULES.map((module) => ({ id: `module_${module.key}`, key: module.key }))
    ),
  },
  organizationModule: { findMany: vi.fn(async () => []) },
  restaurantBranch: { create: vi.fn(), findMany: vi.fn(async () => defaultBranches) },
  restaurantActivationAcknowledgement: { findMany: vi.fn(async () => []) },
  restaurantBranchAssignment: { create: vi.fn() },
  pharmacyBranch: { create: vi.fn() },
  organizationBrand: { create: vi.fn(async ({ data }) => ({ id: 'brand_1', ...data })) },
  organizationEmailSettings: {
    create: vi.fn(async ({ data }) => ({ id: 'email_settings_1', ...data })),
  },
  organizationDeployment: {
    create: organizationDeploymentCreate,
    upsert: organizationDeploymentUpsert,
  },
  platformJob: { create: platformJobCreate },
  organizationLifecycleEvent: {
    create: vi.fn(async ({ data }) => ({ id: 'lifecycle_1', ...data })),
  },
  platformAuditLog: { create: vi.fn(async ({ data }) => ({ id: 'audit_1', ...data })) },
} as unknown as ScopedDb;

function resetState(vertical: 'AGENCY' | 'RESTAURANT' = 'RESTAURANT') {
  organization = null;
  users = [];
  roles = [];
  deployment = null;
  defaultBranches = [];
  packageVertical = vertical;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
  vi.stubEnv('PLATFORM_BASE_DOMAIN', 'localhost');
});

afterEach(() => vi.unstubAllEnvs());

describe('bootstrapDemoRestaurantOrganizationInTransaction', () => {
  it('uses the exact allowlisted app origin only when no tenant base domain exists', async () => {
    vi.stubEnv('PLATFORM_BASE_DOMAIN', '');
    vi.stubEnv('AUTH_URL', 'http://localhost:3217');
    vi.stubEnv('SHARED_APP_HOSTS', 'localhost:3217');

    await bootstrapDemoRestaurantOrganizationInTransaction(platformDb, identity, now);

    expect(organizationDeploymentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ url: 'http://localhost:3217' }),
      })
    );
  });

  it('creates a flagged shared seat with stable identities and restaurant-only authority', async () => {
    await bootstrapDemoRestaurantOrganizationInTransaction(platformDb, identity, now);

    expect(organizationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: identity.organizationId,
          slug: identity.slug,
          isDemo: true,
          vertical: 'RESTAURANT',
          deploymentMode: 'SHARED',
          status: 'ONBOARDING',
        }),
      })
    );
    expect(userCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: identity.managerUserId,
          email: identity.managerEmail,
          password: null,
        }),
      })
    );
    expect(userCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: demoRestaurantApproverUserId(identity.seatNumber),
          name: 'Demo approving manager',
          email: 'approver.seat1@demo.devfathom.invalid',
          password: null,
          role: 'EMPLOYEE',
        }),
      })
    );
    const owner = roles.find((role) => role.key === 'owner');
    const approver = roles.find((role) => role.key === DEMO_APPROVER_ORGANIZATION_ROLE_KEY);
    expect(owner?.permissions.map((permission) => permission.capability).sort()).toEqual(
      [...RESTAURANT_CAPABILITIES].sort()
    );
    expect(owner?.permissions).not.toContainEqual(expect.objectContaining({ capability: '*' }));
    expect(approver?.permissions).toEqual([
      {
        organizationId: identity.organizationId,
        capability: 'coauth:approve',
        effect: 'ALLOW',
      },
    ]);
    expect(roles.map((role) => role.key).sort()).toEqual(
      [
        ...roleTemplatesForVertical('RESTAURANT').map((role) => role.key),
        DEMO_APPROVER_ORGANIZATION_ROLE_KEY,
      ].sort()
    );
    expect(platformDb.restaurantBranch.create).not.toHaveBeenCalled();
    expect(organizationDeploymentCreate).not.toHaveBeenCalled();
    expect(organizationDeploymentUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: 'READY',
          url: `http://${identity.slug}.localhost`,
        }),
      })
    );
    expect(platformJobCreate).not.toHaveBeenCalled();
    expect(platformDb.organizationLifecycleEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ actorId: null, createdAt: now }),
    });
  });

  it('validates a rerun without replacing stable organization, user, password, or token state', async () => {
    await bootstrapDemoRestaurantOrganizationInTransaction(platformDb, identity, now);
    const createdOrganization = organization;
    const createdManager = users.find((user) => user.id === identity.managerUserId)!;
    const createdApprover = users.find(
      (user) => user.id === demoRestaurantApproverUserId(identity.seatNumber)
    )!;
    createdManager.tokenVersion = 17;
    createdApprover.tokenVersion = 23;

    await bootstrapDemoRestaurantOrganizationInTransaction(platformDb, identity, now);

    expect(organization).toBe(createdOrganization);
    expect(users).toContain(createdManager);
    expect(users).toContain(createdApprover);
    expect(createdManager.password).toBeNull();
    expect(createdApprover.password).toBeNull();
    expect(createdManager.tokenVersion).toBe(17);
    expect(createdApprover.tokenVersion).toBe(23);
    expect(organizationCreate).toHaveBeenCalledTimes(1);
    expect(userCreate).toHaveBeenCalledTimes(2);
    expect(platformDb.user.update).not.toHaveBeenCalled();
  });

  it('refuses an unflagged organization occupying the stable seat', async () => {
    organization = {
      ...identity,
      id: identity.organizationId,
      legalName: identity.displayName,
      vertical: 'RESTAURANT',
      status: 'ACTIVE',
      deploymentMode: 'SHARED',
      packageId: 'pkg_restaurant_enterprise',
      isDemo: false,
    };

    await expect(
      bootstrapDemoRestaurantOrganizationInTransaction(platformDb, identity, now)
    ).rejects.toThrow('canonical demo seat identity is occupied');
    expect(organizationCreate).not.toHaveBeenCalled();
  });

  it('refuses a stable manager ID belonging to another organization', async () => {
    users = [
      {
        id: identity.managerUserId,
        organizationId: 'org_demo_restaurant_seat_2',
        email: identity.managerEmail,
      },
    ];

    await expect(
      bootstrapDemoRestaurantOrganizationInTransaction(platformDb, identity, now)
    ).rejects.toThrow('canonical demo manager ID belongs to another seat');
    expect(organizationCreate).not.toHaveBeenCalled();
  });

  it('refuses a stable approver ID belonging to another seat', async () => {
    users = [
      {
        id: demoRestaurantApproverUserId(identity.seatNumber),
        organizationId: 'org_demo_restaurant_seat_2',
        email: 'approver.seat1@demo.devfathom.invalid',
      },
    ];

    await expect(
      bootstrapDemoRestaurantOrganizationInTransaction(platformDb, identity, now)
    ).rejects.toThrow('canonical demo approver ID belongs to another seat');
    expect(organizationCreate).not.toHaveBeenCalled();
  });

  it('refuses widened or missing approver organization authority', async () => {
    await bootstrapDemoRestaurantOrganizationInTransaction(platformDb, identity, now);
    const approverRole = roles.find((role) => role.key === DEMO_APPROVER_ORGANIZATION_ROLE_KEY)!;
    approverRole.permissions.push({ capability: '*', effect: 'ALLOW' });

    await expect(
      bootstrapDemoRestaurantOrganizationInTransaction(platformDb, identity, now)
    ).rejects.toThrow('demo approver authority is invalid');
  });

  it('activates only after real shared, module, manager, and default-branch preflight', async () => {
    await bootstrapDemoRestaurantOrganizationInTransaction(platformDb, identity, now);
    defaultBranches = [
      {
        id: 'branch_default',
        name: 'Gulberg',
        address: 'MM Alam Road, Lahore',
        timezone: 'Asia/Karachi',
        businessDayCutoff: '04:00',
      },
    ];

    await activateDemoRestaurantOrganizationInTransaction(platformDb, identity, now);

    expect(organization?.status).toBe('ACTIVE');
    expect(platformDb.restaurantActivationAcknowledgement.findMany).not.toHaveBeenCalled();
    expect(platformDb.organizationLifecycleEvent.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        action: 'ACTIVATED',
        fromStatus: 'ONBOARDING',
        toStatus: 'ACTIVE',
        actorId: null,
        createdAt: now,
      }),
    });
  });
});

describe('ordinary organization onboarding', () => {
  it('keeps password hashing, wildcard admin, pending deployment, and actor-owned job unchanged', async () => {
    resetState('AGENCY');
    const actor = { id: 'platform_operator', role: 'SUPER_ADMIN' } as never;
    const request = new Request('https://admin.devfathom.test/api/platform/control', {
      method: 'POST',
    });

    await executePlatformCommand(
      actor,
      'organization.create',
      {
        slug: 'ordinary-company',
        legalName: 'Ordinary Company',
        displayName: 'Ordinary Company',
        deploymentMode: 'SHARED',
        packageId: 'pkg_agency',
        timezone: 'UTC',
        locale: 'en-US',
        currency: 'USD',
        primaryContactName: 'Owner',
        primaryContactEmail: 'owner@ordinary.test',
        adminName: 'Owner',
        adminEmail: 'owner@ordinary.test',
        adminPassword: 'ordinary-password',
      },
      request
    );

    expect(mocks.hash).toHaveBeenCalledWith('ordinary-password', 12);
    expect(organizationCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ isDemo: true }) })
    );
    expect(roles[0]?.permissions).toEqual([
      { organizationId: 'org_generated', capability: '*', effect: 'ALLOW' },
    ]);
    expect(organizationDeploymentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'PENDING', mode: 'SHARED' }),
    });
    expect(platformJobCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'PROVISION_SHARED',
        requestedById: 'platform_operator',
      }),
    });
  });
});
