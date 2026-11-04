/**
 * DEV-211 / DEV-660 — inventory branch assignment against PostgreSQL as a
 * NOSUPERUSER NOBYPASSRLS role, through the tenant-scoped client. The router
 * unit tests pin the query shape; this proves its meaning on real rows: an
 * inactive assignment, a sibling-branch assignment, an inactive branch, an
 * unassigned session ADMIN, a member holding the system Owner role template and
 * an ADMIN with a `*` grant are all refused, and another tenant's branch never
 * resolves. There is no durable owner identity to exempt yet (DEV-660), so no
 * one reaches a branch without an active assignment. Skipped unless
 * TEST_DATABASE_URL names that role on a migrated disposable database.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const describeIfDatabase = databaseUrl ? describe : describe.skip;

vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ids = {
  orgA: `org_invasg_a_${suffix}`,
  orgB: `org_invasg_b_${suffix}`,
  branchA: `br_invasg_a_${suffix}`,
  branchB: `br_invasg_b_${suffix}`,
  closedBranch: `br_invasg_c_${suffix}`,
  branchOther: `br_invasg_o_${suffix}`,
  roleA: `role_invasg_a_${suffix}`,
  roleB: `role_invasg_b_${suffix}`,
  roleOwner: `role_invasg_own_${suffix}`,
  roleWildcard: `role_invasg_all_${suffix}`,
  ownerRoleHolder: `user_invasg_own_${suffix}`,
  wildcardAdmin: `user_invasg_all_${suffix}`,
  assigned: `user_invasg_ok_${suffix}`,
  inactive: `user_invasg_off_${suffix}`,
  sibling: `user_invasg_sib_${suffix}`,
  closed: `user_invasg_cls_${suffix}`,
  admin: `user_invasg_adm_${suffix}`,
  outsider: `user_invasg_out_${suffix}`,
};

type Person = { id: string; role: 'ADMIN' | 'EMPLOYEE'; organizationId: string };
type InventoryCaller = ReturnType<
  (typeof import('./pharmacy-inventory'))['pharmacyInventoryRouter']['createCaller']
>;

const OUTSIDE_SCOPE = { code: 'FORBIDDEN', message: 'Branch is outside your scope.' };
const NOT_IN_WORKSPACE = { code: 'BAD_REQUEST', message: 'That record is not in this workspace.' };

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let inventory: typeof import('./pharmacy-inventory');
let disconnect: (() => Promise<void>) | null = null;

function context(db: unknown, tenantId: string, user: Person) {
  return {
    db,
    entitlements: {
      organizationId: tenantId,
      enabledModules: ['pharmacy-inventory'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: {
        id: user.id,
        role: user.role,
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId: user.organizationId,
      },
    },
    organization: { id: tenantId, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never;
}

async function act<T>(
  user: Person,
  run: (api: InventoryCaller, ctx: never) => Promise<T>
): Promise<T> {
  return withTenantDb(
    user.organizationId,
    (db) => {
      const ctx = context(db, user.organizationId, user);
      return run(inventory.pharmacyInventoryRouter.createCaller(ctx) as InventoryCaller, ctx);
    },
    { timeout: 60_000 }
  );
}

/** All 18 assignment-checked procedures, as one caller would reach them. */
function gatedCalls(
  api: InventoryCaller,
  branchId: string
): Array<[string, () => Promise<unknown>]> {
  const key = `${branchId}-${suffix}`;
  return [
    ['createLocation', () => api.createLocation({ branchId, code: 'X', name: 'X', kind: 'STORE' })],
    [
      'receiveLot',
      () =>
        api.receiveLot({
          branchId,
          manufacturingBatchId: 'missing',
          packLevelId: 'missing',
          stockLocationId: 'missing',
          unitsPerPack: 10,
          supplierName: 'Distributor',
          supplierInvoiceRef: 'INV-1',
          unitCostMinor: 100,
          printedMrpMinor: 200,
          printedExpiry: new Date('2027-06-15T00:00:00.000Z'),
          expiryPrecision: 'DAY',
          quantityUnits: 1,
          idempotencyKey: `receive-${key}`,
        }),
    ],
    [
      'createCount',
      () =>
        api.createCount({
          branchId,
          varianceThreshold: 0,
          readings: [
            {
              inventoryLotId: 'missing',
              stockLocationId: 'missing',
              countedSealedPacks: 0,
              countedLooseUnits: 0,
            },
          ],
        }),
    ],
    [
      'writeOff',
      () =>
        api.writeOff({
          branchId,
          inventoryLotId: 'missing',
          stockLocationId: 'missing',
          units: 1,
          witnessId: 'missing',
          reason: 'Damaged',
          evidenceRef: 'photo',
          idempotencyKey: `write-off-${key}`,
        }),
    ],
    ['nearExpiryBoard', () => api.nearExpiryBoard({ branchId })],
    ['onHand', () => api.onHand({ branchId, medicineId: 'missing' })],
    ['temperatureZoneStatuses', () => api.temperatureZoneStatuses({ branchId })],
    ['expiryBoardLots', () => api.expiryBoardLots({ branchId, withinDays: 90 })],
    ['stockSignalDashboard', () => api.stockSignalDashboard({ branchId })],
    ['stockSignalDigest', () => api.stockSignalDigest({ branchId, ownerUserId: 'missing' })],
    ['transferBoard', () => api.transferBoard({ branchId })],
    [
      'allocateForSale',
      () =>
        api.allocateForSale({
          branchId,
          medicineId: 'missing',
          requiredUnits: 1,
          idempotencyKeyPrefix: `sale-${key}`,
        }),
    ],
    [
      'transfer',
      () =>
        api.transfer({
          branchId,
          inventoryLotId: 'missing',
          fromStockLocationId: 'missing-from',
          toStockLocationId: 'missing-to',
          units: 1,
          idempotencyKeyPrefix: `move-${key}`,
        }),
    ],
    [
      'allocateTransfer',
      () =>
        api.allocateTransfer({
          branchId,
          toBranchId: ids.branchB === branchId ? ids.branchA : ids.branchB,
          lines: [
            {
              sourceLotId: 'missing',
              sourceStockLocationId: 'missing',
              destinationStockLocationId: 'missing',
              quantityUnits: 1,
            },
          ],
        }),
    ],
    ['approveTransfer', () => api.approveTransfer({ branchId, transferId: 'missing' })],
    [
      'dispatchTransfer',
      () =>
        api.dispatchTransfer({ branchId, transferId: 'missing', idempotencyKeyPrefix: `d-${key}` }),
    ],
    [
      'receiveTransferLine',
      () =>
        api.receiveTransferLine({
          branchId,
          transferId: 'missing',
          lineId: 'missing',
          receivedUnits: 1,
          idempotencyKeyPrefix: `r-${key}`,
        }),
    ],
    [
      'receiveTransferWithVariance',
      () =>
        api.receiveTransferWithVariance({
          branchId,
          transferId: 'missing',
          lines: [{ lineId: 'missing', receivedUnits: 1 }],
          idempotencyKeyPrefix: `v-${key}`,
        }),
    ],
  ];
}

