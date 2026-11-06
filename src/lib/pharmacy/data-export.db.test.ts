import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const archives = vi.hoisted(() => new Map<string, Buffer>());
vi.mock('@/lib/storage', () => ({
  putUpload: async (namespace: string, key: string, data: Buffer) => {
    archives.set(`${namespace}/${key}`, data);
  },
  deleteUpload: async (namespace: string, key: string) => {
    archives.delete(`${namespace}/${key}`);
  },
  getUpload: async (namespace: string, key: string) => archives.get(`${namespace}/${key}`),
}));
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * #716 acceptance against a real database under forced RLS: an export of a
 * seeded tenant re-imports through the migration wizard (its Excel/CSV profiler,
 * and its DevFathom catalogue adapter for medicines.csv) with matching row
 * counts and no exceptions. Catalogue rows also complete a wizard import into
 * real draft medicines/packs, with source evidence, in another tenant.
 */
const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
const suite = url ? describe : describe.skip;
const suffix = randomBytes(5).toString('hex');
const orgA = `org_data_export_a_${suffix}`;
const orgB = `org_data_export_b_${suffix}`;
const ACTOR = 'user_owner';
const RECEIVED = new Date('2026-09-02T09:00:00.000Z');
const EXPIRES = new Date('2027-10-01T00:00:00.000Z');
const NOW = new Date('2026-10-31T07:00:00.000Z');

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let workbench: typeof import('./migration/workbench');
let catalogueProfiler: typeof import('./migration/devfathom-catalogue-profiler');
let stockLotsProfiler: typeof import('./migration/devfathom-stock-lots-profiler');
let exporter: typeof import('./data-export');
let format: typeof import('./data-export-format');
let profiler: typeof import('./migration/profiler');
let csvProfiler: typeof import('./migration/excel-csv-profiler');
let sourceValues: typeof import('./migration/source-values');

