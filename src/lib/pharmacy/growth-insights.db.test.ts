/** Real ledger regression coverage; run only against an owned, migrated disposable DB. */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { buildPharmacyGrowthInput } from './growth-insights';
import { onHand, receiveLot } from './stock-ledger';

const url = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;
const organizationId = `growth_valuation_${randomUUID()}`;
const from = new Date('2026-09-01T19:00:00Z');
const cutoff = new Date('2026-10-01T19:00:00Z');
const now = new Date('2026-10-02T19:00:00Z');
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;

beforeAll(async () => {
  if (!url) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(scoped.withPlatformDb);
  await scoped.withPlatformDb((db) =>
    db.organization.create({
      data: {
        id: organizationId,
        slug: organizationId,
        legalName: organizationId,
        displayName: organizationId,
        vertical: 'PHARMACY',
        status: 'ACTIVE',
        deploymentMode: 'SHARED',
      },
    })
  );
  withTenantDb = scoped.withTenantDb;
}, 30_000);

async function fixture(db: ScopedDb) {
  const branch = await db.pharmacyBranch.create({
    data: {
      organizationId,
      code: randomUUID(),
      name: 'Valuation regression',
      addressLine: '1 Test Road',
      city: 'Lahore',
      provinceCode: 'PB',
    },
  });
  const medicine = await db.medicine.create({
    data: {
      organizationId,
      productName: 'Synthetic valuation stock',
      productFamily: 'PHARMACEUTICAL',
      presentations: { create: { organizationId, presentation: 'Tablet, 10 per strip' } },
    },
    include: { presentations: true },
  });
  const pack = await db.packLevel.create({
    data: {
      organizationId,
      presentationId: medicine.presentations[0]!.id,
      versionGroupId: randomUUID(),
      version: 1,
      level: 'STRIP',
      unitsPerParent: 10,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    },
  });
  const location = await db.pharmacyStockLocation.create({
    data: { organizationId, branchId: branch.id, code: 'MAIN', name: 'Main store', kind: 'STORE' },
  });
  const scope = { organizationId, branchId: branch.id, actorId: 'synthetic-owner', timezone: 'UTC' };
  return {
    scope,
    medicineId: medicine.id,
    async stock(
      state: 'ACTIVE' | 'RECALLED' | 'QUARANTINED',
      expiresAt: Date,
      receivedAt = new Date('2026-08-01T00:00:00Z')
    ) {
      const batch = await db.pharmacyManufacturingBatch.create({
        data: {
          organizationId,
          medicineId: medicine.id,
          batchNumber: randomUUID(),
          expiresAt,
          state,
          ...(state !== 'ACTIVE'
            ? { stateReason: 'Synthetic safety block', stateChangedAt: from }
            : {}),
        },
      });
      await receiveLot(db, scope, {
        manufacturingBatchId: batch.id,
        packLevelId: pack.id,
        stockLocationId: location.id,
        unitsPerPack: 10,
        supplierName: 'Synthetic distributor',
        supplierInvoiceRef: randomUUID(),
        unitCostMinor: 1200,
        printedMrpMinor: 2000,
        receivedExpiresAt: expiresAt,
        receivedExpiryPrecision: 'DAY',
        quantityUnits: 10,
        idempotencyKey: randomUUID(),
        receivedAt,
      });
    },
  };
}

suite('growth valuation against persisted AVAILABLE stock', () => {
  it.each(['EXPIRED', 'RECALLED', 'QUARANTINED'] as const)(
    'withholds valuation and inventory actions for ten %s lots',
    async (reason) => {
      await withTenantDb(organizationId, async (db) => {
        const f = await fixture(db);
        for (let i = 0; i < 10; i++)
          await f.stock(
            reason === 'EXPIRED' ? 'ACTIVE' : reason,
            // Expired at both period cutoffs, including equality at the comparison cutoff.
            reason === 'EXPIRED' ? from : new Date('2027-01-01T19:00:00Z')
          );
        const balances = await onHand(db, f.scope, f.medicineId, cutoff);
        expect(balances).toHaveLength(10);
        expect(balances.every((b) => b.disposition === 'AVAILABLE' && b.onHandUnits === 10)).toBe(true);
        expect(balances.every((b) => b.blockedBy === reason)).toBe(true);
        const input = await buildPharmacyGrowthInput(db, f.scope, from, cutoff, now);
        expect(input.facts.some((fact) => fact.metric === 'inventory_value_minor')).toBe(false);
        expect(input.actions).toEqual([{ ref: 'a1', kind: 'RETAIL_REVIEW' }]);
      });
    },
    30_000
  );

  it('values only eligible lots and suppresses cohorts after expiry at the cutoff', async () => {
    await withTenantDb(organizationId, async (db) => {
      const f = await fixture(db);
      for (let i = 0; i < 10; i++) {
        await f.stock('ACTIVE', new Date('2026-10-01T19:00:00.001Z'));
        await f.stock('RECALLED', new Date('2027-01-01T19:00:00Z'));
        await f.stock('QUARANTINED', new Date('2027-01-01T19:00:00Z'));
        await f.stock('ACTIVE', cutoff);
        await f.stock('ACTIVE', new Date('2027-01-01T19:00:00Z'), new Date(cutoff.getTime() + 1));
      }
      const input = await buildPharmacyGrowthInput(db, f.scope, from, cutoff, now);
      expect(
        input.facts.find(
          (fact) => fact.period === 'CURRENT' && fact.metric === 'inventory_value_minor'
        )
      ).toMatchObject({ value: '120000', cohortSize: 10, coverage: 'ESTIMATED' });
      expect(input.actions.some((action) => action.kind === 'INVENTORY_COST_REVIEW')).toBe(true);
      // At the next millisecond all ten eligible lots expire. Other AVAILABLE balances remain.
      const expired = await buildPharmacyGrowthInput(
        db,
        f.scope,
        from,
        new Date(cutoff.getTime() + 1),
        now
      );
      expect(
        expired.facts.some(
          (fact) => fact.period === 'CURRENT' && fact.metric === 'inventory_value_minor'
        )
      ).toBe(false);
    });
  }, 30_000);
});
