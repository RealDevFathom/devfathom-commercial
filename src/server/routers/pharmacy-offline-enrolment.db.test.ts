/**
 * DEV-957 phase 1 — counter enrolment, rotation, revocation (and its races with a
 * stock grant or a receipt reservation), the counters list and the offline
 * preparation plan, through the real tRPC procedures and real ABAC, against migrated PostgreSQL with FORCE row level security, as the
 * NOSUPERUSER / NOBYPASSRLS runtime role. Nothing in `@/lib/abac` is mocked.
 *
 * Skipped unless TEST_DATABASE_URL names that role on a migrated disposable database.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const describeIfDatabase = databaseUrl ? describe : describe.skip;

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ids = {
  orgA: `org_dev957_a_${suffix}`,
  orgB: `org_dev957_b_${suffix}`,
  branchA: `br_dev957_a_${suffix}`,
  branchB: `br_dev957_b_${suffix}`,
  adminRoleA: `role_dev957_adm_a_${suffix}`,
  adminRoleB: `role_dev957_adm_b_${suffix}`,
  cashierRole: `role_dev957_cash_${suffix}`,
  ownerA: `user_dev957_own_a_${suffix}`,
  ownerB: `user_dev957_own_b_${suffix}`,
  cashierA: `user_dev957_cash_a_${suffix}`,
  managerRole: `role_dev957_mgr_${suffix}`,
  managerA: `user_dev957_mgr_a_${suffix}`,
  branchA2: `br_dev957_a2_${suffix}`,
};

type Person = { id: string; role: 'ADMIN' | 'EMPLOYEE'; org: string };
const ownerA: Person = { id: ids.ownerA, role: 'ADMIN', org: ids.orgA };
const ownerB: Person = { id: ids.ownerB, role: 'ADMIN', org: ids.orgB };
const cashierA: Person = { id: ids.cashierA, role: 'EMPLOYEE', org: ids.orgA };
/** Not an organization ADMIN, but granted admin:access by role; assigned to branch A2 only. */
const managerA: Person = { id: ids.managerA, role: 'EMPLOYEE', org: ids.orgA };

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let offlineRouter: (typeof import('./pharmacy-offline'))['pharmacyOfflineRouter'];
let router: (typeof import('../trpc'))['router'];
let devices: typeof import('@/lib/pharmacy/offline-devices');
let disconnect: (() => Promise<void>) | null = null;

function context(db: unknown, user: Person) {
  return {
    db,
    entitlements: {
      organizationId: user.org,
      vertical: 'PHARMACY',
      enabledModules: ['pharmacy-core', 'pharmacy-counter'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 2,
    },
    session: {
      expires: 'later',
      user: {
        id: user.id,
        name: user.id,
        role: user.role,
        department: 'PHARMACY',
        status: 'ACTIVE',
        organizationId: user.org,
      },
    },
    organization: { id: user.org, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {}, db },
  } as unknown as import('../trpc').TRPCContext;
}

function mounted() {
  return router({ pharmacyOffline: offlineRouter });
}
type Api = ReturnType<ReturnType<typeof mounted>['createCaller']>;
type OfflineCaller = ReturnType<(typeof offlineRouter)['createCaller']>;

function act<T>(user: Person, run: (api: OfflineCaller) => Promise<T>): Promise<T> {
  return withTenantDb(
    user.org,
    (db) =>
      run(
        (mounted().createCaller(context(db, user)) as Api)
          .pharmacyOffline as unknown as OfflineCaller
      ),
    { timeout: 60_000 }
  );
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return { code: (error as { code?: string }).code, message: (error as Error).message };
  }
  throw new Error('expected a refusal');
}

/** A promise and the function that resolves it, for stepping two transactions in turn. */
function latch() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/**
 * The same transaction client, except that `model.method` first runs `before`. Nested
 * `$transaction` calls (the tRPC procedures open one) hand back the same wrapping.
 */
