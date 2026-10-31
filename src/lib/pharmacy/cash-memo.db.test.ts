/**
 * @vitest-environment node
 *
 * #708 Sindh cash memo against a REAL migrated PostgreSQL, as the restricted
 * runtime role under FORCE RLS: the buyer name and manufacturer are frozen at
 * completion and reprinted unchanged; the database refuses a later buyer-name
 * change; the owner policy refuses a nameless Sindh sale before any money
 * moves; a Punjab branch gets no cash memo.
 *
 * Requires TEST_DATABASE_URL: a disposable, migrated database reached as the runtime role.
 * Without it the suite reports skipped.
 */
import { randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let sales: typeof import('./sales');
let ledger: typeof import('./stock-ledger');
let settlement: typeof import('./settlement');
let counter: typeof import('./counter');
let cashMemo: typeof import('./cash-memo');
let presentation: typeof import('./counter-receipt-presentation');

const describeDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const run = randomUUID().slice(0, 8);
const organizationId = `cm708_${run}`;
const actorId = 'cm708-actor';
const sindh = { organizationId, branchId: `cm708_sd_${run}`, actorId };
const punjab = { organizationId, branchId: `cm708_pb_${run}`, actorId };
const businessDate = new Date('2026-10-31T00:00:00.000Z');
const locations: Record<string, string> = {};

const tenant = <T>(work: (db: ScopedDb) => Promise<T>, timeout = 30_000) =>
  withTenantDb(organizationId, work, { userId: actorId, timeout });

type Scope = typeof sindh;

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  ({ withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db'));
  sales = await import('./sales');
  ledger = await import('./stock-ledger');
  settlement = await import('./settlement');
  counter = await import('./counter');
  cashMemo = await import('./cash-memo');
  presentation = await import('./counter-receipt-presentation');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(withPlatformDb);

  await withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      organizationId
    )
  );
  await tenant(async (db) => {
    for (const [scope, province] of [
      [sindh, 'PK-SD'],
      [punjab, 'PK-PB'],
    ] as const) {
      await db.pharmacyBranch.create({
        data: {
          id: scope.branchId,
          organizationId,
          code: scope.branchId,
          name: `Cash memo ${province}`,
          addressLine: 'Test',
          city: 'Test',
          provinceCode: province,
        },
      });
      await db.branchRegulatoryProfile.create({
        data: {
          organizationId,
          branchId: scope.branchId,
          version: 1,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          provinceCode: province,
          jurisdictionRuleSetId: 'pk_pb_provisional_v1',
          premises: {},
          licenceCategory: 'PROVISIONAL',
          licenceNumber: `DL-${province}-0042`,
          licenceValidFrom: new Date('2026-01-01T00:00:00.000Z'),
          licenceValidTo: new Date('2027-12-31T00:00:00.000Z'),
          licenceEvidenceFileRef: 'file',
          permittedSchedules: [],
          qualifiedPersonRegistration: 'PPC-12345',
          qualifiedPersonValidFrom: new Date('2026-01-01T00:00:00.000Z'),
          qualifiedPersonValidTo: new Date('2027-12-31T00:00:00.000Z'),
          qualifiedPersonCoverageRosterRef: 'roster',
          fiscalStatus: 'UNCONFIRMED',
          retentionPolicy: {},
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
      locations[scope.branchId] = location.id;
    }
  });
}, 60_000);

/** An OPEN sale of 10 units of a medicine with a catalog manufacturer. */
async function cart(scope: Scope, label: string) {
  return tenant(async (db) => {
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: `Cash memo ${label}`,
        manufacturer: 'GSK Pakistan',
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        presentations: { create: { organizationId, presentation: 'Tablet' } },
      },
      include: { presentations: true },
    });
    const presentationRow = medicine.presentations[0]!;
    const pack = await db.packLevel.create({
      data: {
        organizationId,
        presentationId: presentationRow.id,
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
        batchNumber: `CM-${label}`,
        expiresAt: new Date('2031-01-01T00:00:00.000Z'),
        expiryPrecision: 'DAY',
      },
    });
    await ledger.receiveLot(db, scope, {
      manufacturingBatchId: batch.id,
      packLevelId: pack.id,
      stockLocationId: locations[scope.branchId]!,
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
      presentationId: presentationRow.id,
      packLevelId: pack.id,
      saleUnit: 'UNIT',
      quantity: 10,
      canonicalUnitsPerSaleUnit: 1,
      idempotencyKey: randomUUID(),
    });
    const line = await db.pharmacySaleLine.findFirstOrThrow({ where: { saleId: sale.id } });
    return {
      saleId: sale.id,
      totalMinor: line.quantity * line.unitPriceMinor - line.discountMinor,
    };
  });
}

const tender = (scope: Scope, saleId: string, amountMinor: number) =>
  tenant((db) =>
    settlement.applyPharmacyTender(db, scope, {
      saleId,
      deviceId: `device-${run}`,
      businessDate,
      type: 'BANK_TRANSFER',
      amountMinor,
      idempotencyKey: randomUUID(),
    })
  );

const read = (scope: Scope, saleId: string) =>
  tenant(async (db) => {
    const receipt = await counter.readCounterReceipt(db, scope, saleId, {
      name: 'Cash memo',
      currency: 'PKR',
    });
    const cashMemoHeader = receipt.completedAt
      ? await cashMemo.readPharmacyCashMemo(db, scope, new Date(receipt.completedAt))
      : null;
    return { ...receipt, cashMemo: cashMemoHeader };
  });

