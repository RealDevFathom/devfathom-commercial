/**
 * #719 shelf and price labels against migrated PostgreSQL with FORCED RLS.
 *
 * Only a real database can settle that every received lot gets a distinct,
 * immutable label number, that a scanned label resolves to the exact lot in
 * its own branch only, and that the printed pack MRP is the lot price the
 * counter charges. Skipped (never silently passed) without a database URL.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_i719_a_${suffix}`;
const ORG_B = `org_i719_b_${suffix}`;
const BRANCH_A = `branch_i719_a_${suffix}`;
const BRANCH_A_TWO = `branch_i719_a2_${suffix}`;
const BRANCH_B = `branch_i719_b_${suffix}`;
const ACTOR = 'user_i719';
const NOW = new Date('2026-10-31T09:00:00.000Z');

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  ledger: typeof import('./stock-ledger');
  counter: typeof import('./counter');
  source: typeof import('./shelf-label-source');
  code: typeof import('./shelf-label-code');
};
let deps: Deps;

function inOrg<T>(organizationId: string, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(organizationId, work);
}

let unique = 0;
function tag(label: string) {
  unique += 1;
  return `${suffix}-${label}-${unique}`;
}

async function ensureBranch(db: ScopedDb, organizationId: string, branchId: string) {
  await db.pharmacyBranch.createMany({
    data: [
      {
        id: branchId,
        organizationId,
        code: branchId,
        name: `Branch ${branchId}`,
        addressLine: '1 Test Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    ],
    skipDuplicates: true,
  });
}

/** A saleable medicine sold as a box of 3 strips of 10 tablets, with one received lot. */
async function receivedLot(organizationId: string, branchId: string, label: string, mrp = 3000) {
  return inOrg(organizationId, async (db) => {
    await ensureBranch(db, organizationId, branchId);
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: `Loose Strip 500mg ${tag(label)}`,
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        presentations: { create: { organizationId, presentation: 'Tablet, 10 per strip' } },
      },
      include: { presentations: true },
    });
    const presentationId = medicine.presentations[0]!.id;
    const versionGroup = tag(`${label}-pack`);
    const box = await db.packLevel.create({
      data: {
        organizationId,
        presentationId,
        versionGroupId: `${versionGroup}-box`,
        version: 1,
        level: 'BOX',
        unitsPerParent: 1,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const strip = await db.packLevel.create({
      data: {
        organizationId,
        presentationId,
        parentPackLevelId: box.id,
        versionGroupId: `${versionGroup}-strip`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 3,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    await db.packLevel.create({
      data: {
        organizationId,
        presentationId,
        parentPackLevelId: strip.id,
        versionGroupId: `${versionGroup}-unit`,
        version: 1,
        level: 'UNIT',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const location = await db.pharmacyStockLocation.create({
      data: { organizationId, branchId, code: `MAIN-${tag(label)}`, name: 'Main', kind: 'STORE' },
    });
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        organizationId,
        medicineId: medicine.id,
        batchNumber: `LBL-${tag(label)}`,
        expiresAt: new Date('2027-06-30T19:00:00.000Z'),
        expiryPrecision: 'MONTH',
      },
    });
    const { lot } = await deps.ledger.receiveLot(
      db,
      { organizationId, branchId, actorId: ACTOR },
      {
        manufacturingBatchId: batch.id,
        packLevelId: box.id,
        stockLocationId: location.id,
        unitsPerPack: 30,
        supplierName: 'Distributor Ltd',
        supplierInvoiceRef: `INV-${tag(label)}`,
        unitCostMinor: 50,
        printedMrpMinor: mrp,
        receivedExpiresAt: new Date('2027-06-30T19:00:00.000Z'),
        receivedExpiryPrecision: 'MONTH',
        quantityUnits: 300,
        idempotencyKey: `receipt-${tag(label)}`,
        receivedAt: new Date('2026-10-01T00:00:00.000Z'),
      }
    );
    const stored = await db.pharmacyInventoryLot.findFirstOrThrow({
      where: { organizationId, id: lot.id },
      select: { id: true, shelfLabelNumber: true },
    });
    return { lotId: stored.id, shelfLabelNumber: stored.shelfLabelNumber, medicineId: medicine.id };
  });
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, ledger, counter, source, code, roleGuard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./stock-ledger'),
    import('./counter'),
    import('./shelf-label-source'),
    import('./shelf-label-code'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = { withTenantDb: scopedDb.withTenantDb, ledger, counter, source, code };
  await roleGuard.assertRlsEnforcingRole(scopedDb.withPlatformDb);
}, 120_000);

describeIfDatabase('#719 shelf-label lot identity', () => {
  it('numbers each received lot distinctly and refuses to renumber it', async () => {
    const first = await receivedLot(ORG_A, BRANCH_A, 'distinct-1');
    const second = await receivedLot(ORG_A, BRANCH_A, 'distinct-2');
    expect(first.shelfLabelNumber).toBeGreaterThan(0);
    expect(second.shelfLabelNumber).not.toBe(first.shelfLabelNumber);

    const refused = await inOrg(ORG_A, (db) =>
      db.pharmacyInventoryLot
        .update({
          where: { id: first.lotId },
          data: { shelfLabelNumber: second.shelfLabelNumber + 1_000_000 },
        })
        .then(() => 'ACCEPTED')
        .catch((error: Error) => error.message)
    );
    expect(refused).not.toBe('ACCEPTED');
  });

  it('a scanned label selects that exact lot at the counter of its own branch', async () => {
    const lot = await receivedLot(ORG_A, BRANCH_A, 'scan');
    const scanned = deps.code.shelfLabelCode(lot.shelfLabelNumber);

    const result = await inOrg(ORG_A, (db) =>
      deps.counter.searchCounterCatalog(
        db,
        { organizationId: ORG_A, branchId: BRANCH_A },
        { query: scanned, at: NOW }
      )
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      medicineId: lot.medicineId,
      matchedOn: 'BARCODE',
      labelLotId: lot.lotId,
    });
  });

  it('a label never resolves in another branch or another tenant', async () => {
    const lot = await receivedLot(ORG_A, BRANCH_A, 'isolation');
    const scanned = deps.code.shelfLabelCode(lot.shelfLabelNumber);
    await inOrg(ORG_A, (db) => ensureBranch(db, ORG_A, BRANCH_A_TWO));
    await inOrg(ORG_B, (db) => ensureBranch(db, ORG_B, BRANCH_B));

    const otherBranch = await inOrg(ORG_A, (db) =>
      deps.counter.searchCounterCatalog(
        db,
        { organizationId: ORG_A, branchId: BRANCH_A_TWO },
        { query: scanned, at: NOW }
      )
    );
    const otherTenant = await inOrg(ORG_B, (db) =>
      deps.counter.searchCounterCatalog(
        db,
        { organizationId: ORG_B, branchId: BRANCH_B },
        { query: scanned, at: NOW }
      )
    );
    expect(otherBranch.rows).toEqual([]);
    expect(otherTenant.rows).toEqual([]);
  });

  it('prints the lot pack MRP the counter charges, its strip price and printed expiry', async () => {
    const lot = await receivedLot(ORG_A, BRANCH_A, 'price', 3001);
    const { rows } = await inOrg(ORG_A, (db) =>
      deps.source.readShelfLabelSources(
        db,
        { organizationId: ORG_A, branchId: BRANCH_A },
        { inventoryLotIds: [lot.lotId] },
        NOW
      )
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      inventoryLotId: lot.lotId,
      code: deps.code.shelfLabelCode(lot.shelfLabelNumber),
      packMrpMinor: 3001,
      // 10 of 30 tablets, pro-rata and rounded down exactly as the sale line is.
      stripMrpMinor: 1000,
      expiry: '2027-06',
    });
  });

  it('refuses a lot from another branch when printing', async () => {
    const lot = await receivedLot(ORG_A, BRANCH_A, 'print-scope');
    await inOrg(ORG_A, (db) => ensureBranch(db, ORG_A, BRANCH_A_TWO));
    await expect(
      inOrg(ORG_A, (db) =>
        deps.source.readShelfLabelSources(
          db,
          { organizationId: ORG_A, branchId: BRANCH_A_TWO },
          { inventoryLotIds: [lot.lotId] },
          NOW
        )
      )
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
