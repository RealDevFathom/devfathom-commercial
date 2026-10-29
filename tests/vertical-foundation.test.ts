/**
 * M1-L5 acceptance battery — Contract items 2–7 (vertical foundation).
 *
 * Written FROM THE CONTRACT (§9, §15, §16 Phase-1 anti-pattern guard,
 * contract items 1–7), independently of the M1-L2 implementation.
 *
 * Contract items covered here:
 *   2. RESTAURANT create → one default branch (isDefault) + admin assignment +
 *      role templates from the vertical catalog.
 *   3. Crafted mismatched package rejected on create AND on update.
 *   4. Module enablement outside the vertical rejected.
 *   5. `vertical` immutable once active.
 *   6. Restaurant activation preflight matrix — each missing condition
 *      (compatible package / restaurant-core / ≥1 operational module / default
 *      branch) individually fails closed.
 *   7. Scattered-conditional audit: `OrganizationVertical` / `RESTAURANT`
 *      references in `src/` outside the approved consumer set are ZERO
 *      (§2.3 / Phase-1 anti-pattern guard).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RESTAURANT_MODULES, RESTAURANT_ROLE_TEMPLATES } from '@/lib/vertical-catalog';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  pkgFindUnique: vi.fn(),
  orgCreate: vi.fn(),
  orgFindUnique: vi.fn(),
  orgUpdate: vi.fn(),
  roleCreate: vi.fn(),
  departmentCreateMany: vi.fn(),
  userFindFirst: vi.fn(),
  userCreate: vi.fn(),
  branchCreate: vi.fn(),
  // Defaulted because WHA-1181 provisioning enumerates a restaurant's branches
  // to seed their kitchen stations; the §9 preflight fixtures still set their
  // own answer explicitly.
  branchFindMany: vi.fn(async (): Promise<Record<string, unknown>[]> => [{ id: 'branch_1' }]),
  branchCount: vi.fn(),
  assignmentCreate: vi.fn(),
  moduleUpsert: vi.fn(),
  orgModuleFindMany: vi.fn(),
  orgModuleCount: vi.fn(),
  platformModuleFindMany: vi.fn(),
  platformModuleFindUnique: vi.fn(),
  acknowledgementFindMany: vi.fn(),
  // WHA-1181 — restaurant onboarding and activation now also link each
  // organization administrator to a staff profile. Default implementations
  // (which survive `vi.clearAllMocks`) keep every contract fixture below about
  // the behaviour it was written for.
  staffFindFirst: vi.fn(async () => null),
  staffCreate: vi.fn(async () => ({ id: 'staff_1', primaryBranchId: 'branch_1' })),
  staffFindUnique: vi.fn(async () => ({ id: 'staff_1' })),
  branchFindFirst: vi.fn(async () => ({ id: 'branch_1' })),
  branchFindUnique: vi.fn(async () => ({ id: 'branch_1' })),
  jobRoleFindMany: vi.fn(async () => [] as { key: string }[]),
  jobRoleFindFirst: vi.fn(async () => ({ id: 'jobrole_owner', active: true })),
  jobRoleFindUnique: vi.fn(async () => ({ id: 'jobrole_owner', key: 'owner', active: true })),
  jobRoleCreate: vi.fn(async ({ data }: { data: { key: string } }) => ({
    id: `jobrole_${data.key}`,
    key: data.key,
    capabilities: [],
  })),
  staffJobRoleFindUnique: vi.fn(async () => null),
  staffJobRoleCreate: vi.fn(async () => ({ id: 'holding_1' })),
  stationFindFirst: vi.fn(async () => null),
  stationCreate: vi.fn(async ({ data }: { data: { name: string; branchId: string } }) => ({
    id: 'station_1',
    name: data.name,
    branchId: data.branchId,
  })),
  userFindMany: vi.fn(async () => [
    { id: 'user_admin', name: 'Restaurant Admin', email: 'admin@burger.co' },
  ]),
}));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'hashed'), compare: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn() }));
vi.mock('@/lib/platform/auth', () => ({ assertPlatformCapability: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: unknown) => Promise<unknown>) => run(platformDb)),
  withOrganizationDefaults: vi.fn(
    async (tx: unknown, _organizationId: string, run: (db: unknown) => Promise<unknown>) => run(tx)
  ),
}));

function record() {
  return vi.fn(async (args: { data?: unknown }) => ({ id: 'row_1', ...(args?.data as object) }));
}

const platformDb = {
  // Failed-command auditing verifies an attacker-supplied organizationId before
  // retaining it. These contract fixtures use synthetic ids, so no FK is kept.
  $queryRawUnsafe: vi.fn(async () => []),
  platformPackage: { findUnique: mocks.pkgFindUnique },
  organization: {
    create: mocks.orgCreate,
    findUnique: mocks.orgFindUnique,
    update: mocks.orgUpdate,
  },
  organizationRole: { create: mocks.roleCreate },
  // WHA-278: bootstrapOrganization seeds the tenant department catalog
  // before the administrator, because User.department is a composite FK.
  organizationDepartment: { createMany: mocks.departmentCreateMany },
  user: {
    findFirst: mocks.userFindFirst,
    create: mocks.userCreate,
    findMany: mocks.userFindMany,
  },
  organizationBrand: { create: record() },
  organizationEmailSettings: { create: record() },
  organizationDeployment: { create: record() },
  platformJob: { create: record() },
  organizationLifecycleEvent: { create: record() },
  platformAuditLog: { create: record() },
  restaurantBranch: {
    create: mocks.branchCreate,
    findMany: mocks.branchFindMany,
    findFirst: mocks.branchFindFirst,
    findUnique: mocks.branchFindUnique,
    count: mocks.branchCount,
  },
  restaurantBranchAssignment: { create: mocks.assignmentCreate },
  restaurantStaffProfile: {
    findFirst: mocks.staffFindFirst,
    create: mocks.staffCreate,
    findUnique: mocks.staffFindUnique,
  },
  // WHA-1181 — restaurant provisioning also seeds the floor role profiles,
  // grants the administrator the owner role, and gives each branch its default
  // kitchen station. These defaults keep the §9 fixtures below about the
  // onboarding/activation behaviour they were written for.
  restaurantJobRole: {
    findMany: mocks.jobRoleFindMany,
    findFirst: mocks.jobRoleFindFirst,
    findUnique: mocks.jobRoleFindUnique,
    create: mocks.jobRoleCreate,
  },
  restaurantStaffJobRole: {
    findUnique: mocks.staffJobRoleFindUnique,
    create: mocks.staffJobRoleCreate,
  },
  restaurantStaffJobRoleAudit: { create: record() },
  restaurantKitchenStation: {
    findFirst: mocks.stationFindFirst,
    create: mocks.stationCreate,
  },
  organizationModule: {
    upsert: mocks.moduleUpsert,
    findMany: mocks.orgModuleFindMany,
    count: mocks.orgModuleCount,
  },
  platformModule: {
    findUnique: mocks.platformModuleFindUnique,
    findMany: mocks.platformModuleFindMany,
  },
  restaurantActivationAcknowledgement: { findMany: mocks.acknowledgementFindMany },
};

import { executePlatformCommand } from '@/lib/platform/commands';
import { PlatformSecurityError } from '@/lib/platform/security';

const actor = { id: 'op_1', role: 'SUPER_ADMIN' } as never;
const request = new Request('https://admin.devfathom.com/api/platform/control', { method: 'POST' });

function run(action: string, payload: unknown) {
  return executePlatformCommand(actor, action, payload, request);
}

function caught(p: Promise<unknown>) {
  return p.catch((e: unknown) => e);
}

function restaurantPayload(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'burger-co',
    legalName: 'Burger Co Ltd',
    displayName: 'Burger Co',
    deploymentMode: 'SHARED',
    packageId: 'pkg_r',
    timezone: 'Asia/Dubai',
    locale: 'en-AE',
    currency: 'aed',
    seatLimit: 50,
    primaryContactName: 'Ops',
    primaryContactEmail: 'ops@burger.co',
    adminName: 'Restaurant Admin',
    adminEmail: 'admin@burger.co',
    adminPassword: 'a-strong-password',
    vertical: 'RESTAURANT',
    firstBranchName: 'Downtown',
    firstBranchAddress: '1 Market Street',
    businessDayCutoff: '04:00',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Contract item 2 — RESTAURANT create: default branch + assignment + templates
// ---------------------------------------------------------------------------
describe('§9 contract item 2 — RESTAURANT organization.create: branch + assignment + templates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({ id: 'user_admin' });
    mocks.orgCreate.mockResolvedValue({ id: 'org_r', slug: 'burger-co' });
    mocks.roleCreate.mockResolvedValue({ id: 'role_x' });
    mocks.branchCreate.mockResolvedValue({ id: 'branch_1' });
    mocks.assignmentCreate.mockResolvedValue({ id: 'assign_1' });
    mocks.pkgFindUnique.mockResolvedValue({
      defaultSeats: 50,
      id: 'pkg_r',
      active: true,
      defaultSeats: 50,
      vertical: 'RESTAURANT',
      moduleLinks: [{ moduleId: 'restaurant-core' }],
    });
  });

  it('creates exactly one default branch for the restaurant org', async () => {
    await run('organization.create', restaurantPayload());

    expect(mocks.branchCreate).toHaveBeenCalledTimes(1);
    expect(mocks.branchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isDefault: true }),
      })
    );
  });

  it('sets the branch timezone from the organization timezone', async () => {
    await run('organization.create', restaurantPayload());

    expect(mocks.branchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ timezone: 'Asia/Dubai' }),
      })
    );
  });

  it('assigns the admin user to the default branch', async () => {
    await run('organization.create', restaurantPayload());

    expect(mocks.assignmentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          branchId: 'branch_1',
          userId: 'user_admin',
        }),
      })
    );
  });

  it('creates the bootstrap admin role plus every restaurant role template', async () => {
    await run('organization.create', restaurantPayload());

    const expectedCount = 1 + RESTAURANT_ROLE_TEMPLATES.length;
    expect(mocks.roleCreate).toHaveBeenCalledTimes(expectedCount);

    const createdKeys = mocks.roleCreate.mock.calls.map(
      (call) => (call[0] as { data: { key: string } }).data.key
    );
    for (const template of RESTAURANT_ROLE_TEMPLATES) {
      expect(createdKeys).toContain(template.key);
    }
  });
});

// ---------------------------------------------------------------------------
// Contract item 3 — Mismatched package rejected on create AND on update
// ---------------------------------------------------------------------------
describe('§2.3 contract item 3 — mismatched package rejected', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({ id: 'user_admin' });
    mocks.orgCreate.mockResolvedValue({ id: 'org_r', slug: 'burger-co' });
  });

  it('rejects RESTAURANT create with an AGENCY package', async () => {
    mocks.pkgFindUnique.mockResolvedValue({
      defaultSeats: 50,
      id: 'pkg_a',
      active: true,
      defaultSeats: 25,
      vertical: 'AGENCY',
      moduleLinks: [],
    });

    const error = await caught(
      run('organization.create', restaurantPayload({ packageId: 'pkg_a' }))
    );

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400 });
    expect(mocks.orgCreate).not.toHaveBeenCalled();
  });

  it('rejects AGENCY create with a RESTAURANT package', async () => {
    mocks.pkgFindUnique.mockResolvedValue({
      defaultSeats: 50,
      id: 'pkg_r',
      active: true,
      defaultSeats: 25,
      vertical: 'RESTAURANT',
      moduleLinks: [],
    });

    const agencyPayload = {
      slug: 'acme',
      legalName: 'Acme Ltd',
      displayName: 'Acme',
      deploymentMode: 'SHARED',
      packageId: 'pkg_r',
      timezone: 'UTC',
      locale: 'en-US',
      currency: 'usd',
      seatLimit: 10,
      primaryContactName: 'Admin',
      primaryContactEmail: 'admin@acme.com',
      adminName: 'Admin',
      adminEmail: 'admin@acme.com',
      adminPassword: 'a-strong-password',
    };

    const error = await caught(run('organization.create', agencyPayload));

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400 });
    expect(mocks.orgCreate).not.toHaveBeenCalled();
  });

  it('rejects an update that assigns an incompatible package to an active restaurant org', async () => {
    mocks.orgFindUnique.mockResolvedValue({
      id: 'org_r',
      vertical: 'RESTAURANT',
      activatedAt: new Date('2026-01-01'),
      packageId: 'pkg_r',
      status: 'ACTIVE',
      deploymentMode: 'SHARED',
    });
    mocks.pkgFindUnique.mockResolvedValue({ vertical: 'AGENCY' });

    const error = await caught(run('organization.update', { id: 'org_r', packageId: 'pkg_a' }));

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400 });
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('rejects a pre-activation update that would strand a restaurant org on an agency package', async () => {
    mocks.orgFindUnique.mockResolvedValue({
      id: 'org_r',
      vertical: 'RESTAURANT',
      activatedAt: null,
      packageId: 'pkg_r',
      status: 'ONBOARDING',
      deploymentMode: 'SHARED',
    });
    mocks.pkgFindUnique.mockResolvedValue({ vertical: 'AGENCY' });

    const error = await caught(run('organization.update', { id: 'org_r', packageId: 'pkg_a' }));

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400 });
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Contract item 4 — Module enablement outside the vertical is rejected
// ---------------------------------------------------------------------------
describe('§6 contract item 4 — module enablement outside the vertical rejected', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.moduleUpsert.mockResolvedValue({ id: 'orgmod_1' });
  });

  it('rejects enabling a restaurant module on an agency organization', async () => {
    mocks.orgFindUnique.mockResolvedValue({ vertical: 'AGENCY' });
    mocks.platformModuleFindUnique.mockResolvedValue({ key: 'restaurant-pos' });

    const error = await caught(
      run('organization.module', {
        organizationId: 'org_a',
        moduleId: 'mod_pos',
        status: 'ENABLED',
        reason: 'operator',
      })
    );

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400 });
    expect(mocks.moduleUpsert).not.toHaveBeenCalled();
  });

  // module-catalog architecture decision: only VERTICAL_* modules belong to a
  // vertical. `dashboard` is BASELINE (always on everywhere), so it is not an
  // agency module and enabling it is not a cross-vertical violation — the
  // agency-owned VERTICAL_OPTIONAL keys are projects/clients/finance.
  it.each(['projects', 'clients', 'finance'])(
    'rejects enabling the agency VERTICAL_OPTIONAL module %s on a restaurant organization',
    async (key) => {
      mocks.orgFindUnique.mockResolvedValue({ vertical: 'RESTAURANT' });
      mocks.platformModuleFindUnique.mockResolvedValue({ key });

      const error = await caught(
        run('organization.module', {
          organizationId: 'org_r',
          moduleId: `mod_${key}`,
          status: 'ENABLED',
          reason: 'operator',
        })
      );

      expect(error).toBeInstanceOf(PlatformSecurityError);
      expect(error).toMatchObject({ status: 400 });
      expect(mocks.moduleUpsert).not.toHaveBeenCalled();
    }
  );

  // The other half of the decision: PLATFORM modules are sellable into any
  // vertical's package, so enablement itself is vertical-agnostic for them.
  // Whether the organization actually HOLDS one stays a package/contract/override
  // question, resolved by `resolveOrganizationEntitlements`, not by this guard.
  it.each([
    ['notes', 'RESTAURANT'],
    ['notes', 'AGENCY'],
    ['chat', 'RESTAURANT'],
    ['chat', 'AGENCY'],
  ])('allows the PLATFORM module %s on a %s organization', async (key, vertical) => {
    mocks.orgFindUnique.mockResolvedValue({ vertical });
    mocks.platformModuleFindUnique.mockResolvedValue({ key });

    await run('organization.module', {
      organizationId: 'org_x',
      moduleId: `mod_${key}`,
      status: 'ENABLED',
      reason: 'operator',
    });

    expect(mocks.moduleUpsert).toHaveBeenCalledTimes(1);
  });

  it('allows enabling a restaurant module on a restaurant organization', async () => {
    mocks.orgFindUnique.mockResolvedValue({ vertical: 'RESTAURANT' });
    mocks.platformModuleFindUnique.mockResolvedValue({ key: 'restaurant-menu' });

    await run('organization.module', {
      organizationId: 'org_r',
      moduleId: 'mod_menu',
      status: 'ENABLED',
      reason: 'operator',
    });

    expect(mocks.moduleUpsert).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Contract item 5 — `vertical` is immutable once active
// ---------------------------------------------------------------------------
describe('§2.2 contract item 5 — vertical immutable once active', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects changing the vertical after activation', async () => {
    mocks.orgFindUnique.mockResolvedValue({
      id: 'org_r',
      vertical: 'RESTAURANT',
      activatedAt: new Date('2026-03-01'),
      packageId: 'pkg_r',
      status: 'ACTIVE',
      deploymentMode: 'SHARED',
    });

    const error = await caught(
      run('organization.update', {
        id: 'org_r',
        vertical: 'AGENCY',
        reason: 'Correct onboarding classification',
      })
    );

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400 });
    expect((error as PlatformSecurityError).message).toContain('early onboarding');
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('allows passing the same vertical after activation (idempotent, no-op)', async () => {
    mocks.orgFindUnique.mockResolvedValue({
      id: 'org_r',
      vertical: 'RESTAURANT',
      activatedAt: new Date('2026-03-01'),
      packageId: null,
      status: 'ACTIVE',
      deploymentMode: 'SHARED',
    });
    mocks.orgUpdate.mockResolvedValue({ id: 'org_r' });

    await run('organization.update', {
      id: 'org_r',
      vertical: 'RESTAURANT',
      displayName: 'Updated',
    });

    expect(mocks.orgUpdate).toHaveBeenCalledTimes(1);
  });

  it('allows correcting the vertical BEFORE activation', async () => {
    mocks.branchCount.mockResolvedValue(0);
    mocks.orgModuleCount.mockResolvedValue(0);
    mocks.orgFindUnique.mockResolvedValue({
      id: 'org_x',
      vertical: 'AGENCY',
      activatedAt: null,
      packageId: null,
      status: 'ONBOARDING',
      deploymentMode: 'SHARED',
    });
    mocks.orgUpdate.mockResolvedValue({ id: 'org_x' });
    mocks.pkgFindUnique.mockResolvedValue({ active: true, vertical: 'RESTAURANT' });

    await run('organization.update', {
      id: 'org_x',
      vertical: 'RESTAURANT',
      packageId: 'pkg_r',
      reason: 'Correct onboarding classification',
    });

    expect(mocks.orgUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ vertical: 'RESTAURANT' }) })
    );
  });
});

// ---------------------------------------------------------------------------
// Contract item 6 — Restaurant activation preflight matrix (each condition
// individually fails closed)
// ---------------------------------------------------------------------------
describe('§9 contract item 6 — restaurant activation preflight matrix', () => {
  const restaurantModuleRows = RESTAURANT_MODULES.map((m) => ({ id: m.key, key: m.key }));

  function fullyProvisionedState(
    overrides: {
      packageVertical?: string;
      moduleLinks?: Array<{ moduleId: string }>;
      users?: unknown[];
      deployments?: unknown[];
      orgModuleOverrides?: Array<{ moduleId: string; status: string }>;
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

  function activate() {
    return run('organization.transition', {
      id: 'org_r',
      status: 'ACTIVE',
      reason: 'Activating restaurant after onboarding',
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.orgUpdate.mockResolvedValue({ id: 'org_r', status: 'ACTIVE' });
    mocks.platformModuleFindMany.mockResolvedValue(restaurantModuleRows);
    mocks.orgModuleFindMany.mockResolvedValue([]);
    mocks.branchFindMany.mockResolvedValue([
      {
        id: 'branch_1',
        name: 'Downtown',
        address: '1 Market Street',
        timezone: 'Asia/Dubai',
        businessDayCutoff: '04:00',
      },
    ]);
    mocks.acknowledgementFindMany.mockResolvedValue(
      ['TAX', 'PAYMENT', 'DEVICE', 'OPERATOR'].map((kind) => ({
        kind,
        policyReference: `${kind}-v1`,
      }))
    );
  });

  it('activates when all conditions are met', async () => {
    mocks.orgFindUnique.mockResolvedValue(fullyProvisionedState());

    await expect(activate()).resolves.toBeDefined();
    expect(mocks.orgUpdate).toHaveBeenCalledTimes(1);
  });

  it('fails when the package is not restaurant-compatible (condition: compatible package)', async () => {
    mocks.orgFindUnique.mockResolvedValue(fullyProvisionedState({ packageVertical: 'AGENCY' }));

    const error = await caught(activate());
    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect((error as PlatformSecurityError).message).toContain('restaurant-compatible');
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('fails when Restaurant Core is absent from the package (condition: restaurant-core)', async () => {
    mocks.orgFindUnique.mockResolvedValue(
      fullyProvisionedState({ moduleLinks: [{ moduleId: 'restaurant-pos' }] })
    );

    const error = await caught(activate());
    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect((error as PlatformSecurityError).message).toContain('Restaurant Core');
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('fails when only Restaurant Core is present (condition: ≥1 operational module)', async () => {
    mocks.orgFindUnique.mockResolvedValue(
      fullyProvisionedState({ moduleLinks: [{ moduleId: 'restaurant-core' }] })
    );

    const error = await caught(activate());
    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect((error as PlatformSecurityError).message).toContain('additional');
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('fails when an org-level override disables Restaurant Core (condition: restaurant-core active)', async () => {
    mocks.orgFindUnique.mockResolvedValue(fullyProvisionedState());
    mocks.orgModuleFindMany.mockResolvedValue([
      { moduleId: 'restaurant-core', status: 'DISABLED' },
    ]);

    const error = await caught(activate());
    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect((error as PlatformSecurityError).message).toContain('Restaurant Core');
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('fails when there is no active default branch (condition: default branch)', async () => {
    mocks.orgFindUnique.mockResolvedValue(fullyProvisionedState());
    mocks.branchFindMany.mockResolvedValue([]);

    const error = await caught(activate());
    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect((error as PlatformSecurityError).message).toContain('default restaurant branch');
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Contract item 7 — Scattered-conditional audit (§2.3 / Phase-1 guard)
//
// Every reference to `OrganizationVertical` or the literal `RESTAURANT` in
// src/ must reside in an approved consumer. Files outside the approved set
// signal a scattered-conditional anti-pattern that violates §2.3.
//
// Approved consumers:
//   src/lib/vertical-catalog.ts (and its test)
//   src/lib/platform/commands.ts (and its vertical test)
//   src/lib/entitlements.ts
//   src/lib/module-catalog.ts (and its test)
//   src/components/layout/sidebar* (and its test)
//   src/app/platform/(console)/organizations/** (and tests)
//   src/app/platform/(console)/catalog/** (and tests)
//   src/generated/** (Prisma-generated client — read-only)
// ---------------------------------------------------------------------------
describe('§16 / §2.3 contract item 7 — Phase-1 scattered-conditional audit', () => {
  const APPROVED_EXACT_FILES = new Set([
    // b01f8aec: prior catalogs stay intact in additive Hotel integration fixtures.
    'src/lib/hotel/foundation.test.ts',
    // 5c7be21b: Hotel maintenance denies the wrong vertical.
    'src/lib/platform/hotel-property-maintenance.test.ts',
    // 7d8e4cfd: navigation fixtures prove cross-vertical isolation.
    'src/components/layout/hotel-navigation.test.tsx',
    // d299: Restaurant growth availability fixture.
    'src/lib/ai/provider.test.ts',
    // d299: canonical demo identity moved to this tenancy boundary.
    'src/lib/tenancy/demo-identity.ts',
    // d299: shared demo deployment boundary moved to activation gates.
    'src/lib/platform/activation-gates.ts',
    // 9b9f522e: entitlement-gated vertical descriptions and suggestions.
    'src/components/assistant/assistant-suggestions.ts',
    // 9b9f522e: description, isolation and entitlement proof for those suggestions.
    'src/components/assistant/assistant-panel.test.tsx',
    // 675a939b: platform-wide health filter and its matching console selector.
    'src/server/routers/platform-health.ts',
    'src/app/platform/(console)/health/page.tsx',
    // Accepted L1 F5 8537f1d6 (from e623f49d): RESTAURANT is a negative khata
    // fixture; centralized khataScope rejects it FORBIDDEN before tender writes.
    'src/server/routers/pharmacy-sales.khata.test.ts',
    // Accepted catering/growth boundaries and their vertical-isolation fixtures.
    // Exact consumers only; no directory-wide exemption.
    'src/lib/ai/growth-recommendations.test.ts',
    'src/lib/ai/growth-recommendations.ts',
    'src/lib/restaurant/catering-endpoints.db.test.ts',
    'src/lib/restaurant/catering-money.ts',
    'src/lib/restaurant/growth-binding.ts',
    'src/lib/restaurant/growth-concurrency.db.test.ts',
    'src/lib/restaurant/growth-evidence.test.ts',
    'src/lib/restaurant/growth-evidence.ts',
    'src/lib/restaurant/growth-generation.test.ts',
    'src/lib/restaurant/growth-generation.ts',
    'src/lib/restaurant/growth-review.db.test.ts',
    'src/lib/restaurant/growth-review.test.ts',
    'src/lib/restaurant/growth-review.ts',
    'src/lib/restaurant/growth-sandbox.test.ts',
    'src/lib/restaurant/growth-source.ts',
    'src/server/routers/restaurant-growth.test.ts',
    'src/server/routers/restaurant-growth.ts',
    // Accepted platform overview groups cross-tenant counts by vertical under
    // requirePlatformRead/withPlatformDb, matching the console consumer contract.
    // Exact files only: this does not admit other platform routes.
    'src/app/platform/(console)/page.tsx',
    'src/app/platform/(console)/page.test.tsx',
    // Existing demo identity fixtures prove the Restaurant-only access boundary.
    'src/lib/auth.demo.test.ts',
    // Shared-host rate-limit fixtures exercise Restaurant tenant login boundaries.
    'src/lib/auth.rate-limit.test.ts',
    // Hotel tax rejects Restaurant product-class fixtures rather than taxing them as rooms.
    'src/lib/hotel/tax.test.ts',
    'src/lib/restaurant/terminal-auth.test.ts',
    'src/lib/tenancy/tenant-actor.test.ts',
    // Shared receipt designer selects the persisted layout contract by vertical.
    'src/components/receipts/receipt-designer.tsx',
    // Server-derived AI scope and report tools enforce the tenant vertical;
    // their focused tests prove tool exposure and execution restrictions.
    'src/lib/ai/context.ts',
    'src/lib/ai/tools.ts',
    'src/lib/ai/tools-routing.test.ts',
    'src/lib/ai/tools/restaurant-reports.ts',
    'src/lib/ai/tools/restaurant-reports.test.ts',
    'src/app/api/assistant/route.test.ts',
    // The bell selects vertical-specific routers; their hooks remain isolated
    // in separate child components.
    'src/components/layout/topbar.notifications.test.tsx',
    'src/components/layout/topbar.tsx',
    // Pakistan tax owns the authoritative RESTAURANT jurisdiction profiles and
    // the focused fixtures/batteries that provision those schema records.
    'src/components/restaurant/restaurant-tax-console.test.tsx',
    'src/components/restaurant/delivery/delivery-console.test.tsx',
    'src/lib/restaurant/pakistan-tax-profiles.test.ts',
    'src/lib/restaurant/pakistan-tax-profiles.ts',
    'src/lib/test-support/restaurant-tax-profile.ts',
    'src/server/restaurant-branch-scope.db.test.ts',
    'src/server/routers/restaurant-tax.db.test.ts',
    'src/server/routers/restaurant-tax.test.ts',
  ]);

  const APPROVED_PATTERNS = [
    // Vertical catalog — the one authoritative registry
    /src\/lib\/vertical-catalog(\.test)?\.(ts|tsx)$/,
    // Platform commands — the one server enforcement point
    /src\/lib\/platform\/commands(\.vertical\.test)?\.(ts|tsx)$/,
    // Entitlements resolution order (M0 §2.3 correction — sacred)
    /src\/lib\/entitlements(\.test)?\.(ts|tsx)$/,
    // Purpose-built restaurant demo implementation and focused tests
    /src\/lib\/demo\//,
    // Module catalog — owns module→vertical mapping
    /src\/lib\/module-catalog(\.test)?\.(ts|tsx)$/,
    // Sidebar navigation — vertical-aware nav is approved
    /src\/components\/layout\/sidebar(\.test)?\.(ts|tsx)$/,
    /src\/components\/layout\/app-shell(\.test)?\.(ts|tsx)$/,
    /src\/app\/\(app\)\/dashboard\//,
    // Platform console pages for organizations and catalog
    /src\/app\/platform\/\(console\)\/organizations\//,
    /src\/app\/platform\/\(console\)\/catalog\//,
    // WHA-290 — the identity paths derive a department from the vertical
    // catalog rather than branching on the vertical themselves, so only this
    // module's database battery names a vertical: it has to CREATE a restaurant
    // organization to prove the composite foreign key admits what it writes.
    /src\/lib\/department-provisioning\.db\.test\.ts$/,
    // WHA-8 — the platform command form is vertical-AGNOSTIC (zero references in
    // the component itself); only its test names a vertical, as fixture data for
    // the generic filtered-select it renders.
    /src\/components\/platform\/platform-command-form\.[a-z]+\.test\.tsx$/,
    // WHA-1181 — a focused battery over `commands.ts`, the one approved server
    // enforcement point, proving its RESTAURANT branch provisions the
    // administrator a staff profile and its AGENCY branch stays byte-identical.
    // Naming both verticals is the assertion; the production code it covers is
    // the already-approved consumer, not a new one.
    /src\/lib\/platform\/commands\.administrator-staff-profile\.test\.ts$/,
    /src\/lib\/platform\/commands\.demo-bootstrap\.test\.ts$/,
    // WHA-1181 — the provisioning DB battery. The vertical appears once, as the
    // `vertical` COLUMN VALUE of the fixture organization it inserts, because
    // the row has to be faithful for the restaurant tables to accept it. The
    // module under test (`src/lib/restaurant/organization-provisioning.ts`)
    // names no vertical at all: it is restaurant-only by directory, and the
    // already-approved `commands.ts` is what decides to call it.
    /src\/lib\/restaurant\/organization-provisioning\.db\.test\.ts$/,
    // Generated Prisma client — read-only, not authored here
    /src\/generated\//,
  ];

  function isApproved(filePath: string): boolean {
    return (
      APPROVED_EXACT_FILES.has(filePath) ||
      APPROVED_PATTERNS.some((pattern) => pattern.test(filePath))
    );
  }

  it('has zero OrganizationVertical / RESTAURANT references outside the approved consumer set', () => {
    const pattern = /OrganizationVertical|\bRESTAURANT\b/;
    const root = join(process.cwd(), 'src');

    function walk(dir: string): string[] {
      const entries = readdirSync(dir, { withFileTypes: true });
      const results: string[] = [];
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...walk(full));
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          results.push(full);
        }
      }
      return results;
    }

    const allFiles = walk(root);
    const matching = allFiles
      .filter((file) => {
        try {
          return pattern.test(readFileSync(file, 'utf8'));
        } catch {
          return false;
        }
      })
      .map((file) => file.replace(process.cwd() + '/', ''));

    const violations = matching.filter((file) => !isApproved(file));

    expect(violations).toStrictEqual([]);
  });
});
