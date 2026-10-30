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
const orgSales = `report_dimensions_sales_${suffix}`;
let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let readReport: typeof import('./reports').readPharmacyOwnerCommandCentre;

type Fixture = {
  branchId: string;
  supplierA: string;
  supplierB: string;
  batchA: string;
  medicineId: string;
  ingredientId: string;
  lotA: string;
  saleLineId: string;
};

async function fixture(
  organizationId: string,
  postedAt = '2026-09-04T12:00:00Z'
): Promise<Fixture> {
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
    const ingredient = await db.ingredient.create({
      data: { organizationId, name: `Ingredient-${suffix}` },
    });
    await db.medicineStrengthComponent.create({
      data: {
        organizationId,
        medicineId: medicine.id,
        ingredientId: ingredient.id,
        value: 10,
        unit: 'mg',
      },
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
        db.pharmacySupplier.create({
          data: {
            organizationId,
            name: `${name}-${organizationId}`,
            authorized: true,
            licences: {
              create: {
                licenceType: 'DRUG_SALE',
                licenceNumber: `DSL-${name}-${suffix}`,
                issuingAuthority: 'DRAP',
                issuedAt: new Date('2026-01-01'),
                expiresAt: new Date('2099-01-01'),
                verifiedAt: new Date('2026-01-01'),
              },
            },
          },
        })
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
      const receipt = await db.pharmacyGoodsReceipt.create({
        data: {
          organizationId,
          branchId: branch.id,
          reference: `GR-${name}-${suffix}`,
          supplierId,
          supplierInvoiceRef: `INV-${name}-${suffix}`,
          supplierInvoiceDate: new Date('2026-09-01'),
          warrantyEvidenceRef: 'test',
          receivedByUserId: 'owner',
          receivedAt: new Date('2026-09-01'),
          directPurchase: true,
          bypassReason: 'Report acceptance fixture',
          bypassApprovedByUserId: 'approver',
          bypassApprovedAt: new Date('2026-09-01'),
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
      await db.pharmacyGoodsReceipt.update({
        where: { id: receipt.id },
        data: { status: 'POSTED', postedAt: new Date('2026-09-01') },
      });
      return { batch, lot };
    };
    const a = await makeLot('A', supplierA.id);
    const b = await makeLot('B', supplierB.id);
    const sale = await db.pharmacySale.create({
      data: {
        organizationId,
        branchId: branch.id,
        status: 'COMPLETED',
        createdByUserId: 'owner',
        completedAt: new Date('2026-09-04T12:00:00Z'),
        businessDate: new Date('2026-09-04'),
      },
    });
    const saleLine = await db.pharmacySaleLine.create({
      data: {
        organizationId,
        branchId: branch.id,
        saleId: sale.id,
        medicineId: medicine.id,
        presentationId: medicine.presentations[0]!.id,
        packLevelId: pack.id,
        saleUnit: 'PACK',
        quantity: 1,
        canonicalUnitsPerSaleUnit: 1,
        canonicalUnits: 1,
        unitPriceMinor: 110,
        proRataCeilingMinor: 110,
        unitCostMinor: 35,
        discountMinor: 10,
        discountKind: 'DISCOUNT',
        approvalPolicy: 'Report fixture discount',
        approvedByUserId: 'approver',
        idempotencyKey: `sale-line-${suffix}`,
      },
    });
    const entry = await db.financeJournalEntry.create({
      data: {
        organizationId,
        branchId: branch.id,
        sourceKind: 'PHARMACY_SALE_LINE',
        sourceId: saleLine.id,
        description: 'mixed lot sale',
        actorId: 'owner',
        occurredAt: new Date(postedAt),
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
          amountMinor: 66,
          branchId: branch.id,
          productId: medicine.id,
          lotId: a.lot.id,
          sourceLineId: saleLine.id,
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
          sourceLineId: saleLine.id,
        },
        {
          organizationId,
          entryId: entry.id,
          accountCode: 'SALES_REVENUE',
          side: 'CREDIT',
          amountMinor: 44,
          branchId: branch.id,
          productId: medicine.id,
          lotId: b.lot.id,
          sourceLineId: saleLine.id,
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
          sourceLineId: saleLine.id,
        },
        ...[a, b].map((allocation, index) => ({
          organizationId,
          entryId: entry.id,
          accountCode: 'SALES_DISCOUNT' as const,
          side: 'DEBIT' as const,
          amountMinor: index === 0 ? 6 : 4,
          branchId: branch.id,
          productId: medicine.id,
          lotId: allocation.lot.id,
          sourceLineId: saleLine.id,
        })),
        {
          organizationId,
          entryId: entry.id,
          accountCode: 'SALES_CLEARING',
          side: 'DEBIT',
          amountMinor: 100,
          branchId: branch.id,
        },
        {
          organizationId,
          entryId: entry.id,
          accountCode: 'INVENTORY',
          side: 'CREDIT',
          amountMinor: 35,
          branchId: branch.id,
        },
      ],
    });
    // This batch-specific recall must not match supplier A merely because A supplied the medicine.
    await db.pharmacyRecallNotice.create({
      data: {
        organizationId,
        batchId: b.batch.id,
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
      medicineId: medicine.id,
      ingredientId: ingredient.id,
      lotA: a.lot.id,
      saleLineId: saleLine.id,
    };
  });
}

beforeAll(async () => {
  if (!url) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(scoped.withPlatformDb);
  withTenantDb = scoped.withTenantDb;
  readReport = (await import('./reports')).readPharmacyOwnerCommandCentre;
  await scoped.withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt") SELECT id,id,id,id,'PHARMACY','ACTIVE','SHARED',now(),now() FROM unnest($1::text[]) id ON CONFLICT DO NOTHING`,
      [orgA, orgB, orgSales]
    )
  );
}, 30_000);

suite('owner report dimensions on non-empty PostgreSQL', () => {
  it('keeps filtered sales on completed business dates without netting returns or reversals', async () => {
    const a = await fixture(orgSales, '2026-09-05T12:00:00Z');
    const { postJournalEntry, reverseJournalEntry } = await import('@/lib/finance/journal');
    await withTenantDb(orgSales, async (db) => {
      await postJournalEntry(
        db,
        { organizationId: orgSales, actorId: 'owner' },
        {
          branchId: a.branchId,
          sourceKind: 'PHARMACY_SALE_RETURN_LINE',
          sourceId: `return-${suffix}`,
          description: 'partial return',
          occurredAt: new Date('2026-09-04T14:00:00Z'),
          idempotencyKey: `return-${suffix}`,
          lines: [
            {
              accountCode: 'SALES_REVENUE',
              side: 'DEBIT',
              amountMinor: 10,
              productId: a.medicineId,
              lotId: a.lotA,
              sourceLineId: a.saleLineId,
            },
            {
              accountCode: 'COST_OF_GOODS_SOLD',
              side: 'CREDIT',
              amountMinor: 4,
              productId: a.medicineId,
              lotId: a.lotA,
              sourceLineId: a.saleLineId,
            },
            { accountCode: 'CASH', side: 'CREDIT', amountMinor: 10 },
            { accountCode: 'INVENTORY', side: 'DEBIT', amountMinor: 4 },
          ],
        }
      );
      const entry = await db.financeJournalEntry.findFirstOrThrow({
        where: { sourceKind: 'PHARMACY_SALE_LINE', sourceId: a.saleLineId },
      });
      await reverseJournalEntry(
        db,
        { organizationId: orgSales, actorId: 'owner' },
        {
          entryId: entry.id,
          reason: 'posting correction',
          at: new Date('2026-09-06T12:00:00Z'),
          idempotencyKey: `reverse-${suffix}`,
        }
      );
    });
    const report = (date: string, supplierId?: string) =>
      withTenantDb(orgSales, (db) =>
        readReport(db, {
          branchIds: [a.branchId],
          from: date,
          to: date,
          supplierId,
        })
      );
    expect((await report('2026-09-04')).metrics.salesMinor).toBe(100);
    const filtered = await report('2026-09-04', a.supplierA);
    expect(filtered.metrics.salesMinor).toBe(60);
    expect(filtered.metrics.marginMinor).toBe(-6);
    expect((await report('2026-09-05', a.supplierA)).metrics.salesMinor).toBe(0);
    expect((await report('2026-09-06', a.supplierA)).metrics.salesMinor).toBe(0);
  });

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

    const report = (dimensions: { supplierId?: string; ingredientId?: string; batchId?: string }) =>
      withTenantDb(orgA, (db) =>
        readReport(db, {
          branchIds: [a.branchId, foreign.branchId],
          from: '2026-09-04',
          to: '2026-09-04',
          ...dimensions,
        })
      );
    // Batch recalls store no medicineId. Resolve their ingredient through the batch.
    expect((await report({ ingredientId: a.ingredientId })).metrics.openRecalls).toBe(1);
    expect((await report({ ingredientId: foreign.ingredientId })).metrics.openRecalls).toBe(0);

    await withTenantDb(orgA, (db) =>
      db.pharmacyRecallNotice.create({
        data: {
          organizationId: orgA,
          medicineId: a.medicineId,
          reference: `medicine-recall-${suffix}`,
          reason: 'all batches',
          createdById: 'owner',
        },
      })
    );
    // A medicine-wide recall also applies when a particular batch is selected.
    expect((await report({ batchId: a.batchA })).metrics.openRecalls).toBe(1);
    expect((await report({ ingredientId: a.ingredientId })).metrics.openRecalls).toBe(2);
    expect(
      (await report({ supplierId: a.supplierA, ingredientId: a.ingredientId, batchId: a.batchA }))
        .metrics.openRecalls
    ).toBe(1);
    // Supplier and batch must match the same batch of a medicine-wide notice.
    expect((await report({ supplierId: a.supplierB, batchId: a.batchA })).metrics.openRecalls).toBe(
      0
    );
    const unfiltered = await report({});
    expect(unfiltered.metrics.salesMinor).toBe(100);
    expect(unfiltered.metrics.marginMinor).toBe(65);
    expect(unfiltered.metrics.openRecalls).toBe(2);
  });
});
