/** Run only against a NEW disposable wha1364_* database, never an existing tenant. */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { addSaleLine, createSale, changeSaleStatus, returnSaleLine } from './sales';
import { receiveLot } from './stock-ledger';
import { applyPharmacyTender, refundPharmacyTender } from './settlement';
import { readCounterReceipt } from './counter';
import { afterAll } from 'vitest';

const url = process.env.WHA1364_RECEIPT_TEST_DATABASE_URL;
if (url && !new URL(url).pathname.startsWith('/wha1364_')) {
  throw new Error(
    'New isolated WHA1364_RECEIPT_TEST_DATABASE_URL required; no skipped DB acceptance'
  );
}
// The app client, not a bare PrismaPg one: only it decodes the void result of the services'
// `SELECT pg_advisory_xact_lock(...)`. It reads DATABASE_URL lazily, on first use.
if (url) process.env.DATABASE_URL = url;
const client = url ? db : null;
const describeDatabase = url ? describe : describe.skip;
const org = `org_${randomUUID()}`;
const branch = `branch_${randomUUID()}`;
const scope = { organizationId: org, branchId: branch, actorId: 'receipt-test-actor' };
const businessDate = new Date('2026-09-05T13:14:00.000Z');
function transaction<T>(work: (db: ScopedDb) => Promise<T>, organizationId = org) {
  if (!client) throw new Error('Isolated receipt database required');
  return client.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(
        "SELECT set_config('app.current_organization_id', $1, true), set_config('app.is_platform_admin', 'false', true)",
        organizationId
      );
      return work(tx as ScopedDb);
    },
    { timeout: 30000 }
  );
}
beforeAll(async () => {
  if (!client) return;
  const [role] = await client.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
  );
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  // Integrated tip (20261012120000_visibility_context_anchors): tenant rows must reference an
  // existing organization, so anchor this suite's synthetic tenant first.
  await client.$transaction(async (tx) => {
    await tx.$queryRawUnsafe("SELECT set_config('app.is_platform_admin', 'true', true)");
    await tx.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      org
    );
  });
  await transaction((db) =>
    db.pharmacyBranch.create({
      data: {
        id: branch,
        organizationId: org,
        code: branch,
        name: 'Receipt test',
        addressLine: 'Test',
        city: 'Test',
        provinceCode: 'PB',
      },
    })
  );
});
afterAll(() => client?.$disconnect());

async function fixture() {
  return transaction(async (db) => {
    const medicine = await db.medicine.create({
      data: {
        organizationId: org,
        productName: 'Issued medicine',
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        presentations: { create: { organizationId: org, presentation: 'Issued tablet' } },
      },
      include: { presentations: true },
    });
    const presentation = medicine.presentations[0]!;
    const ingredient = await db.ingredient.create({
      data: { organizationId: org, name: `Ingredient ${randomUUID()}` },
    });
    await db.medicineStrengthComponent.create({
      data: {
        organizationId: org,
        medicineId: medicine.id,
        ingredientId: ingredient.id,
        value: 500,
        unit: 'mg',
      },
    });
    const pack = await db.packLevel.create({
      data: {
        organizationId: org,
        presentationId: presentation.id,
        versionGroupId: randomUUID(),
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01'),
      },
    });
    const location = await db.pharmacyStockLocation.create({
      data: {
        organizationId: org,
        branchId: branch,
        code: randomUUID(),
        name: 'Test stock',
        kind: 'STORE',
      },
    });
    const batches = [];
    for (const [index, quantity] of [3, 7].entries()) {
      const expiresAt = new Date(`203${index + 1}-01-01T00:00:00.000Z`);
      const batch = await db.pharmacyManufacturingBatch.create({
        data: {
          organizationId: org,
          medicineId: medicine.id,
          batchNumber: `ISSUED-${index}`,
          expiresAt,
          expiryPrecision: 'DAY',
        },
      });
      await receiveLot(db, scope, {
        manufacturingBatchId: batch.id,
        packLevelId: pack.id,
        stockLocationId: location.id,
        unitsPerPack: 10,
        supplierName: 'Test',
        supplierInvoiceRef: randomUUID(),
        unitCostMinor: 1,
        printedMrpMinor: 1000,
        receivedExpiresAt: expiresAt,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: quantity,
        idempotencyKey: randomUUID(),
        receivedAt: new Date('2026-01-01'),
      });
      batches.push(batch);
    }
    const sale = await createSale(db, scope);
    await addSaleLine(db, scope, {
      saleId: sale.id,
      medicineId: medicine.id,
      presentationId: presentation.id,
      packLevelId: pack.id,
      saleUnit: 'UNIT',
      quantity: 10,
      canonicalUnitsPerSaleUnit: 1,
      discountMinor: 50,
      discountKind: 'DISCOUNT',
      approvedByUserId: scope.actorId,
      approvalPolicy: 'test',
      idempotencyKey: randomUUID(),
    });
    return {
      sale,
      medicine,
      presentation,
      batches,
      input: {
        saleId: sale.id,
        deviceId: randomUUID(),
        businessDate,
        type: 'BANK_TRANSFER' as const,
        amountMinor: 950,
        idempotencyKey: randomUUID(),
      },
    };
  });
}
const read = (saleId: string) =>
  transaction((db) => readCounterReceipt(db, scope, saleId, { name: 'Test', currency: 'PKR' }));
