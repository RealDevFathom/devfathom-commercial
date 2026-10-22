/**
 * #518 — Rx/restricted non-controlled lines need the exact pharmacy:dispense grant, or the
 * organization's allowCashierRxSale owner policy (default OFF), at addLine AND at payment.
 * Real router, persisted roles, PostgreSQL as a NOSUPERUSER NOBYPASSRLS role.
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeIfDatabase = databaseUrl ? describe : describe.skip;

vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

const suffix = randomBytes(6).toString('hex');
const ids = {
  org: `org_r518_${suffix}`,
  branch: `br_r518_${suffix}`,
  cashier: `user_r518_cashier_${suffix}`,
  pharmacist: `user_r518_pharm_${suffix}`,
};
type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let policy: typeof import('@/lib/pharmacy/owner-policy');
let pharmacySalesRouter: typeof import('./pharmacy-sales').pharmacySalesRouter;
let disconnect: (() => Promise<void>) | null = null;
let rx: { medicineId: string; presentationId: string; packLevelId: string };

type Line = { line: { id: string } };
type SalesCaller = {
  create: (input: { branchId: string }) => Promise<{ id: string }>;
  addLine: (input: Record<string, unknown>) => Promise<Line>;
  tender: (input: Record<string, unknown>) => Promise<unknown>;
};

function act<T>(userId: string, run: (api: SalesCaller, db: ScopedDb) => Promise<T>) {
  return withTenantDb(
    ids.org,
    (db) =>
      run(
        pharmacySalesRouter.createCaller({
          db,
          entitlements: {
            organizationId: ids.org,
            enabledModules: ['pharmacy-counter'],
            modules: [],
            limits: {},
            seatLimit: 10,
            activeSeats: 1,
          },
          session: {
            expires: 'later',
            user: {
              id: userId,
              role: 'EMPLOYEE',
              department: 'LEADERSHIP',
              status: 'ACTIVE',
              organizationId: ids.org,
            },
          },
          organization: { id: ids.org, vertical: 'PHARMACY' },
          support: null,
          requestMeta: { ip: null, userAgent: null },
          audit: { detail: {} },
        } as never) as unknown as SalesCaller,
        db
      ),
    { timeout: 60_000, userId }
  );
}

const rxLine = (saleId: string) => ({
  branchId: ids.branch,
  saleId,
  medicineId: rx.medicineId,
  presentationId: rx.presentationId,
  packLevelId: rx.packLevelId,
  saleUnit: 'STRIP',
  quantity: 1,
  canonicalUnitsPerSaleUnit: 10,
  idempotencyKey: randomBytes(8).toString('hex'),
});
const DENIED = {
  code: 'FORBIDDEN',
  message:
    'Selling a prescription-only or restricted medicine needs the pharmacist dispensing permission.',
};
const setPolicy = (allow: boolean) =>
  act(ids.pharmacist, (_api, db) =>
    policy.setAllowCashierRxSale(db, ids.org, ids.pharmacist, allow)
  );

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const sales = await import('./pharmacy-sales');
  const ledger = await import('@/lib/pharmacy/stock-ledger');
  policy = await import('@/lib/pharmacy/owner-policy');
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
       VALUES ($1, $1, 'Rx gate', 'Rx gate', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      ids.org
    )
  );
  await withTenantDb(ids.org, async (tx) => {
    await seedDepartments(tx, [ids.org], ['LEADERSHIP']);
    await tx.pharmacyBranch.create({
      data: {
        id: ids.branch,
        code: 'RX',
        name: 'Rx counter',
        addressLine: '1 Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    // Persisted roles: the Cashier template's grants, and a pharmacist with the exact grant.
    for (const [userId, capabilities] of [
      [ids.cashier, ['pharmacy:counter', 'pharmacy:orders']],
      [ids.pharmacist, ['pharmacy:dispense', 'pharmacy:counter']],
    ] as const) {
      await tx.organizationRole.create({
        data: {
          id: `role_${userId}`,
          key: `role_${userId}`,
          name: userId,
          permissions: {
            create: capabilities.map((capability) => ({ capability, effect: 'ALLOW' as const })),
          },
        },
      });
      await tx.user.create({
        data: {
          id: userId,
          name: userId,
          email: `${userId}@example.test`,
          department: 'LEADERSHIP',
          title: 'Counter',
          organizationRoleId: `role_${userId}`,
        },
      });
      await tx.pharmacyBranchAssignment.create({ data: { userId, branchId: ids.branch } });
    }
    const medicine = await tx.medicine.create({
      data: {
        productName: `Amoxicillin 500mg ${suffix}`,
        productFamily: 'PHARMACEUTICAL',
        rx: true,
        saleable: true,
        presentations: { create: { presentation: 'Capsule, 10 per strip' } },
      },
      include: { presentations: true },
    });
    const packLevel = await tx.packLevel.create({
      data: {
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `strip-${suffix}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const location = await tx.pharmacyStockLocation.create({
      data: { branchId: ids.branch, code: `MAIN-${suffix}`, name: 'Main', kind: 'STORE' },
    });
    const batch = await tx.pharmacyManufacturingBatch.create({
      data: {
        medicineId: medicine.id,
        batchNumber: `B-${suffix}`,
        expiresAt: new Date('2028-10-01T00:00:00.000Z'),
        expiryPrecision: 'DAY',
      },
    });
    await ledger.receiveLot(
      tx,
      { organizationId: ids.org, branchId: ids.branch, actorId: ids.pharmacist },
      {
        manufacturingBatchId: batch.id,
        packLevelId: packLevel.id,
        stockLocationId: location.id,
        unitsPerPack: 10,
        supplierName: 'Distributor Ltd',
        supplierInvoiceRef: `INV-${suffix}`,
        unitCostMinor: 100,
        printedMrpMinor: 2000,
        receivedExpiresAt: new Date('2028-10-01T00:00:00.000Z'),
        receivedExpiryPrecision: 'DAY',
        quantityUnits: 100,
        idempotencyKey: `receipt-${suffix}`,
        receivedAt: new Date('2026-02-01T00:00:00.000Z'),
      }
    );
    rx = {
      medicineId: medicine.id,
      presentationId: medicine.presentations[0]!.id,
      packLevelId: packLevel.id,
    };
  });
}, 120_000);

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('Rx/restricted sale gate with persisted roles (#518)', () => {
  it('refuses a cashier at addLine while the owner policy is missing or OFF', async () => {
    await expect(
      act(ids.cashier, async (api) =>
        api.addLine(rxLine((await api.create({ branchId: ids.branch })).id))
      )
    ).rejects.toMatchObject(DENIED);
    await setPolicy(false);
    await expect(
      act(ids.cashier, async (api) =>
        api.addLine(rxLine((await api.create({ branchId: ids.branch })).id))
      )
    ).rejects.toMatchObject(DENIED);
  });

  it('allows a dispense holder, and refuses a cashier paying for that line', async () => {
    const saleId = await act(ids.pharmacist, async (api) => {
      const sale = await api.create({ branchId: ids.branch });
      await api.addLine(rxLine(sale.id));
      return sale.id;
    });
    await expect(
      act(ids.cashier, (api) =>
        api.tender({
          branchId: ids.branch,
          saleId,
          deviceId: `device-${suffix}`,
          businessDate: new Date('2026-10-22T00:00:00.000Z'),
          type: 'CASH',
          amountMinor: 100,
          cashReceivedMinor: 100,
          idempotencyKey: randomBytes(8).toString('hex'),
        })
      )
    ).rejects.toMatchObject(DENIED);
  });

  it('allows a cashier only while the owner policy is ON, and audits every change', async () => {
    await setPolicy(true);
    await expect(
      act(ids.cashier, async (api) =>
        api.addLine(rxLine((await api.create({ branchId: ids.branch })).id))
      )
    ).resolves.toMatchObject({ line: { id: expect.any(String) } });
    await setPolicy(true); // unchanged: no audit row
    await setPolicy(false);
    await expect(
      act(ids.cashier, async (api) =>
        api.addLine(rxLine((await api.create({ branchId: ids.branch })).id))
      )
    ).rejects.toMatchObject(DENIED);
    const audit = await withTenantDb(ids.org, (tx) =>
      tx.$queryRawUnsafe<
        Array<{ setting: string; oldValue: boolean | null; newValue: boolean; actorUserId: string }>
      >(
        `SELECT setting, "oldValue", "newValue", "actorUserId" FROM pharmacy_owner_policy_audit WHERE "organizationId" = $1 ORDER BY "changedAt", id`,
        ids.org
      )
    );
    // OFF (first write) -> ON -> OFF; the repeated ON wrote nothing.
    expect(audit.map((row) => [row.oldValue, row.newValue])).toEqual([
      [null, false],
      [false, true],
      [true, false],
    ]);
    expect(audit.every((row) => row.setting === 'allowCashierRxSale')).toBe(true);
    expect(audit.every((row) => row.actorUserId === ids.pharmacist)).toBe(true);
  });
});
