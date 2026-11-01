/**
 * @vitest-environment node
 *
 * #633 against a REAL migrated PostgreSQL, as the restricted runtime role under FORCE RLS.
 * Batch safety was decided only at add-to-cart, so a batch recalled, quarantined or past
 * its stored exclusive expiry instant before payment could still be tendered, completed
 * and printed on a receipt. Each change made after add-to-cart must refuse the tender and
 * the completion, leaving money and stock exactly as they were: no tender, journal,
 * movement, receipt-number or completion rows.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the runtime role.
 * Without it the suite reports skipped.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  retirePharmacyRegulatoryRules,
  seedPharmacyRegulatoryProfile,
} from '@/lib/test-support/pharmacy-regulatory';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let sales: typeof import('./sales');
let ledger: typeof import('./stock-ledger');
let settlement: typeof import('./settlement');
let completion: typeof import('./sale-completion');
let inventoryOperations: typeof import('./inventory-operations');

const describeDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const run = randomUUID().slice(0, 8);
const organizationId = `sbs633_${run}`;
const scope = { organizationId, branchId: `sbs633_branch_${run}`, actorId: 'sbs633-actor' };
const businessDate = new Date('2026-10-22T00:00:00.000Z');
let catalog: { locationId: string };
const ruleSetIds: string[] = [];

const tenant = <T>(work: (db: ScopedDb) => Promise<T>, timeout = 30_000) =>
  withTenantDb(organizationId, work, { userId: scope.actorId, timeout });

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  ({ withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
  sales = await import('./sales');
  ledger = await import('./stock-ledger');
  settlement = await import('./settlement');
  completion = await import('./sale-completion');
  inventoryOperations = await import('./inventory-operations');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(withPlatformDb);

  await withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      organizationId
    )
  );
  catalog = await tenant(async (db) => {
    await db.pharmacyBranch.create({
      data: {
        id: scope.branchId,
        organizationId,
        code: scope.branchId,
        name: 'Batch safety',
        addressLine: 'Test',
        city: 'Test',
        provinceCode: 'PB',
      },
    });
    const location = await db.pharmacyStockLocation.create({
      data: {
        organizationId,
        branchId: scope.branchId,
        code: randomUUID(),
        name: 'Stock',
        kind: 'STORE',
      },
    });
    return { locationId: location.id };
  });
  ruleSetIds.push(await seedPharmacyRegulatoryProfile(withPlatformDb, tenant, scope.branchId));
}, 60_000);

afterAll(async () => {
  if (TEST_DATABASE_URL) await retirePharmacyRegulatoryRules(withPlatformDb, ruleSetIds);
});

/**
 * A medicine of its own (so FEFO cannot pick another test's lot), one safe batch with 20
 * units on the shelf, and an OPEN sale holding 10 of them.
 */
async function cart(label: string) {
  return tenant(async (db) => {
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: `Batch safety ${label}`,
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        presentations: { create: { organizationId, presentation: 'Tablet' } },
      },
      include: { presentations: true },
    });
    const presentation = medicine.presentations[0]!;
    const pack = await db.packLevel.create({
      data: {
        organizationId,
        presentationId: presentation.id,
        versionGroupId: randomUUID(),
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01'),
      },
    });
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        organizationId,
        medicineId: medicine.id,
        batchNumber: `SBS-${label}`,
        expiresAt: new Date('2031-01-01T00:00:00.000Z'),
        expiryPrecision: 'DAY',
      },
    });
    const { lot } = await ledger.receiveLot(db, scope, {
      manufacturingBatchId: batch.id,
      packLevelId: pack.id,
      stockLocationId: catalog.locationId,
      unitsPerPack: 10,
      supplierName: 'Test',
      supplierInvoiceRef: randomUUID(),
      unitCostMinor: 1,
      printedMrpMinor: 1000,
      receivedExpiresAt: new Date('2031-01-01T00:00:00.000Z'),
      receivedExpiryPrecision: 'DAY',
      quantityUnits: 20,
      idempotencyKey: randomUUID(),
      receivedAt: new Date('2026-01-01'),
    });
    const sale = await sales.createSale(db, scope);
    await sales.addSaleLine(db, scope, {
      saleId: sale.id,
      medicineId: medicine.id,
      presentationId: presentation.id,
      packLevelId: pack.id,
      saleUnit: 'UNIT',
      quantity: 10,
      canonicalUnitsPerSaleUnit: 1,
      idempotencyKey: randomUUID(),
    });
    const line = await db.pharmacySaleLine.findFirstOrThrow({
      where: { saleId: sale.id },
      include: { allocations: true },
    });
    // The sale holds this test's lot and nothing else.
    expect(line.allocations.map((allocation) => allocation.inventoryLotId)).toEqual([lot.id]);
    return {
      batchId: batch.id,
      lotId: lot.id,
      saleId: sale.id,
      totalMinor: line.quantity * line.unitPriceMinor - line.discountMinor,
    };
  });
}