async function counts(saleId: string) {
  return transaction(async (db) => ({
    sale: await db.pharmacySale.findFirstOrThrow({ where: { id: saleId } }),
    tenders: await db.pharmacyTender.count({ where: { saleId } }),
    events: await db.pharmacySaleEvent.findMany({ where: { saleId, kind: 'COMPLETED' } }),
  }));
}

describeDatabase('numbered receipt issuance on migrated PostgreSQL', () => {
  it('keeps issued labels and both batch quantities after catalog edits, with original sale money after refund', async () => {
    const f = await fixture();
    const result = await transaction((db) => applyPharmacyTender(db, scope, f.input));
    const before = await read(f.sale.id);
    await transaction(async (db) => {
      await db.medicine.update({ where: { id: f.medicine.id }, data: { productName: 'Renamed' } });
      await db.medicineStrengthComponent.updateMany({
        where: { medicineId: f.medicine.id },
        data: { value: 250, unit: 'g' },
      });
      await db.presentation.update({
        where: { id: f.presentation.id },
        data: { presentation: 'Renamed form' },
      });
      for (const batch of f.batches)
        await db.pharmacyManufacturingBatch.update({
          where: { id: batch.id },
          data: { batchNumber: `Renamed ${batch.id}`, expiresAt: new Date('2040-01-01') },
        });
      const tender = await db.pharmacyTender.findFirstOrThrow({ where: { saleId: f.sale.id } });
      // A refund on a COMPLETED sale is capped by the value of goods returned, so goods come
      // back first: 2 of the 10 units return 190 of the 950 net.
      const allocation = await db.pharmacySaleLineAllocation.findFirstOrThrow({
        where: { saleLineId: before.lines[0]!.saleLineId, canonicalUnits: 3 },
      });
      await returnSaleLine(db, scope, {
        saleLineId: allocation.saleLineId,
        lotId: allocation.inventoryLotId,
        canonicalUnits: 2,
        disposition: 'RESTOCK',
        reason: 'test original sale distinction',
        integrityDecision: 'Sealed strip',
        idempotencyKey: randomUUID(),
      });
      await refundPharmacyTender(db, scope, {
        originalTenderId: tender.id,
        deviceId: f.input.deviceId,
        businessDate,
        amountMinor: 100,
        reason: 'test original sale distinction',
        idempotencyKey: randomUUID(),
      });
    });
    expect(await read(f.sale.id)).toEqual(before);
    expect(before.lines).toHaveLength(1);
    expect(before.lines[0]).toMatchObject({
      identityStatus: 'ISSUED',
      medicineName: 'Issued medicine',
      strength: '500 mg',
      presentation: 'Issued tablet',
      quantity: 10,
      lineTotalMinor: 950,
    });
    expect(
      before.lines[0]!.allocations?.map((a) => [a.batchNumber, a.canonicalUnits]).sort()
    ).toEqual([
      ['ISSUED-0', 3],
      ['ISSUED-1', 7],
    ]);
    expect(before.lines[0]!.allocations?.map((a) => a.expiresAt).sort()).toEqual([
      '2031-01-01T00:00:00.000Z',
      '2032-01-01T00:00:00.000Z',
    ]);
    expect(before.totals).toEqual({
      grossMinor: 1000,
      discountMinor: 50,
      netMinor: 950,
      tenderedMinor: 950,
      changeMinor: 0,
    });

    expect(result).toMatchObject({ settled: true, receiptNumber: 1 });
  });
  it('returns all allocated lots as descriptive subrows of one financial line', async () => {
    const f = await fixture();
    await transaction((db) => applyPharmacyTender(db, scope, f.input));
    const receipt = await read(f.sale.id);
    expect(receipt.lines).toHaveLength(1);
    expect(
      receipt.lines[0]!.allocations?.map((a) => [a.batchNumber, a.canonicalUnits]).sort()
    ).toEqual([
      ['ISSUED-0', 3],
      ['ISSUED-1', 7],
    ]);
    expect(receipt.lines[0]!.lineTotalMinor).toBe(950);
    expect(receipt.totals.netMinor).toBe(950);
  });
  it('same-key competing final tenders and replay issue one snapshot and one tender', async () => {
    const f = await fixture();
    const results = await Promise.all([
      transaction((db) => applyPharmacyTender(db, scope, f.input)),
      transaction((db) => applyPharmacyTender(db, scope, f.input)),
    ]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(await transaction((db) => applyPharmacyTender(db, scope, f.input))).toMatchObject({
      replayed: true,
    });
    const state = await counts(f.sale.id);
    expect(state.tenders).toBe(1);
    expect(state.events).toHaveLength(1);
  });
  it('different-key competing final tenders issue exactly once', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      transaction((db) => applyPharmacyTender(db, scope, f.input)),
      transaction((db) =>
        applyPharmacyTender(db, scope, { ...f.input, idempotencyKey: randomUUID() })
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason.message).toBe('SALE_NOT_OPEN');
    const state = await counts(f.sale.id);
    expect(state.tenders).toBe(1);
    expect(state.events).toHaveLength(1);
  });
  it('partial tender issues no snapshot; final tender captures one', async () => {
    const f = await fixture();
    await transaction((db) => applyPharmacyTender(db, scope, { ...f.input, amountMinor: 400 }));
    expect((await counts(f.sale.id)).events).toHaveLength(0);
    await transaction((db) =>
      applyPharmacyTender(db, scope, { ...f.input, amountMinor: 550, idempotencyKey: randomUUID() })
    );
    const state = await counts(f.sale.id);
    expect(state.events).toHaveLength(1);
    expect(state.tenders).toBe(2);
    expect((await read(f.sale.id)).totals.tenderedMinor).toBe(950);
  });
  it('invalid snapshot rolls back sale, tender, receipt sequence and idempotency; retry succeeds', async () => {
    const f = await fixture();
    await transaction((db) =>
      db.medicine.update({ where: { id: f.medicine.id }, data: { productName: '' } })
    );
    await expect(transaction((db) => applyPharmacyTender(db, scope, f.input))).rejects.toThrow(
      'INVALID_RECEIPT_IDENTITY'
    );
    const state = await counts(f.sale.id);
    expect(state.sale).toMatchObject({ status: 'OPEN', receiptNumber: null });
    expect(state.tenders).toBe(0);
    expect(state.events).toHaveLength(0);
    await transaction(async (db) => {
      expect(
        await db.pharmacyReceiptNumberSequence.count({ where: { deviceId: f.input.deviceId } })
      ).toBe(0);
      expect(
        await db.pharmacyMoneyIdempotencyKey.count({ where: { deviceId: f.input.deviceId } })
      ).toBe(0);
      await db.medicine.update({ where: { id: f.medicine.id }, data: { productName: 'Fixed' } });
    });
    expect(await transaction((db) => applyPharmacyTender(db, scope, f.input))).toMatchObject({
      receiptNumber: 1,
    });
  });
  it('event write failure aborts issuance rather than committing without evidence', async () => {
    const f = await fixture();
    await expect(
      transaction((db) => {
        const failing = new Proxy(db, {
          get(target, key) {
            if (key === 'pharmacySaleEvent')
              return {
                create: async () => {
                  throw new Error('EVENT_WRITE_FAILED');
                },
              };
            return Reflect.get(target, key);
          },
        });
        return applyPharmacyTender(failing, scope, f.input);
      })
    ).rejects.toThrow('EVENT_WRITE_FAILED');
    const state = await counts(f.sale.id);
    expect(state.sale.receiptNumber).toBeNull();
    expect(state.tenders).toBe(0);
    expect(state.events).toHaveLength(0);
  });
  it('legacy/status-only completion reports unavailable history without live catalog backfill', async () => {
    const f = await fixture();
    await transaction((db) => changeSaleStatus(db, scope, f.sale.id, 'complete'));
    const receipt = await read(f.sale.id);
    expect(receipt.receiptNumber).toBeGreaterThan(0);
    expect(receipt.lines[0]).toMatchObject({
      identityStatus: 'UNAVAILABLE',
      medicineName: 'Historical identity unavailable',
    });
    expect(receipt.lines[0]!.allocations?.map((a) => a.batchNumber)).toEqual([null, null]);
    await transaction((db) =>
      db.pharmacySale.update({
        where: { id: f.sale.id },
        data: {
          receiptNumber: 42,
          receiptDeviceId: f.input.deviceId,
          businessDate,
        },
      })
    );
    const numberedLegacy = await read(f.sale.id);
    expect(numberedLegacy.receiptNumber).toBe(42);
    expect(numberedLegacy.lines[0]!.identityStatus).toBe('UNAVAILABLE');
    await transaction((db) =>
      db.pharmacySaleEvent.create({
        data: {
          organizationId: org,
          branchId: branch,
          saleId: f.sale.id,
          kind: 'COMPLETED',
          actorId: scope.actorId,
          payload: { receiptIdentitySnapshotVersion: 9 },
        },
      })
    );
    await expect(read(f.sale.id)).rejects.toThrow('INVALID_RECEIPT_IDENTITY');
  });
  it('reader refuses duplicate snapshots and remains tenant/requested-branch scoped', async () => {
    const f = await fixture();
    await transaction((db) => applyPharmacyTender(db, scope, f.input));
    await expect(
      transaction((db) =>
        readCounterReceipt(db, { ...scope, branchId: 'sibling' }, f.sale.id, {
          name: 'Test',
          currency: 'PKR',
        })
      )
    ).rejects.toThrow('CROSS_BRANCH_REFERENCE');
    await expect(
      transaction(
        (db) =>
          readCounterReceipt(db, { ...scope, organizationId: 'other_org' }, f.sale.id, {
            name: 'Test',
            currency: 'PKR',
          }),
        'other_org'
      )
    ).rejects.toThrow('CROSS_BRANCH_REFERENCE');
    await transaction(async (db) => {
      const event = await db.pharmacySaleEvent.findFirstOrThrow({
        where: { saleId: f.sale.id, kind: 'COMPLETED' },
      });
      await db.pharmacySaleEvent.create({
        data: {
          organizationId: org,
          branchId: branch,
          saleId: f.sale.id,
          kind: 'COMPLETED',
          actorId: scope.actorId,
          payload: event.payload!,
        },
      });
    });
    await expect(read(f.sale.id)).rejects.toThrow('INVALID_RECEIPT_IDENTITY');
  });
});
