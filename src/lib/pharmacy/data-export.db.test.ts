import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * #716 acceptance against a real database under forced RLS: an export of a
 * seeded tenant re-imports through the migration wizard's Excel/CSV profiler
 * with matching row counts, and never carries another tenant's rows.
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
let exporter: typeof import('./data-export');
let format: typeof import('./data-export-format');
let profiler: typeof import('./migration/profiler');
let csvProfiler: typeof import('./migration/excel-csv-profiler');
let sourceValues: typeof import('./migration/source-values');

async function seed(organizationId: string, label: string) {
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
        productName: `${label} Paracetamol 500mg`,
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
    const location = await db.pharmacyStockLocation.create({
      data: { organizationId, branchId: branch.id, code: `MAIN-${label}`, name: 'Main store', kind: 'STORE' },
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
    return { branchId: branch.id, customerId: customer.id, lotId: lot.id };
  });
}

beforeAll(async () => {
  if (!url) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(scoped.withPlatformDb);
  withTenantDb = scoped.withTenantDb;
  exporter = await import('./data-export');
  format = await import('./data-export-format');
  profiler = await import('./migration/profiler');
  csvProfiler = await import('./migration/excel-csv-profiler');
  sourceValues = await import('./migration/source-values');
}, 30_000);

suite('owner data export under forced PostgreSQL RLS', () => {
  it('exports a seeded tenant that re-imports with matching row counts and no foreign rows', async () => {
    const seeded = await seed(orgA, 'alpha');
    await seed(orgB, 'beta');

    const { dataset, organizationName } = await withTenantDb(orgA, (db) =>
      exporter.collectPharmacyDataExport(db, orgA, { from: '2026-10-01', to: '2026-10-30' }, NOW)
    );
    expect(organizationName).toBe('alpha Pharmacy');
    expect(dataset.branches).toHaveLength(1);
    expect(dataset.medicines).toHaveLength(1);
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
      const profiled = profiler.profileTable(csvProfiler.excelCsvProfiler, table);
      expect(profiled.rows, spec.name).toHaveLength(dataset[key].length);
    }
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
});
