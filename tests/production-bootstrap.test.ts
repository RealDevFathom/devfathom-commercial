import { describe, expect, it, vi } from 'vitest';

import {
  AGENCY_SUITE_MODULES,
  bootstrapProduction,
  productionBootstrapInputFromEnvironment,
  type RestaurantBootstrapInput,
} from '../prisma/production-bootstrap';
import { syncPlatformCatalog } from '../prisma/catalog-sync';
import { MODULE_CATALOG } from '../src/lib/module-catalog';
import {
  AGENCY_DEPARTMENTS,
  HOSPITALITY_PACKAGES,
  packageDefaultSeats,
  PHARMACY_PACKAGES,
  RESTAURANT_MODULES,
  RESTAURANT_DEPARTMENTS,
  RESTAURANT_ROLE_TEMPLATES,
  RESTAURANT_PACKAGES,
} from '../src/lib/vertical-catalog';

/** Every vertical package bootstrap registers, in registry order. */
const VERTICAL_PACKAGES = [...RESTAURANT_PACKAGES, ...PHARMACY_PACKAGES, ...HOSPITALITY_PACKAGES];

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
  department: string;
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
    departments: { organizationId: string; key: string; name: string }[];
  } = {
    tenantUser: null,
    platformUser: null,
    organizationModules: new Map(),
    permission: null,
    deployment: null,
    departments: [],
  };
  // `syncPlatformCatalog` reads the registry before writing it, so the fake has
  // to remember what a previous pass created: a package that already exists is
  // deliberately left alone rather than re-composed.
  const moduleKeys = new Set<string>();
  const packages = new Map<string, { key: string; defaultSeats?: number }>();
  const findManyByKey = (known: Set<string>) =>
    vi.fn(async (args: { where: { key: { in: string[] } } }) =>
      args.where.key.in.filter((key) => known.has(key)).map((key) => ({ key }))
    );
  const platformModule = {
    findMany: findManyByKey(moduleKeys),
    upsert: vi.fn(async (args: { where: { key: string } }) => {
      moduleKeys.add(args.where.key);
      return { id: `module_${args.where.key}` };
    }),
  };
  const platformPackage = {
    findMany: vi.fn(async (args: { where: { key: { in: string[] } } }) =>
      args.where.key.in.filter((key) => packages.has(key)).map((key) => ({ key }))
    ),
    updateMany: vi.fn(
      async (args: {
        where: { key: string; defaultSeats?: number };
        data: { defaultSeats?: number };
      }) => {
        const row = packages.get(args.where.key);
        if (!row || row.defaultSeats !== args.where.defaultSeats) return { count: 0 };
        Object.assign(row, args.data);
        return { count: 1 };
      }
    ),
    upsert: vi.fn(async (args: { where: { key: string }; create?: { defaultSeats?: number } }) => {
      if (!packages.has(args.where.key))
        packages.set(args.where.key, {
          key: args.where.key,
          defaultSeats: args.create?.defaultSeats,
        });
      return { id: `package_${args.where.key}` };
    }),
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
    organization: {
      upsert: vi.fn(async (args: { create: { id: string } }) => ({
        id: args.create.id,
        vertical: 'AGENCY' as const,
      })),
    },
    // WHA-290: the bootstrap seeds the organization's department catalog before
    // its administrator, because `User.department` is a composite foreign key
    // onto `organization_departments`.
    organizationDepartment: {
      createMany: vi.fn(
        async (args: { data: { organizationId: string; key: string; name: string }[] }) => {
          for (const row of args.data) state.departments.push(row);
          return { count: args.data.length };
        }
      ),
    },
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
    // WHA-290: the administrator's department must be a row this bootstrap
    // actually seeded — the composite foreign key admits nothing else.
    expect(state.departments.map((department) => department.key)).toEqual(
      AGENCY_DEPARTMENTS.map((department) => department.key)
    );
    expect(
      state.departments.every((department) => department.organizationId === INPUT.organizationId)
    ).toBe(true);
    expect(state.departments.map((department) => department.key)).toContain(
      state.tenantUser!.department
    );
    expect(state.platformUser).toMatchObject({
      email: 'platform-admin@devfathom.com',
      passwordHash: 'hash:initial-platform-password',
      role: 'SUPER_ADMIN',
      active: true,
    });
    expect(platformModule.upsert).toHaveBeenCalledTimes(MODULE_CATALOG.length);
    expect(delegates.platformPackage.upsert).toHaveBeenCalledTimes(1 + VERTICAL_PACKAGES.length);
    expect(delegates.platformPackageModule.upsert).toHaveBeenCalledTimes(
      AGENCY_SUITE_MODULES.length +
        VERTICAL_PACKAGES.reduce(
          (total, verticalPackage) => total + verticalPackage.moduleKeys.length,
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
    for (const catalogModule of RESTAURANT_MODULES) {
      expect(platformModule.upsert).toHaveBeenCalledWith({
        where: { key: catalogModule.key },
        update: {},
        create: {
          key: catalogModule.key,
          name: catalogModule.name,
          category: catalogModule.category,
          routePrefix: catalogModule.routePrefix,
          band: catalogModule.mandatory ? 'VERTICAL_CORE' : 'VERTICAL_OPTIONAL',
          vertical: 'RESTAURANT',
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
          defaultSeats: packageDefaultSeats(restaurantPackage),
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
    for (const [key] of AGENCY_SUITE_MODULES) {
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

const RESTAURANT_INPUT: RestaurantBootstrapInput = {
  mode: 'RESTAURANT',
  organizationId: 'org_local_bootstrap',
  organizationSlug: 'local-bootstrap',
  organizationLegalName: 'Local Bootstrap',
  organizationDisplayName: 'Local Bootstrap',
  packageKey: 'restaurant-essentials',
  adminId: 'local_owner',
  adminName: 'Local Owner',
  adminEmail: 'owner@example.invalid',
  adminPassword: 'unit-only-owner-secret',
  adminTitle: 'Owner',
  platformAdminId: 'local_platform_owner',
  platformAdminName: 'Local Platform Owner',
  platformAdminEmail: 'platform@example.invalid',
  platformAdminPassword: 'unit-only-platform-secret',
};

type BootstrapRow = { id: string; [key: string]: unknown };

function restaurantTransaction() {
  const organizations: BootstrapRow[] = [];
  const users: BootstrapRow[] = [];
  const platformUsers: BootstrapRow[] = [];
  const modules = new Map<string, BootstrapRow>();
  const packages = new Map<string, BootstrapRow>();
  const links: BootstrapRow[] = [];
  const roles: BootstrapRow[] = [];
  const departments: Record<string, unknown>[] = [];
  const brands: BootstrapRow[] = [];
  const create = (rows: BootstrapRow[]) =>
    vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `row_${rows.length}`, ...data } as BootstrapRow;
      rows.push(row);
      return row;
    });
  const findIdentities = (rows: BootstrapRow[]) =>
    vi.fn(
      async ({
        where,
      }: {
        where: { OR: Array<{ id?: { in: string[] }; email?: { equals: string } }> };
      }) =>
        rows.filter((row) =>
          where.OR.some(
            (condition) =>
              condition.id?.in.includes(row.id) ||
              (condition.email && String(row.email).toLowerCase() === condition.email.equals)
          )
        )
    );
  const findPackage = vi.fn(async ({ where }: { where: { key: string } }) => {
    const row = packages.get(where.key);
    return row
      ? {
          ...row,
          moduleLinks: links
            .filter((link) => link.packageId === row.id)
            .map((link) => ({
              ...link,
              module: [...modules.values()].find((module) => module.id === link.moduleId),
            })),
        }
      : null;
  });
  const delegates = {
    $executeRawUnsafe: vi.fn(async () => undefined),
    organization: {
      findMany: vi.fn(async ({ where }: { where: { OR: [{ id: string }, { slug: string }] } }) =>
        organizations.filter((row) => row.id === where.OR[0].id || row.slug === where.OR[1].slug)
      ),
      create: create(organizations),
    },
    user: { findMany: findIdentities(users), create: create(users) },
    platformUser: { findMany: findIdentities(platformUsers), create: create(platformUsers) },
    platformModule: {
      findMany: vi.fn(async ({ where }: { where: { key: { in: string[] } } }) =>
        [...modules.values()].filter((row) => where.key.in.includes(String(row.key)))
      ),
      upsert: vi.fn(async ({ create: data }: { create: { key: string } }) => {
        if (!modules.has(data.key))
          modules.set(data.key, { id: `module_${data.key}`, active: true, ...data });
        return modules.get(data.key)!;
      }),
    },
    platformPackage: {
      findMany: vi.fn(async () => [...packages.values()]),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { key: string; defaultSeats: number };
          data: { defaultSeats: number };
        }) => {
          const row = packages.get(where.key);
          if (!row || row.defaultSeats !== where.defaultSeats) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }
      ),
      findUnique: findPackage,
      findUniqueOrThrow: vi.fn(async (args: { where: { key: string } }) => {
        const row = await findPackage(args);
        if (!row) throw new Error('Missing package in fake');
        return row;
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { key: string; defaultSeats: number };
          data: { defaultSeats: number };
        }) => {
          const row = packages.get(where.key);
          if (!row || row.defaultSeats !== where.defaultSeats) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }
      ),
      upsert: vi.fn(async ({ create: data }: { create: { key: string } }) => {
        if (!packages.has(data.key))
          packages.set(data.key, {
            id: `package_${data.key}`,
            active: true,
            defaultSeats: 1,
            ...data,
          });
        return packages.get(data.key)!;
      }),
    },
    platformPackageModule: {
      upsert: vi.fn(async ({ create: data }: { create: Record<string, unknown> }) => {
        const row = { id: `link_${links.length}`, enabled: true, limits: null, ...data };
        if (row.limits === undefined) row.limits = null;
        links.push(row);
        return row;
      }),
    },
    organizationRole: { create: create(roles) },
    organizationDepartment: {
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
        departments.push(...data);
        return { count: data.length };
      }),
    },
    organizationBrand: { create: create(brands) },
  };
  const tx = new Proxy(delegates, {
    get(target, key, receiver) {
      if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
      throw new Error(`Restaurant bootstrap accessed forbidden model: ${String(key)}`);
    },
  }) as unknown as Parameters<typeof bootstrapProduction>[0];
  const writes = [
    delegates.organization.create,
    delegates.user.create,
    delegates.platformUser.create,
    delegates.platformModule.upsert,
    delegates.platformPackage.upsert,
    delegates.platformPackage.updateMany,
    delegates.platformPackageModule.upsert,
    delegates.organizationRole.create,
    delegates.organizationDepartment.createMany,
    delegates.organizationBrand.create,
  ];
  return {
    tx,
    delegates,
    organizations,
    users,
    platformUsers,
    modules,
    packages,
    links,
    roles,
    departments,
    brands,
    writes,
  };
}