function pausing<T extends object>(
  db: T,
  model: string,
  method: string,
  before: () => Promise<void>
): T {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        const run = Reflect.get(target, prop, receiver) as (
          fn: (tx: unknown) => Promise<unknown>,
          ...rest: unknown[]
        ) => Promise<unknown>;
        return (fn: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
          run.call(target, (tx) => fn(pausing(tx as object, model, method, before)), ...rest);
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (prop === model && value && typeof value === 'object') {
        const delegate = value as Record<string, (...args: unknown[]) => Promise<unknown>>;
        return new Proxy(delegate, {
          get(inner, key) {
            const original = Reflect.get(inner, key) as unknown;
            if (key !== method || typeof original !== 'function') return original;
            return async (...args: unknown[]) => {
              await before();
              return (original as (...a: unknown[]) => Promise<unknown>).apply(inner, args);
            };
          },
        });
      }
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** Whether `promise` is still pending after `ms` (it is waiting on a row lock). */
async function stillWaiting(promise: Promise<unknown>, ms = 400) {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true)
  );
  await new Promise((resolve) => setTimeout(resolve, ms));
  return !settled;
}

const LATER = new Date(Date.now() + 365 * 24 * 3_600_000);
const EARLIER = new Date(Date.now() - 24 * 3_600_000);

