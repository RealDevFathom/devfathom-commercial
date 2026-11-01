/**
 * #518 launch fix — an Rx/restricted non-controlled line may be added, paid for or completed only
 * by someone central ABAC allows the exact pharmacy:dispense grant. An explicit DENY wins, and the
 * owner-policy table is never read, so a row that says "allow" changes nothing.
 * Real router, persisted roles and overrides, PostgreSQL as a NOSUPERUSER NOBYPASSRLS role.
 * Skipped unless TEST_DATABASE_URL is set.
 */
import { seedRxChecker, RX_CHECKER_PIN } from '../../../tests/pharmacy-rx-checker-fixture';
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
  checker: `checker_${suffix}`,
  org: `org_r518_${suffix}`,
  branch: `br_r518_${suffix}`,
  cashier: `user_r518_cashier_${suffix}`,
  pharmacist: `user_r518_pharm_${suffix}`,
  /** Role grants pharmacy:dispense; a user override DENYs it. */
  userDenied: `user_r518_udeny_${suffix}`,
  /** Role DENYs pharmacy:dispense; a user override ALLOWs it. */
  roleDenied: `user_r518_rdeny_${suffix}`,
};
const businessDate = new Date('2026-10-22T00:00:00.000Z');
const deviceFor = (userId: string) => `device-${userId}`;
const key = () => randomBytes(8).toString('hex');
const DENIED = {
  code: 'FORBIDDEN',
  message:
    'Selling a prescription-only or restricted medicine needs the pharmacist dispensing permission.',
};
const FORBIDDEN = { code: 'FORBIDDEN' };

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
type Cart = { status: string; totals: { netMinor: number; tenderedMinor: number } };
type SalesCaller = {
  create: (input: { branchId: string }) => Promise<{ id: string }>;
  addLine: (input: Record<string, unknown>) => Promise<{ line: { id: string } }>;
  linkCustomer: (input: Record<string, unknown>) => Promise<unknown>;
  counterCart: (input: { branchId: string; saleId: string }) => Promise<Cart>;
  openDrawer: (input: Record<string, unknown>) => Promise<unknown>;
  tender: (input: Record<string, unknown>) => Promise<{ settled: boolean }>;
  redeemPoints: (input: Record<string, unknown>) => Promise<{ settled: boolean }>;
};

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let pharmacySalesRouter: typeof import('./pharmacy-sales').pharmacySalesRouter;
let disconnect: (() => Promise<void>) | null = null;
let rx: { medicineId: string; presentationId: string; packLevelId: string };
let patientId: string;

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

const rxLine = (saleId: string, quantity = 1) => ({
  branchId: ids.branch,
  saleId,
  medicineId: rx.medicineId,
  presentationId: rx.presentationId,
  packLevelId: rx.packLevelId,
  saleUnit: 'STRIP',
  quantity,
  canonicalUnitsPerSaleUnit: 10,
  idempotencyKey: key(),
  prescriptionApproval: { checkerId: ids.checker, pin: RX_CHECKER_PIN },
});

/** A sale holding one Rx line the pharmacist added, optionally linked to the loyalty customer. */
function pharmacistSale({ customer = false, quantity = 1 } = {}) {
  return act(ids.pharmacist, async (api) => {
    const sale = await api.create({ branchId: ids.branch });
    await api.addLine(rxLine(sale.id, quantity));
    if (customer)
      await api.linkCustomer({
        branchId: ids.branch,
        saleId: sale.id,
        patientId,
        displayName: 'Ayesha Khan',
      });
    const cart = await api.counterCart({ branchId: ids.branch, saleId: sale.id });
    // Points redeem in whole 100-minor steps, so the bill must be one to settle on points alone.
    expect(cart.totals.netMinor % 100).toBe(0);
    return { saleId: sale.id, netMinor: cart.totals.netMinor };
  });
}

const cart = (saleId: string) =>
  act(ids.pharmacist, (api) => api.counterCart({ branchId: ids.branch, saleId }));
