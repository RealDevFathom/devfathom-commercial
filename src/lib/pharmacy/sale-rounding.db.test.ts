/**
 * @vitest-environment node
 *
 * SEC-643-01: real counter search -> preview -> persisted line -> tender,
 * using application transactions and real stock allocation. Requires
 * SEC643_TEST_DATABASE_URL (or TEST_DATABASE_URL): a throwaway, migrated LOCAL
 * database as a NOSUPERUSER/NOBYPASSRLS runtime role. No owner URL, migration,
 * service process or external integration. Fixtures remain. No URL means SKIP.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { previewSaleLine } from './counter-pricing';

const testUrl = process.env.SEC643_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (testUrl) process.env.DATABASE_URL = testUrl;
const describeDatabase = testUrl ? describe : describe.skip;
type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let sales: typeof import('./sales');
let counter: typeof import('./counter');
let ledger: typeof import('./stock-ledger');
let settlement: typeof import('./settlement');

const run = randomUUID().replaceAll('-', '');
const scope = {
  organizationId: 'sec643_' + run,
  branchId: 'sec643_branch_' + run,
  actorId: 'sec643_cashier_' + run,
};
const at = new Date('2026-10-24T12:00:00.000Z');
const expiry = new Date('2100-01-01T00:00:00.000Z');
let stockLocationId: string;
const tenant = <T>(work: (db: ScopedDb) => Promise<T>) =>
  withTenantDb(scope.organizationId, work, { userId: scope.actorId, skipDrain: true });

/** Each case owns a medicine, preventing cross-case FEFO allocations. */
async function catalog(
  label: string,
  increment: number | null,
  policyFirst: boolean,
  quantityUnits = 200
) {
  return tenant(async (db) => {
    const medicine = await db.medicine.create({
      data: {
        organizationId: scope.organizationId,
        productName: 'SEC643 ' + label + run,
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        presentations: { create: { organizationId: scope.organizationId, presentation: 'Tablet' } },
      },
      include: { presentations: true },
    });
    const presentation = medicine.presentations[0]!;
    const makeLevel = (level: string, unitsPerParent: number, parentPackLevelId?: string) =>
      db.packLevel.create({
        data: {
          organizationId: scope.organizationId,
          presentationId: presentation.id,
          versionGroupId: randomUUID(),
          version: 1,
          level,
          unitsPerParent,
          parentPackLevelId,
          effectiveFrom: new Date('2026-01-01'),
        },
      });
    const box = await makeLevel('BOX', 1);
    const strip = await makeLevel('STRIP', 2, box.id);
    await makeLevel('UNIT', 10, strip.id);
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        organizationId: scope.organizationId,
        medicineId: medicine.id,
        batchNumber: 'SEC643-BATCH',
        expiresAt: expiry,
        expiryPrecision: 'DAY',
      },
    });
    const policies = [
      { packLevelId: box.id, batchReference: 'ANOTHER-BATCH', roundingIncrementMinor: 7 },
    ];
    if (increment !== null) {
      const matching = {
        packLevelId: box.id,
        batchReference: batch.batchNumber,
        roundingIncrementMinor: increment,
      };
      if (policyFirst) policies.unshift(matching);
      else policies.push(matching);
    }
    for (const policy of policies) {
      await db.medicinePackMrp.create({
        data: { organizationId: scope.organizationId, printedMrpMinor: 1_003, ...policy },
      });
    }
    const { lot } = await ledger.receiveLot(db, scope, {
      manufacturingBatchId: batch.id,
      packLevelId: box.id,
      stockLocationId,
      unitsPerPack: 20,
      supplierName: 'SEC643 local fixture',
      supplierInvoiceRef: randomUUID(),
      unitCostMinor: 1,
      printedMrpMinor: 1_003,
      receivedExpiresAt: expiry,
      receivedExpiryPrecision: 'DAY',
      quantityUnits,
      idempotencyKey: randomUUID(),
      receivedAt: new Date('2026-01-01'),
    });
    await ledger.breakPack(db, scope, {
      inventoryLotId: lot.id,
      stockLocationId,
      requiredLooseUnits: Math.min(40, quantityUnits),
      idempotencyKey: randomUUID(),
      at,
    });
    return { medicine, lot };
  });
}

