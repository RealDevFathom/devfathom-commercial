/**
 * @vitest-environment node
 * #722: real router, tender posting, customer Khata ledger and drawer under tenant RLS.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl) process.env.DATABASE_URL = databaseUrl;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const suite = databaseUrl ? describe : describe.skip;

// Only the HTTP audit sink is replaced; money, permissions and database writes stay real.
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  recordTrpcAudit: vi.fn(),
}));

const suffix = randomBytes(6).toString('hex');
const organizationId = `org_split_${suffix}`;
const branchId = `branch_split_${suffix}`;
const actorId = `cashier_split_${suffix}`;
const scope = { organizationId, branchId, actorId };
const businessDate = new Date('2026-11-01T00:00:00.000Z');
let tenant: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let router: typeof import('./pharmacy-sales').pharmacySalesRouter;

function inTenant<T>(work: (db: ScopedDb) => Promise<T>) {
  return tenant(
    organizationId,
    async (db) => {
      await db.$queryRawUnsafe("SELECT set_config('app.current_branch_id', $1, true)", branchId);
      return work(db);
    },
    { userId: actorId, timeout: 30000 }
  );
}

function caller(db: ScopedDb) {
  return router.createCaller({
    db,
    entitlements: {
      organizationId,
      enabledModules: ['pharmacy-counter'],
      modules: [],
      limits: {},
      seatLimit: 10,
      activeSeats: 1,
    },
    session: {
      expires: 'later',
      user: {
        id: actorId,
        role: 'EMPLOYEE',
        department: 'LEADERSHIP',
        status: 'ACTIVE',
        organizationId,
      },
    },
    organization: { id: organizationId, vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as never);
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  tenant = scoped.withTenantDb;
  router = (await import('./pharmacy-sales')).pharmacySalesRouter;
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(scoped.withPlatformDb);
  await scoped.withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
     VALUES ($1, $1, 'Split tender fixture', 'Split tender fixture', 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      organizationId
    )
  );
  await inTenant(async (db) => {
    const { seedDepartments } = await import('@/lib/test-support/departments');
    await seedDepartments(db, [organizationId], ['LEADERSHIP']);
    await db.pharmacyBranch.create({
      data: {
        id: branchId,
        code: 'SPLIT',
        name: 'Split counter',
        addressLine: '1 Test Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    const role = await db.organizationRole.create({
      data: {
        key: `split_cashier_${suffix}`,
        name: 'Split cashier',
        permissions: { create: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }] },
      },
    });
    await db.user.create({
      data: {
        id: actorId,
        name: 'Cashier',
        email: `${actorId}@example.test`,
        department: 'LEADERSHIP',
        title: 'Cashier',
        organizationRoleId: role.id,
      },
    });
    await db.pharmacyBranchAssignment.create({ data: { userId: actorId, branchId } });
  });
}, 120000);

/** Each case owns its stock, sale, account and device, so parallel suites cannot share money. */
async function fixture(creditLimitMinor = 40000) {
  return inTenant(async (db) => {
    const { createSale, addSaleLine } = await import('@/lib/pharmacy/sales');
    const { receiveLot } = await import('@/lib/pharmacy/stock-ledger');
    const patient = await db.pharmacyPatient.create({ data: { displayName: 'Test customer' } });
    const customer = await db.pharmacyCustomer.create({
      data: { patientId: patient.id, displayName: 'Test customer' },
    });
    const account = await db.pharmacyFamilyAccount.create({
      data: { branchId, payerCustomerId: customer.id, displayName: 'Test family', creditLimitMinor },
    });
    await db.pharmacyFamilyMember.create({
      data: { branchId, familyAccountId: account.id, customerId: customer.id },
    });
    const medicine = await db.medicine.create({
      data: {
        productName: `Split item ${randomUUID()}`,
        productFamily: 'PHARMACEUTICAL',
        otc: true,
        saleable: true,
        presentations: { create: { presentation: 'Unit' } },
      },
      include: { presentations: true },
    });
    const presentationId = medicine.presentations[0]!.id;
    const pack = await db.packLevel.create({
      data: {
        presentationId,
        versionGroupId: randomUUID(),
        version: 1,
        level: 'UNIT',
        unitsPerParent: 1,
        effectiveFrom: new Date('2026-01-01'),
      },
    });
    const location = await db.pharmacyStockLocation.create({
      data: { branchId, code: randomUUID(), name: 'Test shelf', kind: 'STORE' },
    });
    const expiresAt = new Date('2036-01-01T00:00:00.000Z');
    const batch = await db.pharmacyManufacturingBatch.create({
      data: { medicineId: medicine.id, batchNumber: randomUUID(), expiresAt, expiryPrecision: 'DAY' },
    });
    await receiveLot(db, scope, {
      manufacturingBatchId: batch.id,
      packLevelId: pack.id,
      stockLocationId: location.id,
      unitsPerPack: 1,
      supplierName: 'Test supplier',
      supplierInvoiceRef: randomUUID(),
      unitCostMinor: 50000,
      printedMrpMinor: 100000,
      receivedExpiresAt: expiresAt,
      receivedExpiryPrecision: 'DAY',
      quantityUnits: 1,
      idempotencyKey: randomUUID(),
      receivedAt: new Date('2026-01-01'),
    });
    const sale = await createSale(db, scope);
    await db.pharmacySale.update({ where: { id: sale.id }, data: { customerId: customer.id } });
    await addSaleLine(db, scope, {
      saleId: sale.id,
      medicineId: medicine.id,
      presentationId,
      packLevelId: pack.id,
      saleUnit: 'UNIT',
      quantity: 1,
      canonicalUnitsPerSaleUnit: 1,
      idempotencyKey: randomUUID(),
    });
    const deviceId = randomUUID();
    const drawer = await caller(db).openDrawer({
      branchId, deviceId, businessDate, openingFloatMinor: 0,
    });
    return { saleId: sale.id, familyAccountId: account.id, deviceId, drawerId: drawer!.id };
  });
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function tender(f: Fixture, type: 'CASH' | 'KHATA', amountMinor: number) {
  return {
    branchId,
    saleId: f.saleId,
    deviceId: f.deviceId,
    businessDate,
    type,
    amountMinor,
    idempotencyKey: randomUUID(),
    ...(type === 'KHATA' ? { familyAccountId: f.familyAccountId } : {}),
  };
}

suite('split tender against PostgreSQL', () => {
  it('settles Rs 1,000 with Rs 600 cash and Rs 400 Khata; replay changes neither ledger', async () => {
    const f = await fixture();
    const cash = tender(f, 'CASH', 60000);
    const khata = tender(f, 'KHATA', 40000);
    expect(await inTenant((db) => caller(db).tender(cash))).toMatchObject({
      settled: false, remainingMinor: 40000, receiptNumber: null,
    });
    const partial = await inTenant((db) => caller(db).counterCart({ branchId, saleId: f.saleId }));
    expect(partial.status).toBe('OPEN');
    expect(partial.tenders).toEqual([expect.objectContaining({ type: 'CASH', amountMinor: 60000 })]);

    expect(await inTenant((db) => caller(db).tender(khata))).toMatchObject({
      settled: true, remainingMinor: 0, replayed: false,
    });
    expect(await inTenant((db) => caller(db).tender(cash))).toMatchObject({ replayed: true });
    expect(await inTenant((db) => caller(db).tender(khata))).toMatchObject({ replayed: true });

    await inTenant(async (db) => {
      const { foldExpectedCash } = await import('@/lib/pharmacy/settlement');
      type DrawerMovement = import('@/lib/pharmacy/settlement').DrawerMovement;
      const { readKhataBalance } = await import('@/lib/pharmacy/family-khata');
      const movements = await db.pharmacyDrawerMovement.findMany({
        where: { drawerSessionId: f.drawerId },
      });
      expect(movements).toEqual([expect.objectContaining({ kind: 'CASH_SALE', amountMinor: 60000 })]);
      expect(foldExpectedCash(movements as DrawerMovement[])).toBe(60000);
      expect(await readKhataBalance(db, scope, f.familyAccountId)).toBe(40000);
      expect(
        await db.pharmacyKhataEvent.count({ where: { familyAccountId: f.familyAccountId } })
      ).toBe(1);
      const cart = await caller(db).counterCart({ branchId, saleId: f.saleId });
      expect(cart).toMatchObject({
        status: 'COMPLETED', totals: { netMinor: 100000, tenderedMinor: 100000 },
      });
      expect(cart.receiptNumber).toBeGreaterThan(0);
      expect(cart.tenders).toHaveLength(2);
      const receipt = await caller(db).counterReceipt({ branchId, saleId: f.saleId });
      expect(receipt.tenders).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'CASH', amountMinor: 60000 }),
          expect.objectContaining({ type: 'CREDIT', amountMinor: 40000 }),
        ])
      );
      expect(
        await db.pharmacySaleEvent.count({ where: { saleId: f.saleId, kind: 'COMPLETED' } })
      ).toBe(1);
    });
    const close = await inTenant((db) => caller(db).closeDrawer({
      branchId,
      drawerSessionId: f.drawerId,
      countedCashMinor: 60000,
    }));
    expect(close).toMatchObject({ expectedCashMinor: 60000, varianceMinor: 0 });
  });

  it('retains accepted cash when the Khata remainder exceeds the limit or has no linked customer', async () => {
    const f = await fixture(39999);
    await inTenant((db) => caller(db).tender(tender(f, 'CASH', 60000)));
    await expect(
      inTenant((db) => caller(db).tender(tender(f, 'KHATA', 40000)))
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'CREDIT_LIMIT_EXCEEDED' });
    await inTenant((db) =>
      db.pharmacySale.update({ where: { id: f.saleId }, data: { customerId: null } })
    );
    await expect(
      inTenant((db) => caller(db).tender(tender(f, 'KHATA', 40000)))
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'ACCOUNT_NOT_FOUND' });
    await inTenant(async (db) => {
      const cart = await caller(db).counterCart({ branchId, saleId: f.saleId });
      expect(cart).toMatchObject({
        status: 'OPEN', receiptNumber: null, totals: { tenderedMinor: 60000 },
      });
      expect(cart.tenders).toHaveLength(1);
      expect(
        await db.pharmacyKhataEvent.count({ where: { familyAccountId: f.familyAccountId } })
      ).toBe(0);
      expect(
        await db.pharmacySaleEvent.count({ where: { saleId: f.saleId, kind: 'COMPLETED' } })
      ).toBe(0);
    });
  });
});
