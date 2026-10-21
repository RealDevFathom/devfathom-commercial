/**
 * qa-299: the 20261021110000_canonical_pharmacy_capabilities migration rewrites a
 * cashier's legacy `pharmacy.counter` grant to canonical `pharmacy:counter` and
 * deletes the legacy row. The counter sale gate must then still admit that cashier
 * and let them complete a CASH counter tender — the regression this migration
 * introduced was that the gate only recognized the dotted legacy names.
 *
 * Runs only against a migrated disposable PostgreSQL named by TEST_DATABASE_URL as
 * a NOSUPERUSER NOBYPASSRLS role.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runMigrationSql } from '../../../tests/split-sql-statements';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
const describeIfDatabase = databaseUrl ? describe : describe.skip;

vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return { ...actual, recordTrpcAudit: vi.fn() };
});

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const ids = {
  org: `org_qa299_${suffix}`,
  branch: `br_qa299_${suffix}`,
  role: `role_qa299_${suffix}`,
  cashier: `user_qa299_${suffix}`,
};
const deviceId = `dev_qa299_${suffix}`;
const businessDate = new Date('2026-10-21T00:00:00.000Z');
const expiry = new Date('2027-10-01T00:00:00.000Z');
const received = new Date('2026-09-02T00:00:00.000Z');

type Scope = { organizationId: string; branchId: string; actorId: string };
const scope: Scope = { organizationId: ids.org, branchId: ids.branch, actorId: ids.cashier };

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let createTenantDb: typeof import('@/lib/tenancy/scoped-db').createTenantDb;
let pharmacySalesRouter: typeof import('./pharmacy-sales').pharmacySalesRouter;
let createSale: typeof import('@/lib/pharmacy/sales').createSale;
let addSaleLine: typeof import('@/lib/pharmacy/sales').addSaleLine;
let openPharmacyDrawer: typeof import('@/lib/pharmacy/settlement').openPharmacyDrawer;
let disconnect: (() => Promise<void>) | null = null;

const seed = { medicineId: '', presentationId: '', packLevelId: '' };

type TenderCaller = {
  tender: (input: {
    branchId: string;
    saleId: string;
    deviceId: string;
    businessDate: Date;
    type: 'CASH';
    amountMinor: number;
    idempotencyKey: string;
  }) => Promise<{ tenderId: string; settled: boolean }>;
};

function cashierCaller(): TenderCaller {
  // The router's own request-safe facade: each read runs in its own tenant
  // transaction and `tender` opens one for the money write, exactly as in a live
  // request. The session user is the migrated cashier.
  return pharmacySalesRouter.createCaller({
    db: createTenantDb(ids.org, ids.cashier),
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
        id: ids.cashier,
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
  } as never) as unknown as TenderCaller;
}

const rolePermissions = () =>
  withTenantDb(ids.org, (tx) =>
    tx.organizationRolePermission
      .findMany({ where: { organizationRoleId: ids.role }, select: { capability: true } })
      .then((rows) => rows.map((row) => row.capability).sort())
  );

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const sales = await import('./pharmacy-sales');
  const saleLib = await import('@/lib/pharmacy/sales');
  const settlement = await import('@/lib/pharmacy/settlement');
  const { seedDepartments } = await import('@/lib/test-support/departments');
  const { db } = await import('@/lib/db');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  createTenantDb = scoped.createTenantDb;
  pharmacySalesRouter = sales.pharmacySalesRouter;
  createSale = saleLib.createSale;
  addSaleLine = saleLib.addSaleLine;
  openPharmacyDrawer = settlement.openPharmacyDrawer;
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
       VALUES ($1, $1, 'QA299', 'QA299', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      ids.org
    )
  );

  await withTenantDb(ids.org, async (tx) => {
    await seedDepartments(tx, [ids.org], ['LEADERSHIP']);
    await tx.pharmacyBranch.create({
      data: {
        id: ids.branch,
        code: 'A',
        name: 'Counter A',
        addressLine: '1 Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    await tx.organizationRole.create({
      data: {
        id: ids.role,
        key: `cashier-${suffix}`,
        name: 'Cashier',
        permissions: { create: [{ capability: 'pharmacy.counter', effect: 'ALLOW' }] },
      },
    });
    await tx.user.create({
      data: {
        id: ids.cashier,
        name: 'Cashier',
        email: `${ids.cashier}@example.test`,
        department: 'LEADERSHIP',
        title: 'Cashier',
        role: 'EMPLOYEE',
        organizationRoleId: ids.role,
      },
    });
    await tx.pharmacyBranchAssignment.create({
      data: { userId: ids.cashier, branchId: ids.branch },
    });

    // One sealed strip of stock so the counter sale can allocate and price a line.
    const medicine = await tx.medicine.create({
      data: {
        organizationId: ids.org,
        productName: `Paracetamol 500mg ${suffix}`,
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        presentations: {
          create: { organizationId: ids.org, presentation: 'Tablet, 10 per strip' },
        },
      },
      include: { presentations: true },
    });
    const packLevel = await tx.packLevel.create({
      data: {
        organizationId: ids.org,
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `strip-${suffix}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const location = await tx.pharmacyStockLocation.create({
      data: {
        organizationId: ids.org,
        branchId: ids.branch,
        code: `MAIN-${suffix}`,
        name: 'Main store',
        kind: 'STORE',
      },
    });
    const batch = await tx.pharmacyManufacturingBatch.create({
      data: {
        organizationId: ids.org,
        medicineId: medicine.id,
        batchNumber: `B-${suffix}`,
        expiresAt: expiry,
        expiryPrecision: 'DAY',
      },
    });
    const lot = await tx.pharmacyInventoryLot.create({
      data: {
        organizationId: ids.org,
        branchId: ids.branch,
        manufacturingBatchId: batch.id,
        packLevelId: packLevel.id,
        unitsPerPack: 10,
        supplierName: 'Supplier',
        supplierInvoiceRef: `INV-${suffix}`,
        unitCostMinor: 50,
        printedMrpMinor: 1_000,
        receivedExpiresAt: expiry,
        receivedExpiryPrecision: 'DAY',
        receivedAt: received,
      },
    });
    await tx.pharmacyStockMovement.create({
      data: {
        organizationId: ids.org,
        branchId: ids.branch,
        inventoryLotId: lot.id,
        stockLocationId: location.id,
        kind: 'RECEIPT',
        disposition: 'AVAILABLE',
        quantityUnits: 100,
        sealedPackDelta: 10,
        looseUnitDelta: 0,
        actorId: ids.cashier,
        idempotencyKey: `receipt-${suffix}`,
        occurredAt: received,
      },
    });
    seed.medicineId = medicine.id;
    seed.presentationId = medicine.presentations[0]!.id;
    seed.packLevelId = packLevel.id;
  });
});

afterAll(async () => {
  await disconnect?.();
});

describeIfDatabase('canonical pharmacy counter capability against Postgres', () => {
  it('rewrites a legacy cashier grant and still completes a CASH counter sale', async () => {
    // The role starts with only the dotted legacy grant.
    expect(await rolePermissions()).toEqual(['pharmacy.counter']);

    // Apply the committed migration exactly as a deploy would, and prove it is
    // idempotent by running it twice.
    const migration = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20261021110000_canonical_pharmacy_capabilities/migration.sql'
      ),
      'utf8'
    );
    await withPlatformDb((tx) => runMigrationSql(tx, migration));
    await withPlatformDb((tx) => runMigrationSql(tx, migration));

    // The dotted grant is gone; only the canonical capability remains.
    expect(await rolePermissions()).toEqual(['pharmacy:counter']);

    // The cashier now holds only canonical pharmacy:counter. They open a sale,
    // add a line, open the drawer, and complete a CASH counter tender through the
    // router gate that used to refuse them.
    const sale = await withTenantDb(ids.org, (tx) => createSale(tx, scope));
    await withTenantDb(ids.org, (tx) =>
      addSaleLine(tx, scope, {
        saleId: sale.id,
        medicineId: seed.medicineId,
        presentationId: seed.presentationId,
        packLevelId: seed.packLevelId,
        saleUnit: 'STRIP',
        quantity: 1,
        canonicalUnitsPerSaleUnit: 10,
        idempotencyKey: `line-${suffix}`,
      })
    );
    await withTenantDb(ids.org, (tx) =>
      openPharmacyDrawer(tx, scope, { deviceId, businessDate, openingFloatMinor: 0 })
    );

    const result = await cashierCaller().tender({
      branchId: ids.branch,
      saleId: sale.id,
      deviceId,
      businessDate,
      type: 'CASH',
      amountMinor: 1,
      idempotencyKey: `tender-${suffix}`,
    });
    // A partial tender records the counter sale payment without forcing the
    // settlement/receipt-sequence path; the gate accepting the cashier is the point.
    expect(result.settled).toBe(false);
    expect(result.tenderId).toBeTruthy();

    // The committed tender is on the cashier's sale in their branch.
    const tenders = await withTenantDb(ids.org, (tx) =>
      tx.pharmacyTender.findMany({
        where: { saleId: sale.id },
        select: { type: true, amountMinor: true, actorId: true },
      })
    );
    expect(tenders).toEqual([{ type: 'CASH', amountMinor: 1, actorId: ids.cashier }]);
  });
});