async function seed(organizationId: string, label: string, catalogueEdges = false) {
  return withTenantDb(organizationId, async (db: ScopedDb) => {
    await db.organization.upsert({
      where: { id: organizationId },
      update: {},
      create: {
        id: organizationId,
        slug: organizationId,
        legalName: `${label} Pharmacy`,
        displayName: `${label} Pharmacy`,
        vertical: 'PHARMACY',
        status: 'ACTIVE',
        currency: 'PKR',
      },
    });
    const branch = await db.pharmacyBranch.create({
      data: {
        organizationId,
        code: `${label}-${suffix}`,
        name: `${label} branch`,
        addressLine: '1 Test Road',
        city: 'Rawalpindi',
        provinceCode: 'PB',
      },
    });
    await db.$queryRawUnsafe("SELECT set_config('app.current_branch_id', $1, true)", branch.id);
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: catalogueEdges ? `+${label} Paracetamol 500mg` : `${label} Paracetamol 500mg`,
        manufacturer: catalogueEdges ? "'@Manufacturer" : null,
        productFamily: 'PHARMACEUTICAL',
        presentations: { create: { organizationId, presentation: 'Tablet, 10 per strip' } },
      },
      include: { presentations: true },
    });
    const packLevel = await db.packLevel.create({
      data: {
        organizationId,
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `strip-${label}-${suffix}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    if (catalogueEdges) {
      const ingredient = await db.ingredient.create({
        data: {
          organizationId,
          name: "'Paracetamol",
        },
      });
      await db.medicineStrengthComponent.create({
        data: {
          organizationId,
          medicineId: medicine.id,
          ingredientId: ingredient.id,
          value: '500.000001',
          unit: 'mg',
        },
      });
      await db.packLevel.create({
        data: {
          organizationId,
          presentationId: medicine.presentations[0]!.id,
          versionGroupId: `box-${label}-${suffix}`,
          version: 1,
          level: 'BOX',
          unitsPerParent: 100,
          effectiveFrom: new Date('2026-01-01'),
        },
      });
      await db.medicineBarcode.create({
        data: {
          organizationId,
          presentationId: medicine.presentations[0]!.id,
          packLevelId: packLevel.id,
          type: 'INTERNAL',
          code: `catalogue${suffix}`,
          normalizedCode: `catalogue${suffix}`,
        },
      });
      await db.medicineBarcode.create({
        data: {
          organizationId,
          presentationId: medicine.presentations[0]!.id,
          packLevelId: packLevel.id,
          type: 'MANUFACTURER',
          code: `+pack${suffix}`,
          normalizedCode: `pack${suffix}`,
        },
      });
      await db.medicineBarcode.create({
        data: {
          organizationId,
          presentationId: medicine.presentations[0]!.id,
          packLevelId: null,
          type: 'INTERNAL',
          code: `'+presentation${suffix}`,
          normalizedCode: `presentation${suffix}`,
        },
      });
      await db.medicine.create({
        data: {
          organizationId,
          productName: `${label} Unpacked medicine`,
          productFamily: 'PHARMACEUTICAL',
        },
      });
    }
    const location = await db.pharmacyStockLocation.create({
      data: {
        organizationId,
        branchId: branch.id,
        code: `MAIN-${label}`,
        name: 'Main store',
        kind: 'STORE',
      },
    });
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        organizationId,
        medicineId: medicine.id,
        batchNumber: `B-${label}-${suffix}`,
        expiresAt: EXPIRES,
        expiryPrecision: 'DAY',
      },
    });
    const lot = await db.pharmacyInventoryLot.create({
      data: {
        organizationId,
        branchId: branch.id,
        manufacturingBatchId: batch.id,
        packLevelId: packLevel.id,
        unitsPerPack: 10,
        supplierName: `${label} Distributor`,
        supplierInvoiceRef: `INV-${label}-${suffix}`,
        unitCostMinor: 250,
        printedMrpMinor: 3_000,
        receivedExpiresAt: EXPIRES,
        receivedExpiryPrecision: 'DAY',
        receivedAt: RECEIVED,
      },
    });
    await db.pharmacyStockMovement.create({
      data: {
        organizationId,
        branchId: branch.id,
        inventoryLotId: lot.id,
        stockLocationId: location.id,
        kind: 'RECEIPT',
        disposition: 'AVAILABLE',
        quantityUnits: 120,
        sealedPackDelta: 12,
        looseUnitDelta: 0,
        actorId: ACTOR,
        idempotencyKey: `receipt-${label}-${suffix}`,
        occurredAt: RECEIVED,
      },
    });
    await db.pharmacySupplier.create({
      data: { organizationId, name: `${label} Distributor ${suffix}`, authorized: true },
    });
    const patient = await db.pharmacyPatient.create({
      data: { organizationId, displayName: `${label} patient` },
    });
    const customer = await db.pharmacyCustomer.create({
      data: { organizationId, patientId: patient.id, displayName: `${label} customer` },
    });
    const family = await db.pharmacyFamilyAccount.create({
      data: {
        organizationId,
        branchId: branch.id,
        payerCustomerId: customer.id,
        displayName: `${label} family`,
      },
    });
    await db.pharmacyKhataEvent.create({
      data: {
        organizationId,
        branchId: branch.id,
        familyAccountId: family.id,
        kind: 'CHARGE',
        amountMinor: 125_050,
        dueAt: new Date('2026-11-30T00:00:00.000Z'),
        actorId: ACTOR,
      },
    });
    return { branchId: branch.id, customerId: customer.id, lotId: lot.id, locationId: location.id };
  });
}

beforeAll(async () => {
  if (!url) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(scoped.withPlatformDb);
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  workbench = await import('./migration/workbench');
  catalogueProfiler = await import('./migration/devfathom-catalogue-profiler');
  stockLotsProfiler = await import('./migration/devfathom-stock-lots-profiler');
  exporter = await import('./data-export');
  format = await import('./data-export-format');
  profiler = await import('./migration/profiler');
  csvProfiler = await import('./migration/excel-csv-profiler');
  sourceValues = await import('./migration/source-values');
}, 30_000);

