/**
 * #521 — return and refund authorization against PostgreSQL as a NOSUPERUSER NOBYPASSRLS role.
 *
 * `returnLine` restores stock and `refundTender` pays money out of the drawer. Both now need the
 * canonical counter capability, read by central ABAC from the persisted role and overrides, and an
 * active assignment to that exact branch. A session ADMIN gets no branch exception here.
 *
 * Refused callers get FORBIDDEN before the domain runs. An authorized caller reaches the domain,
 * which refuses the synthetic line and tender as NOT_FOUND / REFUND_EXCEEDS_TENDER: that is the
 * proof the authorization let it through. Skipped unless TEST_DATABASE_URL is set.
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
  orgA: `org_r521_a_${suffix}`,
  orgB: `org_r521_b_${suffix}`,
  branchA: `br_r521_a_${suffix}`,
  branchB: `br_r521_b_${suffix}`,
  branchOther: `br_r521_o_${suffix}`,
  roleCounter: `role_r521_counter_${suffix}`,
  roleLegacy: `role_r521_legacy_${suffix}`,
  roleOrders: `role_r521_orders_${suffix}`,
  roleDispense: `role_r521_dispense_${suffix}`,
  roleOwner: `role_r521_owner_${suffix}`,
  cashier: `user_r521_cashier_${suffix}`,
  unassigned: `user_r521_unassigned_${suffix}`,
  elsewhere: `user_r521_elsewhere_${suffix}`,
  legacy: `user_r521_legacy_${suffix}`,
  orders: `user_r521_orders_${suffix}`,
  dispenser: `user_r521_dispenser_${suffix}`,
  owner: `user_r521_owner_${suffix}`,
  deniedOwner: `user_r521_denied_${suffix}`,
  admin: `user_r521_admin_${suffix}`,
  assignedAdmin: `user_r521_admin_assigned_${suffix}`,
  outsider: `user_r521_outsider_${suffix}`,
};

type Session = { id: string; role: 'ADMIN' | 'EMPLOYEE'; organizationId: string };
type SalesCaller = {
  returnLine: (input: {
    branchId: string;
    saleLineId: string;
    canonicalUnits: number;
    reason: string;
    integrityDecision: string;
    idempotencyKey: string;
  }) => Promise<unknown>;
  refundTender: (input: {
    branchId: string;
    originalTenderId: string;
    deviceId: string;
    businessDate: Date;
    amountMinor: number;
    reason: string;
    idempotencyKey: string;
  }) => Promise<unknown>;
};

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let pharmacySalesRouter: typeof import('./pharmacy-sales').pharmacySalesRouter;
let disconnect: (() => Promise<void>) | null = null;

function caller(db: unknown, tenantId: string, user: Session): SalesCaller {
  return pharmacySalesRouter.createCaller({
    db,
    entitlements: {
      organizationId: tenantId,
      enabledModules: ['pharmacy-counter'],
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
  } as never) as SalesCaller;
}

function act<T>(user: Session, run: (api: SalesCaller) => Promise<T>, tenantId = ids.orgA) {
  return withTenantDb(tenantId, (db) => run(caller(db, tenantId, user)), {
    timeout: 60_000,
    userId: user.id,
  });
}

const employee = (id: string): Session => ({ id, role: 'EMPLOYEE', organizationId: ids.orgA });
const administrator = (id: string): Session => ({ id, role: 'ADMIN', organizationId: ids.orgA });

const returnInput = (branchId = ids.branchA) => ({
  branchId,
  saleLineId: `line_missing_${suffix}`,
  canonicalUnits: 1,
  reason: 'WRONG_ITEM',
  integrityDecision: 'Sealed strip',
  idempotencyKey: randomUUID(),
});
const refundInput = (branchId = ids.branchA) => ({
  branchId,
  originalTenderId: `tender_missing_${suffix}`,
  deviceId: `device_${suffix}`,
  businessDate: new Date('2026-10-22T00:00:00.000Z'),
  amountMinor: 100,
  reason: 'WRONG_ITEM',
  idempotencyKey: randomUUID(),
});

const NOT_ASSIGNED = {
  code: 'FORBIDDEN',
  message: 'You must be assigned to this branch to record returns and refunds.',
};
const NO_COUNTER = {
  code: 'FORBIDDEN',
  message: 'Counter permission is required to record returns and refunds.',
};

async function expectRefused(user: Session, refusal: object, branchId = ids.branchA) {
  await expect(act(user, (api) => api.returnLine(returnInput(branchId)))).rejects.toMatchObject(
    refusal
  );
  await expect(act(user, (api) => api.refundTender(refundInput(branchId)))).rejects.toMatchObject(
    refusal
  );
}

/** The domain refuses the synthetic line and tender only once authorization has passed. */
async function expectAuthorized(user: Session) {
  await expect(act(user, (api) => api.returnLine(returnInput()))).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
  await expect(act(user, (api) => api.refundTender(refundInput()))).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'REFUND_EXCEEDS_TENDER',
  });
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const sales = await import('./pharmacy-sales');
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const { db } = await import('@/lib/db');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  pharmacySalesRouter = sales.pharmacySalesRouter;
  disconnect = () => db.$disconnect();

  const [role] = await withPlatformDb((tx) =>
    tx.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    )
  );
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });

  await withPlatformDb((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, 'Returns A', 'Returns A', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now()),
              ($2, $2, 'Returns B', 'Returns B', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      ids.orgA,
      ids.orgB
    )
  );

  const address = { addressLine: '1 Road', city: 'Lahore', provinceCode: 'PB' };
  await withTenantDb(ids.orgA, async (tx) => {
    await seedDepartments(tx, [ids.orgA], ['LEADERSHIP']);
    await tx.pharmacyBranch.createMany({
      data: [
        { id: ids.branchA, code: 'A', name: 'Counter A', ...address },
        { id: ids.branchB, code: 'B', name: 'Counter B', ...address },
      ],
    });
    // Persisted roles, as provisioned and as #163's migration leaves existing ones.
    for (const [roleId, capability] of [
      [ids.roleCounter, 'pharmacy:counter'],
      [ids.roleLegacy, 'pharmacy.counter'],
      [ids.roleOrders, 'pharmacy:orders'],
      [ids.roleDispense, 'pharmacy:dispense'],
      [ids.roleOwner, 'pharmacy:*'],
    ] as const) {
      await tx.organizationRole.create({
        data: {
          id: roleId,
          key: roleId,
          name: roleId,
          permissions: { create: [{ capability, effect: 'ALLOW' }] },
        },
      });
    }
    const people: Array<{ id: string; roleId: string; role?: 'ADMIN' }> = [
      { id: ids.cashier, roleId: ids.roleCounter },
      { id: ids.unassigned, roleId: ids.roleCounter },
      { id: ids.elsewhere, roleId: ids.roleCounter },
      { id: ids.legacy, roleId: ids.roleLegacy },
      { id: ids.orders, roleId: ids.roleOrders },
      { id: ids.dispenser, roleId: ids.roleDispense },
      { id: ids.owner, roleId: ids.roleOwner },
      { id: ids.deniedOwner, roleId: ids.roleOwner },
      { id: ids.admin, roleId: ids.roleCounter, role: 'ADMIN' },
      { id: ids.assignedAdmin, roleId: ids.roleCounter, role: 'ADMIN' },
    ];
    for (const person of people) {
      await tx.user.create({
        data: {
          id: person.id,
          name: person.id,
          email: `${person.id}@example.test`,
          department: 'LEADERSHIP',
          title: 'Counter',
          role: person.role ?? 'EMPLOYEE',
          organizationRoleId: person.roleId,
        },
      });
    }
    await tx.userPermissionOverride.create({
      data: {
        userId: ids.deniedOwner,
        capability: 'pharmacy:counter',
        effect: 'DENY',
        reason: 'Suspended from the till',
      },
    });
    await tx.pharmacyBranchAssignment.createMany({
      data: [
        { userId: ids.cashier, branchId: ids.branchA },
        { userId: ids.elsewhere, branchId: ids.branchB },
        { userId: ids.legacy, branchId: ids.branchA },
        { userId: ids.orders, branchId: ids.branchA },
        { userId: ids.dispenser, branchId: ids.branchA },
        { userId: ids.owner, branchId: ids.branchA },
        { userId: ids.deniedOwner, branchId: ids.branchA },
        { userId: ids.assignedAdmin, branchId: ids.branchA },
        // The unassigned ADMIN is assigned elsewhere only.
        { userId: ids.admin, branchId: ids.branchB },
      ],
    });
  });

  await withTenantDb(ids.orgB, async (tx) => {
    await seedDepartments(tx, [ids.orgB], ['LEADERSHIP']);
    await tx.pharmacyBranch.create({
      data: { id: ids.branchOther, code: 'O', name: 'Other', ...address },
    });
    await tx.organizationRole.create({
      data: {
        id: `role_r521_out_${suffix}`,
        key: `out-${suffix}`,
        name: 'Outsider',
        permissions: { create: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }] },
      },
    });
    await tx.user.create({
      data: {
        id: ids.outsider,
        name: 'Outsider',
        email: `${ids.outsider}@example.test`,
        department: 'LEADERSHIP',
        title: 'Outsider',
        organizationRoleId: `role_r521_out_${suffix}`,
      },
    });
    await tx.pharmacyBranchAssignment.create({
      data: { userId: ids.outsider, branchId: ids.branchOther },
    });
  });
}, 120_000);

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('returns and refunds need the counter grant and this branch (#521)', () => {
  it('lets an assigned counter user and an assigned owner reach the return and refund domain', async () => {
    await expectAuthorized(employee(ids.cashier));
    await expectAuthorized(employee(ids.owner));
    await expectAuthorized(administrator(ids.assignedAdmin));
  });

  it('refuses counter users without an assignment to this branch, ADMIN included', async () => {
    await expectRefused(employee(ids.unassigned), NOT_ASSIGNED);
    await expectRefused(employee(ids.elsewhere), NOT_ASSIGNED);
    await expectRefused(administrator(ids.admin), NOT_ASSIGNED);
  });

  it('refuses assigned staff whose persisted grants do not include the counter capability', async () => {
    await expectRefused(employee(ids.orders), NO_COUNTER);
    await expectRefused(employee(ids.dispenser), NO_COUNTER);
    await expectRefused(employee(ids.legacy), NO_COUNTER);
    await expectRefused(employee(ids.deniedOwner), NO_COUNTER);
  });

  it('refuses another organization’s member and branch before reading grants', async () => {
    await expectRefused(
      { id: ids.outsider, role: 'EMPLOYEE', organizationId: ids.orgB },
      { code: 'FORBIDDEN', message: 'Branch is outside your scope.' }
    );
    await expectRefused(
      employee(ids.cashier),
      { code: 'FORBIDDEN', message: 'Branch is outside your scope.' },
      ids.branchOther
    );
  });
});