type Change = 'recall' | 'quarantine' | 'expiry';
const REASON: Record<Change, string> = {
  recall: 'SALE_BATCH_RECALLED',
  quarantine: 'SALE_BATCH_QUARANTINED',
  expiry: 'SALE_BATCH_EXPIRED',
};

/** The change, made after add-to-cart, through the same writes production uses. */
async function makeUnsafe(db: ScopedDb, batchId: string, change: Change) {
  if (change === 'recall') {
    await inventoryOperations.createRecall(db, scope, {
      batchId,
      reference: `RCL-${randomUUID().slice(0, 8)}`,
      reason: 'Manufacturer recall',
    });
  } else if (change === 'quarantine') {
    await db.pharmacyManufacturingBatch.update({
      where: { id: batchId },
      data: {
        state: 'QUARANTINED',
        stateReason: 'Cold-chain excursion',
        stateChangedAt: new Date(),
      },
    });
  } else {
    // The stored exclusive expiry instant has just passed.
    await db.pharmacyManufacturingBatch.update({
      where: { id: batchId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
  }
}

/** Everything a tender or completion could have written, organization-wide. */
async function moneyAndStock(saleId: string, lotId: string) {
  return tenant(async (db) => ({
    sale: await db.pharmacySale.findFirstOrThrow({
      where: { id: saleId },
      select: { status: true, receiptNumber: true, completedAt: true },
    }),
    tenders: await db.pharmacyTender.count(),
    journal: await db.financeJournalEntry.count(),
    movements: await db.pharmacyStockMovement.count(),
    balances: await db.pharmacyStockBalance.findMany({
      where: { inventoryLotId: lotId },
      select: { stockLocationId: true, disposition: true, onHandUnits: true },
      orderBy: [{ stockLocationId: 'asc' }, { disposition: 'asc' }],
    }),
    completions: await db.pharmacySaleEvent.count({ where: { kind: 'COMPLETED' } }),
    receiptSequences: await db.pharmacyReceiptNumberSequence.count(),
    moneyKeys: await db.pharmacyMoneyIdempotencyKey.count(),
  }));
}

function tenderInput(saleId: string, amountMinor: number) {
  return {
    saleId,
    deviceId: randomUUID(),
    businessDate,
    type: 'BANK_TRANSFER' as const,
    amountMinor,
    idempotencyKey: randomUUID(),
  };
}

describeDatabase('#633 batch safety is rechecked at tender and completion', () => {
  it('still settles and completes a sale whose batch stayed safe', async () => {
    const f = await cart('safe');
    const result = await tenant((db) =>
      settlement.applyPharmacyTender(db, scope, tenderInput(f.saleId, f.totalMinor))
    );
    expect(result).toMatchObject({ settled: true, remainingMinor: 0 });
    const after = await moneyAndStock(f.saleId, f.lotId);
    expect(after.sale.status).toBe('COMPLETED');
    expect(after.sale.receiptNumber).toEqual(expect.any(Number));
  });

  describe.each<Change>(['recall', 'quarantine', 'expiry'])('%s after add-to-cart', (change) => {
    it('refuses the tender and writes no money or stock', async () => {
      const f = await cart(`${change}-tender`);
      await tenant((db) => makeUnsafe(db, f.batchId, change));
      const before = await moneyAndStock(f.saleId, f.lotId);

      await expect(
        tenant((db) =>
          settlement.applyPharmacyTender(db, scope, tenderInput(f.saleId, f.totalMinor))
        )
      ).rejects.toMatchObject({ reason: REASON[change] });

      const after = await moneyAndStock(f.saleId, f.lotId);
      expect(after).toEqual(before);
      expect(after.sale).toEqual({ status: 'OPEN', receiptNumber: null, completedAt: null });
    });

    it('refuses completion and writes no receipt, posting or stock', async () => {
      const f = await cart(`${change}-complete`);
      await tenant((db) => makeUnsafe(db, f.batchId, change));
      const before = await moneyAndStock(f.saleId, f.lotId);

      await expect(
        tenant(async (db) => {
          await db.$queryRaw`SELECT id FROM pharmacy_sales WHERE id = ${f.saleId} FOR UPDATE`;
          const sale = await db.pharmacySale.findFirstOrThrow({
            where: { id: f.saleId },
            include: completion.completionSaleInclude,
          });
          return completion.completePaidPharmacySale(db, scope, sale, {
            deviceId: randomUUID(),
            businessDate,
          });
        })
      ).rejects.toMatchObject({ reason: REASON[change] });

      const after = await moneyAndStock(f.saleId, f.lotId);
      expect(after).toEqual(before);
      expect(after.sale).toEqual({ status: 'OPEN', receiptNumber: null, completedAt: null });
    });
  });

  it('keeps a tender taken before the recall and refuses the balance after it', async () => {
    const f = await cart('part-paid');
    const first = await tenant((db) =>
      settlement.applyPharmacyTender(db, scope, tenderInput(f.saleId, 1))
    );
    expect(first).toMatchObject({ settled: false });
    await tenant((db) => makeUnsafe(db, f.batchId, 'recall'));
    const before = await moneyAndStock(f.saleId, f.lotId);

    await expect(
      tenant((db) =>
        settlement.applyPharmacyTender(db, scope, tenderInput(f.saleId, f.totalMinor - 1))
      )
    ).rejects.toMatchObject({ reason: 'SALE_BATCH_RECALLED' });
    expect(await moneyAndStock(f.saleId, f.lotId)).toEqual(before);
  });

  it('re-reads the batch under lock: a tender queued behind a recall sees the recall', async () => {
    const f = await cart('race');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let recalled!: () => void;
    const recallWritten = new Promise<void>((resolve) => {
      recalled = resolve;
    });
    // The recall updates the batch row and holds it, uncommitted, until released.
    const recall = tenant(async (db) => {
      await makeUnsafe(db, f.batchId, 'recall');
      recalled();
      await gate;
    });
    await recallWritten;
    const tender = tenant((db) =>
      settlement.applyPharmacyTender(db, scope, tenderInput(f.saleId, f.totalMinor))
    );
    const outcome = tender.then(
      () => 'settled',
      (error: { reason?: string }) => error.reason ?? 'error'
    );
    try {
      await waitForLockWaiter();
    } finally {
      release();
    }
    await recall;
    expect(await outcome).toBe('SALE_BATCH_RECALLED');
    expect((await moneyAndStock(f.saleId, f.lotId)).sale.status).toBe('OPEN');
  });

  it('uses the database clock after a batch-lock wait and rolls back a partial tender', async () => {
    const f = await cart('expires-while-waiting');
    expect(f.totalMinor).toBeGreaterThan(1);
    const before = await moneyAndStock(f.saleId, f.lotId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const batchLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });

    // Set a near expiry and retain the row lock. The tender begins while the
    // batch is still valid, but cannot acquire FOR SHARE until after expiry.
    const blocker = tenant(async (db) => {
      await db.$queryRaw`
        UPDATE pharmacy_manufacturing_batches
        SET "expiresAt" = clock_timestamp() + interval '500 milliseconds'
        WHERE id = ${f.batchId}
        RETURNING id`;
      locked();
      await gate;
    });
    await batchLocked;
    const tender = tenant((db) =>
      settlement.applyPharmacyTender(db, scope, tenderInput(f.saleId, 1))
    );
    const outcome = tender.then(
      () => 'accepted',
      (error: { reason?: string }) => error.reason ?? 'error'
    );
    try {
      await waitForLockWaiter();
      await new Promise((resolve) => setTimeout(resolve, 650));
    } finally {
      release();
    }
    await blocker;

    expect(await outcome).toBe('SALE_BATCH_EXPIRED');
    expect(await moneyAndStock(f.saleId, f.lotId)).toEqual(before);
  });
});

/** Until some backend on this database waits on a row lock (the tender, behind the recall). */
async function waitForLockWaiter() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const [row] = await withPlatformDb(
      (db) =>
        db.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`
    );
    if ((row?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('The tender never waited on the recalled batch row.');
}
