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
  branchFindMany: vi.fn(),
  branchCount: vi.fn(),
  assignmentCreate: vi.fn(),
  moduleUpsert: vi.fn(),
  orgModuleFindMany: vi.fn(),
  orgModuleCount: vi.fn(),
  platformModuleFindMany: vi.fn(),
  platformModuleFindUnique: vi.fn(),
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
      id: 'pkg_r',
      active: true,
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
      id: 'pkg_a',
      active: true,
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
      id: 'pkg_r',
      active: true,
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

  it('rejects enabling an agency module on a restaurant organization', async () => {
    mocks.orgFindUnique.mockResolvedValue({ vertical: 'RESTAURANT' });
    mocks.platformModuleFindUnique.mockResolvedValue({ key: 'dashboard' });

    const error = await caught(
      run('organization.module', {
        organizationId: 'org_r',
        moduleId: 'mod_dashboard',
        status: 'ENABLED',
        reason: 'operator',
      })
    );

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400 });
    expect(mocks.moduleUpsert).not.toHaveBeenCalled();
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

    const error = await caught(run('organization.update', { id: 'org_r', vertical: 'AGENCY' }));

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

    await run('organization.update', { id: 'org_x', vertical: 'RESTAURANT', packageId: 'pkg_r' });

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
    mocks.branchFindMany.mockResolvedValue([{ id: 'branch_1' }]);
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
  const APPROVED_PATTERNS = [
    // Vertical catalog — the one authoritative registry
    /src\/lib\/vertical-catalog(\.test)?\.(ts|tsx)$/,
    // Platform commands — the one server enforcement point
    /src\/lib\/platform\/commands(\.vertical\.test)?\.(ts|tsx)$/,
    // Entitlements resolution order (M0 §2.3 correction — sacred)
    /src\/lib\/entitlements\.(ts|tsx)$/,
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
    // Generated Prisma client — read-only, not authored here
    /src\/generated\//,
  ];

  function isApproved(filePath: string): boolean {
    return APPROVED_PATTERNS.some((pattern) => pattern.test(filePath));
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