suite('owner data export under forced PostgreSQL RLS', () => {
  it('exports a seeded tenant that re-imports with matching row counts and no foreign rows', async () => {
    const seeded = await seed(orgA, 'alpha', true);
    await seed(orgB, 'beta');

    const { dataset, organizationName } = await withTenantDb(orgA, (db) =>
      exporter.collectPharmacyDataExport(db, orgA, { from: '2026-10-01', to: '2026-10-30' }, NOW)
    );
    expect(organizationName).toBe('alpha Pharmacy');
    expect(dataset.branches).toHaveLength(1);
    expect(dataset.medicines).toHaveLength(3);
    expect(dataset.medicineBarcodes).toHaveLength(3);
    expect(dataset.stockLots).toEqual([
      expect.objectContaining({ lot_code: seeded.lotId, quantity: 120, pack: 10, cost: '2.50' }),
    ]);
    expect(dataset.customers).toEqual([
      expect.objectContaining({ code: seeded.customerId, balance: '1250.50', khata_accounts: 1 }),
    ]);
    expect(dataset.khataLedger).toHaveLength(1);
    expect(dataset.suppliers).toHaveLength(1);
    expect(JSON.stringify(dataset)).not.toContain('beta');

    const files = format.buildPharmacyExportFiles(dataset, {
      organizationName,
      generatedAt: NOW,
      salesFrom: '2026-10-01',
      salesTo: '2026-10-30',
    });
    for (const key of format.PHARMACY_EXPORT_FILE_KEYS) {
      const spec = format.PHARMACY_EXPORT_FILES[key];
      if (!spec.importable) continue;
      const file = files.find((item) => item.name === spec.name)!;
      const table = sourceValues.parseDelimitedText(file.data.toString('utf8'));
      const profiled = profiler.profileTable(
        key === 'medicines'
          ? catalogueProfiler.devfathomCatalogueProfiler
          : key === 'stockLots'
            ? stockLotsProfiler.devfathomStockLotsProfiler
            : csvProfiler.excelCsvProfiler,
        table
      );
      expect(profiled.rows, spec.name).toHaveLength(dataset[key].length);
      expect(profiled.exceptions, spec.name).toEqual([]);
    }

    // Complete the supported catalogue path, rather than just counting profiler rows.
    const target = `${orgA}_import`;
    await withTenantDb(target, (db) =>
      db.organization.create({
        data: {
          id: target,
          slug: target,
          legalName: 'Imported pharmacy',
          displayName: 'Imported pharmacy',
          vertical: 'PHARMACY',
        },
      })
    );
    const csv = files.find((file) => file.name === 'medicines.csv')!.data.toString('utf8');
    const imported = await withTenantDb(target, (db) =>
      workbench.importCatalogueSource(db, {
        organizationId: target,
        fileName: 'medicines.csv',
        csv,
        now: NOW,
      })
    );
    expect(imported).toEqual({
      sourceId: expect.any(String),
      batchId: expect.any(String),
      exceptionCount: 0,
      rows: 3,
      medicines: 2,
      presentations: 1,
      packs: 2,
    });
    // The wizard kept the file as evidence and one profiled row per CSV row, with no exceptions.
    const evidence = await withTenantDb(target, async (db) => ({
      source: await db.pharmacyMigrationSource.findMany(),
      batch: await db.pharmacyMigrationBatch.findMany({
        include: { rows: true, exceptions: true },
      }),
    }));
    expect(evidence.source).toEqual([
      expect.objectContaining({
        id: imported.sourceId,
        kind: 'EXCEL_CSV',
        fileName: 'medicines.csv',
      }),
    ]);
    expect(evidence.batch).toEqual([
      expect.objectContaining({
        id: imported.batchId,
        status: 'PROFILED',
        rowCount: 3,
        exceptionCount: 0,
        profilerVersion: 'devfathom-catalogue/1',
        exceptions: [],
      }),
    ]);
    expect(evidence.batch[0]!.rows.map((row) => row.sourceKey).sort()).toEqual(
      dataset.medicines.map((row) => String(row.code)).sort()
    );
    const restored = await withTenantDb(target, (db) =>
      exporter.collectPharmacyDataExport(db, target, { from: '2026-10-01', to: '2026-10-30' }, NOW)
    );
    const values = (rows: typeof dataset.medicines) =>
      rows
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).filter(
              ([key]) => !['code', 'medicine_code', 'presentation_code'].includes(key)
            )
          )
        )
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(values(restored.dataset.medicines)).toEqual(values(dataset.medicines));
    expect(restored.dataset.stockLots).toEqual([]);
    expect(
      await withTenantDb(target, (db) =>
        db.medicine.findMany({
          include: { provenance: true },
        })
      )
    ).toEqual([
      expect.objectContaining({
        saleable: false,
        provenance: [expect.objectContaining({ status: 'UNREVIEWED', sourceType: 'IMPORT' })],
      }),
      expect.objectContaining({
        saleable: false,
        provenance: [expect.objectContaining({ status: 'UNREVIEWED', sourceType: 'IMPORT' })],
      }),
    ]);
  }, 60_000);

  it('keeps export requests tenant-isolated', async () => {
    const requested = await withTenantDb(orgA, (db) =>
      exporter.requestPharmacyDataExport(
        db,
        { organizationId: orgA, actorId: ACTOR, range: { from: '2026-10-01', to: '2026-10-30' } },
        NOW
      )
    );
    expect(requested.created).toBe(true);
    const again = await withTenantDb(orgA, (db) =>
      exporter.requestPharmacyDataExport(
        db,
        { organizationId: orgA, actorId: ACTOR, range: { from: '2026-10-01', to: '2026-10-30' } },
        NOW
      )
    );
    expect(again).toMatchObject({ created: false, export: { id: requested.export.id } });
    const visibleToB = await withTenantDb(orgB, (db) =>
      db.pharmacyDataExport.findMany({ where: { id: requested.export.id } })
    );
    expect(visibleToB).toEqual([]);
    await expect(
      withTenantDb(orgB, (db) =>
        exporter.readPharmacyDataExportArchive(db, {
          organizationId: orgB,
          exportId: requested.export.id,
        })
      )
    ).rejects.toThrow('NOT_FOUND');
  }, 30_000);

  it('serializes simultaneous requests for deduplication and the fifth daily slot', async () => {
    const organizationId = `${orgA}_limits`;
    await seed(organizationId, 'limits');
    const request = () =>
      withTenantDb(organizationId, (db) =>
        exporter.requestPharmacyDataExport(
          db,
          { organizationId, actorId: ACTOR, range: { from: '2026-10-01', to: '2026-10-30' } },
          NOW
        )
      );
    const wave = () => Promise.all(Array.from({ length: 6 }, request));
    const first = await wave();
    expect(first.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(first.map((result) => result.export.id)).size).toBe(1);
    await withTenantDb(organizationId, async (db) => {
      await db.pharmacyDataExport.updateMany({ data: { status: 'FAILED' } });
      await db.pharmacyDataExport.createMany({
        data: Array.from({ length: 3 }, () => ({
          organizationId,
          requestedByUserId: ACTOR,
          status: 'FAILED' as const,
          requestedAt: NOW,
          salesFrom: new Date('2026-10-01'),
          salesTo: new Date('2026-10-30'),
        })),
      });
    });
    const fifth = await wave();
    expect(fifth.filter((result) => result.created)).toHaveLength(1);
    expect(await withTenantDb(organizationId, (db) => db.pharmacyDataExport.count())).toBe(5);
    await withTenantDb(organizationId, (db) =>
      db.pharmacyDataExport.updateMany({ data: { status: 'FAILED' } })
    );
    const denied = await Promise.allSettled(Array.from({ length: 3 }, request));
    expect(
      denied.every(
        (result) =>
          result.status === 'rejected' &&
          result.reason instanceof exporter.PharmacyDataExportError &&
          result.reason.reason === 'RATE_LIMITED'
      )
    ).toBe(true);
  }, 60_000);

  it('collects stock and sales from one repeatable snapshot while a sale commits', async () => {
    const organizationId = `${orgA}_snapshot`;
    const seeded = await seed(organizationId, 'snapshot');
    const collected = await withPlatformDb(
      async (db) => {
        const { withOrganizationDefaults } = await import('@/lib/tenancy/scoped-db');
        return withOrganizationDefaults(db, organizationId, async (tx) => {
          // Interleave a committed sale after the stock query and before the sales query.
          const interleaved = new Proxy(tx, {
            get(target, key) {
              if (key !== 'pharmacySale') return Reflect.get(target, key);
              return {
                findMany: async (args: Parameters<typeof tx.pharmacySale.findMany>[0]) => {
                  await withTenantDb(organizationId, async (writer) => {
                    await writer.pharmacyStockMovement.create({
                      data: {
                        organizationId,
                        branchId: seeded.branchId,
                        inventoryLotId: seeded.lotId,
                        stockLocationId: seeded.locationId,
                        kind: 'SALE',
                        disposition: 'AVAILABLE',
                        quantityUnits: -10,
                        sealedPackDelta: -1,
                        actorId: ACTOR,
                        idempotencyKey: `snapshot-sale-${suffix}`,
                        occurredAt: NOW,
                      },
                    });
                    await writer.pharmacySale.create({
                      data: {
                        organizationId,
                        branchId: seeded.branchId,
                        createdByUserId: ACTOR,
                        status: 'COMPLETED',
                        completedAt: NOW,
                        businessDate: new Date('2026-10-15'),
                      },
                    });
                  });
                  return target.pharmacySale.findMany(args);
                },
              };
            },
          });
          return exporter.collectPharmacyDataExport(
            interleaved,
            organizationId,
            { from: '2026-10-01', to: '2026-10-30' },
            NOW
          );
        });
      },
      { isolationLevel: 'RepeatableRead' }
    );
    expect(collected.dataset.stockLots[0]?.quantity).toBe(120);
    expect(collected.dataset.sales).toEqual([]);
    const after = await withTenantDb(organizationId, (db) =>
      exporter.collectPharmacyDataExport(
        db,
        organizationId,
        { from: '2026-10-01', to: '2026-10-30' },
        NOW
      )
    );
    expect(after.dataset.stockLots[0]?.quantity).toBe(110);
    expect(after.dataset.sales).toHaveLength(1);
  }, 60_000);

  it.each(['QUEUED', 'FAILED'] as const)(
    'collects uploads after rollback with a %s request and no storage metadata',
    async (status) => {
      const organizationId = `${orgA}_rollback_${status}`;
      await seed(organizationId, 'rollback');
      const requested = await withTenantDb(organizationId, (db) =>
        exporter.requestPharmacyDataExport(
          db,
          { organizationId, actorId: ACTOR, range: { from: '2026-10-01', to: '2026-10-30' } },
          NOW
        )
      );
      const exportId = requested.export.id;
      const key = `${organizationId}/pharmacy-data-exports/${exportId}.zip`;
      await expect(
        withPlatformDb(
          async (db) => {
            await exporter.runPharmacyDataExportJob(
              db,
              { id: 'rollback-job', organizationId, attempts: 1, maxAttempts: 1 },
              { exportId },
              { now: NOW }
            );
            expect(archives.has(key)).toBe(true);
            throw new Error('commit rejected');
          },
          { isolationLevel: 'RepeatableRead' }
        )
      ).rejects.toThrow('commit rejected');
      expect(
        await withTenantDb(organizationId, (db) =>
          db.pharmacyDataExport.findUnique({
            where: { id: exportId },
          })
        )
      ).toMatchObject({ status: 'QUEUED', storageKey: null, expiresAt: null });
      if (status === 'FAILED')
        await withTenantDb(organizationId, (db) =>
          db.pharmacyDataExport.update({
            where: { id: exportId },
            data: { status: 'FAILED' },
          })
        );
      const later =
        status === 'FAILED'
          ? NOW
          : new Date(NOW.getTime() + exporter.PHARMACY_DATA_EXPORT_STALE_MS + 1);
      await withTenantDb(organizationId, (db) => exporter.expirePharmacyDataExports(db, later));
      expect(archives.has(key)).toBe(false);
      expect(
        await withTenantDb(organizationId, (db) =>
          db.pharmacyDataExport.findUnique({
            where: { id: exportId },
          })
        )
      ).toMatchObject({ status: 'EXPIRED' });
      expect(
        await withPlatformDb((db) =>
          exporter.runPharmacyDataExportJob(
            db,
            { id: 'retry-job', organizationId, attempts: 2, maxAttempts: 2 },
            { exportId },
            { now: later }
          )
        )
      ).toMatchObject({ skipped: 'EXPIRED' });
      expect(archives.has(key)).toBe(false);
    },
    60_000
  );
});