/** Every one of the 18 must refuse with exactly this error before touching stock. */
async function expectRefusedEverywhere(api: InventoryCaller, branchId: string, refusal: object) {
  const calls = gatedCalls(api, branchId);
  expect(calls).toHaveLength(18);
  for (const [name, call] of calls) {
    const outcome = await call().then(
      () => ({ name, resolved: true }),
      (error: unknown) => ({ name, error })
    );
    expect(outcome, name).toMatchObject({ name, error: refusal });
  }
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const { db } = await import('@/lib/db');
  inventory = await import('./pharmacy-inventory');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  disconnect = () => db.$disconnect();

  const [role] = await withPlatformDb((tx) =>
    tx.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    )
  );
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });

  await withPlatformDb(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, 'Assignment A', 'Assignment A', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now()),
              ($2, $2, 'Assignment B', 'Assignment B', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      ids.orgA,
      ids.orgB
    );
  });

  const address = { addressLine: '1 Road', city: 'Lahore', provinceCode: 'PB' };
  await withTenantDb(ids.orgA, async (tx) => {
    await seedDepartments(tx, [ids.orgA], ['LEADERSHIP']);
    await tx.pharmacyBranch.createMany({
      data: [
        { id: ids.branchA, code: 'A', name: 'Branch A', ...address },
        { id: ids.branchB, code: 'B', name: 'Branch B', ...address },
        { id: ids.closedBranch, code: 'C', name: 'Closed', active: false, ...address },
      ],
    });
    await tx.organizationRole.create({
      data: {
        id: ids.roleA,
        key: `inventory-${suffix}`,
        name: 'Inventory',
        permissions: { create: [{ capability: 'pharmacy:inventory', effect: 'ALLOW' }] },
      },
    });
    // The system Owner template a tenant administrator can hand to any member,
    // and the provisioning-style administrator role with `*`.
    await tx.organizationRole.create({
      data: {
        id: ids.roleOwner,
        key: 'owner',
        name: 'Owner',
        isSystem: true,
        permissions: { create: [{ capability: 'pharmacy:*', effect: 'ALLOW' }] },
      },
    });
    await tx.organizationRole.create({
      data: {
        id: ids.roleWildcard,
        key: 'admin',
        name: 'Organization administrator',
        isSystem: true,
        permissions: { create: [{ capability: '*', effect: 'ALLOW' }] },
      },
    });
    const people = [
      { id: ids.assigned, role: 'EMPLOYEE' as const, roleId: ids.roleA },
      { id: ids.inactive, role: 'EMPLOYEE' as const, roleId: ids.roleA },
      { id: ids.sibling, role: 'EMPLOYEE' as const, roleId: ids.roleA },
      { id: ids.closed, role: 'EMPLOYEE' as const, roleId: ids.roleA },
      { id: ids.admin, role: 'ADMIN' as const, roleId: ids.roleA },
      { id: ids.ownerRoleHolder, role: 'EMPLOYEE' as const, roleId: ids.roleOwner },
      { id: ids.wildcardAdmin, role: 'ADMIN' as const, roleId: ids.roleWildcard },
    ];
    for (const person of people) {
      await tx.user.create({
        data: {
          id: person.id,
          name: person.id,
          email: `${person.id}@example.test`,
          department: 'LEADERSHIP',
          title: 'Inventory',
          role: person.role,
          organizationRoleId: person.roleId,
        },
      });
    }
    await tx.pharmacyBranchAssignment.createMany({
      data: [
        { userId: ids.assigned, branchId: ids.branchA },
        { userId: ids.inactive, branchId: ids.branchA, active: false },
        { userId: ids.sibling, branchId: ids.branchB },
        { userId: ids.closed, branchId: ids.closedBranch },
      ],
    });
  });

  await withTenantDb(ids.orgB, async (tx) => {
    await seedDepartments(tx, [ids.orgB], ['LEADERSHIP']);
    await tx.pharmacyBranch.create({
      data: { id: ids.branchOther, code: 'O', name: 'Other tenant', ...address },
    });
    await tx.organizationRole.create({
      data: {
        id: ids.roleB,
        key: `inventory-${suffix}`,
        name: 'Inventory',
        permissions: { create: [{ capability: 'pharmacy:inventory', effect: 'ALLOW' }] },
      },
    });
    await tx.user.create({
      data: {
        id: ids.outsider,
        name: 'Outsider',
        email: `${ids.outsider}@example.test`,
        department: 'LEADERSHIP',
        title: 'Inventory',
        organizationRoleId: ids.roleB,
      },
    });
    await tx.pharmacyBranchAssignment.create({
      data: { userId: ids.outsider, branchId: ids.branchOther },
    });
  });
});

