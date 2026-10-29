/** PostgreSQL acceptance for apportioned report dimensions and forced tenant isolation. */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;
const suffix = randomUUID();
const orgA = `report_dimensions_a_${suffix}`;
const orgB = `report_dimensions_b_${suffix}`;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let readReport: typeof import('./reports').readPharmacyOwnerCommandCentre;

type Fixture = { branchId: string; supplierA: string; supplierB: string; batchA: string };

async function fixture(organizationId: string): Promise<Fixture> {
  return withTenantDb(organizationId, async (db: ScopedDb) => {
    const branch = await db.pharmacyBranch.create({
      data: {
        organizationId,
        code: `B-${suffix}`,
        name: 'Report fixture',
        addressLine: '1 Test Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    await db.$queryRawUnsafe("SELECT set_config('app.current_branch_id', $1, true)", branch.id);
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: `Report medicine ${suffix}`,
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        presentations: { create: { organizationId, presentation: 'Tablet' } },
      },
      include: { presentations: true },
    });
    const pack = await db.packLevel.create({
      data: {
        organizationId,
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `pack-${suffix}`,
        version: 1,
        level: 'UNIT',
        unitsPerParent: 1,
        effectiveFrom: new Date('2026-01-01'),
      },
    });
    const location = await db.pharmacyStockLocation.create({
      data: {
        organizationId,
        branchId: branch.id,
        code: `STORE-${suffix}`,
        name: 'Store',
        kind: 'STORE',
      },
    });
    const [supplierA, supplierB] = await Promise.all(
      ['A', 'B'].map((name) =>
        db.pharmacySupplier.create({ data: { organizationId, name: `${name}-${organizationId}` } })
      )
    );
    const makeLot = async (name: string, supplierId: string) => {
      const batch = await db.pharmacyManufacturingBatch.create({
        data: {
          organizationId,
          medicineId: medicine.id,
          batchNumber: `${name}-${suffix}`,
          expiresAt: new Date('2028-01-01'),
        },
      });
      const lot = await db.pharmacyInventoryLot.create({
        data: {
          organizationId,
          branchId: branch.id,
          manufacturingBatchId: batch.id,
          packLevelId: pack.id,
          unitsPerPack: 1,
          supplierName: name,
          supplierInvoiceRef: `INV-${name}-${suffix}`,
          unitCostMinor: 40,
          printedMrpMinor: 100,
          receivedExpiresAt: new Date('2028-01-01'),
          receivedExpiryPrecision: 'DAY',
          receivedAt: new Date('2026-09-01'),
        },
      });
      await db.pharmacyGoodsReceipt.create({
        data: {
          organizationId,
          branchId: branch.id,
          reference: `GR-${name}-${suffix}`,
          status: 'POSTED',
          supplierId,
          supplierInvoiceRef: `INV-${name}-${suffix}`,
          supplierInvoiceDate: new Date('2026-09-01'),
          warrantyEvidenceRef: 'test',
          receivedByUserId: 'owner',
          receivedAt: new Date('2026-09-01'),
          directPurchase: true,
          lines: {
            create: {
              lineNumber: 1,
              medicineId: medicine.id,
              packLevelId: pack.id,
              batchNumber: `${name}-${suffix}`,
              printedExpiry: new Date('2028-01-01'),
              expiryPrecision: 'DAY',
              printedMrpMinor: 100,
              canonicalUnitsPerPack: 1,
              receivedPacks: 1,
              receivedCanonicalUnits: 1,
              acceptedCanonicalUnits: 1,
              invoicedPricePerPackMinor: 40,
              unitCostMinor: 40,
              stockLocationId: location.id,
              inventoryLotId: lot.id,
            },
          },
        },
      });
      return { batch, lot };
    };
    const a = await makeLot('A', supplierA.id);
    const b = await makeLot('B', supplierB.id);
    const entry = await db.financeJournalEntry.create({
      data: {
        organizationId,
        branchId: branch.id,
        sourceKind: 'PHARMACY_SALE_LINE',
        sourceId: `sale-${suffix}`,
        description: 'mixed lot sale',
        actorId: 'owner',
        occurredAt: new Date('2026-09-04T12:00:00Z'),
        idempotencyKey: `sale-${organizationId}-${suffix}`,
      },
    });
    await db.financeJournalLine.createMany({
      data: [
        {
          organizationId,
          entryId: entry.id,
          accountCode: 'SALES_REVENUE',
          side: 'CREDIT',
          amountMinor: 60,
          branchId: branch.id,
          productId: medicine.id,
          lotId: a.lot.id,
          sourceLineId: 'mixed',
        },
        {
          organizationId,
          entryId: entry.id,
          accountCode: 'COST_OF_GOODS_SOLD',
          side: 'DEBIT',
          amountMinor: 20,
          branchId: branch.id,
          productId: medicine.id,
          lotId: a.lot.id,
          sourceLineId: 'mixed',
        },
        {
          organizationId,
          entryId: entry.id,
          accountCode: 'SALES_REVENUE',
          side: 'CREDIT',
          amountMinor: 40,
          branchId: branch.id,
          productId: medicine.id,
          lotId: b.lot.id,
          sourceLineId: 'mixed',
        },
        {
          organizationId,
          entryId: entry.id,
          accountCode: 'COST_OF_GOODS_SOLD',
          side: 'DEBIT',
          amountMinor: 15,
          branchId: branch.id,
          productId: medicine.id,
          lotId: b.lot.id,
          sourceLineId: 'mixed',
        },
      ],
    });
    // This batch-specific recall must not match supplier A merely because A supplied the medicine.
    await db.pharmacyRecallNotice.create({
      data: {
        organizationId,
        batchId: b.batch.id,
        medicineId: medicine.id,
        reference: `recall-${suffix}`,
        reason: 'test',
        createdById: 'owner',
      },
    });
    return {
      branchId: branch.id,
      supplierA: supplierA.id,
      supplierB: supplierB.id,
      batchA: a.batch.id,
    };
  });
}

beforeAll(async () => {
  if (!url) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  withTenantDb = scoped.withTenantDb;
  readReport = (await import('./reports')).readPharmacyOwnerCommandCentre;
  await scoped.withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt") SELECT id,id,id,id,'PHARMACY','ACTIVE','SHARED',now(),now() FROM unnest($1::text[]) id ON CONFLICT DO NOTHING`,
      [orgA, orgB]
    )
  );
}, 30_000);

suite('owner report dimensions on non-empty PostgreSQL', () => {
  it('apportions mixed-lot revenue, intersects filters, rejects wrong-batch recalls, and enforces RLS', async () => {
    const a = await fixture(orgA);
    const foreign = await fixture(orgB);
    const selected = await withTenantDb(orgA, (db) =>
      readReport(db, {
        branchIds: [a.branchId, foreign.branchId],
        from: '2026-09-04',
        to: '2026-09-04',
        supplierId: a.supplierA,
        batchId: a.batchA,
      })
    );
    expect(selected.metrics.salesMinor).toBe(60);
    expect(selected.metrics.marginMinor).toBe(40);
    expect(selected.metrics.openRecalls).toBe(0);
    const other = await withTenantDb(orgA, (db) =>
      readReport(db, {
        branchIds: [a.branchId],
        from: '2026-09-04',
        to: '2026-09-04',
        supplierId: a.supplierB,
      })
    );
    expect(other.metrics.salesMinor).toBe(40);
    expect(other.metrics.marginMinor).toBe(25);
    expect(other.metrics.openRecalls).toBe(1);
  });
});
