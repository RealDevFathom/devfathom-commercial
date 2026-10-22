/**
 * #604 against migrated PostgreSQL as a NOSUPERUSER NOBYPASSRLS role: expiry boundaries
 * are 00:00 in the organization's timezone, enforced in the database as well as in code.
 *
 * - Rollout race: the previous web task still writes the old UTC-midnight boundary while
 *   the migration runs. The trigger turns such a write into local midnight.
 * - Backfill: rows stored at UTC midnight are converted by the migration's statement,
 *   and running it again changes nothing.
 * Skipped unless TEST_DATABASE_URL names a migrated database.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG = `org_exp604_${suffix}`;
const BRANCH = `branch_exp604_${suffix}`;
const MIGRATION = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20261023000604_pharmacy_expiry_local_midnight/migration.sql'
  ),
  'utf8'
);
// The migration's backfill, limited to this test's organization.
const BACKFILL = [
  `UPDATE "pharmacy_manufacturing_batches" SET "expiresAt" = pharmacy_local_expiry_boundary("expiresAt", "organizationId") WHERE "expiresAt" = date_trunc('day', "expiresAt")`,
  `UPDATE "pharmacy_inventory_lots" SET "receivedExpiresAt" = pharmacy_local_expiry_boundary("receivedExpiresAt", "organizationId") WHERE "receivedExpiresAt" = date_trunc('day', "receivedExpiresAt")`,
];

let withTenantDb: typeof import('@/lib/tenancy/scoped-db').withTenantDb;
let withPlatformDb: typeof import('@/lib/tenancy/scoped-db').withPlatformDb;
let fixture: { medicineId: string; packLevelId: string };

const UTC_JULY = new Date('2027-07-01T00:00:00.000Z');
const KARACHI_JULY = '2027-06-30T19:00:00.000Z';

async function setZone(zone: string) {
  await withPlatformDb((tx) =>
    tx.$executeRawUnsafe('UPDATE organizations SET timezone = $1 WHERE id = $2', zone, ORG)
  );
}

/** A batch and a lot written the way code before #604 wrote them: UTC midnight. */
async function legacyStock(db: ScopedDb, label: string) {
  const batch = await db.pharmacyManufacturingBatch.create({
    data: {
      organizationId: ORG,
      medicineId: fixture.medicineId,
      batchNumber: `B-${label}-${suffix}`,
      expiresAt: UTC_JULY,
      expiryPrecision: 'MONTH',
    },
  });
  const lot = await db.pharmacyInventoryLot.create({
    data: {
      organizationId: ORG,
      branchId: BRANCH,
      manufacturingBatchId: batch.id,
      packLevelId: fixture.packLevelId,
      unitsPerPack: 10,
      supplierName: 'Distributor',
      supplierInvoiceRef: `INV-${label}-${suffix}`,
      unitCostMinor: 100,
      printedMrpMinor: 200,
      receivedExpiresAt: UTC_JULY,
      receivedExpiryPrecision: 'MONTH',
    },
  });
  return { batchId: batch.id, lotId: lot.id };
}

async function stored(ids: { batchId: string; lotId: string }) {
  return withTenantDb(ORG, async (db) => ({
    batch: (
      await db.pharmacyManufacturingBatch.findFirstOrThrow({ where: { id: ids.batchId } })
    ).expiresAt.toISOString(),
    lot: (
      await db.pharmacyInventoryLot.findFirstOrThrow({ where: { id: ids.lotId } })
    ).receivedExpiresAt.toISOString(),
  }));
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const scoped = await import('@/lib/tenancy/scoped-db');
  withTenantDb = scoped.withTenantDb;
  withPlatformDb = scoped.withPlatformDb;
  const [role] = await withPlatformDb((tx) =>
    tx.$queryRawUnsafe<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
    )
  );
  expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  await withPlatformDb((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", timezone, "createdAt", "updatedAt")
       VALUES ($1, $1, 'Expiry 604', 'Expiry 604', 'PHARMACY', 'ACTIVE', 'SHARED', 'UTC', now(), now())`,
      ORG
    )
  );
  fixture = await withTenantDb(ORG, async (db) => {
    await db.pharmacyBranch.create({
      data: {
        id: BRANCH,
        organizationId: ORG,
        code: 'E604',
        name: 'Expiry 604',
        addressLine: '1 Test Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    const medicine = await db.medicine.create({
      data: {
        organizationId: ORG,
        productName: `Amoxicillin ${suffix}`,
        productFamily: 'PHARMACEUTICAL',
        presentations: { create: { organizationId: ORG, presentation: 'Capsule, 10 per strip' } },
      },
      include: { presentations: true },
    });
    const packLevel = await db.packLevel.create({
      data: {
        organizationId: ORG,
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `strip-${suffix}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    return { medicineId: medicine.id, packLevelId: packLevel.id };
  });
}, 60_000);

