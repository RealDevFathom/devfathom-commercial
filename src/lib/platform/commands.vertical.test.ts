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
import type { ZodError } from 'zod';

import {
  AGENCY_DEPARTMENTS,
  HOSPITALITY_DEPARTMENTS,
  PHARMACY_ROLE_TEMPLATES,
  RESTAURANT_DEPARTMENTS,
  RESTAURANT_MODULES,
  RESTAURANT_ROLE_TEMPLATES,
  roleTemplatesForVertical,
} from '@/lib/vertical-catalog';
import { PHARMACY_ONBOARDING_STEPS } from '@/lib/pharmacy/onboarding';

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
  // WHA-1206 — the pharmacy branch aggregate, a different table from the
  // restaurant branch above, so a test can tell which one provisioning wrote.
  pharmacyBranchCreate: vi.fn(),
  // H1-01 — the hospitality branch aggregate: in that vertical the property row
  // IS the branch, so a third create tells the three paths apart.
  hotelPropertyCreate: vi.fn(),
  hotelPropertyFindFirst: vi.fn(),
  // PROP-04 G1 — provisioning now also writes the bootstrap administrator's
  // assignment to the property it just created, in the same transaction.
  hotelAssignmentCreate: vi.fn(),
  acknowledgementFindMany: vi.fn(),
  // WHA-1181 — restaurant onboarding and activation now also link each
  // organization administrator to a staff profile. Default implementations
  // (which survive `vi.clearAllMocks`) keep the fixtures below about the
  // vertical/package behaviour they were written for.
  staffFindFirst: vi.fn(async () => null),
  staffCreate: vi.fn(async () => ({ id: 'staff_1', primaryBranchId: 'branch_1' })),
  branchFindFirst: vi.fn(async () => ({ id: 'branch_1' })),
  userFindMany: vi.fn(async () => [
    { id: 'user_admin', name: 'Restaurant Admin', email: 'admin@burger.co' },
  ]),
  assignmentCreate: vi.fn(),
  moduleUpsert: vi.fn(),
  orgModuleFindMany: vi.fn(),
  orgModuleCount: vi.fn(),
  platformModuleFindUnique: vi.fn(),
  platformModuleFindMany: vi.fn(),
  packageModuleUpsert: vi.fn(),
  departmentCreateMany: vi.fn(),
  auditCreate: vi.fn(),
  tenantAuditCreate: vi.fn(),
  regulatoryProfileFindFirst: vi.fn(),
  organizationExists: vi.fn(),
  gateStateFindMany: vi.fn(),
  roleCount: vi.fn(),
  publicationEntryCount: vi.fn(),
  inventoryLotCount: vi.fn(),
  supplierCount: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('bcryptjs', () => ({ hash: vi.fn(async () => 'hashed'), compare: vi.fn() }));
vi.mock('@/lib/secret-crypto', () => ({ encryptSecret: vi.fn(), decryptSecret: vi.fn() }));
vi.mock('@/lib/platform/auth', () => ({ assertPlatformCapability: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withPlatformDb: vi.fn(async (run: (db: unknown) => Promise<unknown>) => run(platformDb)),
  withTenantDb: vi.fn(async (_organizationId: string, run: (db: unknown) => Promise<unknown>) =>
    run(platformDb)
  ),
}));

function record() {
  return vi.fn(async (args: { data?: unknown }) => ({ id: 'row_1', ...(args?.data as object) }));
}

