// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';
import {
  retirePharmacyRegulatoryRules,
  seedPharmacyRegulatoryProfile,
} from '@/lib/test-support/pharmacy-regulatory';
import { createSale, addSaleLine, readReturnHistory, returnSaleLine } from './sales';
import { linkCustomerToSale, redeemSalePoints } from './customer-loyalty';
import { publishLoyaltyProgramVersion, stepRule } from './loyalty-program';
import { receiveLot } from './stock-ledger';
import { applyPharmacyTender, openPharmacyDrawer, refundPharmacyTender } from './settlement';

const databaseUrl = process.env.PHARMACY_E2E_DATABASE_URL;
const enabled = process.env.PHARMACY_E2E === '1' && !!databaseUrl;
const day = new Date('2026-09-29');
const ruleSetIds: string[] = [];

async function createReturnsFixture() {
  // Neither FEFO stock nor loyalty/redemption state may leak across cases or runs.
  const suffix = randomUUID();
  const scope = {
    organizationId: `org_returns_${suffix}`,
    branchId: `branch_returns_${suffix}`,
    actorId: `actor_returns_${suffix}`,
  };
  const inTenant = <T>(work: Parameters<typeof withTenantDb<T>>[1]) =>
    withTenantDb(scope.organizationId, work);
  const fixture = {
    medicineId: `medicine_returns_${suffix}`,
    presentationId: `presentation_returns_${suffix}`,
    stripPackId: `strip_returns_${suffix}`,
    unitPackId: `unit_returns_${suffix}`,
    stockLocationId: `stock_returns_${suffix}`,
    quarantineLocationId: `quarantine_returns_${suffix}`,
    patientId: `patient_returns_${suffix}`,
    patientName: 'Settlement returns patient',
  };

  await inTenant(async (db) => {
    await db.organization.create({
      data: {
        id: scope.organizationId,
        slug: `returns-${scope.organizationId}`,
        legalName: 'Settlement returns fixture',
        displayName: 'Settlement returns fixture',
        vertical: 'PHARMACY',
        status: 'ACTIVE',
      },
    });
    await db.pharmacyBranch.create({
      data: {
        id: scope.branchId,
        organizationId: scope.organizationId,
        code: 'RETURNS',
        name: 'Settlement Returns',
        addressLine: 'Synthetic settlement acceptance branch',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    await db.medicine.create({
      data: {
        id: fixture.medicineId,
        organizationId: scope.organizationId,
        productName: 'Settlement returns medicine',
        productFamily: 'PHARMACEUTICAL',
        otc: true,
        saleable: true,
      },
    });
    await db.presentation.create({
      data: {
        id: fixture.presentationId,
        organizationId: scope.organizationId,
        medicineId: fixture.medicineId,
        presentation: 'Tablet',
      },
    });
    await db.packLevel.create({
      data: {
        id: fixture.stripPackId,
        organizationId: scope.organizationId,
        presentationId: fixture.presentationId,
        versionGroupId: `${fixture.stripPackId}-returns`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01'),
      },
    });
    await db.packLevel.create({
      data: {
        id: fixture.unitPackId,
        organizationId: scope.organizationId,
        presentationId: fixture.presentationId,
        parentPackLevelId: fixture.stripPackId,
        versionGroupId: `${fixture.unitPackId}-returns`,
        version: 1,
        level: 'UNIT',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01'),
      },
    });
    for (const [id, code, name, kind] of [
      [fixture.stockLocationId, 'STORE', 'Store', 'STORE'],
      [fixture.quarantineLocationId, 'QUARANTINE', 'Quarantine', 'QUARANTINE'],
    ] as const) {
      await db.pharmacyStockLocation.create({
        data: {
          id,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          code,
          name,
          kind,
        },
      });
    }
    await db.pharmacyPatient.create({
      data: {
        id: fixture.patientId,
        organizationId: scope.organizationId,
        displayName: fixture.patientName,
      },
    });
  });
  ruleSetIds.push(await seedPharmacyRegulatoryProfile(withPlatformDb, inTenant, scope.branchId));
  return { fixture, scope, inTenant };
}

describe.skipIf(!enabled)('return/refund disposable database acceptance', () => {
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    expect(['postgres:', 'postgresql:']).toContain(url.protocol);
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(url.hostname);
    expect(decodeURIComponent(url.pathname.slice(1))).toMatch(/(^|[_-])disposable([_-]|$)/);
    const targetOverrides = ['host', 'hostaddr', 'port', 'dbname', 'db', 'database'];
    expect(
      [...url.searchParams.keys()].filter((key) => targetOverrides.includes(key.toLowerCase()))
    ).toEqual([]);
    // The app pool must connect to the same URL that passed the safety checks.
    process.env.DATABASE_URL = databaseUrl;
    await withPlatformDb(async (db) => {
      const roles = await db.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
        Prisma.sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`
      );
      expect(roles[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });
  });

  afterAll(() => retirePharmacyRegulatoryRules(withPlatformDb, ruleSetIds));

  it('restores loyalty, splits refunds, audits cash fallback, and serializes cumulative caps', async () => {
    const { fixture, scope, inTenant } = await createReturnsFixture();
    const deviceId = `returns-${randomUUID()}`;
    const key = () => randomUUID();
    await inTenant(async (db) => {
      // A fresh organization has no earn rate. Let the PKR 25 sale earn five points.
      await publishLoyaltyProgramVersion(db, scope, stepRule(5, 25));
      if (
        !(await db.patientConsent.findFirst({
          where: { patientId: fixture.patientId, purpose: 'LOYALTY' },
        }))
      ) {
        await db.patientConsent.create({
          data: {
            organizationId: scope.organizationId,
            patientId: fixture.patientId,
            purpose: 'LOYALTY',
            channel: 'IN_PERSON',
            version: 1,
            granted: true,
            recordedByUserId: scope.actorId,
          },
        });
      }
      const expiry = new Date('2027-12-31');
      const batch = await db.pharmacyManufacturingBatch.create({
        data: {
          organizationId: scope.organizationId,
          medicineId: fixture.medicineId,
          batchNumber: `RETURNS-${key()}`,
          expiresAt: expiry,
          expiryPrecision: 'DAY',
        },
      });
      await receiveLot(db, scope, {
        manufacturingBatchId: batch.id,
        packLevelId: fixture.stripPackId,
        stockLocationId: fixture.stockLocationId,
        unitsPerPack: 10,
        supplierName: 'Settlement returns fixture',
        supplierInvoiceRef: key(),
        unitCostMinor: 100,
        printedMrpMinor: 2500,
        receivedExpiresAt: expiry,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: 20,
        idempotencyKey: key(),
        receivedAt: new Date('2026-09-01'),
      });
      await openPharmacyDrawer(db, scope, {
        deviceId,
        businessDate: day,
        openingFloatMinor: 10000,
      });
    });
    async function bill() {
      return inTenant(async (db) => {
        const sale = await createSale(db, scope);
        const { line } = await addSaleLine(db, scope, {
          saleId: sale.id,
          medicineId: fixture.medicineId,
          presentationId: fixture.presentationId,
          packLevelId: fixture.stripPackId,
          saleUnit: 'STRIP',
          quantity: 1,
          canonicalUnitsPerSaleUnit: 10,
          idempotencyKey: key(),
        });
        await linkCustomerToSale(db, scope, {
          saleId: sale.id,
          patientId: fixture.patientId,
          displayName: fixture.patientName,
        });
        return { sale, line };
      });
    }
    // Earn actual points through settlement, rather than seeding a fabricated redemption.
    const earned = await bill();
    await inTenant((db) =>
      applyPharmacyTender(db, scope, {
        saleId: earned.sale.id,
        deviceId,
        businessDate: day,
        type: 'CASH',
        amountMinor: 2500,
        cashReceivedMinor: 2500,
        idempotencyKey: key(),
      })
    );
    const sold = await bill();
    await inTenant((db) =>
      redeemSalePoints(db, scope, {
        saleId: sold.sale.id,
        points: 5,
        deviceId,
        businessDate: day,
        idempotencyKey: key(),
      })
    );
    await inTenant((db) =>
      applyPharmacyTender(db, scope, {
        saleId: sold.sale.id,
        deviceId,
        businessDate: day,
        type: 'CASH',
        amountMinor: 1000,
        cashReceivedMinor: 1000,
        idempotencyKey: key(),
      })
    );
    await inTenant((db) =>
      applyPharmacyTender(db, scope, {
        saleId: sold.sale.id,
        deviceId,
        businessDate: day,
        type: 'CARD',
        amountMinor: 1000,
        idempotencyKey: key(),
        adapter: {
          name: 'TEST',
          certified: true,
          execute: async () => ({ approved: true, providerRef: 'test-sale' }),
        },
      })
    );
    const history = () => inTenant((db) => readReturnHistory(db, scope, sold.sale.id));
    const before = await history();
    const tenderId = (type: string) => before.tenders.find((row) => row.type === type)!.id;
    const returnInput = {
      saleLineId: sold.line.id,
      lotId: before.lines[0].lots[0].lotId,
      canonicalUnits: 5,
      disposition: 'RESTOCK' as const,
      reason: 'WRONG_ITEM',
      integrityDecision: 'Intact strip; storage verified',
      idempotencyKey: key(),
    };
    await inTenant((db) => returnSaleLine(db, scope, returnInput));
    const replay = await inTenant((db) => returnSaleLine(db, scope, returnInput));
    expect(replay.replayed).toBe(true);
    expect((await history()).lines[0].returnedUnits).toBe(5);
    const refund = (type: string, amountMinor: number, idempotencyKey = key()) =>
      inTenant((db) =>
        refundPharmacyTender(db, scope, {
          originalTenderId: tenderId(type),
          deviceId,
          businessDate: day,
          amountMinor,
          reason: 'WRONG_ITEM',
          idempotencyKey,
          requireReturnedValue: true,
          manualCashFallback: type === 'CARD',
        })
      );
    const loyaltyKey = key();
    await refund('LOYALTY', 500, loyaltyKey);
    await refund('LOYALTY', 500, loyaltyKey);
    await refund('CASH', 500);
    await refund('CARD', 250);
    const partial = await history();
    expect(partial.refundableMinor).toBe(0);
    expect(
      partial.tenders.find((row) => row.type === 'CARD')!.refunds[0].manualReversalRequired
    ).toBe(true);
    await expect(refund('CARD', 1)).rejects.toThrow('REFUND_EXCEEDS_TENDER');
    await inTenant(async (db) => {
      const points = await db.pharmacyLoyaltyPointsEntry.findMany({
        where: { saleId: sold.sale.id, kind: 'REFUND' },
      });
      expect(points).toHaveLength(1);
      expect(points[0].points).toBe(5);
      expect(points[0].refundId).toBeTruthy();
    });
    const unidentified = {
      ...returnInput,
      lotId: undefined,
      canonicalUnits: 2,
      disposition: 'QUARANTINE' as const,
      quarantineLocationId: fixture.quarantineLocationId,
      idempotencyKey: key(),
    };
    const held = await inTenant((db) => returnSaleLine(db, scope, unidentified));
    const heldReplay = await inTenant((db) => returnSaleLine(db, scope, unidentified));
    expect(heldReplay.replayed).toBe(true);
    expect(heldReplay.returnId).toBe(held.returnId);
    expect(held.movement).toBeNull();
    await inTenant((db) =>
      returnSaleLine(db, scope, { ...unidentified, canonicalUnits: 3, idempotencyKey: key() })
    );
    await inTenant(async (db) => {
      const tasks = await db.pharmacyReturnVerificationTask.findMany({
        where: { holding: { saleLineId: sold.line.id } },
      });
      expect(tasks).toHaveLength(2);
      const holds = await db.pharmacyUnidentifiedReturnHold.findMany({
        where: { saleLineId: sold.line.id },
      });
      expect(holds.map((h) => h.canonicalUnits).sort()).toEqual([2, 3]);
    });
    expect((await history()).lines[0].unidentifiedUnits).toBe(5);
    const race = await Promise.allSettled([refund('CASH', 500), refund('CASH', 500)]);
    expect(race.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(race.filter((row) => row.status === 'rejected')).toHaveLength(1);
    const final = await history();
    expect(final.lines[0].returnedUnits).toBe(10);
    expect(final.tenders.find((row) => row.type === 'CASH')!.refundedMinor).toBe(1000);
    await expect(
      inTenant((db) =>
        returnSaleLine(db, scope, { ...returnInput, idempotencyKey: key(), canonicalUnits: 1 })
      )
    ).rejects.toThrow('RETURN_EXCEEDS_SOLD');
  }, 30000);
  it('isolates partial A/B returns, refuses recalled B, and never credits A for unidentified stock', async () => {
    const key = () => randomUUID();
    const deviceId = `lots-${key()}`;
    const { fixture, scope, inTenant } = await createReturnsFixture();
    const prepared = await inTenant(async (db) => {
      await openPharmacyDrawer(db, scope, { deviceId, businessDate: day, openingFloatMinor: 5000 });
      const lots = [];
      for (const label of ['A', 'B']) {
        const expiry = new Date(label === 'A' ? '2027-01-01' : '2027-02-01');
        const batch = await db.pharmacyManufacturingBatch.create({
          data: {
            organizationId: scope.organizationId,
            medicineId: fixture.medicineId,
            batchNumber: `${label}-${key()}`,
            expiresAt: expiry,
            expiryPrecision: 'DAY',
          },
        });
        const { lot } = await receiveLot(db, scope, {
          manufacturingBatchId: batch.id,
          packLevelId: fixture.unitPackId,
          stockLocationId: fixture.stockLocationId,
          unitsPerPack: 1,
          supplierName: 'Test',
          supplierInvoiceRef: key(),
          unitCostMinor: 125,
          printedMrpMinor: 250,
          receivedExpiresAt: expiry,
          receivedExpiryPrecision: 'DAY',
          quantityUnits: 2,
          idempotencyKey: key(),
          receivedAt: new Date('2026-09-01'),
        });
        lots.push({ lot, batch });
      }
      const sale = await createSale(db, scope);
      const { line } = await addSaleLine(db, scope, {
        saleId: sale.id,
        medicineId: fixture.medicineId,
        presentationId: fixture.presentationId,
        packLevelId: fixture.unitPackId,
        saleUnit: 'UNIT',
        quantity: 4,
        canonicalUnitsPerSaleUnit: 1,
        idempotencyKey: key(),
      });
      await applyPharmacyTender(db, scope, {
        saleId: sale.id,
        deviceId,
        businessDate: day,
        type: 'CASH',
        amountMinor: 1000,
        cashReceivedMinor: 1000,
        idempotencyKey: key(),
      });
      const allocations = await db.pharmacySaleLineAllocation.findMany({
        where: { saleLineId: line.id },
      });
      expect(new Set(allocations.map((a) => a.inventoryLotId))).toEqual(
        new Set(lots.map((l) => l.lot.id))
      );
      await db.pharmacyManufacturingBatch.update({
        where: { id: lots[1].batch.id },
        data: { state: 'RECALLED', stateReason: 'Regression recall', stateChangedAt: new Date() },
      });
      return { lots, sale, line };
    });
    const input = {
      saleLineId: prepared.line.id,
      lotId: prepared.lots[1].lot.id,
      canonicalUnits: 1,
      disposition: 'RESTOCK' as const,
      reason: 'WRONG_ITEM',
      integrityDecision: 'Physical B verified',
      idempotencyKey: key(),
    };
    await expect(inTenant((db) => returnSaleLine(db, scope, input))).rejects.toThrow(
      'UNSAFE_STOCK'
    );
    const quarantined = await inTenant((db) =>
      returnSaleLine(db, scope, {
        ...input,
        disposition: 'QUARANTINE',
        quarantineLocationId: fixture.quarantineLocationId,
        idempotencyKey: key(),
      })
    );
    expect(quarantined.movement).toMatchObject({
      inventoryLotId: prepared.lots[1].lot.id,
      disposition: 'QUARANTINE',
    });
    const a = await inTenant((db) =>
      returnSaleLine(db, scope, { ...input, lotId: prepared.lots[0].lot.id, idempotencyKey: key() })
    );
    expect(a.movement).toMatchObject({
      inventoryLotId: prepared.lots[0].lot.id,
      disposition: 'AVAILABLE',
    });
    const unknown = await inTenant((db) =>
      returnSaleLine(db, scope, {
        ...input,
        lotId: undefined,
        quarantineLocationId: fixture.quarantineLocationId,
        idempotencyKey: key(),
      })
    );
    expect(unknown.movement).toBeNull();
    await inTenant(async (db) => {
      const returned = await db.pharmacyStockMovement.findMany({
        where: { kind: 'RETURN', inventoryLotId: { in: prepared.lots.map((l) => l.lot.id) } },
      });
      expect(returned).toHaveLength(2);
      const history = await readReturnHistory(db, scope, prepared.sale.id);
      expect(history.lines[0].returnedUnits).toBe(3);
      expect(history.lines[0].unidentifiedUnits).toBe(1);
      expect(
        history.lines[0].lots.find((l) => l.lotId === prepared.lots[1].lot.id)?.restockAllowed
      ).toBe(false);
      expect(
        await db.pharmacyPharmacistReviewItem.count({ where: { saleLineId: prepared.line.id } })
      ).toBe(0);
    });
    // The database guard also rejects direct inserts that bypass service validation.
    await expect(
      inTenant(async (db) => {
        const extra = await db.pharmacySaleReturn.create({
          data: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            originalSaleId: prepared.sale.id,
            actorId: scope.actorId,
            reason: 'Boundary probe',
          },
        });
        return db.pharmacyUnidentifiedReturnHold.create({
          data: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            returnId: extra.id,
            saleLineId: prepared.line.id,
            quarantineLocationId: fixture.quarantineLocationId,
            canonicalUnits: 2,
            integrityDecision: 'Unidentified',
            actorId: scope.actorId,
          },
        });
      })
    ).rejects.toThrow(/RETURN_EXCEEDS_SOLD/);
    await withTenantDb('other_return_test_tenant', async (db) => {
      expect(await db.pharmacyUnidentifiedReturnHold.findMany()).toEqual([]);
      expect(await db.pharmacyReturnVerificationTask.findMany()).toEqual([]);
    });
    await expect(
      inTenant((db) =>
        db.pharmacyUnidentifiedReturnHold.update({
          where: { id: unknown.holding!.id },
          data: { canonicalUnits: 2 },
        })
      )
    ).rejects.toThrow(/append-only/);
  }, 30000);
});