describeIfDatabase('#604 local-midnight expiry in PostgreSQL', () => {
  it('ships the trigger and the backfill in the migration', () => {
    expect(MIGRATION).toContain(
      'BEFORE INSERT OR UPDATE OF "expiresAt" ON "pharmacy_manufacturing_batches"'
    );
    expect(MIGRATION).toContain(
      'BEFORE INSERT OR UPDATE OF "receivedExpiresAt" ON "pharmacy_inventory_lots"'
    );
    for (const statement of BACKFILL) expect(MIGRATION.replace(/\s+/g, ' ')).toContain(statement);
  });

  it('backfills rows stored at UTC midnight, and a second run changes nothing', async () => {
    // Written while the organization was on UTC, so they are stored at UTC midnight.
    const ids = await withTenantDb(ORG, (db) => legacyStock(db, 'backfill'));
    expect(await stored(ids)).toEqual({
      batch: UTC_JULY.toISOString(),
      lot: UTC_JULY.toISOString(),
    });
    await setZone('Asia/Karachi');
    const backfill = () =>
      withPlatformDb(async (tx) => {
        for (const statement of BACKFILL)
          await tx.$executeRawUnsafe(`${statement} AND "organizationId" = $1`, ORG);
      });
    await backfill();
    expect(await stored(ids)).toEqual({ batch: KARACHI_JULY, lot: KARACHI_JULY });
    await backfill();
    expect(await stored(ids)).toEqual({ batch: KARACHI_JULY, lot: KARACHI_JULY });
  });

  it('normalizes a UTC-midnight write from the previous web task (rollout race)', async () => {
    await setZone('Asia/Karachi');
    const ids = await withTenantDb(ORG, (db) => legacyStock(db, 'race'));
    expect(await stored(ids)).toEqual({ batch: KARACHI_JULY, lot: KARACHI_JULY });
    // An unrelated update leaves an already-local boundary alone.
    await withTenantDb(ORG, (db) =>
      db.pharmacyManufacturingBatch.update({
        where: { id: ids.batchId },
        data: { expiresAt: new Date(KARACHI_JULY) },
      })
    );
    expect(await stored(ids)).toEqual({ batch: KARACHI_JULY, lot: KARACHI_JULY });
  });

  it('stores what the new code computes unchanged, so receipt conflict checks agree', async () => {
    await setZone('Asia/Karachi');
    const { expiryInstant } = await import('./stock-ledger');
    const computed = expiryInstant(new Date('2027-06-01T00:00:00.000Z'), 'MONTH', 'Asia/Karachi');
    const batch = await withTenantDb(ORG, (db) =>
      db.pharmacyManufacturingBatch.create({
        data: {
          organizationId: ORG,
          medicineId: fixture.medicineId,
          batchNumber: `B-new-${suffix}`,
          expiresAt: computed,
          expiryPrecision: 'MONTH',
        },
      })
    );
    expect(batch.expiresAt.toISOString()).toBe(KARACHI_JULY);
    const { organizationTimezone } = await import('./stock-ledger');
    expect(await withTenantDb(ORG, (db) => organizationTimezone(db, ORG))).toBe('Asia/Karachi');
  });
});