const payInCash = (userId: string, sale: { saleId: string; netMinor: number }) =>
  act(userId, (api) =>
    api.tender({
      branchId: ids.branch,
      saleId: sale.saleId,
      deviceId: deviceFor(userId),
      businessDate,
      type: 'CASH',
      amountMinor: sale.netMinor,
      cashReceivedMinor: sale.netMinor,
      idempotencyKey: key(),
    })
  );
/** Loyalty points covering the whole bill complete the sale without any cash or card tender. */
const payInPoints = (userId: string, sale: { saleId: string; netMinor: number }) =>
  act(userId, (api) =>
    api.redeemPoints({
      branchId: ids.branch,
      saleId: sale.saleId,
      points: sale.netMinor / 100,
      deviceId: deviceFor(userId),
      businessDate,
      idempotencyKey: key(),
    })
  );

/**
 * addLine, a full cash tender, and a loyalty-funded completion are each refused, and nothing is
 * paid. `tenderRefusal` is the gate's own refusal unless the user holds an explicit DENY: with
 * the central precedence fix (6b120a50) the counter-access check refuses that user first, which
 * is still a 403 that pays nothing.
 */
async function expectRefusedEverywhere(
  userId: string,
  tenderRefusal: { code: string; message?: string } = DENIED
) {
  await expect(
    act(userId, async (api) => api.addLine(rxLine((await api.create({ branchId: ids.branch })).id)))
  ).rejects.toMatchObject(DENIED);
  const tendered = await pharmacistSale();
  await expect(payInCash(userId, tendered)).rejects.toMatchObject(tenderRefusal);
  const redeemed = await pharmacistSale({ customer: true });
  // OTC counter access is independent; Rx redemption still requires dispensing permission.
  await expect(payInPoints(userId, redeemed)).rejects.toMatchObject(DENIED);
  for (const sale of [tendered, redeemed])
    expect(await cart(sale.saleId)).toMatchObject({ status: 'OPEN', totals: { tenderedMinor: 0 } });
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const sales = await import('./pharmacy-sales');
  const ledger = await import('@/lib/pharmacy/stock-ledger');
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
    await seedRxChecker(tx, ids.branch, ids.checker);
    // Persisted roles: the Cashier template's grants, a pharmacist with the exact grant, and the
    // two explicit-DENY combinations.
    const users: Array<{
      id: string;
      role: Array<[string, 'ALLOW' | 'DENY']>;
      override?: 'ALLOW' | 'DENY';
    }> = [
      {
        id: ids.cashier,
        role: [
          ['pharmacy:counter', 'ALLOW'],
          ['pharmacy:orders', 'ALLOW'],
        ],
      },
      {
        id: ids.pharmacist,
        role: [
          ['pharmacy:dispense', 'ALLOW'],
          ['pharmacy:counter', 'ALLOW'],
        ],
      },
      {
        id: ids.userDenied,
        role: [
          ['pharmacy:dispense', 'ALLOW'],
          ['pharmacy:counter', 'ALLOW'],
        ],
        override: 'DENY',
      },
      {
        id: ids.roleDenied,
        role: [
          ['pharmacy:dispense', 'DENY'],
          ['pharmacy:counter', 'ALLOW'],
        ],
        override: 'ALLOW',
      },
    ];
    for (const user of users) {
      await tx.organizationRole.create({
        data: {
          id: `role_${user.id}`,
          key: `role_${user.id}`,
          name: user.id,
          permissions: {
            create: user.role.map(([capability, effect]) => ({ capability, effect })),
          },
        },
      });
      await tx.user.create({
        data: {
          id: user.id,
          name: user.id,
          email: `${user.id}@example.test`,
          department: 'LEADERSHIP',
          title: 'Counter',
          organizationRoleId: `role_${user.id}`,
        },
      });
      if (user.override)
        await tx.userPermissionOverride.create({
          data: {
            userId: user.id,
            capability: 'pharmacy:dispense',
            effect: user.override,
            reason: 'Set by the #518 test',
          },
        });
      await tx.pharmacyBranchAssignment.create({ data: { userId: user.id, branchId: ids.branch } });
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
        quantityUnits: 500,
        idempotencyKey: `receipt-${suffix}`,
        receivedAt: new Date('2026-02-01T00:00:00.000Z'),
      }
    );
    rx = {
      medicineId: medicine.id,
      presentationId: medicine.presentations[0]!.id,
      packLevelId: packLevel.id,
    };
    await tx.pharmacyLoyaltySettings.create({ data: { pointsEnabled: true } });
    const patient = await tx.pharmacyPatient.create({ data: { displayName: 'Ayesha Khan' } });
    patientId = patient.id;
    await tx.patientConsent.create({
      data: {
        patientId,
        purpose: 'LOYALTY',
        channel: 'IN_PERSON',
        version: 1,
        granted: true,
        recordedByUserId: ids.pharmacist,
      },
    });
  });
  for (const userId of [ids.cashier, ids.pharmacist, ids.userDenied, ids.roleDenied])
    await act(userId, (api) =>
      api.openDrawer({
        branchId: ids.branch,
        deviceId: deviceFor(userId),
        businessDate,
        openingFloatMinor: 0,
      })
    );
  // The customer earns real points: the pharmacist sells and is paid for four strips. A refused
  // redemption rolls back, so the balance covers every one-strip redemption below.
  const earning = await pharmacistSale({ customer: true, quantity: 4 });
  await expect(payInCash(ids.pharmacist, earning)).resolves.toMatchObject({ settled: true });
}, 120_000);

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('Rx/restricted sale gate with persisted roles (#518 launch fix)', () => {
  it('refuses a cashier at addLine, tender and completion', async () => {
    await expectRefusedEverywhere(ids.cashier);
  });

  it('lets a user DENY override beat a role pharmacy:dispense grant everywhere', async () => {
    await expectRefusedEverywhere(ids.userDenied, FORBIDDEN);
  });

  it('lets a dispense holder add the line and complete it by cash or by points', async () => {
    const byCash = await pharmacistSale();
    await expect(payInCash(ids.pharmacist, byCash)).resolves.toMatchObject({ settled: true });
    expect(await cart(byCash.saleId)).toMatchObject({ status: 'COMPLETED' });
    const byPoints = await pharmacistSale({ customer: true });
    await expect(payInPoints(ids.pharmacist, byPoints)).resolves.toMatchObject({ settled: true });
    expect(await cart(byPoints.saleId)).toMatchObject({ status: 'COMPLETED' });
  });

  describe('with an owner-policy row that says allow', () => {
    beforeAll(async () => {
      // Written straight to the table: no application code reads or writes it any more.
      const rows = await withTenantDb(
        ids.org,
        async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO pharmacy_owner_policies ("organizationId", "allowCashierRxSale", "updatedByUserId")
             VALUES ($1, true, $2)
             ON CONFLICT ("organizationId") DO UPDATE SET "allowCashierRxSale" = true`,
            ids.org,
            ids.pharmacist
          );
          return tx.$queryRawUnsafe<Array<{ allowCashierRxSale: boolean }>>(
            `SELECT "allowCashierRxSale" FROM pharmacy_owner_policies WHERE "organizationId" = $1`,
            ids.org
          );
        },
        { userId: ids.pharmacist }
      );
      expect(rows).toEqual([{ allowCashierRxSale: true }]);
    });

    it('still refuses a cashier at addLine, tender and completion', async () => {
      await expectRefusedEverywhere(ids.cashier);
    });

    it('still lets the user DENY override win everywhere', async () => {
      await expectRefusedEverywhere(ids.userDenied, FORBIDDEN);
    });

    it('refuses a role DENY over a user pharmacy:dispense ALLOW everywhere', async () => {
      await expectRefusedEverywhere(ids.roleDenied, FORBIDDEN);
    });
  });
});
