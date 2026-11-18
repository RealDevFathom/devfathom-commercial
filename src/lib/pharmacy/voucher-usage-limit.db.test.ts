// @vitest-environment node
/**
 * DEV-780: a voucher's use limit holds against migrated PostgreSQL with FORCE RLS, including
 * when several counters redeem the same voucher at the same moment. Each redemption takes one
 * use with a compare-and-set inside its own sale transaction; the losers are refused and their
 * lines roll back. Requires TEST_DATABASE_URL (a migrated throwaway database); without it the
 * suite is skipped.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomUUID().slice(0, 8);
const org = `dev780_${suffix}`;
const owner = `dev780_owner_${suffix}`;
const scope = { organizationId: org, branchId: `${org}_branch`, actorId: owner };

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  sales: typeof import('./sales');
  ledger: typeof import('./stock-ledger');
  regulatory: typeof import('@/lib/test-support/pharmacy-regulatory');
};
let deps: Deps;
let locationId: string;
const ruleSetIds: string[] = [];

const tenant = <T>(fn: (db: ScopedDb) => Promise<T>) =>
  deps.withTenantDb(org, fn, { timeout: 30_000 });

/** A front-shop (non-drug) item with `units` in stock, priced at Rs 5 a unit. */
async function frontShopItem(units: number) {
  return tenant(async (db) => {
    const medicine = await db.medicine.create({
      data: {
        organizationId: org,
        productName: `Front shop ${randomUUID()}`,
        productFamily: 'FRONT_SHOP',
        saleable: true,
        otc: false,
        presentations: { create: { organizationId: org, presentation: 'Unit' } },
      },
      include: { presentations: true },
    });
    const presentation = medicine.presentations[0]!;
    const pack = await db.packLevel.create({
      data: {
        organizationId: org,
        presentationId: presentation.id,
        versionGroupId: randomUUID(),
        version: 1,
        level: 'UNIT',
        unitsPerParent: 1,
        effectiveFrom: new Date('2020-01-01'),
      },
    });
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        organizationId: org,
        medicineId: medicine.id,
        batchNumber: randomUUID(),
        expiresAt: new Date('2031-01-01'),
        expiryPrecision: 'DAY',
      },
    });
    await deps.ledger.receiveLot(db, scope, {
      manufacturingBatchId: batch.id,
      packLevelId: pack.id,
      stockLocationId: locationId,
      unitsPerPack: 1,
      supplierName: 'QA',
      supplierInvoiceRef: randomUUID(),
      unitCostMinor: 100,
      printedMrpMinor: 500,
      receivedExpiresAt: batch.expiresAt as Date,
      receivedExpiryPrecision: 'DAY',
      quantityUnits: units,
      idempotencyKey: randomUUID(),
      receivedAt: new Date('2020-01-01'),
    });
    return { medicineId: medicine.id, presentationId: presentation.id, packLevelId: pack.id };
  });
}