describeDatabase('#708 Sindh cash memo (PostgreSQL, FORCE RLS)', () => {
  it('freezes the typed buyer name and manufacturer, and reprints the same memo', async () => {
    const { saleId, totalMinor } = await cart(sindh, 'typed');
    await tenant((db) =>
      cashMemo.setPharmacySaleBuyerName(db, sindh, { saleId, buyerName: '  Ayesha  Khan ' })
    );
    await expect(tender(sindh, saleId, totalMinor)).resolves.toMatchObject({ settled: true });

    const first = await read(sindh, saleId);
    expect(first.buyerName).toBe('Ayesha Khan');
    expect(first.lines[0]).toMatchObject({
      identityStatus: 'ISSUED',
      manufacturer: 'GSK Pakistan',
    });
    expect(first.cashMemo).toEqual({
      template: 'SINDH_CASH_MEMO',
      licenceNumber: 'DL-PK-SD-0042',
      licenceValidFrom: '2026-01-01T00:00:00.000Z',
      licenceValidTo: '2027-12-31T00:00:00.000Z',
      pharmacistRegistration: 'PPC-12345',
    });

    // A later catalog edit does not reach the issued memo.
    await tenant((db) =>
      db.medicine.updateMany({
        where: { organizationId, productName: 'Cash memo typed' },
        data: { manufacturer: 'Someone else' },
      })
    );
    const reprint = await read(sindh, saleId);
    expect(reprint.lines[0]!.manufacturer).toBe('GSK Pakistan');
    const preview = presentation.buildCounterReceiptPreview(reprint, 'en', 80, true);
    for (const field of [
      'Drug sale licence: DL-PK-SD-0042',
      'Valid: 2026-01-01 to 2027-12-31',
      'Pharmacist reg.: PPC-12345',
      'Buyer: Ayesha Khan',
      'Manufacturer: GSK Pakistan',
      'Signature of qualified person: ________________',
    ])
      expect(preview).toContain(field);
  }, 60_000);

  it('refuses a buyer-name change once the receipt is issued, in the database itself', async () => {
    const { saleId, totalMinor } = await cart(sindh, 'immutable');
    await tender(sindh, saleId, totalMinor);
    await expect(
      tenant((db) =>
        db.pharmacySale.update({
          where: { organizationId_id: { organizationId, id: saleId } },
          data: { buyerName: 'Changed later' },
        })
      )
    ).rejects.toThrow(/ISSUED_RECEIPT_IMMUTABLE/);
    await expect(
      tenant((db) => cashMemo.setPharmacySaleBuyerName(db, sindh, { saleId, buyerName: 'X' }))
    ).rejects.toMatchObject({ reason: 'SALE_NOT_OPEN' });
    expect((await read(sindh, saleId)).buyerName).toBeNull();
  }, 60_000);

  it('rejects a blank stored buyer name', async () => {
    const { saleId } = await cart(sindh, 'blank');
    await expect(
      tenant((db) =>
        db.pharmacySale.update({
          where: { organizationId_id: { organizationId, id: saleId } },
          data: { buyerName: '   ' },
        })
      )
    ).rejects.toThrow(/pharmacy_sales_buyer_name_check/);
  }, 60_000);

  it('refuses a nameless Sindh sale before money moves if the owner requires a name', async () => {
    const { saleId, totalMinor } = await cart(sindh, 'policy');
    await tenant((db) =>
      db.pharmacyBranch.update({
        where: { id: sindh.branchId },
        data: { cashMemoBuyerNameRequired: true },
      })
    );
    try {
      await expect(tender(sindh, saleId, totalMinor)).rejects.toMatchObject({
        reason: 'BUYER_NAME_REQUIRED',
      });
      const state = await tenant(async (db) => ({
        sale: await db.pharmacySale.findFirstOrThrow({
          where: { id: saleId },
          select: { status: true, receiptNumber: true },
        }),
        tenders: await db.pharmacyTender.count({ where: { saleId } }),
      }));
      expect(state).toEqual({ sale: { status: 'OPEN', receiptNumber: null }, tenders: 0 });

      await tenant((db) =>
        cashMemo.setPharmacySaleBuyerName(db, sindh, { saleId, buyerName: 'Bilal Ahmed' })
      );
      await expect(tender(sindh, saleId, totalMinor)).resolves.toMatchObject({ settled: true });
      expect((await read(sindh, saleId)).buyerName).toBe('Bilal Ahmed');
    } finally {
      await tenant((db) =>
        db.pharmacyBranch.update({
          where: { id: sindh.branchId },
          data: { cashMemoBuyerNameRequired: false },
        })
      );
    }
  }, 60_000);

  it('gives a Punjab branch no cash memo, so its receipt is unchanged', async () => {
    const { saleId, totalMinor } = await cart(punjab, 'punjab');
    await tender(punjab, saleId, totalMinor);
    const receipt = await read(punjab, saleId);
    expect(receipt.cashMemo).toBeNull();
    const preview = presentation.buildCounterReceiptPreview(receipt, 'en', 80);
    expect(preview).not.toContain('Cash memo');
    expect(preview).not.toContain('Signature of qualified person');
  }, 60_000);
});