/** One medicine with one lot holding `units` AVAILABLE units at `locationId`. */
async function stock(
  label: string,
  flags: Partial<Record<'rx' | 'controlled' | 'restricted' | 'highAlert' | 'lasa', boolean>>,
  options: { units?: number; expiresAt?: Date; recalled?: boolean } = {}
) {
  return withTenantDb(ids.orgA, async (db) => {
    const medicine = await db.medicine.create({
      data: {
        productName: `DEV957 ${label} ${suffix}`,
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        ...flags,
        presentations: { create: { presentation: 'Tablet, 10 per strip' } },
      },
      include: { presentations: true },
    });
    const pack = await db.packLevel.create({
      data: {
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `pack-${label}-${suffix}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        medicineId: medicine.id,
        batchNumber: `B-${label}-${suffix}`,
        expiresAt: options.expiresAt ?? LATER,
        expiryPrecision: 'DAY',
        ...(options.recalled
          ? { state: 'RECALLED' as const, stateReason: 'Recall notice', stateChangedAt: new Date() }
          : {}),
      },
    });
    const units = options.units ?? 30;
    const lot = await db.pharmacyInventoryLot.create({
      data: {
        branchId: ids.branchA,
        manufacturingBatchId: batch.id,
        packLevelId: pack.id,
        unitsPerPack: 10,
        supplierName: 'Supplier',
        supplierInvoiceRef: `INV-${label}-${suffix}`,
        unitCostMinor: 50,
        printedMrpMinor: 1_000,
        receivedExpiresAt: options.expiresAt ?? LATER,
        receivedExpiryPrecision: 'DAY',
        receivedAt: new Date(),
      },
    });
    // The balance projection is maintained by the ledger trigger from movements.
    await db.pharmacyStockMovement.create({
      data: {
        branchId: ids.branchA,
        inventoryLotId: lot.id,
        stockLocationId: locationId,
        kind: 'RECEIPT',
        disposition: 'AVAILABLE',
        quantityUnits: units,
        sealedPackDelta: Math.floor(units / 10),
        looseUnitDelta: units % 10,
        actorId: ids.ownerA,
        idempotencyKey: `receipt-${label}-${suffix}`,
        occurredAt: new Date(),
      },
    });
    return { medicineId: medicine.id, lotId: lot.id };
  });
}

let locationId = '';

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const { db } = await import('@/lib/db');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  offlineRouter = (await import('./pharmacy-offline')).pharmacyOfflineRouter;
  router = (await import('../trpc')).router;
  devices = await import('@/lib/pharmacy/offline-devices');
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
       SELECT id, id, id, id, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now() FROM unnest($1::text[]) AS id`,
      [ids.orgA, ids.orgB]
    )
  );
  const address = { addressLine: '1 Road', city: 'Lahore', provinceCode: 'PB' };
  for (const [org, branch, adminRole, owner] of [
    [ids.orgA, ids.branchA, ids.adminRoleA, ids.ownerA],
    [ids.orgB, ids.branchB, ids.adminRoleB, ids.ownerB],
  ] as const) {
    await withTenantDb(org, async (tx) => {
      await seedDepartments(tx, [org], ['PHARMACY']);
      await tx.pharmacyBranch.create({
        data: { id: branch, code: 'MAIN', name: 'Main', ...address },
      });
      await tx.organizationRole.create({
        data: {
          id: adminRole,
          key: 'admin',
          name: 'Organization administrator',
          isSystem: true,
          permissions: { create: [{ capability: '*', effect: 'ALLOW' }] },
        },
      });
      await tx.user.create({
        data: {
          id: owner,
          name: owner,
          email: `${owner}@example.test`,
          department: 'PHARMACY',
          title: 'Owner',
          role: 'ADMIN',
          status: 'ACTIVE',
          organizationRoleId: adminRole,
        },
      });
    });
  }
  await withTenantDb(ids.orgA, async (tx) => {
    await tx.organizationRole.create({
      data: {
        id: ids.cashierRole,
        key: `cashier-${suffix}`,
        name: 'Cashier',
        permissions: {
          create: ['pharmacy:counter', 'pharmacy:orders'].map((capability) => ({
            capability,
            effect: 'ALLOW' as const,
          })),
        },
      },
    });
    await tx.user.create({
      data: {
        id: ids.cashierA,
        name: ids.cashierA,
        email: `${ids.cashierA}@example.test`,
        department: 'PHARMACY',
        title: 'Cashier',
        role: 'EMPLOYEE',
        status: 'ACTIVE',
        organizationRoleId: ids.cashierRole,
      },
    });
    await tx.pharmacyBranchAssignment.create({
      data: { userId: ids.cashierA, branchId: ids.branchA },
    });
    await tx.pharmacyBranch.create({
      data: { id: ids.branchA2, code: 'SECOND', name: 'Second', ...address },
    });
    await tx.organizationRole.create({
      data: {
        id: ids.managerRole,
        key: `branch-manager-${suffix}`,
        name: 'Branch manager',
        permissions: { create: [{ capability: 'admin:access', effect: 'ALLOW' as const }] },
      },
    });
    await tx.user.create({
      data: {
        id: ids.managerA,
        name: ids.managerA,
        email: `${ids.managerA}@example.test`,
        department: 'PHARMACY',
        title: 'Manager',
        role: 'EMPLOYEE',
        status: 'ACTIVE',
        organizationRoleId: ids.managerRole,
      },
    });
    await tx.pharmacyBranchAssignment.create({
      data: { userId: ids.managerA, branchId: ids.branchA2 },
    });
    const location = await tx.pharmacyStockLocation.create({
      data: {
        branchId: ids.branchA,
        code: `FRONT-${suffix}`,
        name: 'Front shelf',
        kind: 'RACK_BIN',
      },
    });
    locationId = location.id;
  });
}, 180_000);

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('DEV-957 counter enrolment procedures (runtime role, real ABAC)', () => {
  it('enrols for the owner, returns the secret once and never lists it', async () => {
    const enrolled = await act(ownerA, (api) =>
      api.enroll({ branchId: ids.branchA, name: 'Front counter' })
    );
    expect(enrolled.secret).toMatch(/^pcd_[A-Za-z0-9_-]{43}$/);
    expect(enrolled.device).toEqual({
      id: expect.any(String),
      name: 'Front counter',
      branchId: ids.branchA,
    });
    const listed = await act(ownerA, (api) => api.counters({ branchId: ids.branchA }));
    const row = listed.find((counter) => counter.id === enrolled.device.id);
    expect(row).toMatchObject({ name: 'Front counter', status: 'ACTIVE', receiptNumbersLeft: 0 });
    expect(JSON.stringify(listed)).not.toContain(enrolled.secret);
    expect(JSON.stringify(listed)).not.toMatch(/deviceSecretHash|pcd_/);
    // The audit entry names the action, never the secret.
    const audit = await withTenantDb(ids.orgA, (tx) =>
      tx.auditLog.findMany({ where: { action: 'pharmacyOffline.enroll', actorId: ids.ownerA } })
    );
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(enrolled.secret);
  });

  it('rotates: the new secret works and the old one never resolves again', async () => {
    const enrolled = await act(ownerA, (api) =>
      api.enroll({ branchId: ids.branchA, name: 'Rotating counter' })
    );
    const rotated = await act(ownerA, (api) =>
      api.rotate({ branchId: ids.branchA, deviceId: enrolled.device.id })
    );
    expect(rotated.secret).not.toBe(enrolled.secret);
    await withTenantDb(ids.orgA, async (tx) => {
      expect(await devices.resolvePharmacyCounterBySecret(tx, enrolled.secret)).toBeNull();
      expect((await devices.resolvePharmacyCounterBySecret(tx, rotated.secret))?.id).toBe(
        enrolled.device.id
      );
    });
  });

  it('revokes, and refuses to rotate a revoked counter', async () => {
    const enrolled = await act(ownerA, (api) =>
      api.enroll({ branchId: ids.branchA, name: 'Lost counter' })
    );
    const revoked = await act(ownerA, (api) =>
      api.revoke({ branchId: ids.branchA, deviceId: enrolled.device.id })
    );
    expect(revoked).toEqual({ deviceId: enrolled.device.id, status: 'REVOKED', quotasReleased: 0 });
    expect(
      await refusal(
        act(ownerA, (api) => api.rotate({ branchId: ids.branchA, deviceId: enrolled.device.id }))
      )
    ).toMatchObject({ code: 'CONFLICT', message: 'REVOKED' });
    const listed = await act(ownerA, (api) => api.counters({ branchId: ids.branchA }));
    expect(listed.find((row) => row.id === enrolled.device.id)?.status).toBe('REVOKED');
  });

  it('refuses enrol, rotate, revoke, the list and the plan to a cashier', async () => {
    const enrolled = await act(ownerA, (api) =>
      api.enroll({ branchId: ids.branchA, name: 'Cashier target' })
    );
    const attempts: Array<(api: OfflineCaller) => Promise<unknown>> = [
      (api) => api.enroll({ branchId: ids.branchA, name: 'Sneaky' }),
      (api) => api.rotate({ branchId: ids.branchA, deviceId: enrolled.device.id }),
      (api) => api.revoke({ branchId: ids.branchA, deviceId: enrolled.device.id }),
      (api) => api.counters({ branchId: ids.branchA }),
      (api) => api.preparationPlan({ branchId: ids.branchA, deviceId: enrolled.device.id }),
    ];
    for (const attempt of attempts)
      expect(await refusal(act(cashierA, attempt))).toMatchObject({ code: 'FORBIDDEN' });
    const after = await withTenantDb(ids.orgA, (tx) =>
      tx.pharmacyRegisteredDevice.findMany({ where: { name: 'Sneaky' } })
    );
    expect(after).toEqual([]);
    const device = await withTenantDb(ids.orgA, (tx) =>
      tx.pharmacyRegisteredDevice.findUnique({
        where: { organizationId_id: { organizationId: ids.orgA, id: enrolled.device.id } },
      })
    );
    expect(device?.status).toBe('ACTIVE');
  });

  it("refuses another tenant's owner on this tenant's branch and counters", async () => {
    const enrolled = await act(ownerA, (api) =>
      api.enroll({ branchId: ids.branchA, name: 'Tenant A counter' })
    );
    expect(
      await refusal(act(ownerB, (api) => api.enroll({ branchId: ids.branchA, name: 'Cross' })))
    ).toMatchObject({ code: 'FORBIDDEN', message: 'branch_unavailable' });
    expect(
      await refusal(act(ownerB, (api) => api.counters({ branchId: ids.branchA })))
    ).toMatchObject({ code: 'FORBIDDEN' });
    // Even naming tenant A's device under tenant B's own branch finds nothing.
    const crossTenant: Array<(api: OfflineCaller) => Promise<unknown>> = [
      (api: OfflineCaller) => api.rotate({ branchId: ids.branchB, deviceId: enrolled.device.id }),
      (api: OfflineCaller) => api.revoke({ branchId: ids.branchB, deviceId: enrolled.device.id }),
      (api: OfflineCaller) =>
        api.preparationPlan({ branchId: ids.branchB, deviceId: enrolled.device.id }),
    ];
    for (const attempt of crossTenant)
      expect(await refusal(act(ownerB, attempt))).toMatchObject({ code: 'NOT_FOUND' });
    const device = await withTenantDb(ids.orgA, (tx) =>
      tx.pharmacyRegisteredDevice.findUnique({
        where: { organizationId_id: { organizationId: ids.orgA, id: enrolled.device.id } },
      })
    );
    expect(device?.status).toBe('ACTIVE');
    expect(device?.deviceSecretHash).toBeDefined();
  });

  it('refuses a non-ADMIN with admin:access at a branch they are not assigned to (branch_forbidden)', async () => {
    const attempts: Array<(api: OfflineCaller) => Promise<unknown>> = [
      (api) => api.enroll({ branchId: ids.branchA, name: 'Unassigned manager' }),
      (api) => api.counters({ branchId: ids.branchA }),
    ];
    for (const attempt of attempts)
      expect(await refusal(act(managerA, attempt))).toMatchObject({
        code: 'FORBIDDEN',
        message: 'branch_forbidden',
      });
    const atOwnBranch = await act(managerA, (api) =>
      api.enroll({ branchId: ids.branchA2, name: 'Assigned manager counter' })
    );
    expect(atOwnBranch.device.branchId).toBe(ids.branchA2);
    const unassigned = await withTenantDb(ids.orgA, (tx) =>
      tx.pharmacyRegisteredDevice.findMany({ where: { name: 'Unassigned manager' } })
    );
    expect(unassigned).toEqual([]);
  });

  it('releases every open quota of a revoked counter, audited, so the units can be granted again once', async () => {
    const { grantDeviceLotQuota } = await import('@/lib/pharmacy/offline-quotas');
    const lot = await stock('release', {}, { units: 12 });
    const first = await act(ownerA, (api) =>
      api.enroll({ branchId: ids.branchA, name: 'Releasing counter' })
    );
    const second = await act(ownerA, (api) =>
      api.enroll({ branchId: ids.branchA, name: 'Receiving counter' })
    );
    const scope = { organizationId: ids.orgA, branchId: ids.branchA, actorId: ids.ownerA };
    const bucket = { inventoryLotId: lot.lotId, stockLocationId: locationId };
    const grant = (deviceId: string, units: number) =>
      withTenantDb(ids.orgA, (tx) =>
        grantDeviceLotQuota(tx, scope, { ...bucket, deviceId, units })
      );
    await grant(first.device.id, 10);
    // 12 on hand, 10 held: the second counter cannot take more than 2.
    await expect(grant(second.device.id, 3)).rejects.toMatchObject({
      reason: 'QUOTA_EXCEEDS_ON_HAND',
    });

    const revoked = await act(ownerA, (api) =>
      api.revoke({ branchId: ids.branchA, deviceId: first.device.id })
    );
    expect(revoked).toMatchObject({ status: 'REVOKED', quotasReleased: 1 });
    const rows = await withTenantDb(ids.orgA, (tx) =>
      tx.pharmacyDeviceLotQuota.findMany({ where: { deviceId: first.device.id } })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.releasedAt).toBeInstanceOf(Date);
    const audit = await withTenantDb(ids.orgA, (tx) =>
      tx.auditLog.findFirst({
        where: { action: 'pharmacyOffline.releaseOfflineQuotas', targetId: first.device.id },
      })
    );
    expect(audit?.actorId).toBe(ids.ownerA);
    expect(audit?.metadata).toMatchObject({ quotasReleased: 1, unitsReleased: 10 });

    // The 10 released units are free again, exactly once: 12 can be granted, 13 cannot.
    await expect(grant(second.device.id, 13)).rejects.toMatchObject({
      reason: 'QUOTA_EXCEEDS_ON_HAND',
    });
    await grant(second.device.id, 12);
    await expect(grant(second.device.id, 1)).rejects.toMatchObject({
      reason: 'QUOTA_EXCEEDS_ON_HAND',
    });
    // A second revoke finds nothing open, releases nothing twice and keeps the
    // first revocation time.
    const revokedAt = async () =>
      (
        await withTenantDb(ids.orgA, (tx) =>
          tx.pharmacyRegisteredDevice.findFirstOrThrow({ where: { id: first.device.id } })
        )
      ).revokedAt;
    const firstRevokedAt = await revokedAt();
    expect(firstRevokedAt).toBeInstanceOf(Date);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = await act(ownerA, (api) =>
      api.revoke({ branchId: ids.branchA, deviceId: first.device.id })
    );
    expect(again).toMatchObject({ status: 'REVOKED', quotasReleased: 0 });
    expect(await revokedAt()).toEqual(firstRevokedAt);
  });

  describe("a stock grant or receipt reservation racing the same counter's revoke", () => {
    const scope = { organizationId: ids.orgA, branchId: ids.branchA, actorId: ids.ownerA };

    /** Open units held by `deviceId`, open units held by every counter, and on hand. */
    async function ledger(lotId: string, deviceId: string) {
      return withTenantDb(ids.orgA, async (tx) => {
        const open = await tx.pharmacyDeviceLotQuota.findMany({
          where: { inventoryLotId: lotId, stockLocationId: locationId, releasedAt: null },
          select: { deviceId: true, quotaUnits: true, consumedUnits: true },
        });
        const held = (rows: typeof open) =>
          rows.reduce((total, row) => total + row.quotaUnits - row.consumedUnits, 0);
        const balance = await tx.pharmacyStockBalance.findFirstOrThrow({
          where: { inventoryLotId: lotId, stockLocationId: locationId, disposition: 'AVAILABLE' },
          select: { onHandUnits: true },
        });
        return {
          revokedHolds: held(open.filter((row) => row.deviceId === deviceId)),
          heldByAll: held(open),
          onHand: balance.onHandUnits,
        };
      });
    }

    /** on hand == held + free, where free is exactly what another counter can still take. */
    async function expectBalanced(lotId: string, revokedId: string) {
      const { grantDeviceLotQuota } = await import('@/lib/pharmacy/offline-quotas');
      const after = await ledger(lotId, revokedId);
      expect(after.revokedHolds).toBe(0);
      const free = after.onHand - after.heldByAll;
      const other = await act(ownerA, (api) =>
        api.enroll({ branchId: ids.branchA, name: `Other counter ${randomUUID().slice(0, 6)}` })
      );
      const grant = (units: number) =>
        withTenantDb(ids.orgA, (tx) =>
          grantDeviceLotQuota(tx, scope, {
            inventoryLotId: lotId,
            stockLocationId: locationId,
            deviceId: other.device.id,
            units,
          })
        );
      await expect(grant(free + 1)).rejects.toMatchObject({ reason: 'QUOTA_EXCEEDS_ON_HAND' });
      await grant(free);
      const settled = await ledger(lotId, revokedId);
      expect(settled.onHand).toBe(settled.heldByAll);
    }

    it('(a) grant checked the counter, then the revoke: the revoke waits and releases the grant', async () => {
      const { grantDeviceLotQuota } = await import('@/lib/pharmacy/offline-quotas');
      const lot = await stock('race-a', {}, { units: 8 });
      const counter = await act(ownerA, (api) =>
        api.enroll({ branchId: ids.branchA, name: 'Racing counter A' })
      );
      const checked = latch();
      const go = latch();
      const granting = withTenantDb(
        ids.orgA,
        (tx) =>
          grantDeviceLotQuota(
            pausing(tx, 'pharmacyDeviceLotQuota', 'create', async () => {
              checked.open();
              await go.opened;
            }),
            scope,
            {
              inventoryLotId: lot.lotId,
              stockLocationId: locationId,
              deviceId: counter.device.id,
              units: 4,
            }
          ),
        { timeout: 60_000 }
      );
      await checked.opened;
      const revoking = act(ownerA, (api) =>
        api.revoke({ branchId: ids.branchA, deviceId: counter.device.id })
      );
      // The grant holds the counter row: the revoke cannot commit before it.
      expect(await stillWaiting(revoking)).toBe(true);
      go.open();
      await expect(granting).resolves.toMatchObject({ quotaUnits: 4 });
      await expect(revoking).resolves.toMatchObject({ status: 'REVOKED', quotasReleased: 1 });
      await expectBalanced(lot.lotId, counter.device.id);
    });

    it('(b) grant while the revoke is in progress: the grant waits and is refused', async () => {
      const { grantDeviceLotQuota } = await import('@/lib/pharmacy/offline-quotas');
      const lot = await stock('race-b', {}, { units: 8 });
      const counter = await act(ownerA, (api) =>
        api.enroll({ branchId: ids.branchA, name: 'Racing counter B' })
      );
      const revokedRow = latch();
      const go = latch();
      // Pause the revoke after it updated the counter row and before it reads the
      // open quotas, so its transaction is in flight when the grant arrives.
      const revoking = withTenantDb(
        ids.orgA,
        (db) =>
          (
            mounted().createCaller(
              context(
                pausing(db, 'pharmacyDeviceLotQuota', 'findMany', async () => {
                  revokedRow.open();
                  await go.opened;
                }),
                ownerA
              )
            ) as Api
          ).pharmacyOffline.revoke({ branchId: ids.branchA, deviceId: counter.device.id }),
        { timeout: 60_000 }
      );
      await revokedRow.opened;
      const granting = withTenantDb(ids.orgA, (tx) =>
        grantDeviceLotQuota(tx, scope, {
          inventoryLotId: lot.lotId,
          stockLocationId: locationId,
          deviceId: counter.device.id,
          units: 4,
        })
      );
      expect(await stillWaiting(granting)).toBe(true);
      go.open();
      await expect(revoking).resolves.toMatchObject({ status: 'REVOKED', quotasReleased: 0 });
      await expect(granting).rejects.toMatchObject({ reason: 'DEVICE_NOT_USABLE' });
      await expectBalanced(lot.lotId, counter.device.id);
    });

    it('a receipt block reserved while the revoke is in progress waits and is refused', async () => {
      const { reserveReceiptNumberBlock } = await import('@/lib/pharmacy/offline-receipt-leases');
      const counter = await act(ownerA, (api) =>
        api.enroll({ branchId: ids.branchA, name: 'Racing counter C' })
      );
      const revokedRow = latch();
      const go = latch();
      const revoking = withTenantDb(
        ids.orgA,
        (db) =>
          (
            mounted().createCaller(
              context(
                pausing(db, 'pharmacyDeviceLotQuota', 'findMany', async () => {
                  revokedRow.open();
                  await go.opened;
                }),
                ownerA
              )
            ) as Api
          ).pharmacyOffline.revoke({ branchId: ids.branchA, deviceId: counter.device.id }),
        { timeout: 60_000 }
      );
      await revokedRow.opened;
      const reserving = withTenantDb(ids.orgA, (tx) =>
        reserveReceiptNumberBlock(tx, scope, { deviceId: counter.device.id, size: 5 })
      );
      expect(await stillWaiting(reserving)).toBe(true);
      go.open();
      await expect(revoking).resolves.toMatchObject({ status: 'REVOKED' });
      await expect(reserving).rejects.toMatchObject({ reason: 'DEVICE_NOT_USABLE' });
      const leases = await withTenantDb(ids.orgA, (tx) =>
        tx.pharmacyReceiptNumberLease.count({ where: { deviceId: counter.device.id } })
      );
      expect(leases).toBe(0);
    });
  });

  it('plans only safe over-the-counter stock, at half on hand capped at 20, net of other counters', async () => {
    const counter = await act(ownerA, (api) =>
      api.enroll({ branchId: ids.branchA, name: 'Planning counter' })
    );
    const other = await act(ownerA, (api) =>
      api.enroll({ branchId: ids.branchA, name: 'Other counter' })
    );
    const otc = await stock('otc', {}, { units: 30 });
    const big = await stock('big', {}, { units: 100 });
    const shared = await stock('shared', {}, { units: 12 });
    const excluded = await Promise.all([
      stock('rx', { rx: true }),
      stock('controlled', { controlled: true }),
      stock('restricted', { restricted: true }),
      stock('highalert', { highAlert: true }),
      stock('lasa', { lasa: true }),
      stock('recalled', {}, { recalled: true }),
      stock('expired', {}, { expiresAt: EARLIER }),
    ]);
    const { grantDeviceLotQuota } = await import('@/lib/pharmacy/offline-quotas');
    await withTenantDb(ids.orgA, (tx) =>
      grantDeviceLotQuota(
        tx,
        { organizationId: ids.orgA, branchId: ids.branchA, actorId: ids.ownerA },
        {
          deviceId: other.device.id,
          inventoryLotId: shared.lotId,
          stockLocationId: locationId,
          units: 10,
        }
      )
    );
    const plan = await act(ownerA, (api) =>
      api.preparationPlan({ branchId: ids.branchA, deviceId: counter.device.id })
    );
    const byLot = new Map(plan.lots.map((lot) => [lot.inventoryLotId, lot]));
    expect(byLot.get(otc.lotId)).toMatchObject({
      onHandUnits: 30,
      freeUnits: 30,
      suggestedUnits: 15,
    });
    expect(byLot.get(big.lotId)).toMatchObject({ onHandUnits: 100, suggestedUnits: 20 });
    // 12 on hand, 10 held by the other counter: at most the 2 still free.
    expect(byLot.get(shared.lotId)).toMatchObject({
      onHandUnits: 12,
      freeUnits: 2,
      suggestedUnits: 2,
    });
    for (const lot of excluded) expect(byLot.has(lot.lotId)).toBe(false);
    expect(plan.lots.every((lot) => lot.stockLocationId === locationId)).toBe(true);
  });
});