const platformDb = {
  $queryRawUnsafe: mocks.organizationExists,
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
  organizationRole: { create: mocks.roleCreate, count: mocks.roleCount },
  pharmacyOnboardingGateState: { findMany: mocks.gateStateFindMany },
  medicinePublicationEntry: { count: mocks.publicationEntryCount },
  pharmacyInventoryLot: { count: mocks.inventoryLotCount },
  pharmacySupplier: { count: mocks.supplierCount },
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
  platformAuditLog: { create: mocks.auditCreate },
  auditLog: { create: mocks.tenantAuditCreate },
  branchRegulatoryProfile: { findFirst: mocks.regulatoryProfileFindFirst },
  restaurantBranch: {
    create: mocks.branchCreate,
    findMany: mocks.branchFindMany,
    findFirst: mocks.branchFindFirst,
    count: mocks.branchCount,
  },
  pharmacyBranch: { create: mocks.pharmacyBranchCreate },
  hotelProperty: {
    create: mocks.hotelPropertyCreate,
    findFirst: mocks.hotelPropertyFindFirst,
  },
  hotelPropertyAssignment: { create: mocks.hotelAssignmentCreate },
  restaurantBranchAssignment: { create: mocks.assignmentCreate },
  restaurantStaffProfile: { findFirst: mocks.staffFindFirst, create: mocks.staffCreate },
  restaurantActivationAcknowledgement: { findMany: mocks.acknowledgementFindMany },
  organizationModule: {
    upsert: mocks.moduleUpsert,
    findMany: mocks.orgModuleFindMany,
    count: mocks.orgModuleCount,
  },
  platformModule: {
    findUnique: mocks.platformModuleFindUnique,
    findMany: mocks.platformModuleFindMany,
  },
  platformPackageModule: { upsert: mocks.packageModuleUpsert },
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

function restaurantCreatePayload(overrides: Record<string, unknown> = {}) {
  return createPayload({
    vertical: 'RESTAURANT',
    firstBranchName: 'Main Branch',
    firstBranchAddress: '1 Restaurant Way',
    businessDayCutoff: '04:00',
    ...overrides,
  });
}

function pharmacyCreatePayload(overrides: Record<string, unknown> = {}) {
  return createPayload({
    vertical: 'PHARMACY',
    packageId: 'pkg_p',
    timezone: 'Asia/Karachi',
    firstBranchName: 'Clifton Chemist',
    firstBranchAddress: '21 Khayaban-e-Shamsheer',
    firstBranchCity: 'Karachi',
    firstBranchProvinceCode: 'PK-SD',
    ...overrides,
  });
}

function hospitalityCreatePayload(overrides: Record<string, unknown> = {}) {
  return createPayload({
    vertical: 'HOSPITALITY',
    packageId: 'pkg_h',
    timezone: 'Asia/Karachi',
    firstBranchName: 'Serena Gulberg',
    firstBranchAddress: '12 Main Boulevard',
    firstBranchCity: 'Lahore',
    ...overrides,
  });
}

function run(action: string, payload: unknown) {
  return executePlatformCommand(actor, action, payload, request);
}

function caught(promise: Promise<unknown>) {
  return promise.catch((error: unknown) => error);
}

const HOSTILE_AUDIT_INPUT = 'token_live_VERTICAL_SECRET';

function expectSanitizedModuleFailureAudit() {
  expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
  expect(mocks.auditCreate).toHaveBeenCalledWith({
    data: expect.objectContaining({
      action: 'organization.module',
      success: false,
      reason: 'Platform command validation failed.',
      error: 'Platform command validation failed.',
      metadata: { outcomeCategory: 'validation_failed' },
    }),
  });
  expect(JSON.stringify(mocks.auditCreate.mock.calls[0])).not.toContain(HOSTILE_AUDIT_INPUT);
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
    // PROP-04 F-B — role ids have to be distinguishable now: provisioning assigns
    // the hospitality property to the Owner role it created from the catalog, not
    // to the bootstrap `admin` role, so a single shared id would let the two pass
    // for each other. `admin` keeps `role_x` because the administrator user is
    // created against it.
    mocks.roleCreate.mockImplementation(async (args: { data: { key: string } }) => ({
      id: args.data.key === 'admin' ? 'role_x' : `role_${args.data.key}`,
    }));
    mocks.branchCreate.mockResolvedValue({ id: 'branch_1' });
    mocks.assignmentCreate.mockResolvedValue({ id: 'assign_1' });
    // The property's own id is `branchId`, and G1 assigns against exactly the row
    // this create returned — so the fixture has to return one.
    mocks.hotelPropertyCreate.mockResolvedValue({ branchId: 'prop_1' });
    mocks.hotelAssignmentCreate.mockResolvedValue({ id: 'hpa_1' });
    mocks.departmentCreateMany.mockResolvedValue({ count: 0 });
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

    await run('organization.create', restaurantCreatePayload({ packageId: 'pkg_r' }));

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

  // WHA-278 — `User.department` is a composite FK onto organization_departments.
  // A newly created organization therefore cannot hold its own administrator
  // unless provisioning seeds the vertical's departments first.
  it('seeds AGENCY departments from the catalog before creating the administrator', async () => {
    mocks.pkgFindUnique.mockResolvedValue({
      id: 'pkg_1',
      active: true,
      vertical: 'AGENCY',
      moduleLinks: [],
    });

    await run('organization.create', createPayload());

    expect(mocks.departmentCreateMany).toHaveBeenCalledTimes(1);
    const seeded = (
      mocks.departmentCreateMany.mock.calls[0]![0] as {
        data: { organizationId: string; key: string; name: string; sortOrder: number }[];
      }
    ).data;
    expect(seeded.map((row) => row.key)).toEqual(AGENCY_DEPARTMENTS.map((d) => d.key));
    expect(seeded.every((row) => row.organizationId === 'org_new')).toBe(true);
    // No restaurant leakage into an agency tenant.
    for (const restaurantDepartment of RESTAURANT_DEPARTMENTS) {
      expect(seeded.map((row) => row.key)).not.toContain(restaurantDepartment.key);
    }
    // The administrator is filed under a department that was actually seeded.
    const adminDepartment = (mocks.userCreate.mock.calls[0]![0] as { data: { department: string } })
      .data.department;
    expect(adminDepartment).toBe('LEADERSHIP');
    expect(seeded.map((row) => row.key)).toContain(adminDepartment);
    // Ordering is the FK constraint: departments must exist before the user.
    expect(mocks.departmentCreateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.userCreate.mock.invocationCallOrder[0]!
    );
  });

  it('seeds RESTAURANT departments only, and files the admin front of house', async () => {
    mocks.pkgFindUnique.mockResolvedValue({
      id: 'pkg_r',
      active: true,
      vertical: 'RESTAURANT',
      moduleLinks: [{ moduleId: 'restaurant-core', enabled: true }],
    });

    await run('organization.create', restaurantCreatePayload({ packageId: 'pkg_r' }));

    const seeded = (
      mocks.departmentCreateMany.mock.calls[0]![0] as {
        data: { key: string; name: string }[];
      }
    ).data;
    expect(seeded.map((row) => row.key)).toEqual(RESTAURANT_DEPARTMENTS.map((d) => d.key));
    expect(seeded.map((row) => row.name)).toContain('Kitchen');
    expect(seeded.map((row) => row.name)).toContain('Front of House');
    // The agency enum must not leak into a restaurant tenant.
    for (const agencyDepartment of AGENCY_DEPARTMENTS) {
      expect(seeded.map((row) => row.key)).not.toContain(agencyDepartment.key);
    }
    // 'LEADERSHIP' does not exist for this vertical, so the admin cannot use it.
    const adminDepartment = (mocks.userCreate.mock.calls[0]![0] as { data: { department: string } })
      .data.department;
    expect(adminDepartment).toBe('FRONT_OF_HOUSE');
    expect(seeded.map((row) => row.key)).toContain(adminDepartment);
  });

  // -------------------------------------------------------------------------
  // WHA-1206 — a PHARMACY organization is provisioned the same way: its own
  // first branch and its own role templates. Before this, both were seeded only
  // inside the RESTAURANT block, so a pharmacy was created holding one `admin`
  // role and no branch — a tenant whose OWNER_AND_ROLE_TEMPLATES and
  // PREMISES_AND_LICENCES gates could never pass without a manual database write.
  // -------------------------------------------------------------------------
  it('provisions a PHARMACY organization: its own branch aggregate and role templates', async () => {
    mocks.pkgFindUnique.mockResolvedValue({
      id: 'pkg_p',
      active: true,
      vertical: 'PHARMACY',
      moduleLinks: [{ moduleId: 'pharmacy-core', enabled: true }],
    });

    await run('organization.create', pharmacyCreatePayload());

    expect(mocks.orgCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ vertical: 'PHARMACY' }) })
    );
    // The pharmacy branch aggregate, not the restaurant one: the regulatory
    // profile PLAT-02 writes has a composite FK onto `pharmacy_branches`.
    expect(mocks.pharmacyBranchCreate).toHaveBeenCalledTimes(1);
    expect(mocks.pharmacyBranchCreate).toHaveBeenCalledWith({
      data: {
        organizationId: 'org_new',
        code: 'MAIN',
        name: 'Clifton Chemist',
        addressLine: '21 Khayaban-e-Shamsheer',
        city: 'Karachi',
        provinceCode: 'PK-SD',
      },
    });
    expect(mocks.branchCreate).not.toHaveBeenCalled();
    expect(mocks.assignmentCreate).not.toHaveBeenCalled();
    // Bootstrap admin role + every pharmacy role template the readiness gate
    // requires, asserted against the catalog rather than a copied list.
    const createdRoleKeys = mocks.roleCreate.mock.calls.map(
      (call) => (call[0] as { data: { key: string } }).data.key
    );
    expect(mocks.roleCreate).toHaveBeenCalledTimes(1 + PHARMACY_ROLE_TEMPLATES.length);
    for (const template of roleTemplatesForVertical('PHARMACY')) {
      expect(createdRoleKeys).toContain(template.key);
    }
    // No restaurant template leaked into a pharmacy tenant.
    for (const template of RESTAURANT_ROLE_TEMPLATES) {
      if (roleTemplatesForVertical('PHARMACY').some((one) => one.key === template.key)) continue;
      expect(createdRoleKeys).not.toContain(template.key);
    }
  });

  it('refuses a PHARMACY create that names no premises for its first branch', async () => {
    mocks.pkgFindUnique.mockResolvedValue({
      id: 'pkg_p',
      active: true,
      vertical: 'PHARMACY',
      moduleLinks: [],
    });

    const error = await caught(
      run(
        'organization.create',
        createPayload({ vertical: 'PHARMACY', packageId: 'pkg_p', timezone: 'Asia/Karachi' })
      )
    );

    // Every missing premises column is reported on its own field, so the
    // operator form marks all four at once rather than one per submission.
    const paths = ((error as ZodError).issues ?? []).map((issue) => issue.path.join('.'));
    expect(paths).toEqual(
      expect.arrayContaining([
        'firstBranchName',
        'firstBranchAddress',
        'firstBranchCity',
        'firstBranchProvinceCode',
      ])
    );
    expect(mocks.orgCreate).not.toHaveBeenCalled();
    expect(mocks.pharmacyBranchCreate).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // H1-01 — a HOSPITALITY organization is provisioned the same way. Its branch
  // is `hotel_properties`: an organization without that row has no branch at
  // all, so the checklist, the settings page and every later hotel table would
  // have nothing to hang off.
  // -------------------------------------------------------------------------
  it('provisions a HOSPITALITY organization: its property row and its role templates', async () => {
    mocks.pkgFindUnique.mockResolvedValue({
      id: 'pkg_h',
      active: true,
      vertical: 'HOSPITALITY',
      moduleLinks: [{ moduleId: 'hotel-core', enabled: true }],
    });

    await run('organization.create', hospitalityCreatePayload());

    expect(mocks.orgCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ vertical: 'HOSPITALITY' }) })
    );
    expect(mocks.hotelPropertyCreate).toHaveBeenCalledTimes(1);
    expect(mocks.hotelPropertyCreate).toHaveBeenCalledWith({
      data: {
        organizationId: 'org_new',
        name: 'Serena Gulberg',
        addressLine: '12 Main Boulevard',
        city: 'Lahore',
        timezone: 'Asia/Karachi',
        // Deterministic from the workspace slug the operator already chose, so
        // provisioning never has to ask for a public booking address.
        bookingEngineSlug: 'acme-serena-gulberg',
      },
    });
    // No mode, tax profile or business-date policy is pre-seeded: the checklist
    // has to have something real to refuse, and the column defaults carry the
    // rest (H-D14 HOTEL, PKR, en/ur).
    const written = mocks.hotelPropertyCreate.mock.calls[0]![0] as {
      data: Record<string, unknown>;
    };
    for (const field of ['mode', 'taxProfileId', 'businessDatePolicy', 'currency']) {
      expect(written.data).not.toHaveProperty(field);
    }
    // PROP-04 G1 — and the property is assigned to the operator-named
    // administrator in the same transaction. Exactly one assignment, naming the
    // exact tuple provisioning created: the property row returned above, the user
    // created from `adminName`/`adminEmail`, and this organization's own Owner
    // role. Not an all-property grant and not an inferred one — the values are the
    // ids the creates above returned, so nothing was searched for.
    expect(mocks.hotelAssignmentCreate).toHaveBeenCalledTimes(1);
    expect(mocks.hotelAssignmentCreate).toHaveBeenCalledWith({
      data: {
        organizationId: 'org_new',
        branchId: 'prop_1',
        userId: 'user_admin',
        organizationRoleId: 'role_owner',
        active: true,
      },
    });

    // Neither of the other verticals' branch aggregates was touched.
    expect(mocks.branchCreate).not.toHaveBeenCalled();
    expect(mocks.pharmacyBranchCreate).not.toHaveBeenCalled();
    expect(mocks.assignmentCreate).not.toHaveBeenCalled();

    const createdRoleKeys = mocks.roleCreate.mock.calls.map(
      (call) => (call[0] as { data: { key: string } }).data.key
    );
    expect(mocks.roleCreate).toHaveBeenCalledTimes(
      1 + roleTemplatesForVertical('HOSPITALITY').length
    );
    for (const template of roleTemplatesForVertical('HOSPITALITY')) {
      expect(createdRoleKeys).toContain(template.key);
    }
    // The hospitality departments, not another vertical's.
    expect(mocks.departmentCreateMany).toHaveBeenCalledWith({
      data: HOSPITALITY_DEPARTMENTS.map((department, index) => ({
        organizationId: 'org_new',
        key: department.key,
        name: department.name,
        sortOrder: index,
      })),
    });
  });

  // PROP-04 F-B — the regression the first G1 delivery missed. Provisioning wrote
  // the assignment against the bootstrap `admin` role, which
  // `requireHotelPropertyScope` does not filter on, so the tRPC `findFirst`
  // returned null and every newly provisioned hospitality organization opened on
  // a property nobody in it could operate. Asserted against the catalog rather
  // than a copied literal, so renaming the Owner template fails here.
  it('assigns the property to a role the tenant resolver actually resolves on', async () => {
    mocks.pkgFindUnique.mockResolvedValue({
      id: 'pkg_h',
      active: true,
      vertical: 'HOSPITALITY',
      moduleLinks: [],
    });

    await run('organization.create', hospitalityCreatePayload());

    const assigned = (
      mocks.hotelAssignmentCreate.mock.calls[0]![0] as {
        data: { organizationRoleId: string; userId: string };
      }
    ).data;
    // The id belongs to a role this very provisioning created — not a searched-for
    // one and not a pre-existing one.
    const createdKeys = mocks.roleCreate.mock.calls.map(
      (call) => (call[0] as { data: { key: string } }).data.key
    );
    const assignedKey = createdKeys.find((key) => `role_${key}` === assigned.organizationRoleId);
    expect(assignedKey).toBeDefined();
    // And it is one of the keys `requireHotelPropertyScope` filters assignments
    // by, which is the predicate the old `admin` role failed.
    expect(roleTemplatesForVertical('HOSPITALITY').map((template) => template.key)).toContain(
      assignedKey
    );
    expect(assigned.organizationRoleId).not.toBe('role_x');
    // The recipient is unchanged: still the operator-named administrator.
    expect(assigned.userId).toBe('user_admin');
  });

  // The role templates now have to exist before the hospitality block runs, since
  // that block names one of them. Pinned so a later reordering fails here rather
  // than by assigning a role id that does not exist yet.
  it('creates the hospitality role templates before it writes the property assignment', async () => {
    mocks.pkgFindUnique.mockResolvedValue({
      id: 'pkg_h',
      active: true,
      vertical: 'HOSPITALITY',
      moduleLinks: [],
    });

    await run('organization.create', hospitalityCreatePayload());

    expect(mocks.roleCreate).toHaveBeenCalledBefore(mocks.hotelAssignmentCreate);
    expect(mocks.roleCreate).toHaveBeenCalledBefore(mocks.hotelPropertyCreate);
  });

  it('refuses a HOSPITALITY create that names no premises for its first property', async () => {
    mocks.pkgFindUnique.mockResolvedValue({
      id: 'pkg_h',
      active: true,
      vertical: 'HOSPITALITY',
      moduleLinks: [],
    });

    const error = await caught(
      run(
        'organization.create',
        createPayload({ vertical: 'HOSPITALITY', packageId: 'pkg_h', timezone: 'Asia/Karachi' })
      )
    );

    const paths = ((error as ZodError).issues ?? []).map((issue) => issue.path.join('.'));
    expect(paths).toEqual(
      expect.arrayContaining(['firstBranchName', 'firstBranchAddress', 'firstBranchCity'])
    );
    // A property is not licensed per jurisdiction, so no province is demanded.
    expect(paths).not.toContain('firstBranchProvinceCode');
    expect(mocks.orgCreate).not.toHaveBeenCalled();
    expect(mocks.hotelPropertyCreate).not.toHaveBeenCalled();
  });

  it('rejects a crafted HOSPITALITY create carrying a pharmacy package', async () => {
    mocks.pkgFindUnique.mockResolvedValue({
      id: 'pkg_p',
      active: true,
      vertical: 'PHARMACY',
      moduleLinks: [],
    });

    await expect(
      run('organization.create', hospitalityCreatePayload({ packageId: 'pkg_p' }))
    ).rejects.toBeInstanceOf(PlatformSecurityError);
    expect(mocks.orgCreate).not.toHaveBeenCalled();
    expect(mocks.hotelPropertyCreate).not.toHaveBeenCalled();
  });

  it('refuses a province no pharmacy surface can name', async () => {
    mocks.pkgFindUnique.mockResolvedValue({
      id: 'pkg_p',
      active: true,
      vertical: 'PHARMACY',
      moduleLinks: [],
    });

    const error = await caught(
      run('organization.create', pharmacyCreatePayload({ firstBranchProvinceCode: 'PK-ZZ' }))
    );

    expect(((error as ZodError).issues ?? []).map((issue) => issue.path.join('.'))).toContain(
      'firstBranchProvinceCode'
    );
    expect(mocks.pharmacyBranchCreate).not.toHaveBeenCalled();
  });

  it('leaves the AGENCY path untouched: no branch of either kind, no template roles', async () => {
    // The guard this fix widened. `AGENCY_ROLE_TEMPLATES` repeats the bootstrap
    // `admin` role and adds `member`; seeding it would collide on the
    // (organizationId, key) unique index and change every agency onboarding.
    mocks.pkgFindUnique.mockResolvedValue({
      id: 'pkg_1',
      active: true,
      vertical: 'AGENCY',
      moduleLinks: [],
    });

    await run('organization.create', createPayload());

    expect(mocks.roleCreate).toHaveBeenCalledTimes(1);
    expect((mocks.roleCreate.mock.calls[0]![0] as { data: { key: string } }).data.key).toBe(
      'admin'
    );
    expect(mocks.branchCreate).not.toHaveBeenCalled();
    expect(mocks.pharmacyBranchCreate).not.toHaveBeenCalled();
  });

  it('rejects a crafted RESTAURANT create carrying an AGENCY package', async () => {
    mocks.pkgFindUnique.mockResolvedValue({
      id: 'pkg_a',
      active: true,
      vertical: 'AGENCY',
      moduleLinks: [],
    });

    const error = await caught(
      run('organization.create', restaurantCreatePayload({ packageId: 'pkg_a' }))
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
    reason: HOSTILE_AUDIT_INPUT,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.moduleUpsert.mockResolvedValue({ id: 'orgmod_1' });
    mocks.organizationExists.mockResolvedValue([]);
    mocks.auditCreate.mockImplementation(async ({ data }) => ({ id: 'audit_1', ...data }));
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
    expectSanitizedModuleFailureAudit();
  });

  it('rejects an agency module on a restaurant organization', async () => {
    mocks.orgFindUnique.mockResolvedValue({ vertical: 'RESTAURANT' });
    mocks.platformModuleFindUnique.mockResolvedValue({ key: 'projects' });

    const error = await caught(run('organization.module', modulePayload('mod_dash')));

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect(error).toMatchObject({ status: 400 });
    expect(mocks.moduleUpsert).not.toHaveBeenCalled();
    expectSanitizedModuleFailureAudit();
  });

  it('allows shared platform modules on either vertical', async () => {
    mocks.orgFindUnique.mockResolvedValue({ vertical: 'RESTAURANT' });
    mocks.platformModuleFindUnique.mockResolvedValue({ key: 'hr' });

    await run('organization.module', modulePayload('mod_hr'));

    expect(mocks.moduleUpsert).toHaveBeenCalledTimes(1);
  });

  it('rejects disabling a baseline module', async () => {
    mocks.orgFindUnique.mockResolvedValue({ vertical: 'AGENCY' });
    mocks.platformModuleFindUnique.mockResolvedValue({ key: 'dashboard' });

    const error = await caught(
      run('organization.module', { ...modulePayload('mod_dashboard'), status: 'DISABLED' })
    );

    expect(error).toBeInstanceOf(PlatformSecurityError);
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
      expectSanitizedModuleFailureAudit();
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

describe('catalog.package.module band compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pkgFindUnique.mockResolvedValue({ vertical: 'AGENCY' });
    mocks.packageModuleUpsert.mockResolvedValue({ id: 'link_1' });
  });

  const attach = () =>
    run('catalog.package.module', {
      packageId: 'pkg_1',
      moduleId: 'mod_1',
      enabled: true,
    });

  it('allows a shared platform module', async () => {
    mocks.platformModuleFindUnique.mockResolvedValue({
      key: 'chat',
      band: 'PLATFORM',
      vertical: null,
    });

    await attach();

    expect(mocks.packageModuleUpsert).toHaveBeenCalledTimes(1);
  });

  it('rejects baseline plumbing and cross-vertical modules', async () => {
    mocks.platformModuleFindUnique.mockResolvedValue({
      key: 'dashboard',
      band: 'BASELINE',
      vertical: null,
    });
    expect(await caught(attach())).toBeInstanceOf(PlatformSecurityError);

    mocks.platformModuleFindUnique.mockResolvedValue({
      key: 'restaurant-pos',
      band: 'VERTICAL_OPTIONAL',
      vertical: 'RESTAURANT',
    });
    expect(await caught(attach())).toBeInstanceOf(PlatformSecurityError);
    expect(mocks.packageModuleUpsert).not.toHaveBeenCalled();
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
    mocks.branchFindMany.mockResolvedValue([
      {
        id: 'branch_1',
        name: 'Main Branch',
        address: '1 Restaurant Way',
        timezone: 'Europe/Berlin',
        businessDayCutoff: '04:00',
      },
    ]);
    mocks.acknowledgementFindMany.mockResolvedValue(
      ['TAX', 'PAYMENT', 'DEVICE', 'OPERATOR'].map((kind) => ({
        kind,
        policyReference: `${kind.toLowerCase()}-policy-v1`,
      }))
    );
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
    expect(mocks.acknowledgementFindMany).not.toHaveBeenCalled();
    expect(mocks.platformModuleFindMany).not.toHaveBeenCalled();
  });
});