async function issueVoucher(maxUses: number) {
  return tenant((db) =>
    db.pharmacyVoucher.create({
      data: {
        organizationId: org,
        branchId: scope.branchId,
        code: `QA-${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'Front shop offer',
        body: 'Rs 1 off selected items this week.',
        discountMinor: 100,
        maxUses,
        validUntil: new Date(Date.now() + 7 * 86_400_000),
        issuedByUserId: owner,
        approvedByUserId: owner,
        approvalPolicy: 'VOUCHER_WITHIN_CAP',
      },
    })
  );
}

/** One counter: opens its own bill and redeems the voucher on one front-shop unit. */
async function redeem(item: Awaited<ReturnType<typeof frontShopItem>>, voucherId: string) {
  return tenant(async (db) => {
    const sale = await deps.sales.createSale(db, scope);
    return deps.sales.addSaleLine(db, scope, {
      saleId: sale.id,
      ...item,
      saleUnit: 'UNIT',
      quantity: 1,
      canonicalUnitsPerSaleUnit: 1,
      voucherId,
      voucherCashierPinVerified: true,
      idempotencyKey: randomUUID(),
    });
  });
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, sales, ledger, regulatory, departments] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./sales'),
    import('./stock-ledger'),
    import('@/lib/test-support/pharmacy-regulatory'),
    import('@/lib/test-support/departments'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    sales,
    ledger,
    regulatory,
  };
  await deps.withPlatformDb(async (db) => {
    await db.organization.create({
      data: {
        id: org,
        slug: org.replaceAll('_', '-'),
        legalName: org,
        displayName: org,
        vertical: 'PHARMACY',
        status: 'ACTIVE',
      },
    });
    await departments.seedDepartments(db, [org], ['LEADERSHIP']);
    // Redemption re-checks that the Pharmacy CRM module is licensed.
    const crm = await departments.ensurePlatformModule(db, 'pharmacy-crm', {
      name: 'Pharmacy CRM',
      category: 'Pharmacy',
    });
    await db.organizationModule.create({
      data: { organizationId: org, moduleId: crm.id, startsAt: new Date('2020-01-01') },
    });
  });
  locationId = await tenant(async (db) => {
    // The issuer must still be an active owner of this workspace at redemption.
    await db.user.create({
      data: {
        id: owner,
        organizationId: org,
        name: 'Owner',
        email: `${owner}@voucher.test`,
        role: 'ADMIN',
        department: 'LEADERSHIP',
        title: 'Owner',
        status: 'ACTIVE',
      },
    });
    await db.pharmacyBranch.create({
      data: {
        id: scope.branchId,
        organizationId: org,
        code: org,
        name: 'QA',
        addressLine: 'QA',
        city: 'QA',
        provinceCode: 'PB',
      },
    });
    return (
      await db.pharmacyStockLocation.create({
        data: {
          organizationId: org,
          branchId: scope.branchId,
          code: randomUUID(),
          name: 'Stock',
          kind: 'STORE',
        },
      })
    ).id;
  });
  ruleSetIds.push(
    await deps.regulatory.seedPharmacyRegulatoryProfile(deps.withPlatformDb, tenant, scope.branchId)
  );
}, 120_000);

afterAll(async () => {
  if (!TEST_DATABASE_URL) return;
  await deps.regulatory.retirePharmacyRegulatoryRules(deps.withPlatformDb, ruleSetIds);
});

describeIfDatabase('DEV-780 voucher use limit (database)', () => {
  it('refuses a voucher once its use limit is reached', async () => {
    const item = await frontShopItem(5);
    const voucher = await issueVoucher(2);
    for (let use = 0; use < 2; use++) {
      const { line } = await redeem(item, voucher.id);
      expect(line).toMatchObject({ voucherId: voucher.id, discountKind: 'VOUCHER' });
    }
    await expect(redeem(item, voucher.id)).rejects.toThrow('VOUCHER_INVALID');
    await tenant(async (db) => {
      const stored = await db.pharmacyVoucher.findFirstOrThrow({ where: { id: voucher.id } });
      expect(stored.usedCount).toBe(2);
      expect(await db.pharmacySaleLine.count({ where: { voucherId: voucher.id } })).toBe(2);
    });
  });

  it('lets concurrent redemptions take no more uses than the limit', async () => {
    const attempts = 8;
    const limit = 3;
    const item = await frontShopItem(attempts + limit + 1);
    const voucher = await issueVoucher(limit);
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () => redeem(item, voucher.id))
    );
    const redeemed = results.filter((result) => result.status === 'fulfilled').length;
    const refused = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    // A redemption that loses the race is refused even if a use is still left, so the
    // number that win varies; it never exceeds the limit.
    expect(redeemed).toBeGreaterThanOrEqual(1);
    expect(redeemed).toBeLessThanOrEqual(limit);
    for (const result of refused) expect(String(result.reason)).toContain('VOUCHER_INVALID');
    const counts = () =>
      tenant(async (db) => ({
        used: (await db.pharmacyVoucher.findFirstOrThrow({ where: { id: voucher.id } })).usedCount,
        // A refused redemption leaves no discounted line behind.
        lines: await db.pharmacySaleLine.count({ where: { voucherId: voucher.id } }),
      }));
    expect(await counts()).toEqual({ used: redeemed, lines: redeemed });
    // The uses left can still be taken, one at a time, and then the voucher is refused.
    for (let use = redeemed; use < limit; use++) await redeem(item, voucher.id);
    await expect(redeem(item, voucher.id)).rejects.toThrow('VOUCHER_INVALID');
    expect(await counts()).toEqual({ used: limit, lines: limit });
  });
});
