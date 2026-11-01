/**
 * §2.3 package-module inheritance, at the command boundary (mock-style, modeled
 * on commands.organization-create.test.ts).
 *
 * The correction: onboarding no longer COPIES the package's enabled modules into
 * `organization_modules`. Two facts have to hold for that to be safe, and both
 * are asserted here against a fully mocked Prisma client:
 *
 *   (a) `organization.create` writes ZERO OrganizationModule rows — the package
 *       baseline is inherited live by the resolver, not materialized;
 *   (b) activation preflight still passes for such an org: zero OrganizationModule
 *       rows plus a module-bearing package satisfies `assertActivationReady`,
 *       which counts `organization.modules` PLUS the package's `moduleLinks`.
 *
 * A DB-backed companion (package-inheritance.db.test.ts) proves the resolved
 * entitlements and the cleanup migration against real PostgreSQL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
  userCreate: vi.fn(),
  orgFindUnique: vi.fn(),
  moduleCreateMany: vi.fn(),
  moduleCreate: vi.fn(),
  moduleUpsert: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'hashed'), compare: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn() }));
vi.mock('@/lib/platform/auth', () => ({ assertPlatformCapability: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: unknown) => Promise<unknown>) => run(platformDb)),
}));

function record() {
  return vi.fn(async (args: { data?: unknown }) => ({ id: 'row_1', ...(args?.data as object) }));
}

const platformDb = {
  $queryRaw: vi.fn(async () => []),
  platformPackage: {
    findUnique: vi.fn(async () => ({
      id: 'pkg_1',
      active: true,
      name: 'Growth',
      defaultSeats: 25,
      // A module-bearing package: onboarding used to copy these into
      // organization_modules; it must not anymore.
      moduleLinks: [
        { moduleId: 'mod_a', enabled: true },
        { moduleId: 'mod_b', enabled: true },
      ],
    })),
  },
  organization: {
    create: vi.fn(async () => ({ id: 'org_new', slug: 'acme' })),
    findUnique: mocks.orgFindUnique,
    update: vi.fn(async (args: { data?: unknown }) => ({
      id: 'org_new',
      status: 'ACTIVE',
      ...(args?.data as object),
    })),
  },
  organizationRole: { create: vi.fn(async () => ({ id: 'role_admin' })) },
  organizationDepartment: { createMany: vi.fn(async () => ({ count: 6 })) },
  user: { count: vi.fn(async () => 0), findFirst: mocks.userFindFirst, create: mocks.userCreate },
  organizationModule: {
    createMany: mocks.moduleCreateMany,
    create: mocks.moduleCreate,
    upsert: mocks.moduleUpsert,
  },
  organizationBrand: { create: record() },
  organizationEmailSettings: { create: record() },
  organizationDeployment: { create: record() },
  platformJob: { create: record() },
  organizationLifecycleEvent: { create: record() },
  platformAuditLog: { create: record() },
};

import { executePlatformCommand } from './commands';
import { PlatformSecurityError } from './security';

const actor = { id: 'op_1', role: 'SUPER_ADMIN' } as never;
const request = new Request('https://admin.devfathom.com/api/platform/control', { method: 'POST' });

const createPayload = {
  slug: 'acme',
  legalName: 'Acme Inc',
  displayName: 'Acme',
  deploymentMode: 'SHARED',
  packageId: 'pkg_1',
  timezone: 'UTC',
  locale: 'en-US',
  currency: 'usd',
  seatLimit: 25,
  primaryContactName: 'Ops',
  primaryContactEmail: 'ops@acme.com',
  adminName: 'Acme Admin',
  adminEmail: 'admin@acme.com',
  adminPassword: 'a-strong-password',
};

/** An org row shaped for both the `before` lookup and `assertActivationReady`. */
function activationState(overrides: {
  modules?: unknown[];
  moduleLinks?: unknown[];
  users?: unknown[];
  deployments?: unknown[];
  packageId?: string | null;
}) {
  return {
    id: 'org_new',
    status: 'ONBOARDING',
    activatedAt: null,
    packageId: 'packageId' in overrides ? overrides.packageId : 'pkg_1',
    package: { moduleLinks: overrides.moduleLinks ?? [{ moduleId: 'mod_a' }] },
    modules: overrides.modules ?? [],
    users: overrides.users ?? [{ id: 'admin_1' }],
    deployments: overrides.deployments ?? [{ id: 'dep_1' }],
  };
}

describe('organization.create module inheritance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({ id: 'user_new' });
  });

  it('writes zero OrganizationModule rows even for a module-bearing package', async () => {
    await executePlatformCommand(actor, 'organization.create', createPayload, request);

    // The package carries two enabled modules; none of them may be copied.
    expect(platformDb.organization.create).toHaveBeenCalledTimes(1);
    expect(mocks.moduleCreateMany).not.toHaveBeenCalled();
    expect(mocks.moduleCreate).not.toHaveBeenCalled();
    expect(mocks.moduleUpsert).not.toHaveBeenCalled();
  });
});

describe('activation preflight without copied module rows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('activates an org with zero OrganizationModule rows and a module-bearing package', async () => {
    mocks.orgFindUnique.mockResolvedValue(activationState({ modules: [] }));

    await expect(
      executePlatformCommand(
        actor,
        'organization.transition',
        { id: 'org_new', status: 'ACTIVE', reason: 'Activating after onboarding checks' },
        request
      )
    ).resolves.toBeDefined();

    expect(platformDb.organization.update).toHaveBeenCalledTimes(1);
    // Preflight was satisfied by the package's moduleLinks, not by copied rows.
    expect(mocks.moduleCreateMany).not.toHaveBeenCalled();
  });

  it('still fails preflight when neither module rows nor package modules exist', async () => {
    mocks.orgFindUnique.mockResolvedValue(activationState({ modules: [], moduleLinks: [] }));

    const error = await executePlatformCommand(
      actor,
      'organization.transition',
      { id: 'org_new', status: 'ACTIVE', reason: 'Activating after onboarding checks' },
      request
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400 });
    expect((error as PlatformSecurityError).message).toContain('enabled module');
    expect(platformDb.organization.update).not.toHaveBeenCalled();
  });
});