/** A pharmacy organization that already clears the vertical-agnostic preflight. */
function pharmacyOrg() {
  return {
    id: 'org_p',
    vertical: 'PHARMACY',
    status: 'ONBOARDING',
    activatedAt: null,
    packageId: 'pkg_p',
    package: { vertical: 'PHARMACY', moduleLinks: [{ moduleId: 'mod_pharmacy_core' }] },
    modules: [],
    users: [{ id: 'admin_1' }],
    deployments: [{ id: 'dep_1' }],
  };
}

/**
 * An effective PLAT-02 profile on confirmed jurisdiction rules. It carries both
 * the `branchId` the activation lookup selects and the full snapshot
 * `assertStoredBranchMayOperate` evaluates, so one `mockResolvedValue` serves
 * every call the preflight and the readiness evaluation make.
 */
const VALID_PROFILE = {
  branchId: 'branch-p',
  licenceCategory: 'PHARMACY',
  licenceValidFrom: new Date('2026-01-01'),
  licenceValidTo: new Date('2027-01-01'),
  permittedSchedules: ['RX'],
  qualifiedPersonRegistration: 'QP-1',
  qualifiedPersonValidFrom: new Date('2026-01-01'),
  qualifiedPersonValidTo: new Date('2027-01-01'),
  qualifiedPersonCoverageRosterRef: 'roster-1',
  jurisdictionRuleSet: {
    licenceCategories: { provisional: false, values: ['PHARMACY'] },
    permittedSchedules: { provisional: false, values: ['RX'] },
    pharmacistCoverageRule: { provisional: false, values: {} },
  },
};