describeDatabase('SEC-643-01 persisted quote/charge parity on PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)) {
      throw new Error('SEC643 regression requires a local throwaway database');
    }
    ({ withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
    sales = await import('./sales');
    counter = await import('./counter');
    ledger = await import('./stock-ledger');
    settlement = await import('./settlement');
    const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
    await assertRlsEnforcingRole(withPlatformDb);
    await withPlatformDb((db) =>
      db.$executeRawUnsafe(
        `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
         VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
        scope.organizationId
      )
    );
    stockLocationId = await tenant(async (db) => {
      await db.pharmacyBranch.create({
        data: {
          id: scope.branchId,
          organizationId: scope.organizationId,
          code: scope.branchId,
          name: 'SEC643 counter rounding',
          addressLine: 'Test',
          city: 'Test',
          provinceCode: 'PB',
        },
      });
      return (
        await db.pharmacyStockLocation.create({
          data: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            code: 'SEC643-STOCK',
            name: 'Stock',
            kind: 'STORE',
          },
        })
      ).id;
    });
  }, 60_000);

  it.each([
    { kind: 'STRIP', quantity: 1, increment: 5, expected: 500, ceiling: 501, policyFirst: true },
    { kind: 'STRIP', quantity: 1, increment: 5, expected: 500, ceiling: 501, policyFirst: false },
    { kind: 'STRIP', quantity: 3, increment: 5, expected: 500, ceiling: 501, policyFirst: true },
    { kind: 'STRIP', quantity: 3, increment: 5, expected: 500, ceiling: 501, policyFirst: false },
    { kind: 'PACK', quantity: 2, increment: 5, expected: 1_003, ceiling: 1_003, policyFirst: true },
    { kind: 'UNIT', quantity: 4, increment: 5, expected: 50, ceiling: 50, policyFirst: true },
    { kind: 'STRIP', quantity: 2, increment: null, expected: 501, ceiling: 501, policyFirst: true },
    { kind: 'STRIP', quantity: 2, increment: 6, expected: 498, ceiling: 501, policyFirst: true },
  ] as const)(
    '$kind quantity=$quantity increment=$increment policyFirst=$policyFirst',
    async ({ kind, quantity, increment, expected, ceiling, policyFirst }) => {
      const { medicine, lot } = await catalog(
        [kind, quantity, increment, policyFirst].join('-'),
        increment,
        policyFirst
      );
      const { rows } = await tenant((db) =>
        counter.searchCounterCatalog(db, scope, { query: medicine.productName, at })
      );
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      const option = row.saleUnits.find((unit) => unit.kind === kind)!;
      const preview = previewSaleLine({
        option,
        quantity,
        printedMrpMinor: row.printedMrpMinor!,
        unitsPerPack: row.unitsPerPack!,
        roundingIncrementMinor: row.roundingIncrementMinor,
        availableUnits: row.onHandUnits,
      });
      expect(row.recommendedLotId).toBe(lot.id);
      expect(row.roundingIncrementMinor).toBe(increment ?? 1);
      expect(row.saleableUnits.find((unit) => unit.kind === kind)?.unitPriceMinor).toBe(expected);
      expect(preview.unitPriceMinor).toBe(expected);
      const expectedTotal = expected * quantity;
      expect(preview.grossMinor).toBe(expectedTotal);
      const { line } = await tenant(async (db) => {
        const sale = await sales.createSale(db, scope);
        return sales.addSaleLine(db, scope, {
          saleId: sale.id,
          medicineId: row.medicineId,
          presentationId: row.presentationId,
          packLevelId: option.packLevelId,
          saleUnit: kind,
          quantity,
          canonicalUnitsPerSaleUnit: option.canonicalUnitsPerSaleUnit,
          idempotencyKey: randomUUID(),
        });
      });
      // A fresh transaction proves the charged value was actually persisted.
      const stored = await tenant((db) =>
        db.pharmacySaleLine.findFirstOrThrow({
          where: { id: line.id, organizationId: scope.organizationId, branchId: scope.branchId },
          include: { allocations: true },
        })
      );
      expect(stored.quantity).toBe(quantity);
      expect(stored.unitPriceMinor).toBe(expected);
      expect(stored.unitPriceMinor).toBe(preview.unitPriceMinor);
      expect(stored.unitPriceMinor * stored.quantity).toBe(expectedTotal);
      expect(stored.proRataCeilingMinor).toBe(ceiling);
      expect(stored.unitPriceMinor).toBeLessThanOrEqual(stored.proRataCeilingMinor);
      expect(stored.unitPriceMinor * stored.quantity).toBe(preview.grossMinor);
      expect(stored.canonicalUnits).toBe(preview.canonicalUnits);
      expect(stored.allocations).toHaveLength(1);
      expect(stored.allocations[0]).toMatchObject({
        inventoryLotId: lot.id,
        canonicalUnits: preview.canonicalUnits,
      });
      // No payment adapter: BANK_TRANSFER is recorded entirely in the local DB.
      const paid = await tenant((db) =>
        settlement.applyPharmacyTender(db, scope, {
          saleId: stored.saleId,
          deviceId: randomUUID(),
          businessDate: new Date('2026-10-24'),
          type: 'BANK_TRANSFER',
          amountMinor: preview.grossMinor,
          idempotencyKey: randomUUID(),
        })
      );
      expect(paid).toMatchObject({ settled: true, remainingMinor: 0 });
      const tender = await tenant((db) =>
        db.pharmacyTender.findFirstOrThrow({
          where: {
            saleId: stored.saleId,
            organizationId: scope.organizationId,
            branchId: scope.branchId,
          },
        })
      );
      expect(tender.amountMinor).toBe(expectedTotal);
      expect(tender.amountMinor).toBe(preview.grossMinor);
      const journal = await tenant((db) =>
        db.financeJournalEntry.findFirstOrThrow({
          where: {
            organizationId: scope.organizationId,
            sourceKind: 'PHARMACY_TENDER',
            sourceId: tender.id,
          },
          include: { lines: true },
        })
      );
      const debits = journal.lines
        .filter((line) => line.side === 'DEBIT')
        .reduce((sum, line) => sum + line.amountMinor, 0);
      const credits = journal.lines
        .filter((line) => line.side === 'CREDIT')
        .reduce((sum, line) => sum + line.amountMinor, 0);
      expect(debits).toBe(expectedTotal);
      expect(credits).toBe(expectedTotal);
      expect(debits).toBe(credits);
    },
    30_000
  );

  /**
   * Decision Q3-A: MRP and its rounding are resolved per allocated lot, and the
   * line keeps the existing maximum-across-allocations price and ceiling.
   */
  async function checkSplitLotCheckout(
    laterMrpMinor: number,
    expected: { unitPriceMinor: number; ceilingMinor: number }
  ) {
    const { medicine, lot: firstLot } = await catalog(`split-lot-${laterMrpMinor}`, 5, true, 20);
    const secondLot = await tenant(async (db) => {
      const batch = await db.pharmacyManufacturingBatch.create({
        data: {
          organizationId: scope.organizationId,
          medicineId: medicine.id,
          batchNumber: 'SEC643-BATCH-LATER',
          expiresAt: new Date('2100-02-01T00:00:00.000Z'),
          expiryPrecision: 'DAY',
        },
      });
      await db.medicinePackMrp.create({
        data: {
          organizationId: scope.organizationId,
          packLevelId: firstLot.packLevelId,
          batchReference: batch.batchNumber,
          printedMrpMinor: laterMrpMinor,
          roundingIncrementMinor: 6,
        },
      });
      const received = await ledger.receiveLot(db, scope, {
        manufacturingBatchId: batch.id,
        packLevelId: firstLot.packLevelId,
        stockLocationId,
        unitsPerPack: 20,
        supplierName: 'SEC643 split fixture',
        supplierInvoiceRef: randomUUID(),
        unitCostMinor: 1,
        printedMrpMinor: laterMrpMinor,
        receivedExpiresAt: batch.expiresAt,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: 200,
        idempotencyKey: randomUUID(),
        receivedAt: new Date('2026-01-02'),
      });
      // Open one pack so the later lot can supply loose units: allocation for a
      // 10-unit strip from a 20-unit pack otherwise stops at INVALID_ARRANGEMENT
      // before line pricing is ever reached.
      await ledger.breakPack(db, scope, {
        inventoryLotId: received.lot.id,
        stockLocationId,
        requiredLooseUnits: 20,
        idempotencyKey: randomUUID(),
        at,
      });
      return received.lot;
    });
    const { rows } = await tenant((db) =>
      counter.searchCounterCatalog(db, scope, { query: medicine.productName, at })
    );
    const row = rows[0]!;
    const option = row.saleUnits.find((unit) => unit.kind === 'STRIP')!;
    const preview = previewSaleLine({
      option,
      quantity: 3,
      printedMrpMinor: row.printedMrpMinor!,
      unitsPerPack: row.unitsPerPack!,
      roundingIncrementMinor: row.roundingIncrementMinor,
      availableUnits: row.onHandUnits,
    });
    expect(preview.grossMinor).toBe(1_500);
    const sale = await tenant((db) => sales.createSale(db, scope));
    const addLine = () =>
      tenant((db) =>
        sales.addSaleLine(db, scope, {
          saleId: sale.id,
          medicineId: medicine.id,
          presentationId: row.presentationId,
          packLevelId: option.packLevelId,
          saleUnit: 'STRIP',
          quantity: 3,
          canonicalUnitsPerSaleUnit: option.canonicalUnitsPerSaleUnit,
          idempotencyKey: randomUUID(),
        })
      );
    const { line } = await addLine();
    const stored = await tenant((db) =>
      db.pharmacySaleLine.findFirstOrThrow({
        where: { id: line.id },
        include: { allocations: true },
      })
    );
    expect(stored.allocations).toHaveLength(2);
    expect(new Set(stored.allocations.map((part) => part.inventoryLotId))).toEqual(
      new Set([firstLot.id, secondLot.id])
    );
    expect(stored.unitPriceMinor).toBe(expected.unitPriceMinor);
    expect(stored.proRataCeilingMinor).toBe(expected.ceilingMinor);
    expect(stored.unitPriceMinor).toBeLessThanOrEqual(stored.proRataCeilingMinor);
    const chargedMinor = stored.unitPriceMinor * stored.quantity;
    await tenant((db) =>
      settlement.applyPharmacyTender(db, scope, {
        saleId: sale.id,
        deviceId: randomUUID(),
        businessDate: new Date('2026-10-24'),
        type: 'BANK_TRANSFER',
        amountMinor: chargedMinor,
        idempotencyKey: randomUUID(),
      })
    );
    const receipt = await tenant((db) =>
      counter.readCounterReceipt(db, scope, sale.id, {
        name: 'SEC643 Pharmacy',
        currency: 'PKR',
      })
    );
    expect(receipt.totals.netMinor).toBe(chargedMinor);
    expect(receipt.totals.tenderedMinor).toBe(chargedMinor);
  }

  it(
    'charges the higher per-lot price when a later batch has a higher MRP',
    // Later lot: 1030 * 10 / 20 = 515 ceiling, rounded to its own increment 6 => 510.
    () => checkSplitLotCheckout(1_030, { unitPriceMinor: 510, ceilingMinor: 515 }),
    30_000
  );

  it(
    'keeps the earlier lot price when a later batch has a lower MRP',
    // Later lot: 900 * 10 / 20 = 450; the earlier lot's 500 (ceiling 501) remains the maximum.
    () => checkSplitLotCheckout(900, { unitPriceMinor: 500, ceilingMinor: 501 }),
    30_000
  );
});
