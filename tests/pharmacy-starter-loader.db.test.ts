// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { assertDisposableRlsDatabase } from './disposable-rls-database';

vi.mock('@/lib/pharmacy/migration/starter-products.json', () => ({
  default: Array.from({ length: 251 }, (_, i) => ({
    sourceId: String(i).padStart(4, '0'),
    legacyCode: i === 249 || i === 250 ? 'QA-shared-code' : 'QA-' + i,
    name: i === 1 ? 'QA archived medicine' : 'QA catalogue ' + i,
    active: i !== 1,
    controlled: i === 0,
    class: i === 0 ? 'NARCOTICS' : null,
    packSize: 12,
    verifiedGeneric: 'QA generic',
    manufacturerLabel: 'QA manufacturer',
  })),
}));

async function snapshot(db: ScopedDb) {
  const tables = [
    await db.medicine.findMany({ orderBy: { id: 'asc' } }),
    await db.presentation.findMany({ orderBy: { id: 'asc' } }),
    await db.packLevel.findMany({ orderBy: { id: 'asc' } }),
    await db.medicineAlias.findMany({ orderBy: { id: 'asc' } }),
    await db.pharmacyStarterIdentity.findMany({ orderBy: { sourceId: 'asc' } }),
    await db.pharmacyStarterConflict.findMany({ orderBy: [{ sourceId: 'asc' }, { field: 'asc' }] }),
    await db.pharmacyStarterImport.findMany(),
    await db.auditLog.findMany({ orderBy: { id: 'asc' } }),
  ];
  return {
    counts: tables.map((rows) => rows.length),
    checksum: createHash('sha256').update(JSON.stringify(tables)).digest('hex'),
  };
}

