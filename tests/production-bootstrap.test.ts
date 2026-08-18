import { describe, expect, it, vi } from 'vitest';

import { bootstrapProduction, PLATFORM_MODULES } from '../prisma/production-bootstrap';
import { RESTAURANT_MODULES, RESTAURANT_PACKAGES } from '../src/lib/vertical-catalog';

const INPUT = {
  organizationId: 'org_devfathom',
  adminName: 'Workspace Administrator',
  adminEmail: '  ADMIN@DevFathom.com ',
  adminPassword: 'initial-tenant-password',
  adminTitle: 'Administrator',
  platformAdminName: 'Platform Administrator',
  platformAdminEmail: ' PLATFORM-ADMIN@DevFathom.com ',
  platformAdminPassword: 'initial-platform-password',
  deploymentUrl: 'https://www.devfathom.com',
};

type TenantUser = {
  id: string;
  email: string;
  password: string | null;
  organizationRoleId: string;
  role: string;
  status: string;
};

type PlatformUser = {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  active: boolean;
};

function fakeTransaction() {
  const state: {
    tenantUser: TenantUser | null;
    platformUser: PlatformUser | null;
    organizationModules: Map<string, { status: string; expiresAt: string | null }>;
    permission: { effect: string } | null;
    deployment: { mode: string; status: string; provider: string; url?: string } | null;
  } = {
    tenantUser: null,
    platformUser: null,
    organizationModules: new Map(),
    permission: null,
    deployment: null,
  };
  const platformModule = {
    upsert: vi.fn(async (args: { where: { key: string } }) => ({
      id: `module_${args.where.key}`,
    })),
  };
  const platformPackage = {
    upsert: vi.fn(async (args: { where: { key: string } }) => ({
      id: `package_${args.where.key}`,
    })),
  };
  const organizationDeployment = {
    upsert: vi.fn(
      async (args: {
        update: Partial<NonNullable<typeof state.deployment>>;
        create: NonNullable<typeof state.deployment>;
      }) => {
        if (state.deployment) Object.assign(state.deployment, args.update);
        else {
          state.deployment = {
            mode: args.create.mode,
            status: args.create.status,
            provider: args.create.provider,
            url: args.create.url,
          };
        }
      }
    ),
  };
  const allowed = {
    $executeRawUnsafe: vi.fn(async () => undefined),
    platformPackage,
    organization: { upsert: vi.fn(async () => undefined) },
    platformModule,
    platformPackageModule: {
      upsert: vi.fn(
        async (_args: {
          create: {
            packageId: string;
            moduleId: string;
            limits?: Readonly<Record<string, number>>;
          };
        }) => undefined
      ),
    },
    organizationModule: {
      upsert: vi.fn(
        async (args: {
          where: { organizationId_moduleId: { moduleId: string } };
          update: Partial<{ status: string; expiresAt: string | null }>;
          create: { status: string };
        }) => {
          const key = args.where.organizationId_moduleId.moduleId;
          const current = state.organizationModules.get(key);
          if (current) Object.assign(current, args.update);
          else state.organizationModules.set(key, { status: args.create.status, expiresAt: null });
        }
      ),
    },
    organizationRole: {
      upsert: vi.fn(async (args: { where: { organizationId_key: { key: string } } }) => ({
        id: `role_${args.where.organizationId_key.key}`,
      })),
    },
    organizationRolePermission: {
      upsert: vi.fn(
        async (args: { update: Partial<{ effect: string }>; create: { effect: string } }) => {
          if (state.permission) Object.assign(state.permission, args.update);
          else state.permission = { effect: args.create.effect };
        }
      ),
    },
    organizationBrand: { upsert: vi.fn(async () => undefined) },
    organizationDeployment,
    user: {
      findFirst: vi.fn(
        async (args: { where: { email: { equals: string }; organizationId: string } }) =>
          state.tenantUser?.email.toLowerCase() === args.where.email.equals.toLowerCase()
            ? { id: state.tenantUser.id }
            : null
      ),
      create: vi.fn(async (args: { data: Omit<TenantUser, 'id'> }) => {
        state.tenantUser = { id: 'tenant_admin', ...args.data };
        return state.tenantUser;
      }),
      update: vi.fn(async (args: { data: Partial<TenantUser> }) => {
        state.tenantUser = { ...state.tenantUser!, ...args.data };
        return state.tenantUser;
      }),
    },
    platformUser: {
      findFirst: vi.fn(async (args: { where: { email: { equals: string } } }) =>
        state.platformUser?.email.toLowerCase() === args.where.email.equals.toLowerCase()
          ? { id: state.platformUser.id }
          : null
      ),
      create: vi.fn(async (args: { data: Omit<PlatformUser, 'id'> }) => {
        state.platformUser = { id: 'platform_admin', ...args.data };
        return state.platformUser;
      }),
      update: vi.fn(async (args: { data: Partial<PlatformUser> }) => {
        state.platformUser = { ...state.platformUser!, ...args.data };
        return state.platformUser;
      }),
    },
  };
  const tx = new Proxy(allowed, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      throw new Error(`Production bootstrap accessed unexpected model: ${String(property)}`);
    },
  }) as unknown as Parameters<typeof bootstrapProduction>[0];

  return { tx, state, platformModule, organizationDeployment, delegates: allowed };
}