afterAll(async () => {
  await disconnect?.();
});

const person = (id: string, role: Person['role'] = 'EMPLOYEE'): Person => ({
  id,
  role,
  organizationId: ids.orgA,
});

describeIfDatabase('inventory branch assignment against Postgres', () => {
  it('admits an active assignment to the branch and only that branch', async () => {
    await act(person(ids.assigned), async (api, ctx) => {
      await expect(api.transferBoard({ branchId: ids.branchA })).resolves.toEqual([]);
      await expect(api.nearExpiryBoard({ branchId: ids.branchA })).resolves.toBeDefined();
      // Admitted, so the refusal is now the ledger's own: no such transfer here.
      await expect(
        api.approveTransfer({ branchId: ids.branchA, transferId: 'missing' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'CROSS_BRANCH_REFERENCE' });
      await expectRefusedEverywhere(api, ids.branchB, OUTSIDE_SCOPE);
      await expect(inventory.assignedInventoryBranchIds(ctx)).resolves.toEqual(
        new Set([ids.branchA])
      );
    });
  });

  it('refuses an inactive assignment', async () => {
    await act(person(ids.inactive), async (api, ctx) => {
      await expectRefusedEverywhere(api, ids.branchA, OUTSIDE_SCOPE);
      await expect(inventory.assignedInventoryBranchIds(ctx)).resolves.toEqual(new Set());
    });
  });

  it('refuses an assignment that belongs to a sibling branch', async () => {
    await act(person(ids.sibling), async (api, ctx) => {
      await expectRefusedEverywhere(api, ids.branchA, OUTSIDE_SCOPE);
      await expect(inventory.assignedInventoryBranchIds(ctx)).resolves.toEqual(
        new Set([ids.branchB])
      );
    });
  });

  it('refuses an unassigned session ADMIN: administrators are not exempt', async () => {
    await act(person(ids.admin, 'ADMIN'), async (api, ctx) => {
      await expectRefusedEverywhere(api, ids.branchA, OUTSIDE_SCOPE);
      await expect(inventory.assignedInventoryBranchIds(ctx)).resolves.toEqual(new Set());
    });
  });

  it('refuses a member holding the system Owner role template without an assignment', async () => {
    // The Owner template is assignable by any tenant administrator, so it is not
    // proof of ownership and grants no cross-branch scope.
    await act(person(ids.ownerRoleHolder), async (api, ctx) => {
      await expectRefusedEverywhere(api, ids.branchA, OUTSIDE_SCOPE);
      await expect(inventory.assignedInventoryBranchIds(ctx)).resolves.toEqual(new Set());
    });
  });

  it('refuses an unassigned ADMIN whose role grants *', async () => {
    await act(person(ids.wildcardAdmin, 'ADMIN'), async (api, ctx) => {
      await expectRefusedEverywhere(api, ids.branchA, OUTSIDE_SCOPE);
      await expect(inventory.assignedInventoryBranchIds(ctx)).resolves.toEqual(new Set());
    });
  });

  it('refuses an inactive branch even with an assignment to it', async () => {
    await act(person(ids.closed), async (api, ctx) => {
      await expectRefusedEverywhere(api, ids.closedBranch, NOT_IN_WORKSPACE);
      await expect(inventory.assignedInventoryBranchIds(ctx)).resolves.toEqual(new Set());
    });
  });

  it("never resolves another tenant's branch, whatever that tenant's assignments say", async () => {
    await act(person(ids.assigned), async (api) => {
      await expectRefusedEverywhere(api, ids.branchOther, NOT_IN_WORKSPACE);
    });
  });
});