describe.runIf(process.env.TEST_DATABASE_URL)('starter load in disposable PostgreSQL', () => {
  it(
    'resumes across transactions, keeps edited values, isolates stock and prices, and replays with identical counts and checksum',
    { timeout: 120000 },
    async () => {
      const url = process.env.TEST_DATABASE_URL!;
      assertDisposableRlsDatabase(url);
      if (!/[_-](test|disposable)(?:$|[_-])/.test(new URL(url).pathname))
        throw new Error('Disposable test database required.');
      vi.stubEnv('DATABASE_URL', url);
      const { withTenantDb, withPlatformDb } = await import('@/lib/tenancy/scoped-db');
      const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
      await assertRlsEnforcingRole(withPlatformDb);
      const { enqueueStarterImport } = await import('@/lib/pharmacy/migration/starter-queue');
      const { loadStarterBatch } = await import('@/lib/pharmacy/migration/starter-loader');
      const a = randomUUID(),
        b = randomUUID();
      for (const id of [a, b]) {
        await withPlatformDb(async (db) => {
          await db.organization.create({
            data: { id, slug: id, displayName: id, legalName: id, vertical: 'PHARMACY' },
          });
          await enqueueStarterImport(db, id);
        });
      }
      const existing = await withTenantDb(b, async (db) => {
        const row = await db.medicine.create({
          data: {
            productName: 'QA local edit',
            manufacturer: 'QA local label',
            productFamily: 'PHARMACEUTICAL',
            saleable: false,
            aliases: { create: { type: 'LEGACY_CODE', value: 'QA-0', normalizedValue: 'qa0' } },
            presentations: {
              create: {
                presentation: 'QA local pack',
                packLevels: {
                  create: {
                    level: 'BOX',
                    versionGroupId: randomUUID(),
                    version: 1,
                    unitsPerParent: 20,
                    effectiveFrom: new Date(),
                  },
                },
              },
            },
          },
          include: { presentations: { include: { packLevels: true } } },
        });
        return row;
      });
      for (const id of [a, b]) {
        await expect(
          withTenantDb(id, async (db) => {
            await loadStarterBatch(db, id);
            throw new Error('Synthetic interruption before commit');
          })
        ).rejects.toThrow('Synthetic interruption before commit');
        expect(await withTenantDb(id, (db) => db.pharmacyStarterIdentity.count())).toBe(0);
        await withTenantDb(id, (db) => loadStarterBatch(db, id));
        expect(await withTenantDb(id, (db) => db.pharmacyStarterIdentity.count())).toBe(250);
        await withTenantDb(id, (db) => loadStarterBatch(db, id));
        const before = await withTenantDb(id, snapshot);
        expect(before.counts.slice(0, 3)).toEqual([251, 251, 251]);
        expect(before.counts[4]).toBe(251);
        expect(
          await withTenantDb(id, (db) =>
            db.medicineAlias.count({ where: { value: 'QA-shared-code' } })
          )
        ).toBe(2);
        await withPlatformDb((db) => enqueueStarterImport(db, id));
        await withTenantDb(id, (db) => loadStarterBatch(db, id));
        expect(await withTenantDb(id, snapshot)).toEqual(before);
      }
      await withTenantDb(b, async (db) => {
        expect(await db.medicine.findUnique({ where: { id: existing.id } })).toMatchObject({
          productName: 'QA local edit',
          manufacturer: 'QA local label',
          saleable: false,
          controlled: true,
        });
        expect(
          await db.pharmacyStarterConflict.findMany({
            orderBy: { field: 'asc' },
            select: { field: true, existingValue: true, starterValue: true },
          })
        ).toEqual([
          { field: 'active', existingValue: 'false', starterValue: 'true' },
          { field: 'controlled', existingValue: 'false', starterValue: 'true' },
          { field: 'packSize', existingValue: '20', starterValue: '12' },
        ]);
        expect(await db.pharmacyStarterIdentity.count({ where: { narcoticsReview: true } })).toBe(
          1
        );
        const pack = existing.presentations[0]!.packLevels[0]!;
        const branch = await db.pharmacyBranch.create({
          data: {
            code: 'MAIN',
            name: 'QA branch',
            addressLine: 'QA',
            city: 'QA',
            provinceCode: 'PB',
          },
        });
        expect(
          await db.medicine.findFirstOrThrow({ where: { productName: 'QA archived medicine' } })
        ).toMatchObject({ saleable: false });
        const { searchCounterCatalog } = await import('@/lib/pharmacy/counter');
        const scope = { organizationId: b, branchId: branch.id };
        const inactive = await searchCounterCatalog(db, scope, { query: 'QA archived medicine' });
        expect(inactive.rows).toEqual([]);
        const active = await searchCounterCatalog(db, scope, { query: 'QA catalogue 248' });
        expect(active.rows).toHaveLength(1);
        expect(active.rows[0]).toMatchObject({
          displayName: 'QA catalogue 248',
          onHandUnits: 0,
          printedMrpMinor: null,
        });
        const batch = await db.pharmacyManufacturingBatch.create({
          data: { medicineId: existing.id, batchNumber: 'QA', expiresAt: new Date('2031-01-01') },
        });
        await db.medicinePackMrp.create({
          data: { packLevelId: pack.id, batchReference: 'QA', printedMrpMinor: 580 },
        });
        const location = await db.pharmacyStockLocation.create({
          data: { branchId: branch.id, code: 'QA', name: 'QA stock', kind: 'STORE' },
        });
        const { receiveLot } = await import('@/lib/pharmacy/stock-ledger');
        const { lot } = await receiveLot(
          db,
          { organizationId: b, branchId: branch.id, actorId: 'qa-worker' },
          {
            stockLocationId: location.id,
            receivedAt: new Date(),
            quantityUnits: 60,
            idempotencyKey: randomUUID(),
            manufacturingBatchId: batch.id,
            packLevelId: pack.id,
            unitsPerPack: 20,
            supplierName: 'QA',
            supplierInvoiceRef: 'QA',
            unitCostMinor: 3,
            printedMrpMinor: 580,
            receivedExpiresAt: new Date('2031-01-01'),
            receivedExpiryPrecision: 'DAY',
          }
        );
        expect(
          await db.pharmacyStockBalance.count({
            where: { inventoryLotId: lot.id, onHandUnits: 60 },
          })
        ).toBe(1);
        expect(await db.pharmacyInventoryLot.findUnique({ where: { id: lot.id } })).toBeTruthy();
        expect(await db.medicinePackMrp.count()).toBe(1);
      });
      await withTenantDb(a, async (db) => {
        expect(await db.medicine.count({ where: { organizationId: b } })).toBe(0);
        expect(await db.medicinePackMrp.count()).toBe(0);
        expect(await db.pharmacyInventoryLot.count()).toBe(0);
        expect(await db.pharmacyStockBalance.count()).toBe(0);
        expect(await db.medicine.count({ where: { saleable: true } })).toBe(250);
        expect(await db.pharmacyStarterConflict.count()).toBe(0);
        expect(
          await db.auditLog.count({
            where: { action: 'pharmacy.starterCatalogue.loaded', actorType: 'SYSTEM' },
          })
        ).toBe(1);
      });
    }
  );
});
