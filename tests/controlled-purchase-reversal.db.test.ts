// @vitest-environment node
/**
 * GitHub pharmacy #305, on the full migrated schema and native Prisma client.
 * Only synthetic tenant fixtures are inserted. No replacement schema/client,
 * disabled constraints/triggers, or privileged application connection is used.
 * The fixture seeds a POSTED controlled purchase (including a historic
 * quarantine purchase); reversal itself calls the actual reverseGoodsReceipt.
 * PIN authentication on purchase posting is covered separately, not mocked here.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
process.env.PLATFORM_ENCRYPTION_KEY ??= Buffer.alloc(32, 30).toString('base64');
const describeDb = url ? describe : describe.skip;
const AT = new Date('2026-09-02T09:00:00Z');
const EXPIRY = new Date('2028-06-01T00:00:00Z');
let tenant: typeof import('@/lib/tenancy/scoped-db');
let receipts: typeof import('@/lib/pharmacy/goods-receipt');
let ledger: typeof import('@/lib/pharmacy/stock-ledger');
let register: typeof import('@/lib/pharmacy/controlled-register');

beforeAll(async () => {
  if (!url) return;
  [tenant, receipts, ledger, register] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/pharmacy/goods-receipt'),
    import('@/lib/pharmacy/stock-ledger'),
    import('@/lib/pharmacy/controlled-register'),
  ]);
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(tenant.withPlatformDb);
}, 120_000);

async function receiptFixture(
  disposition: 'AVAILABLE' | 'QUARANTINE' = 'AVAILABLE',
  options: { controlled?: boolean; originals?: readonly boolean[] } = {}
) {
  const originals = options.originals ?? [true];
  const id = randomUUID();
  const scope = {
    organizationId: `org305-${id}`,
    branchId: `branch305-${id}`,
    actorId: 'receiver',
  };
  return tenant.withTenantDb(scope.organizationId, async (db) => {
    const { organizationId, branchId } = scope;
    await db.pharmacyBranch.create({
      data: {
        id: branchId,
        organizationId,
        code: 'MAIN',
        name: 'Synthetic #305',
        addressLine: '1 Test Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: `Controlled synthetic ${id}`,
        productFamily: 'PHARMACEUTICAL',
        controlled: options.controlled ?? true,
        presentations: { create: { organizationId, presentation: '10 per strip' } },
      },
      include: { presentations: true },
    });
    const pack = await db.packLevel.create({
      data: {
        organizationId,
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `pack-${id}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: AT,
      },
    });
    const store = await db.pharmacyStockLocation.create({
      data: {
        organizationId,
        branchId,
        code: 'MAIN',
        name: 'Main store',
        kind: 'STORE',
      },
    });
    const quarantine = await db.pharmacyStockLocation.create({
      data: {
        organizationId,
        branchId,
        code: 'QUAR',
        name: 'Quarantine',
        kind: 'QUARANTINE',
      },
    });
    const supplier = await db.pharmacySupplier.create({
      data: {
        organizationId,
        name: 'Synthetic supplier',
        authorized: true,
        licences: {
          create: {
            licenceType: 'DRUG_SALE',
            licenceNumber: `DSL-${id}`,
            issuingAuthority: 'DRAP',
            issuedAt: AT,
            expiresAt: EXPIRY,
            verifiedAt: AT,
          },
        },
      },
    });
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        organizationId,
        medicineId: medicine.id,
        batchNumber: `B-${id}`,
        expiresAt: EXPIRY,
      },
    });
    const isQuarantine = disposition === 'QUARANTINE';
    const receipt = await db.pharmacyGoodsReceipt.create({
      data: {
        organizationId,
        branchId,
        reference: `GRN-${id}`,
        supplierId: supplier.id,
        supplierInvoiceRef: `INV-${id}`,
        supplierInvoiceDate: AT,
        warrantyEvidenceRef: `W-${id}`,
        receivedByUserId: scope.actorId,
        receivedAt: AT,
        qualifiedPersonUserId: 'witness',
        directPurchase: true,
        bypassReason: 'Synthetic fixture direct purchase',
        bypassApprovedByUserId: 'approver',
        bypassApprovedAt: AT,
        lines: {
          create: originals.map((_, index) => ({
            lineNumber: index + 1,
            medicineId: medicine.id,
            packLevelId: pack.id,
            batchNumber: batch.batchNumber,
            printedExpiry: EXPIRY,
            expiryPrecision: 'DAY',
            printedMrpMinor: 25000,
            canonicalUnitsPerPack: 10,
            receivedPacks: 1,
            bonusPacks: 0,
            receivedCanonicalUnits: 10,
            bonusCanonicalUnits: 0,
            acceptedCanonicalUnits: isQuarantine ? 0 : 10,
            rejectedCanonicalUnits: isQuarantine ? 10 : 0,
            rejectionReason: isQuarantine ? 'Damaged at receipt' : null,
            invoicedPricePerPackMinor: 10000,
            unitCostMinor: 1000,
            stockLocationId: store.id,
            quarantineLocationId: isQuarantine ? quarantine.id : null,
          })),
        },
      },
      include: { lines: true },
    });
    const postings = [];
    let serial = 0;
    for (const line of receipt.lines) {
      const posted = await ledger.receiveLot(db, scope, {
        manufacturingBatchId: batch.id,
        packLevelId: pack.id,
        stockLocationId: store.id,
        unitsPerPack: 10,
        supplierName: supplier.name,
        supplierInvoiceRef: `${receipt.supplierInvoiceRef}#${line.lineNumber}`,
        unitCostMinor: 1000,
        printedMrpMinor: 25000,
        receivedExpiresAt: EXPIRY,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: isQuarantine ? 0 : 10,
        idempotencyKey: `pharmacy-receipt:${line.id}:accepted`,
        receivedAt: AT,
        quarantine: isQuarantine
          ? {
              units: 10,
              stockLocationId: quarantine.id,
              idempotencyKey: `pharmacy-receipt:${line.id}:quarantine`,
              reason: 'Damaged at receipt',
            }
          : undefined,
      });
      const movement = (isQuarantine ? posted.quarantineMovement : posted.movement)!;
      const original = originals[line.lineNumber - 1]
        ? await db.pharmacyControlledRegisterEntry.create({
            data: {
              organizationId,
              branchId,
              serial: ++serial,
              entryKind: 'PURCHASE',
              medicineId: medicine.id,
              inventoryLotId: posted.lot.id,
              stockMovementId: movement.id,
              batchNumber: batch.batchNumber,
              quantityCanonicalUnits: 10,
              balanceDelta: isQuarantine ? 0 : 10,
              runningBalance: isQuarantine ? 0 : 10,
              recordedByUserId: 'receiver',
              witnessedByUserId: 'witness',
              signatureRef: 'pin:source-witness',
              manufacturer: 'Synthetic maker',
              prescriberName: 'Original snapshot',
              prescriberRegNo: 'REG305',
              patientAddress: 'Original address snapshot',
              rxSerialWritten: true,
              counterpartyName: supplier.name,
            },
          })
        : null;
      postings.push({ line, lot: posted.lot, movement, original });
    }
    await db.pharmacyGoodsReceipt.update({
      where: { id: receipt.id },
      data: { status: 'POSTED', postedAt: AT },
    });
    return { scope, receipt, postings, ...postings[0]! };
  });
}
type ReceiptFixture = Awaited<ReturnType<typeof receiptFixture>>;
async function fixture(disposition: 'AVAILABLE' | 'QUARANTINE' = 'AVAILABLE') {
  const f = await receiptFixture(disposition);
  if (!f.original) throw new Error('Expected registered fixture');
  return { ...f, original: f.original };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function inFixture<T>(f: ReceiptFixture, run: (db: ScopedDb) => Promise<T>) {
  return tenant.withTenantDb(f.scope.organizationId, run);
}
function reverse(f: ReceiptFixture) {
  return inFixture(f, (db) =>
    receipts.reverseGoodsReceipt(db, f.scope, {
      goodsReceiptId: f.receipt.id,
      reason: 'Cancelled synthetic invoice',
      at: AT,
    })
  );
}
function snapshot(f: ReceiptFixture) {
  return inFixture(f, async (db) => ({
    receipt: await db.pharmacyGoodsReceipt.findFirstOrThrow({ where: { id: f.receipt.id } }),
    lines: await db.pharmacyGoodsReceiptLine.findMany({
      where: { goodsReceiptId: f.receipt.id },
      orderBy: { id: 'asc' },
    }),
    movements: await db.pharmacyStockMovement.findMany({ orderBy: { id: 'asc' } }),
    entries: await db.pharmacyControlledRegisterEntry.findMany({ orderBy: { serial: 'asc' } }),
    balances: await db.pharmacyStockBalance.findMany({ orderBy: { inventoryLotId: 'asc' } }),
    incidents: await db.pharmacyRegisterIncident.findMany({ orderBy: { id: 'asc' } }),
  }));
}
function correction(
  f: Fixture,
  reversalId: string,
  patch: Partial<Prisma.PharmacyControlledRegisterEntryUncheckedCreateInput> = {}
) {
  return {
    organizationId: f.scope.organizationId,
    branchId: f.scope.branchId,
    serial: 2,
    entryKind: 'CORRECTION' as const,
    medicineId: f.original.medicineId,
    inventoryLotId: f.lot.id,
    batchNumber: f.original.batchNumber,
    stockMovementId: null,
    correctsEntryId: f.original.id,
    restorationMovementId: reversalId,
    correctionReason: 'Native SQL regression',
    quantityCanonicalUnits: 10,
    balanceDelta: f.movement.disposition === 'QUARANTINE' ? 0 : -10,
    runningBalance: 0,
    recordedByUserId: 'receiver',
    witnessedByUserId: 'witness',
    ...patch,
  };
}

describeDb('native controlled goods-in reversal (#305)', () => {
  it.each(
    [[false], [false, false], [true, false], [false, true]].map((originals) => ({ originals }))
  )(
    'atomically refuses missing required originals %j through reverseGoodsReceipt',
    async ({ originals }) => {
      // Build legacy/incomplete state directly; never delete immutable originals,
      // disable triggers, mock the producer, or substitute a hand-authored schema.
      const f = await receiptFixture('AVAILABLE', { originals });
      const before = await snapshot(f);
      expect(before.movements).toHaveLength(originals.length);
      expect(before.entries).toHaveLength(originals.filter(Boolean).length);
      await expect(reverse(f)).rejects.toThrow('MISSING_PURCHASE_ORIGINAL');
      const after = await snapshot(f);
      expect(after).toEqual(before);
      expect(after.receipt.status).toBe('POSTED');
      expect(after.movements.every((m) => m.kind === 'RECEIPT')).toBe(true);
      expect(after.entries.every((e) => e.entryKind === 'PURCHASE')).toBe(true);
      expect(after.balances.every((b) => b.onHandUnits === 10)).toBe(true);
      expect(after.incidents).toEqual([]);
    }
  );

  it.each([
    ['AVAILABLE', false],
    ['QUARANTINE', true],
    ['QUARANTINE', false],
  ] as const)(
    'preserves legitimate unregistered reversal: %s controlled=%s',
    async (disposition, controlled) => {
      const f = await receiptFixture(disposition, { controlled, originals: [false] });
      const before = await snapshot(f);
      const result = await reverse(f);
      const after = await snapshot(f);
      expect(result.reversalMovementIds).toHaveLength(1);
      expect(after.movements).toHaveLength(2);
      expect(after.movements.find((m) => m.id === f.movement.id)).toEqual(f.movement);
      expect(after.movements.find((m) => m.id !== f.movement.id)).toMatchObject({
        reversesMovementId: f.movement.id,
        kind: 'ADJUSTMENT',
        disposition,
        quantityUnits: -10,
      });
      expect(after.entries).toEqual([]);
      expect(after.lines).toEqual(before.lines);
      expect(after.balances.every((b) => b.onHandUnits === 0)).toBe(true);
      expect(after.receipt.status).toBe('REVERSED');
      expect(after.incidents).toEqual([]);
      await expect(reverse(f)).rejects.toThrow('INVALID_TRANSITION');
      expect(await snapshot(f)).toEqual(after);
    }
  );

  it('retains complete multi-line correction and immutable original history', async () => {
    const f = await receiptFixture('AVAILABLE', { originals: [true, true] });
    const before = await snapshot(f);
    const result = await reverse(f);
    const after = await snapshot(f);
    expect(result.reversalMovementIds).toHaveLength(2);
    expect(after.movements).toHaveLength(4);
    expect(after.entries.slice(0, 2)).toEqual(before.entries);
    expect(
      after.entries.slice(2).map((entry) => ({
        kind: entry.entryKind,
        serial: entry.serial,
        original: entry.correctsEntryId,
        quantity: entry.quantityCanonicalUnits,
        delta: entry.balanceDelta,
        balance: entry.runningBalance,
      }))
    ).toEqual(
      before.entries.map((entry, index) => ({
        kind: 'CORRECTION',
        serial: index + 3,
        original: entry.id,
        quantity: 10,
        delta: -10,
        balance: 0,
      }))
    );
    expect(after.lines).toEqual(before.lines);
    expect(after.balances.every((balance) => balance.onHandUnits === 0)).toBe(true);
    expect(after.receipt.status).toBe('REVERSED');
    expect(after.incidents).toEqual([]);
  });

  it.each(['AVAILABLE', 'QUARANTINE'] as const)(
    'appends one linked correction, preserves history, and refuses replay without effects: %s',
    async (disposition) => {
      const f = await fixture(disposition);
      const before = await snapshot(f);
      const result = await reverse(f);
      const after = await snapshot(f);
      expect(result.reversalMovementIds).toHaveLength(1);
      expect(after.movements).toHaveLength(2);
      expect(after.movements.find((m) => m.id === f.movement.id)).toEqual(f.movement);
      expect(after.movements.find((m) => m.id !== f.movement.id)).toMatchObject({
        kind: 'ADJUSTMENT',
        reversesMovementId: f.movement.id,
        quantityUnits: -10,
        disposition,
      });
      expect(after.entries).toHaveLength(2);
      expect(after.entries[0]).toEqual(f.original);
      expect(after.entries[1]).toMatchObject({
        entryKind: 'CORRECTION',
        serial: 2,
        correctsEntryId: f.original.id,
        restorationMovementId: result.reversalMovementIds[0],
        stockMovementId: null,
        quantityCanonicalUnits: 10,
        balanceDelta: disposition === 'QUARANTINE' ? 0 : -10,
        runningBalance: 0,
        medicineId: f.original.medicineId,
        inventoryLotId: f.lot.id,
        batchNumber: f.original.batchNumber,
        witnessedByUserId: f.original.witnessedByUserId,
        signatureRef: f.original.signatureRef,
        manufacturer: f.original.manufacturer,
        prescriberName: f.original.prescriberName,
        prescriberRegNo: f.original.prescriberRegNo,
        patientAddress: f.original.patientAddress,
        rxSerialWritten: true,
        counterpartyName: f.original.counterpartyName,
      });
      expect(after.lines).toEqual(before.lines);
      expect(after.balances.every((b) => b.onHandUnits === 0)).toBe(true);
      expect(after.receipt.status).toBe('REVERSED');
      expect(after.incidents).toEqual([]);
      // Preserve the established domain contract: retry refuses, it never appends twice.
      await expect(reverse(f)).rejects.toThrow('INVALID_TRANSITION');
      await expect(
        inFixture(f, (db) =>
          register.appendControlledPurchaseReversals(db, {
            ...f.scope,
            movements: [
              {
                sourceMovementId: f.movement.id,
                reversalMovementId: result.reversalMovementIds[0]!,
              },
            ],
            recordedByUserId: 'receiver',
            reason: 'Duplicate correction',
          })
        )
      ).rejects.toThrow('ALREADY_CORRECTED');
      expect(await snapshot(f)).toEqual(after);
    }
  );

  it.each(['AVAILABLE', 'QUARANTINE'] as const)(
    'rolls back movements, balances and receipt status when the actual correction trigger fails: %s',
    async (disposition) => {
      const f = await fixture(disposition);
      await inFixture(f, (db) =>
        db.pharmacyRegisterIncident.create({
          data: {
            organizationId: f.scope.organizationId,
            branchId: f.scope.branchId,
            registerEntryId: f.original.id,
            expectedBalance: 10,
            actualBalance: 9,
          },
        })
      );
      const before = await snapshot(f);
      await expect(reverse(f)).rejects.toThrow(
        /controlled dispensing blocked by open register incident/
      );
      expect(await snapshot(f)).toEqual(before);
      expect(before.receipt.status).toBe('POSTED');
    }
  );

  it.each([
    { organizationId: 'foreign-tenant' },
    { branchId: 'foreign-branch' },
    { medicineId: null },
    { medicineId: 'missing-medicine' },
    { inventoryLotId: 'missing-lot' },
    { batchNumber: 'different-batch' },
    { correctsEntryId: 'missing-entry' },
    { restorationMovementId: 'missing-movement' },
    { quantityCanonicalUnits: 0 },
    { quantityCanonicalUnits: -10 },
    { quantityCanonicalUnits: 11 },
    { balanceDelta: 0 },
    { balanceDelta: -9 },
    { runningBalance: 1 },
  ])(
    'SQL refuses scope/existence/identity/quantity/delta/balance forgery %j atomically',
    async (patch) => {
      const f = await fixture();
      const before = await snapshot(f);
      await expect(
        inFixture(f, async (db) => {
          const [r] = await ledger.reverseMovements(db, f.scope, {
            movementIds: [f.movement.id],
            reason: 'Native regression',
            at: AT,
          });
          await db.pharmacyControlledRegisterEntry.create({ data: correction(f, r!.id, patch) });
        })
      ).rejects.toThrow();
      expect(await snapshot(f)).toEqual(before);
    }
  );

  it('SQL refuses a positive or unrelated movement as a purchase compensation', async () => {
    const f = await fixture();
    const before = await snapshot(f);
    await expect(
      inFixture(f, async (db) => {
        const movement = await db.pharmacyStockMovement.create({
          data: {
            organizationId: f.scope.organizationId,
            branchId: f.scope.branchId,
            inventoryLotId: f.lot.id,
            stockLocationId: f.movement.stockLocationId,
            kind: 'ADJUSTMENT',
            disposition: 'AVAILABLE',
            quantityUnits: 10,
            sealedPackDelta: 1,
            looseUnitDelta: 0,
            actorId: 'receiver',
            reason: 'Unrelated positive adjustment',
            idempotencyKey: randomUUID(),
            occurredAt: AT,
          },
        });
        await db.pharmacyControlledRegisterEntry.create({
          data: correction(f, movement.id, { balanceDelta: 10, runningBalance: 20 }),
        });
      })
    ).rejects.toThrow(/compensating stock movement/);
    expect(await snapshot(f)).toEqual(before);
  });

  it('SQL refuses reuse/cumulative over-restoration even when quarantine masks the delta', async () => {
    const f = await fixture('QUARANTINE');
    const result = await reverse(f);
    const before = await snapshot(f);
    await expect(
      inFixture(f, (db) =>
        db.pharmacyControlledRegisterEntry.create({
          data: correction(f, result.reversalMovementIds[0]!, { serial: 3 }),
        })
      )
    ).rejects.toThrow();
    expect(await snapshot(f)).toEqual(before);
  });

  it('serializes competing actual receipt reversals to exactly one append', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([reverse(f), reverse(f)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const after = await snapshot(f);
    expect(after.receipt.status).toBe('REVERSED');
    expect(after.entries).toHaveLength(2);
    expect(after.entries[0]).toEqual(f.original);
    expect(after.entries[1]).toMatchObject({
      entryKind: 'CORRECTION',
      correctsEntryId: f.original.id,
      runningBalance: 0,
    });
    expect(after.movements).toHaveLength(2);
    expect(after.balances.every((b) => b.onHandUnits === 0)).toBe(true);
    expect(after.incidents).toEqual([]);
  });

  it.each([
    { medicineId: null },
    { medicineId: 'missing-medicine' },
    { batchNumber: 'wrong-batch' },
    { inventoryLotId: 'missing-lot' },
    { stockMovementId: 'missing-movement' },
  ])('retains strict normal PURCHASE existence and lot identity checks %j', async (patch) => {
    const f = await fixture();
    const before = await snapshot(f);
    await expect(
      inFixture(f, async (db) => {
        const movement = await db.pharmacyStockMovement.create({
          data: {
            organizationId: f.scope.organizationId,
            branchId: f.scope.branchId,
            inventoryLotId: f.lot.id,
            stockLocationId: f.movement.stockLocationId,
            kind: 'RECEIPT',
            disposition: 'AVAILABLE',
            quantityUnits: 10,
            sealedPackDelta: 1,
            looseUnitDelta: 0,
            actorId: 'receiver',
            reason: 'Native identity regression',
            idempotencyKey: randomUUID(),
            occurredAt: AT,
          },
        });
        await db.pharmacyControlledRegisterEntry.create({
          data: {
            organizationId: f.scope.organizationId,
            branchId: f.scope.branchId,
            serial: 2,
            entryKind: 'PURCHASE',
            medicineId: f.original.medicineId,
            inventoryLotId: f.lot.id,
            stockMovementId: movement.id,
            batchNumber: f.original.batchNumber,
            quantityCanonicalUnits: 10,
            balanceDelta: 10,
            runningBalance: 20,
            recordedByUserId: 'receiver',
            witnessedByUserId: 'witness',
            ...patch,
          },
        });
      })
    ).rejects.toThrow();
    expect(await snapshot(f)).toEqual(before);
  });

  it('retains manual correction quantity caps without a stock movement', async () => {
    const f = await fixture();
    const before = await snapshot(f);
    for (const quantityCanonicalUnits of [0, -1, 21]) {
      await expect(
        inFixture(f, (db) =>
          db.pharmacyControlledRegisterEntry.create({
            data: correction(f, '', {
              restorationMovementId: null,
              quantityCanonicalUnits,
              balanceDelta: quantityCanonicalUnits - 10,
              runningBalance: quantityCanonicalUnits,
            }),
          })
        )
      ).rejects.toThrow(/quantityCanonicalUnits_check|correction quantity exceeds original cap/);
    }
    expect(await snapshot(f)).toEqual(before);
  });

  it('keeps purchase rows append-only, consecutive serials, forced RLS and incident behavior', async () => {
    const f = await fixture();
    const before = await snapshot(f);
    await expect(
      inFixture(f, (db) =>
        db.pharmacyControlledRegisterEntry.update({
          where: { id: f.original.id },
          data: { quantityCanonicalUnits: 9 },
        })
      )
    ).rejects.toThrow();
    await expect(
      inFixture(f, (db) =>
        db.pharmacyControlledRegisterEntry.delete({ where: { id: f.original.id } })
      )
    ).rejects.toThrow();
    await expect(
      inFixture(f, async (db) => {
        const [r] = await ledger.reverseMovements(db, f.scope, {
          movementIds: [f.movement.id],
          reason: 'Native regression',
          at: AT,
        });
        await db.pharmacyControlledRegisterEntry.create({
          data: correction(f, r!.id, { serial: 3 }),
        });
      })
    ).rejects.toThrow(/serial must be consecutive/);
    const flags = await inFixture(
      f,
      (db) =>
        db.$queryRaw<
          { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
        >`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='pharmacy_controlled_register_entries'`
    );
    expect(flags).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const hidden = await tenant.withTenantDb(`foreign-${randomUUID()}`, (db) =>
      db.pharmacyControlledRegisterEntry.count({ where: { id: f.original.id } })
    );
    expect(hidden).toBe(0);
    expect(await snapshot(f)).toEqual(before);
  });
});