describe('production bootstrap', () => {
  it('creates the foundation once and preserves deliberate account and entitlement changes', async () => {
    const { tx, state, platformModule, organizationDeployment, delegates } = fakeTransaction();
    const hashPassword = vi.fn(async (password: string) => `hash:${password}`);

    await bootstrapProduction(tx, INPUT, hashPassword);

    expect(state.tenantUser).toMatchObject({
      email: 'admin@devfathom.com',
      password: 'hash:initial-tenant-password',
      organizationRoleId: 'role_admin',
      role: 'ADMIN',
      status: 'ACTIVE',
    });
    expect(state.platformUser).toMatchObject({
      email: 'platform-admin@devfathom.com',
      passwordHash: 'hash:initial-platform-password',
      role: 'SUPER_ADMIN',
      active: true,
    });
    expect(platformModule.upsert).toHaveBeenCalledTimes(
      PLATFORM_MODULES.length + RESTAURANT_MODULES.length
    );
    expect(delegates.platformPackage.upsert).toHaveBeenCalledTimes(1 + RESTAURANT_PACKAGES.length);
    expect(delegates.platformPackageModule.upsert).toHaveBeenCalledTimes(
      PLATFORM_MODULES.length +
        RESTAURANT_PACKAGES.reduce(
          (total, restaurantPackage) => total + restaurantPackage.moduleKeys.length,
          0
        )
    );
    expect(delegates.platformPackage.upsert).toHaveBeenCalledWith({
      where: { key: 'agency-suite' },
      update: {},
      create: expect.objectContaining({
        key: 'agency-suite',
        vertical: 'AGENCY',
        defaultSeats: 25,
      }),
    });
    for (const module of RESTAURANT_MODULES) {
      expect(platformModule.upsert).toHaveBeenCalledWith({
        where: { key: module.key },
        update: {},
        create: {
          key: module.key,
          name: module.name,
          category: module.category,
          routePrefix: module.routePrefix,
        },
      });
    }
    for (const restaurantPackage of RESTAURANT_PACKAGES) {
      const packageId = `package_${restaurantPackage.key}`;
      expect(delegates.platformPackage.upsert).toHaveBeenCalledWith({
        where: { key: restaurantPackage.key },
        update: {},
        create: {
          key: restaurantPackage.key,
          name: restaurantPackage.name,
          vertical: 'RESTAURANT',
        },
      });
      for (const moduleKey of restaurantPackage.moduleKeys) {
        expect(delegates.platformPackageModule.upsert).toHaveBeenCalledWith({
          where: {
            packageId_moduleId: { packageId, moduleId: `module_${moduleKey}` },
          },
          update: {},
          create: {
            packageId,
            moduleId: `module_${moduleKey}`,
            limits: moduleKey === 'restaurant-core' ? restaurantPackage.defaultLimits : undefined,
          },
        });
      }
      const limitLink = delegates.platformPackageModule.upsert.mock.calls.find(
        ([args]) => args.create.packageId === packageId && args.create.limits
      );
      expect(limitLink?.[0].create.limits).toEqual(restaurantPackage.defaultLimits);
      expect(Object.keys(limitLink?.[0].create.limits ?? {})).toEqual(
        Object.keys(restaurantPackage.defaultLimits)
      );
    }
    for (const [key] of PLATFORM_MODULES) {
      expect(delegates.platformPackageModule.upsert).toHaveBeenCalledWith({
        where: {
          packageId_moduleId: {
            packageId: 'package_agency-suite',
            moduleId: `module_${key}`,
          },
        },
        update: {},
        create: {
          packageId: 'package_agency-suite',
          moduleId: `module_${key}`,
        },
      });
    }
    expect(organizationDeployment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          provider: 'AZURE_CONTAINER_APPS',
          url: 'https://www.devfathom.com',
        }),
      })
    );

    // §2.3: bootstrap no longer copies package modules into OrganizationModule rows —
    // the bootstrap org inherits its modules live from the Agency Suite package
    // (platform_package_modules). A deliberate org-level entitlement change is now an
    // explicit operator override row (created the new way, i.e. an OrganizationModule
    // row with a reason via `organization.module`), which must survive re-bootstrap
    // unchanged because bootstrap never touches OrganizationModule.
    expect(state.organizationModules.size).toBe(0);
    expect(delegates.organizationModule.upsert).not.toHaveBeenCalled();
    const dashboardEntitlement = { status: 'DISABLED', expiresAt: '2026-09-01T00:00:00.000Z' };
    state.organizationModules.set('module_dashboard', dashboardEntitlement);
    state.permission!.effect = 'DENY';
    Object.assign(state.deployment!, {
      mode: 'DEDICATED',
      status: 'FAILED',
      provider: 'OPERATOR_OVERRIDE',
      url: 'https://disabled.invalid',
    });

    state.tenantUser!.password = 'hash:changed-by-tenant-admin';
    state.tenantUser!.email = 'ADMIN@DEVFATHOM.COM';
    state.tenantUser!.role = 'EMPLOYEE';
    state.tenantUser!.status = 'INACTIVE';
    state.platformUser!.passwordHash = 'hash:changed-by-platform-admin';
    state.platformUser!.email = 'PLATFORM-ADMIN@DEVFATHOM.COM';
    state.platformUser!.role = 'AUDITOR';
    state.platformUser!.active = false;

    state.tenantUser!.organizationRoleId = 'role_demoted';

    await bootstrapProduction(
      tx,
      { ...INPUT, adminPassword: undefined, platformAdminPassword: undefined },
      hashPassword
    );

    expect(state.tenantUser!.password).toBe('hash:changed-by-tenant-admin');
    state.tenantUser!.password = null;
    await bootstrapProduction(
      tx,
      { ...INPUT, adminPassword: undefined, platformAdminPassword: undefined },
      hashPassword
    );

    expect(hashPassword).toHaveBeenCalledTimes(2);
    expect(state.tenantUser).toMatchObject({
      email: 'ADMIN@DEVFATHOM.COM',
      password: null,
      organizationRoleId: 'role_demoted',
      role: 'EMPLOYEE',
      status: 'INACTIVE',
    });
    expect(state.platformUser).toMatchObject({
      email: 'PLATFORM-ADMIN@DEVFATHOM.COM',
      passwordHash: 'hash:changed-by-platform-admin',
      role: 'AUDITOR',
      active: false,
    });
    expect(dashboardEntitlement).toEqual({
      status: 'DISABLED',
      expiresAt: '2026-09-01T00:00:00.000Z',
    });
    expect(state.permission).toEqual({ effect: 'DENY' });
    expect(state.deployment).toEqual({
      mode: 'DEDICATED',
      status: 'FAILED',
      provider: 'OPERATOR_OVERRIDE',
      url: 'https://disabled.invalid',
    });
    expect(delegates.user.create).toHaveBeenCalledTimes(1);
    expect(delegates.platformUser.create).toHaveBeenCalledTimes(1);
    expect(delegates.user.update).not.toHaveBeenCalled();
    expect(delegates.platformUser.update).not.toHaveBeenCalled();

    const createOnlyUpserts = [
      delegates.platformPackage.upsert,
      delegates.organization.upsert,
      delegates.platformModule.upsert,
      delegates.platformPackageModule.upsert,
      delegates.organizationRole.upsert,
      delegates.organizationRolePermission.upsert,
      delegates.organizationBrand.upsert,
      delegates.organizationDeployment.upsert,
    ];
    for (const upsert of createOnlyUpserts) {
      for (const [args] of upsert.mock.calls as unknown as Array<[{ update: unknown }]>) {
        expect(args.update).toEqual({});
      }
    }
  });

  it.each([
    { adminPassword: undefined, platformAdminPassword: INPUT.platformAdminPassword },
    { adminPassword: INPUT.adminPassword, platformAdminPassword: 'too-short' },
  ])(
    'fails before creating foundation data when a new account credential is invalid',
    async (input) => {
      const { tx, delegates } = fakeTransaction();
      const hashPassword = vi.fn(async (password: string) => `hash:${password}`);

      await expect(bootstrapProduction(tx, { ...INPUT, ...input }, hashPassword)).rejects.toThrow(
        'Missing or invalid production bootstrap credential.'
      );

      expect(delegates.platformPackage.upsert).not.toHaveBeenCalled();
      expect(delegates.organization.upsert).not.toHaveBeenCalled();
      expect(delegates.user.create).not.toHaveBeenCalled();
      expect(delegates.platformUser.create).not.toHaveBeenCalled();
      expect(hashPassword).not.toHaveBeenCalled();
    }
  );
});
