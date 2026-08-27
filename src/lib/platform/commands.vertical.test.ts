/**
 * M1-L2 — server enforcement of the restaurant vertical (§2.2 / §2.3 / §6 / §9),
 * at the command boundary. Mock-style, modeled on
 * commands.organization-create.test.ts and commands.package-inheritance.test.ts:
 * every guard is asserted against a fully mocked Prisma client, so the tests
 * prove the server rejects crafted requests without needing a database.
 *
 * All vertical decisions delegate to the L1 catalog (src/lib/vertical-catalog.ts);
 * these tests import from it only to build faithful fixtures, never to restate
 * the compatibility rules the command layer is being tested for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RESTAURANT_MODULES, RESTAURANT_ROLE_TEMPLATES } from '@/lib/vertical-catalog';

const mocks = vi.hoisted(() => ({
  pkgFindUnique: vi.fn(),
  pkgCreate: vi.fn(),
  pkgUpdate: vi.fn(),
  orgCreate: vi.fn(),
  orgFindUnique: vi.fn(),
  orgUpdate: vi.fn(),
  roleCreate: vi.fn(),
  userFindFirst: vi.fn(),
  userCreate: vi.fn(),
  branchCreate: vi.fn(),
  branchFindMany: vi.fn(),
  branchCount: vi.fn(),
  assignmentCreate: vi.fn(),
  moduleUpsert: vi.fn(),
  orgModuleFindMany: vi.fn(),
  orgModuleCount: vi.fn(),
  platformModuleFindUnique: vi.fn(),
  platformModuleFindMany: vi.fn(),
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
  platformPackage: {
    findUnique: mocks.pkgFindUnique,
    create: mocks.pkgCreate,
    update: mocks.pkgUpdate,
  },
  organization: {
    create: mocks.orgCreate,
    findUnique: mocks.orgFindUnique,
    update: mocks.orgUpdate,
  },
  organizationRole: { create: mocks.roleCreate },
  user: { findFirst: mocks.userFindFirst, create: mocks.userCreate },
  organizationBrand: { create: record() },
  organizationEmailSettings: { create: record() },
  organizationDeployment: { create: record() },
  platformJob: { create: record() },
  organizationLifecycleEvent: { create: record() },
  platformAuditLog: { create: record() },
  restaurantBranch: {
    create: mocks.branchCreate,
    findMany: mocks.branchFindMany,
    count: mocks.branchCount,
  },
  restaurantBranchAssignment: { create: mocks.assignmentCreate },
  organizationModule: {
    upsert: mocks.moduleUpsert,
    findMany: mocks.orgModuleFindMany,
    count: mocks.orgModuleCount,
  },
  platformModule: {
    findUnique: mocks.platformModuleFindUnique,
    findMany: mocks.platformModuleFindMany,
  },
};

import { executePlatformCommand } from './commands';
import { PlatformSecurityError } from './security';

const actor = { id: 'op_1', role: 'SUPER_ADMIN' } as never;
const request = new Request('https://admin.devfathom.com/api/platform/control', { method: 'POST' });

function createPayload(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'acme',
    legalName: 'Acme Inc',
    displayName: 'Acme',
    deploymentMode: 'SHARED',
    packageId: 'pkg_1',
    timezone: 'Europe/Berlin',
    locale: 'en-US',
    currency: 'usd',
    seatLimit: 25,
    primaryContactName: 'Ops',
    primaryContactEmail: 'ops@acme.com',
    adminName: 'Acme Admin',
    adminEmail: 'admin@acme.com',
    adminPassword: 'a-strong-password',
    ...overrides,
  };
}

function run(action: string, payload: unknown) {
  return executePlatformCommand(actor, action, payload, request);
}

function caught(promise: Promise<unknown>) {
  return promise.catch((error: unknown) => error);
}

// ---------------------------------------------------------------------------
// §2.3 — organization.create: vertical stamping + package compatibility
// ---------------------------------------------------------------------------
describe('organization.create vertical + package compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({ id: 'user_admin' });
    mocks.orgCreate.mockResolvedValue({ id: 'org_new', slug: 'acme' });
    mocks.roleCreate.mockResolvedValue({ id: 'role_x' });
    mocks.branchCreate.mockResolvedValue({ id: 'branch_1' });
    mocks.assignmentCreate.mockResolvedValue({ id: 'assign_1' });
  });

  it('stamps an AGENCY organization by default and writes no restaurant rows', async () => {
    mocks.pkgFindUnique.mockResolvedValue({
      id: 'pkg_1',
      active: true,
      vertical: 'AGENCY',
      moduleLinks: [],
    });

    await run('organization.create', createPayload());

    expect(mocks.orgCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ vertical: 'AGENCY' }) })
    );
    // AGENCY path is byte-identical: exactly the bootstrap admin role, no branch.
    expect(mocks.roleCreate).toHaveBeenCalledTimes(1);
    expect(mocks.branchCreate).not.toHaveBeenCalled();
    expect(mocks.assignmentCreate).not.toHaveBeenCalled();
  });

  it('provisions a RESTAURANT organization: default branch, admin assignment, role templates', async () => {
    mocks.pkgFindUnique.mockResolvedValue({
      id: 'pkg_r',
      active: true,
      vertical: 'RESTAURANT',
      moduleLinks: [{ moduleId: 'restaurant-core', enabled: true }],
    });

    await run('organization.create', createPayload({ vertical: 'RESTAURANT', packageId: 'pkg_r' }));

    expect(mocks.orgCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ vertical: 'RESTAURANT' }) })
    );
    // One default branch on the org timezone, conservative name.
    expect(mocks.branchCreate).toHaveBeenCalledTimes(1);
    expect(mocks.branchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: 'org_new',
          timezone: 'Europe/Berlin',
          isDefault: true,
        }),
      })
    );
    // Admin assigned to the default branch.
    expect(mocks.assignmentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ branchId: 'branch_1', userId: 'user_admin' }),
      })
    );
    // Bootstrap admin role + every restaurant role template from the catalog.
    expect(mocks.roleCreate).toHaveBeenCalledTimes(1 + RESTAURANT_ROLE_TEMPLATES.length);
    const createdRoleKeys = mocks.roleCreate.mock.calls.map(
      (call) => (call[0] as { data: { key: string } }).data.key
    );
    for (const template of RESTAURANT_ROLE_TEMPLATES) {
      expect(createdRoleKeys).toContain(template.key);
    }
  });

  it('rejects a crafted RESTAURANT create carrying an AGENCY package', async () => {
    mocks.pkgFindUnique.mockResolvedValue({
      id: 'pkg_a',
      active: true,
      vertical: 'AGENCY',
      moduleLinks: [],
    });

    const error = await caught(
      run('organization.create', createPayload({ vertical: 'RESTAURANT', packageId: 'pkg_a' }))
    );

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400 });
    expect((error as PlatformSecurityError).message).toContain('RESTAURANT');
    expect(mocks.orgCreate).not.toHaveBeenCalled();
    expect(mocks.branchCreate).not.toHaveBeenCalled();
  });

  it('rejects a crafted AGENCY create carrying a RESTAURANT package', async () => {
    mocks.pkgFindUnique.mockResolvedValue({
      id: 'pkg_r',
      active: true,
      vertical: 'RESTAURANT',
      moduleLinks: [],
    });

    const error = await caught(
      run('organization.create', createPayload({ vertical: 'AGENCY', packageId: 'pkg_r' }))
    );

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400 });
    expect(mocks.orgCreate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §2.2 / §2.3 — organization.update: immutability + package compatibility
// ---------------------------------------------------------------------------
describe('organization.update vertical immutability + package compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.orgUpdate.mockResolvedValue({ id: 'org_1' });
    mocks.branchCount.mockResolvedValue(0);
    mocks.orgModuleCount.mockResolvedValue(0);
  });

  it('allows a pre-activation vertical correction with a compatible package', async () => {
    mocks.orgFindUnique.mockResolvedValue({
      id: 'org_1',
      vertical: 'AGENCY',
      activatedAt: null,
      packageId: 'pkg_a',
      status: 'ONBOARDING',
      deploymentMode: 'SHARED',
    });
    mocks.pkgFindUnique.mockResolvedValue({ active: true, vertical: 'RESTAURANT' });

    await run('organization.update', {
      id: 'org_1',
      vertical: 'RESTAURANT',
      packageId: 'pkg_r',
    });

    expect(mocks.orgUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ vertical: 'RESTAURANT' }) })
    );
  });

  it('rejects a vertical change once the organization is activated', async () => {
    mocks.orgFindUnique.mockResolvedValue({
      id: 'org_1',
      vertical: 'AGENCY',
      activatedAt: new Date('2026-01-01T00:00:00.000Z'),
      packageId: 'pkg_a',
      status: 'ACTIVE',
      deploymentMode: 'SHARED',
    });

    const error = await caught(run('organization.update', { id: 'org_1', vertical: 'RESTAURANT' }));

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400 });
    expect((error as PlatformSecurityError).message).toContain('early onboarding');
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('allows re-passing the same vertical after activation (no-op)', async () => {
    mocks.orgFindUnique.mockResolvedValue({
      id: 'org_1',
      vertical: 'RESTAURANT',
      activatedAt: new Date('2026-01-01T00:00:00.000Z'),
      packageId: null,
      status: 'ACTIVE',
      deploymentMode: 'SHARED',
    });

    await run('organization.update', {
      id: 'org_1',
      vertical: 'RESTAURANT',
      displayName: 'Acme 2',
    });

    expect(mocks.orgUpdate).toHaveBeenCalledTimes(1);
  });

  it('rejects a crafted package change to an incompatible package', async () => {
    mocks.orgFindUnique.mockResolvedValue({
      id: 'org_1',
      vertical: 'RESTAURANT',
      activatedAt: new Date('2026-01-01T00:00:00.000Z'),
      packageId: 'pkg_r',
      status: 'ACTIVE',
      deploymentMode: 'SHARED',
    });
    mocks.pkgFindUnique.mockResolvedValue({ active: true, vertical: 'AGENCY' });

    const error = await caught(run('organization.update', { id: 'org_1', packageId: 'pkg_a' }));

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400 });
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('rejects a pre-activation vertical change that strands the existing package', async () => {
    mocks.orgFindUnique.mockResolvedValue({
      id: 'org_1',
      vertical: 'AGENCY',
      activatedAt: null,
      packageId: 'pkg_a',
      status: 'ONBOARDING',
      deploymentMode: 'SHARED',
    });
    const error = await caught(run('organization.update', { id: 'org_1', vertical: 'RESTAURANT' }));

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400 });
    expect((error as PlatformSecurityError).message).toContain('together');
    expect(mocks.pkgFindUnique).not.toHaveBeenCalled();
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('rejects correction after vertical-owned rows exist', async () => {
    mocks.orgFindUnique.mockResolvedValue({
      id: 'org_1',
      vertical: 'AGENCY',
      activatedAt: null,
      packageId: 'pkg_a',
      status: 'ONBOARDING',
      deploymentMode: 'SHARED',
    });
    mocks.branchCount.mockResolvedValue(1);

    const error = await caught(
      run('organization.update', {
        id: 'org_1',
        vertical: 'RESTAURANT',
        packageId: 'pkg_r',
      })
    );

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400 });
    expect((error as PlatformSecurityError).message).toContain('setup has started');
    expect(mocks.pkgFindUnique).not.toHaveBeenCalled();
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §6 — organization.module: enablement guard
// ---------------------------------------------------------------------------
describe('organization.module enablement guard', () => {
  const modulePayload = (moduleId: string) => ({
    organizationId: 'org_1',
    moduleId,
    status: 'ENABLED',
    reason: 'operator enablement',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.moduleUpsert.mockResolvedValue({ id: 'orgmod_1' });
  });

  it('allows a restaurant module on a restaurant organization', async () => {
    mocks.orgFindUnique.mockResolvedValue({ vertical: 'RESTAURANT' });
    mocks.platformModuleFindUnique.mockResolvedValue({ key: 'restaurant-pos' });

    await run('organization.module', modulePayload('mod_pos'));

    expect(mocks.moduleUpsert).toHaveBeenCalledTimes(1);
  });

  it('rejects a restaurant module on an agency organization', async () => {
    mocks.orgFindUnique.mockResolvedValue({ vertical: 'AGENCY' });
    mocks.platformModuleFindUnique.mockResolvedValue({ key: 'restaurant-pos' });

    const error = await caught(run('organization.module', modulePayload('mod_pos')));

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400 });
    expect(mocks.moduleUpsert).not.toHaveBeenCalled();
  });

  it('rejects an agency module on a restaurant organization', async () => {
    mocks.orgFindUnique.mockResolvedValue({ vertical: 'RESTAURANT' });
    mocks.platformModuleFindUnique.mockResolvedValue({ key: 'dashboard' });

    const error = await caught(run('organization.module', modulePayload('mod_dash')));

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400 });
    expect(mocks.moduleUpsert).not.toHaveBeenCalled();
  });

  it('rejects an unknown module id', async () => {
    mocks.orgFindUnique.mockResolvedValue({ vertical: 'RESTAURANT' });
    mocks.platformModuleFindUnique.mockResolvedValue(null);

    const error = await caught(run('organization.module', modulePayload('mod_missing')));

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(mocks.moduleUpsert).not.toHaveBeenCalled();
  });

  it.each([
    ['DISABLED', 'ONBOARDING'],
    ['EXPIRED', 'ACTIVE'],
  ] as const)(
    'rejects %s for mandatory Restaurant Core while %s',
    async (status, organizationStatus) => {
      mocks.orgFindUnique.mockResolvedValue({
        vertical: 'RESTAURANT',
        status: organizationStatus,
      });
      mocks.platformModuleFindUnique.mockResolvedValue({ key: 'restaurant-core' });

      const error = await caught(
        run('organization.module', { ...modulePayload('mod_core'), status })
      );

      expect(error).toBeInstanceOf(PlatformSecurityError);
      expect(error).toMatchObject({ status: 400 });
      expect((error as PlatformSecurityError).message).toContain('mandatory');
      expect(mocks.moduleUpsert).not.toHaveBeenCalled();
    }
  );
});

// ---------------------------------------------------------------------------
// §2.3 — catalog.package.upsert: vertical metadata
// ---------------------------------------------------------------------------
describe('catalog.package.upsert vertical metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pkgCreate.mockResolvedValue({ id: 'pkg_new' });
    mocks.pkgUpdate.mockResolvedValue({ id: 'pkg_1' });
  });

  it('stamps the vertical when creating a package', async () => {
    await run('catalog.package.upsert', {
      key: 'restaurant-essentials',
      name: 'Restaurant Essentials',
      vertical: 'RESTAURANT',
      defaultSeats: 10,
    });

    expect(mocks.pkgCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ vertical: 'RESTAURANT' }) })
    );
  });

  it('leaves the vertical untouched on update when omitted', async () => {
    await run('catalog.package.upsert', {
      id: 'pkg_1',
      key: 'restaurant-essentials',
      name: 'Restaurant Essentials',
      defaultSeats: 10,
    });

    const updateArg = mocks.pkgUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(updateArg.data).not.toHaveProperty('vertical');
    expect(updateArg.data).toHaveProperty('version');
  });
});

// ---------------------------------------------------------------------------
// §9 Step 7 — activation preflight matrix (via organization.transition → ACTIVE)
// ---------------------------------------------------------------------------
describe('restaurant activation preflight', () => {
  const restaurantModuleRows = RESTAURANT_MODULES.map((module) => ({
    id: module.key,
    key: module.key,
  }));

  /** A restaurant org shaped for the transition `before` lookup AND the
   * preflight `include`. `moduleLinks` moduleIds equal the module keys. */
  function activationState(
    overrides: {
      packageVertical?: string;
      moduleLinks?: Array<{ moduleId: string }>;
      users?: unknown[];
      deployments?: unknown[];
    } = {}
  ) {
    return {
      id: 'org_r',
      vertical: 'RESTAURANT',
      status: 'ONBOARDING',
      activatedAt: null,
      packageId: 'pkg_r',
      package: {
        vertical: overrides.packageVertical ?? 'RESTAURANT',
        moduleLinks: overrides.moduleLinks ?? [
          { moduleId: 'restaurant-core' },
          { moduleId: 'restaurant-pos' },
        ],
      },
      modules: [],
      users: overrides.users ?? [{ id: 'admin_1' }],
      deployments: overrides.deployments ?? [{ id: 'dep_1' }],
    };
  }

  const transition = () =>
    run('organization.transition', {
      id: 'org_r',
      status: 'ACTIVE',
      reason: 'Activating after onboarding checks',
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.orgUpdate.mockResolvedValue({ id: 'org_r', status: 'ACTIVE' });
    mocks.platformModuleFindMany.mockResolvedValue(restaurantModuleRows);
    mocks.orgModuleFindMany.mockResolvedValue([]);
    mocks.branchFindMany.mockResolvedValue([{ id: 'branch_1' }]);
  });

  it('activates a fully-provisioned restaurant organization', async () => {
    mocks.orgFindUnique.mockResolvedValue(activationState());

    await expect(transition()).resolves.toBeDefined();
    expect(mocks.orgUpdate).toHaveBeenCalledTimes(1);
  });

  it('fails when Restaurant Core is not enabled', async () => {
    mocks.orgFindUnique.mockResolvedValue(
      activationState({ moduleLinks: [{ moduleId: 'restaurant-pos' }] })
    );

    const error = await caught(transition());
    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect((error as PlatformSecurityError).message).toContain('Restaurant Core');
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('fails when only Restaurant Core is enabled (no additional operational module)', async () => {
    mocks.orgFindUnique.mockResolvedValue(
      activationState({ moduleLinks: [{ moduleId: 'restaurant-core' }] })
    );

    const error = await caught(transition());
    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect((error as PlatformSecurityError).message).toContain('additional');
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('honors an override that disables Restaurant Core', async () => {
    mocks.orgFindUnique.mockResolvedValue(activationState());
    mocks.orgModuleFindMany.mockResolvedValue([
      { moduleId: 'restaurant-core', status: 'DISABLED' },
    ]);

    const error = await caught(transition());
    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect((error as PlatformSecurityError).message).toContain('Restaurant Core');
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('fails without an active default branch', async () => {
    mocks.orgFindUnique.mockResolvedValue(activationState());
    mocks.branchFindMany.mockResolvedValue([]);

    const error = await caught(transition());
    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect((error as PlatformSecurityError).message).toContain('default restaurant branch');
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('fails when the assigned package is not restaurant-compatible', async () => {
    mocks.orgFindUnique.mockResolvedValue(activationState({ packageVertical: 'AGENCY' }));

    const error = await caught(transition());
    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect((error as PlatformSecurityError).message).toContain('restaurant-compatible');
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §9 Step 7 — AGENCY preflight is unchanged: it never runs restaurant checks
// ---------------------------------------------------------------------------
describe('agency activation preflight unchanged', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.orgUpdate.mockResolvedValue({ id: 'org_a', status: 'ACTIVE' });
  });

  it('activates an agency org with no branch and no restaurant modules', async () => {
    mocks.orgFindUnique.mockResolvedValue({
      id: 'org_a',
      vertical: 'AGENCY',
      status: 'ONBOARDING',
      activatedAt: null,
      packageId: 'pkg_a',
      package: { vertical: 'AGENCY', moduleLinks: [{ moduleId: 'mod_dashboard' }] },
      modules: [],
      users: [{ id: 'admin_1' }],
      deployments: [{ id: 'dep_1' }],
    });

    await expect(
      run('organization.transition', {
        id: 'org_a',
        status: 'ACTIVE',
        reason: 'Activating after onboarding checks',
      })
    ).resolves.toBeDefined();

    expect(mocks.orgUpdate).toHaveBeenCalledTimes(1);
    // No restaurant-only preflight queries were made for an agency org.
    expect(mocks.branchFindMany).not.toHaveBeenCalled();
    expect(mocks.platformModuleFindMany).not.toHaveBeenCalled();
  });
});
