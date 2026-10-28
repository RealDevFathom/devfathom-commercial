/**
 * M1-L5 acceptance battery — Contract item 1 + agency side of item 7.
 *
 * Written FROM THE CONTRACT (§9 onboarding, §15 global acceptance, §16
 * Phase-1 anti-pattern guard), independently of the M1-L2 implementation.
 * These tests overlap L2 intentionally; divergence is a signal, not duplication.
 *
 * Contract item 1:
 *   AGENCY `organization.create` → zero branch rows; module / role / limit /
 *   audit outcomes identical to baseline; agency activation preflight unchanged
 *   (contract item 7 — the AGENCY path must never run restaurant-specific
 *   preflight queries).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks (same infrastructure the rest of the command test suite uses)
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
  assignmentCreate: vi.fn(),
  moduleUpsert: vi.fn(),
  orgModuleFindMany: vi.fn(),
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
  restaurantBranch: { create: mocks.branchCreate, findMany: mocks.branchFindMany },
  restaurantBranchAssignment: { create: mocks.assignmentCreate },
  organizationModule: { upsert: mocks.moduleUpsert, findMany: mocks.orgModuleFindMany },
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

function agencyPayload(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'acme-agency',
    legalName: 'Acme Agency Ltd',
    displayName: 'Acme Agency',
    deploymentMode: 'SHARED',
    packageId: 'pkg_a',
    timezone: 'UTC',
    locale: 'en-US',
    currency: 'usd',
    seatLimit: 25,
    primaryContactName: 'Admin',
    primaryContactEmail: 'admin@acme.com',
    adminName: 'Acme Admin',
    adminEmail: 'admin@acme.com',
    adminPassword: 'a-strong-password',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §9 onboarding — Contract item 1: AGENCY create produces zero branch rows
// ---------------------------------------------------------------------------
describe('§9 contract item 1 — AGENCY organization.create: zero branch rows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.userCreate.mockResolvedValue({ id: 'user_admin' });
    mocks.orgCreate.mockResolvedValue({ id: 'org_a', slug: 'acme-agency' });
    mocks.roleCreate.mockResolvedValue({ id: 'role_admin' });
    mocks.pkgFindUnique.mockResolvedValue({
      defaultSeats: 25,
      id: 'pkg_a',
      active: true,
      vertical: 'AGENCY',
      moduleLinks: [],
    });
  });

  it('creates the organization without touching restaurantBranch or restaurantBranchAssignment', async () => {
    await run('organization.create', agencyPayload());

    expect(mocks.orgCreate).toHaveBeenCalledTimes(1);
    expect(mocks.branchCreate).not.toHaveBeenCalled();
    expect(mocks.assignmentCreate).not.toHaveBeenCalled();
  });

  it('creates exactly one role (the bootstrap admin role — no templates)', async () => {
    await run('organization.create', agencyPayload());

    expect(mocks.roleCreate).toHaveBeenCalledTimes(1);
  });

  it('stamps the organization with vertical AGENCY', async () => {
    await run('organization.create', agencyPayload());

    expect(mocks.orgCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ vertical: 'AGENCY' }) })
    );
  });

  it('writes the user record exactly once (the admin)', async () => {
    await run('organization.create', agencyPayload());

    expect(mocks.userCreate).toHaveBeenCalledTimes(1);
  });

  it('writes the audit log entry', async () => {
    const db = platformDb as Record<string, { create?: ReturnType<typeof vi.fn> }>;
    const auditSpy = vi.spyOn(db.platformAuditLog!, 'create');

    await run('organization.create', agencyPayload());

    expect(auditSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// §9 contract item 7 — AGENCY activation preflight is unchanged
// The AGENCY path must never query restaurantBranch or platformModule (those
// are restaurant-specific preflight queries added by M1-L2).
// ---------------------------------------------------------------------------
describe('§9 contract item 7 — AGENCY activation preflight: no restaurant-specific queries', () => {
  function agencyOrgState(overrides: Record<string, unknown> = {}) {
    return {
      id: 'org_a',
      vertical: 'AGENCY',
      status: 'ONBOARDING',
      activatedAt: null,
      packageId: 'pkg_a',
      package: { vertical: 'AGENCY', moduleLinks: [{ moduleId: 'mod_dashboard' }] },
      modules: [],
      users: [{ id: 'admin_1' }],
      deployments: [{ id: 'dep_1' }],
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.orgUpdate.mockResolvedValue({ id: 'org_a', status: 'ACTIVE' });
  });

  it('activates an agency org that has users and deployments', async () => {
    mocks.orgFindUnique.mockResolvedValue(agencyOrgState());

    await expect(
      run('organization.transition', {
        id: 'org_a',
        status: 'ACTIVE',
        reason: 'Activating agency after onboarding',
      })
    ).resolves.toBeDefined();

    expect(mocks.orgUpdate).toHaveBeenCalledTimes(1);
  });

  it('does NOT query restaurantBranch during AGENCY activation', async () => {
    mocks.orgFindUnique.mockResolvedValue(agencyOrgState());

    await run('organization.transition', {
      id: 'org_a',
      status: 'ACTIVE',
      reason: 'Activating',
    });

    expect(mocks.branchFindMany).not.toHaveBeenCalled();
  });

  it('does NOT query platformModule during AGENCY activation', async () => {
    mocks.orgFindUnique.mockResolvedValue(agencyOrgState());

    await run('organization.transition', {
      id: 'org_a',
      status: 'ACTIVE',
      reason: 'Activating',
    });

    expect(mocks.platformModuleFindMany).not.toHaveBeenCalled();
  });

  it('still requires users for AGENCY activation (baseline preflight unchanged)', async () => {
    mocks.orgFindUnique.mockResolvedValue(agencyOrgState({ users: [] }));

    const error = await run('organization.transition', {
      id: 'org_a',
      status: 'ACTIVE',
      reason: 'Activating',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400 });
  });

  it('still requires deployments for AGENCY activation (baseline preflight unchanged)', async () => {
    mocks.orgFindUnique.mockResolvedValue(agencyOrgState({ deployments: [] }));

    const error = await run('organization.transition', {
      id: 'org_a',
      status: 'ACTIVE',
      reason: 'Activating',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400 });
  });
});