const fakeHash = () => vi.fn(async () => 'unit-only-hash');
const expectNoWrites = (fake: ReturnType<typeof restaurantTransaction>) => {
  for (const write of fake.writes) expect(write).not.toHaveBeenCalled();
};

describe('explicit Restaurant fresh bootstrap', () => {
  it('creates only the selected code-owned catalog and Restaurant foundations, with no deployment or trading models', async () => {
    const fake = restaurantTransaction();
    await bootstrapProduction(fake.tx, RESTAURANT_INPUT, fakeHash());
    const selected = RESTAURANT_PACKAGES.find((pkg) => pkg.key === RESTAURANT_INPUT.packageKey)!;
    expect(fake.organizations).toEqual([
      expect.objectContaining({
        id: RESTAURANT_INPUT.organizationId,
        slug: RESTAURANT_INPUT.organizationSlug,
        vertical: 'RESTAURANT',
        status: 'ONBOARDING',
        isDemo: false,
        packageId: 'package_restaurant-essentials',
        seatLimit: packageDefaultSeats(selected),
      }),
    ]);
    expect([...fake.packages.keys()]).toEqual(['restaurant-essentials']);
    expect([...fake.modules.keys()].sort()).toEqual(
      ['dashboard', 'admin', 'notifications', ...selected.moduleKeys].sort()
    );
    expect(fake.links.map((link) => link.moduleId).sort()).toEqual(
      selected.moduleKeys.map((key) => `module_${key}`).sort()
    );
    expect(fake.links.find((link) => link.moduleId === 'module_restaurant-core')?.limits).toEqual(
      selected.defaultLimits
    );
    expect(fake.departments.map((row) => row.key)).toEqual(
      RESTAURANT_DEPARTMENTS.map((row) => row.key)
    );
    expect(fake.roles.map((row) => row.key)).toEqual(
      RESTAURANT_ROLE_TEMPLATES.map((role) => role.key)
    );
    for (const template of RESTAURANT_ROLE_TEMPLATES) {
      expect(fake.roles.find((role) => role.key === template.key)?.permissions).toEqual({
        create: template.capabilities.map((capability) => ({
          organizationId: RESTAURANT_INPUT.organizationId,
          capability,
          effect: 'ALLOW',
        })),
      });
    }
    expect(fake.users).toEqual([
      expect.objectContaining({
        id: RESTAURANT_INPUT.adminId,
        role: 'ADMIN',
        department: 'FRONT_OF_HOUSE',
        organizationRoleId: fake.roles[0].id,
      }),
    ]);
    expect(fake.platformUsers).toEqual([
      expect.objectContaining({ id: RESTAURANT_INPUT.platformAdminId, role: 'SUPER_ADMIN' }),
    ]);
    expect(fake.brands).toHaveLength(1);
  });

  it.each(RESTAURANT_PACKAGES.map((pkg) => pkg.key))(
    'accepts only the explicitly selected package %s',
    async (packageKey) => {
      const fake = restaurantTransaction();
      await bootstrapProduction(fake.tx, { ...RESTAURANT_INPUT, packageKey }, fakeHash());
      expect([...fake.packages.keys()]).toEqual([packageKey]);
    }
  );

  it('replays without writes, hashing, account promotion, permission repair, or catalog expansion', async () => {
    const fake = restaurantTransaction();
    const hash = fakeHash();
    await bootstrapProduction(fake.tx, RESTAURANT_INPUT, hash);
    Object.assign(fake.users[0], {
      role: 'EMPLOYEE',
      status: 'INACTIVE',
      password: null,
      organizationRoleId: null,
    });
    Object.assign(fake.platformUsers[0], {
      role: 'AUDITOR',
      active: false,
      passwordHash: 'operator-changed',
    });
    fake.roles[0].permissions = { create: [] };
    fake.links.pop();
    fake.organizations[0].status = 'SUSPENDED';
    const before = JSON.stringify([
      fake.users,
      fake.platformUsers,
      fake.roles,
      fake.links,
      fake.organizations,
    ]);
    for (const write of fake.writes) write.mockClear();
    hash.mockClear();
    await bootstrapProduction(
      fake.tx,
      { ...RESTAURANT_INPUT, adminPassword: undefined, platformAdminPassword: undefined },
      hash
    );
    expectNoWrites(fake);
    expect(hash).not.toHaveBeenCalled();
    expect(
      JSON.stringify([fake.users, fake.platformUsers, fake.roles, fake.links, fake.organizations])
    ).toBe(before);
  });

  it.each([
    'organizationId',
    'organizationSlug',
    'organizationLegalName',
    'organizationDisplayName',
    'packageKey',
    'adminId',
    'adminName',
    'adminEmail',
    'adminTitle',
    'platformAdminId',
    'platformAdminName',
    'platformAdminEmail',
  ] as const)('rejects missing %s before accessing the transaction', async (key) => {
    const fake = restaurantTransaction();
    await expect(
      bootstrapProduction(fake.tx, { ...RESTAURANT_INPUT, [key]: '' }, fakeHash())
    ).rejects.toThrow();
    expectNoWrites(fake);
    expect(fake.delegates.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it.each([
    { packageKey: 'agency-suite' },
    { packageKey: 'pharmacy-essentials' },
    { organizationSlug: '../invalid' },
    { adminEmail: 'invalid' },
    { adminId: RESTAURANT_INPUT.platformAdminId },
    { adminEmail: RESTAURANT_INPUT.platformAdminEmail.toUpperCase() },
    { adminPassword: undefined },
    { platformAdminPassword: undefined },
    { adminPassword: 'short' },
    { platformAdminPassword: 'short' },
    { adminPassword: 'x'.repeat(73) },
    { platformAdminPassword: 'é'.repeat(37) },
  ])('rejects invalid identities, selection, or credentials without writes', async (changes) => {
    const fake = restaurantTransaction();
    await expect(
      bootstrapProduction(fake.tx, { ...RESTAURANT_INPUT, ...changes }, fakeHash())
    ).rejects.toThrow();
    expectNoWrites(fake);
  });

  it.each([
    'organizationId',
    'slug',
    'tenantEmail',
    'tenantId',
    'platformEmail',
    'platformId',
    'crossNamespace',
  ] as const)('rejects fresh identity collision: %s', async (kind) => {
    const fake = restaurantTransaction();
    if (kind === 'organizationId')
      fake.organizations.push({ id: RESTAURANT_INPUT.organizationId, slug: 'occupied' });
    if (kind === 'slug')
      fake.organizations.push({ id: 'other', slug: RESTAURANT_INPUT.organizationSlug });
    if (kind === 'tenantEmail')
      fake.users.push({
        id: 'other',
        email: RESTAURANT_INPUT.adminEmail.toUpperCase(),
        organizationId: 'other',
      });
    if (kind === 'tenantId')
      fake.users.push({
        id: RESTAURANT_INPUT.adminId,
        email: 'other@example.invalid',
        organizationId: 'other',
      });
    if (kind === 'platformEmail')
      fake.platformUsers.push({
        id: 'other',
        email: RESTAURANT_INPUT.platformAdminEmail.toUpperCase(),
      });
    if (kind === 'platformId')
      fake.platformUsers.push({
        id: RESTAURANT_INPUT.platformAdminId,
        email: 'other@example.invalid',
      });
    if (kind === 'crossNamespace')
      fake.platformUsers.push({ id: 'other', email: RESTAURANT_INPUT.adminEmail });
    await expect(bootstrapProduction(fake.tx, RESTAURANT_INPUT, fakeHash())).rejects.toThrow(
      'collision'
    );
    expectNoWrites(fake);
  });

  it.each([
    'missingOwner',
    'duplicateEmail',
    'wrongVertical',
    'demo',
    'packageChanged',
    'wrongOwner',
    'wrongPlatformOwner',
  ] as const)('rejects incomplete or mismatched replay: %s', async (kind) => {
    const fake = restaurantTransaction();
    await bootstrapProduction(fake.tx, RESTAURANT_INPUT, fakeHash());
    if (kind === 'missingOwner') fake.users.pop();
    if (kind === 'duplicateEmail')
      fake.users.push({
        ...fake.users[0],
        id: 'duplicate',
        email: RESTAURANT_INPUT.adminEmail.toUpperCase(),
      });
    if (kind === 'wrongVertical') fake.organizations[0].vertical = 'AGENCY';
    if (kind === 'demo') fake.organizations[0].isDemo = true;
    if (kind === 'packageChanged') fake.organizations[0].packageId = 'other';
    if (kind === 'wrongOwner') fake.users[0].id = 'other';
    if (kind === 'wrongPlatformOwner') fake.platformUsers[0].id = 'other';
    for (const write of fake.writes) write.mockClear();
    await expect(bootstrapProduction(fake.tx, RESTAURANT_INPUT, fakeHash())).rejects.toThrow(
      'collision'
    );
    expectNoWrites(fake);
  });

  it.each([
    'missingLink',
    'extraLink',
    'disabledLink',
    'limits',
    'inactiveModule',
    'wrongModuleVertical',
    'wrongModuleBand',
    'inactivePackage',
    'wrongPackageVertical',
  ] as const)('refuses catalog drift for a fresh organization: %s', async (kind) => {
    const fake = restaurantTransaction();
    await syncPlatformCatalog(fake.tx, {
      vertical: 'RESTAURANT',
      packageKey: RESTAURANT_INPUT.packageKey,
    });
    if (kind === 'missingLink') fake.links.pop();
    if (kind === 'extraLink') fake.links.push({ ...fake.links[0], id: 'extra' });
    if (kind === 'disabledLink') fake.links[0].enabled = false;
    if (kind === 'limits') fake.links[0].limits = { unauthorized: 1 };
    if (kind === 'inactiveModule') fake.modules.get('restaurant-core')!.active = false;
    if (kind === 'wrongModuleVertical') fake.modules.get('restaurant-core')!.vertical = 'AGENCY';
    if (kind === 'wrongModuleBand') fake.modules.get('restaurant-core')!.band = 'BASELINE';
    if (kind === 'inactivePackage') fake.packages.get(RESTAURANT_INPUT.packageKey)!.active = false;
    if (kind === 'wrongPackageVertical')
      fake.packages.get(RESTAURANT_INPUT.packageKey)!.vertical = 'PHARMACY';
    for (const write of fake.writes) write.mockClear();
    await expect(bootstrapProduction(fake.tx, RESTAURANT_INPUT, fakeHash())).rejects.toThrow(
      'catalog'
    );
    expectNoWrites(fake);
  });

  it('uses an intact existing package without changing its composition or operator labels', async () => {
    const fake = restaurantTransaction();
    await syncPlatformCatalog(fake.tx, {
      vertical: 'RESTAURANT',
      packageKey: RESTAURANT_INPUT.packageKey,
    });
    fake.packages.get(RESTAURANT_INPUT.packageKey)!.name = 'Operator label';
    const before = JSON.stringify(fake.links);
    fake.delegates.platformPackageModule.upsert.mockClear();
    await bootstrapProduction(fake.tx, RESTAURANT_INPUT, fakeHash());
    expect(fake.delegates.platformPackageModule.upsert).not.toHaveBeenCalled();
    expect(JSON.stringify(fake.links)).toBe(before);
    expect(fake.packages.get(RESTAURANT_INPUT.packageKey)!.name).toBe('Operator label');
  });
});

describe('bootstrap environment contract', () => {
  const env: Record<string, string> = {
    BOOTSTRAP_MODE: 'RESTAURANT',
    ORGANIZATION_ID: RESTAURANT_INPUT.organizationId,
    ORGANIZATION_SLUG: RESTAURANT_INPUT.organizationSlug,
    ORGANIZATION_LEGAL_NAME: RESTAURANT_INPUT.organizationLegalName,
    ORGANIZATION_DISPLAY_NAME: RESTAURANT_INPUT.organizationDisplayName,
    BOOTSTRAP_PACKAGE_KEY: RESTAURANT_INPUT.packageKey,
    ADMIN_ID: RESTAURANT_INPUT.adminId,
    ADMIN_NAME: RESTAURANT_INPUT.adminName,
    ADMIN_EMAIL: RESTAURANT_INPUT.adminEmail,
    ADMIN_TITLE: RESTAURANT_INPUT.adminTitle,
    PLATFORM_ADMIN_ID: RESTAURANT_INPUT.platformAdminId,
    PLATFORM_ADMIN_NAME: RESTAURANT_INPUT.platformAdminName,
    PLATFORM_ADMIN_EMAIL: RESTAURANT_INPUT.platformAdminEmail,
  };
  it('requires explicit Restaurant selection and no AUTH_URL or default identities', () => {
    expect(productionBootstrapInputFromEnvironment(env)).toEqual({
      ...RESTAURANT_INPUT,
      adminPassword: undefined,
      platformAdminPassword: undefined,
    });
  });
  it.each(Object.keys(env).filter((key) => key !== 'BOOTSTRAP_MODE'))(
    'requires supplied %s',
    (key) => {
      expect(() => productionBootstrapInputFromEnvironment({ ...env, [key]: undefined })).toThrow();
    }
  );
  it('rejects unsupported and blank modes without falling back to Agency', () => {
    for (const mode of ['PHARMACY', 'restaurant', '']) {
      expect(() =>
        productionBootstrapInputFromEnvironment({ ...env, BOOTSTRAP_MODE: mode })
      ).toThrow('BOOTSTRAP_MODE');
    }
  });
  it('preserves the legacy environment defaults and organization precedence', () => {
    const legacy = {
      ADMIN_EMAIL: INPUT.adminEmail,
      PLATFORM_ADMIN_EMAIL: INPUT.platformAdminEmail,
      AUTH_URL: INPUT.deploymentUrl,
    };
    expect(productionBootstrapInputFromEnvironment(legacy)).toEqual({
      ...INPUT,
      adminPassword: undefined,
      platformAdminPassword: undefined,
    });
    expect(
      productionBootstrapInputFromEnvironment({
        ...legacy,
        DEFAULT_ORGANIZATION_ID: 'preferred',
        ORGANIZATION_ID: 'secondary',
      }).organizationId
    ).toBe('preferred');
    expect(
      productionBootstrapInputFromEnvironment({ ...legacy, BOOTSTRAP_MODE: 'AGENCY' })
    ).toEqual(productionBootstrapInputFromEnvironment(legacy));
  });
});