/** Every one of the twelve gates recorded PASSED, with a full attestation. */
function allGatesClaimedPassed() {
  mocks.gateStateFindMany.mockResolvedValue(
    PHARMACY_ONBOARDING_STEPS.map((step) => ({
      gate: step.gate,
      status: 'PASSED',
      evidenceRef: `evidence://${step.gate}`,
      actorId: 'seed',
      recordedAt: new Date('2026-09-02T00:00:00.000Z'),
    }))
  );
}

/** No gate row recorded, and no backing data behind any evidence-backed gate. */
function noReadinessEvidence() {
  mocks.gateStateFindMany.mockResolvedValue([]);
  mocks.roleCount.mockResolvedValue(0);
  mocks.publicationEntryCount.mockResolvedValue(0);
  mocks.inventoryLotCount.mockResolvedValue(0);
  mocks.supplierCount.mockResolvedValue(0);
}

/** Backing data present for all six evidence-backed gates. */
function allReadinessEvidence() {
  mocks.roleCount.mockResolvedValue(roleTemplatesForVertical('PHARMACY').length);
  mocks.publicationEntryCount.mockResolvedValue(1);
  mocks.inventoryLotCount.mockResolvedValue(1);
  mocks.supplierCount.mockResolvedValue(1);
}

describe('pharmacy activation preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails closed without a valid effective-dated regulatory profile', async () => {
    mocks.orgFindUnique.mockResolvedValue(pharmacyOrg());
    noReadinessEvidence();

    await expect(
      run('organization.transition', {
        id: 'org_p',
        status: 'ACTIVE',
        reason: 'Attempt pharmacy activation',
      })
    ).rejects.toThrow(/PROFILE_MISSING/);
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('fails closed when the regulatory profile is valid but no P0 gate has passed', async () => {
    // PLAT-03: a valid PLAT-02 profile satisfies one of twelve gates. On its own
    // it is not readiness, and activation must still refuse.
    mocks.orgFindUnique.mockResolvedValue(pharmacyOrg());
    mocks.regulatoryProfileFindFirst.mockResolvedValue(VALID_PROFILE);
    noReadinessEvidence();

    await expect(
      run('organization.transition', {
        id: 'org_p',
        status: 'ACTIVE',
        reason: 'Attempt pharmacy activation',
      })
    ).rejects.toThrow(/onboarding gates not passed/);
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('refuses a seeded PASSED gate that the evidence query does not support', async () => {
    // The acceptance criterion of PRD §6.1 PLAT-03, at the command boundary:
    // every gate is claimed PASSED with a full attestation, and the evidence
    // queries do not agree. Activation is refused and the refusal names the
    // gates whose data is missing.
    //
    // The organization here really does hold a compatible pharmacy package and
    // a valid regulatory profile, so COMMERCIAL_PACKAGE and PREMISES_AND_LICENCES
    // pass on their evidence and are absent from the refusal — which is what
    // shows the downgrade is per-gate rather than a blanket rejection.
    mocks.orgFindUnique.mockResolvedValue(pharmacyOrg());
    mocks.regulatoryProfileFindFirst.mockResolvedValue(VALID_PROFILE);
    allGatesClaimedPassed();
    noReadinessEvidence();

    const error = await run('organization.transition', {
      id: 'org_p',
      status: 'ACTIVE',
      reason: 'Attempt pharmacy activation on seeded gates',
    }).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(PlatformSecurityError);
    expect((error as Error).message).toMatch(
      /OWNER_AND_ROLE_TEMPLATES, MEDICINE_CATALOG_READINESS, OPENING_STOCK_READINESS, PARTIES_AND_BALANCES/
    );
    expect((error as Error).message).not.toMatch(/COMMERCIAL_PACKAGE|PREMISES_AND_LICENCES/);
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('refuses when a single evidence-backed gate loses its backing data', async () => {
    mocks.orgFindUnique.mockResolvedValue(pharmacyOrg());
    mocks.regulatoryProfileFindFirst.mockResolvedValue(VALID_PROFILE);
    allGatesClaimedPassed();
    allReadinessEvidence();
    mocks.inventoryLotCount.mockResolvedValue(0);

    await expect(
      run('organization.transition', {
        id: 'org_p',
        status: 'ACTIVE',
        reason: 'Attempt pharmacy activation without opening stock',
      })
    ).rejects.toThrow(/OPENING_STOCK_READINESS/);
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('activates once the profile is valid and every P0 gate genuinely passes', async () => {
    mocks.orgFindUnique.mockResolvedValue(pharmacyOrg());
    mocks.orgUpdate.mockResolvedValue({ id: 'org_p', status: 'ACTIVE' });
    mocks.regulatoryProfileFindFirst.mockResolvedValue(VALID_PROFILE);
    allGatesClaimedPassed();
    allReadinessEvidence();

    await expect(
      run('organization.transition', {
        id: 'org_p',
        status: 'ACTIVE',
        reason: 'Regulatory checks and onboarding gates complete',
      })
    ).resolves.toBeDefined();
    expect(mocks.orgUpdate).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// H1-01 / PROP-01 — "no go-live without tax profile, mode and business date",
// enforced at the same command boundary pharmacy uses. Readiness is recomputed
// from the property row on every attempt, so activation cannot be reached by
// writing rows.
// ---------------------------------------------------------------------------

/** A hospitality organization that already clears the vertical-agnostic preflight. */
function hospitalityOrg() {
  return {
    id: 'org_h',
    vertical: 'HOSPITALITY',
    status: 'ONBOARDING',
    activatedAt: null,
    packageId: 'pkg_h',
    package: { vertical: 'HOSPITALITY', moduleLinks: [{ moduleId: 'mod_hotel_core' }] },
    modules: [],
    users: [{ id: 'admin_1' }],
    deployments: [{ id: 'dep_1' }],
  };
}

/** A fully recorded property — every step H1-01 can answer is satisfied. */
const COMPLETE_PROPERTY = {
  mode: 'HOTEL',
  name: 'Serena Gulberg',
  addressLine: '12 Main Boulevard',
  city: 'Lahore',
  timezone: 'Asia/Karachi',
  checkInTime: '14:00',
  checkOutTime: '12:00',
  auditTime: '03:00',
  taxProfileId: 'tax_profile_1',
  businessDatePolicy: { roll: 'AUDIT' },
};

describe('hospitality activation preflight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.orgFindUnique.mockResolvedValue(hospitalityOrg());
    mocks.orgUpdate.mockResolvedValue({ id: 'org_h', status: 'ACTIVE' });
    mocks.roleCount.mockResolvedValue(roleTemplatesForVertical('HOSPITALITY').length);
    mocks.hotelPropertyFindFirst.mockResolvedValue(COMPLETE_PROPERTY);
  });

  const activate = () =>
    run('organization.transition', {
      id: 'org_h',
      status: 'ACTIVE',
      reason: 'Attempt hospitality activation',
    });

  it('fails closed when the organization has no property at all', async () => {
    mocks.hotelPropertyFindFirst.mockResolvedValue(null);

    await expect(activate()).rejects.toThrow(/PROPERTY_FACTS/);
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('refuses go-live while the tax profile is unattached', async () => {
    mocks.hotelPropertyFindFirst.mockResolvedValue({
      ...COMPLETE_PROPERTY,
      taxProfileId: null,
    });

    await expect(activate()).rejects.toThrow(/TAX_PROFILE/);
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('refuses go-live while the business date is undecided', async () => {
    // The column default is `{}` — a property that was created and never
    // configured, which is exactly the state this gate exists to catch.
    mocks.hotelPropertyFindFirst.mockResolvedValue({
      ...COMPLETE_PROPERTY,
      businessDatePolicy: {},
    });

    await expect(activate()).rejects.toThrow(/BUSINESS_DATE_AND_AUDIT/);
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('refuses go-live when the role templates are not all present', async () => {
    mocks.roleCount.mockResolvedValue(roleTemplatesForVertical('HOSPITALITY').length - 1);

    await expect(activate()).rejects.toThrow(/ROLES_ASSIGNED/);
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });

  it('still refuses on room types alone, which H1-03 owns', async () => {
    // Everything this lane can answer is satisfied, and activation is still
    // refused — the room-type step has no resolver yet and reports pending
    // rather than being quietly assumed complete.
    await expect(activate()).rejects.toThrow(/ROOM_TYPES/);
    expect(mocks.orgUpdate).not.toHaveBeenCalled();
  });
});
