/**
 * DEV-853 against migrated PostgreSQL with FORCED row level security.
 *
 * Legacy opening stock with no batch number and/or no expiry is stored as NULL
 * (never an invented batch or date), posts, and is sellable. FEFO draws known
 * expiries first; a KNOWN expiry that has passed stays blocked; staff can
 * record the real batch and expiry once. The column and CHECK changes only mean
 * anything against a real database, so this suite is skipped (never silently
 * passed) when the database URL is absent.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG = `org_dev853_${suffix}`;
const ACTOR = 'user_dev853_owner';

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  assertRlsEnforcingRole: (typeof import('@/lib/testing/rls-role-guard'))['assertRlsEnforcingRole'];
  ownerImport: typeof import('./migration/owner-import');
  ledger: typeof import('./stock-ledger');
  inventory: typeof import('./inventory');
  record: typeof import('./record-unrecorded-batch');
};
let deps: Deps;

function inOrg<T>(work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(ORG, work);
}

let unique = 0;
function tag(label: string) {
  unique += 1;
  return `${suffix}-${label}-${unique}`;
}

type Scenario = { branchId: string; medicineId: string; packLevelId: string; locationId: string };

async function scenario(label: string): Promise<Scenario> {
  const branchId = `branch_${tag(label)}`;
  return inOrg(async (db) => {
    await db.pharmacyBranch.create({
      data: {
        id: branchId,
        organizationId: ORG,
        code: branchId,
        name: `Branch ${label}`,
        addressLine: '1 Test Road',
        city: 'Lahore',
        provinceCode: 'PB',
      },
    });
    const medicine = await db.medicine.create({
      data: {
        organizationId: ORG,
        productName: `Legacy stock ${tag(label)}`,
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        presentations: { create: { organizationId: ORG, presentation: 'Tablet, 10 per strip' } },
      },
      include: { presentations: true },
    });
    const packLevel = await db.packLevel.create({
      data: {
        organizationId: ORG,
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `strip-${tag(label)}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const location = await db.pharmacyStockLocation.create({
      data: {
        organizationId: ORG,
        branchId,
        code: `MAIN-${tag(label)}`,
        name: 'Main',
        kind: 'STORE',
      },
    });
    return {
      branchId,
      medicineId: medicine.id,
      packLevelId: packLevel.id,
      locationId: location.id,
    };
  });
}

const scopeOf = (fixture: Scenario) => ({
  organizationId: ORG,
  branchId: fixture.branchId,
  actorId: ACTOR,
});

/** Commit an owner opening import of the given CSV rows (Source,Pack,Batch,Expiry,...). */
async function importRows(fixture: Scenario, rows: string[]) {
  const input = {
    fileName: 'legacy.csv',
    branchId: fixture.branchId,
    stockLocationId: fixture.locationId,
    mapping: {
      sourceRef: 0,
      pack: 1,
      batch: 2,
      expiry: 3,
      mrp: 4,
      cost: 5,
      expected: 6,
      counted: 7,
    },
    content: Buffer.from(
      `Source,Pack,Batch,Expiry,MRP,Cost,Exported,Counted\n${rows
        .map((row) => row.replaceAll('PACK', fixture.packLevelId))
        .join('\n')}`
    ).toString('base64'),
  };
  const preview = await inOrg((db) =>
    deps.ownerImport.previewOwnerImport(db, scopeOf(fixture), input)
  );
  expect(preview.lines.flatMap((line) => line.errors)).toEqual([]);
  expect(preview.canCommit).toBe(true);
  return inOrg((db) =>
    deps.ownerImport.commitOwnerImport(db, scopeOf(fixture), {
      ...input,
      previewHash: preview.previewHash,
    })
  );
}

async function expectRejection(work: (db: ScopedDb) => Promise<unknown>): Promise<string> {
  try {
    await inOrg(work);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected the statement to be rejected, but it succeeded.');
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, roleGuard, ownerImport, ledger, inventory, record] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/testing/rls-role-guard'),
    import('./migration/owner-import'),
    import('./stock-ledger'),
    import('./inventory'),
    import('./record-unrecorded-batch'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    assertRlsEnforcingRole: roleGuard.assertRlsEnforcingRole,
    ownerImport,
    ledger,
    inventory,
    record,
  };
  await deps.assertRlsEnforcingRole(scopedDb.withPlatformDb);
  await deps.withPlatformDb((db) =>
    db.organization.createMany({
      data: [
        {
          id: ORG,
          slug: `dev853-${suffix}`,
          legalName: 'DEV-853',
          displayName: 'DEV-853',
          status: 'ACTIVE' as const,
          deploymentMode: 'SHARED' as const,
        },
      ],
      skipDuplicates: true,
    })
  );
}, 120_000);

describeIfDatabase('DEV-853 legacy opening stock with no batch or expiry', () => {
  it('imports and posts the stock with the batch number and expiry stored as NULL', async () => {
    const fixture = await scenario('import');
    const receipt = await importRows(fixture, ['LEGACY-1,PACK,,,25.00,1.25,10,10']);
    expect(receipt).toMatchObject({ replayed: false, totalUnits: 10 });

    await inOrg(async (db) => {
      const line = await db.pharmacyOpeningStockLine.findFirstOrThrow({
        where: { organizationId: ORG, sessionId: receipt.sessionId },
      });
      expect(line).toMatchObject({
        status: 'POSTED',
        batchNumber: null,
        expiryDate: null,
        expiryPrecision: null,
      });
      const lot = await db.pharmacyInventoryLot.findFirstOrThrow({
        where: { organizationId: ORG, id: line.postedLotId! },
        include: { batch: true },
      });
      expect(lot).toMatchObject({ receivedExpiresAt: null, receivedExpiryPrecision: null });
      expect(lot.batch).toMatchObject({ batchNumber: null, expiresAt: null, state: 'ACTIVE' });
      expect(
        await db.pharmacyOpeningException.count({
          where: { organizationId: ORG, sessionId: receipt.sessionId },
        })
      ).toBe(0);

      // Sellable: the ledger offers it and the hard-block predicate clears it.
      const candidates = await deps.ledger.loadStockCandidatesForRead(
        db,
        scopeOf(fixture),
        fixture.medicineId
      );
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({ inventoryLotId: lot.id, expiresAt: null });
      expect(
        deps.inventory.blockReasonFor(candidates[0]!, {
          organizationId: ORG,
          branchId: fixture.branchId,
          at: new Date(),
        })
      ).toBeNull();
    });
  });

  it('draws known-expiry stock first, then the unrecorded lot', async () => {
    const fixture = await scenario('fefo');
    await importRows(fixture, [
      'UNKNOWN-1,PACK,,,25.00,1.25,10,10',
      'KNOWN-1,PACK,K-1,2099-06,25.00,1.25,10,10',
    ]);

    await inOrg(async (db) => {
      const candidates = await deps.ledger.loadStockCandidatesForRead(
        db,
        scopeOf(fixture),
        fixture.medicineId
      );
      // SQL order: the known expiry first, the unrecorded one last.
      expect(candidates.map((row) => row.expiresAt === null)).toEqual([false, true]);
      const plan = deps.inventory.planAllocation({
        candidates,
        requiredUnits: 15,
        scope: { organizationId: ORG, branchId: fixture.branchId, at: new Date() },
      });
      const lots = await db.pharmacyInventoryLot.findMany({
        where: {
          organizationId: ORG,
          id: { in: plan.allocations.map((row) => row.inventoryLotId) },
        },
        include: { batch: true },
      });
      const byId = new Map(lots.map((lot) => [lot.id, lot]));
      expect(
        plan.allocations.map((row) => [byId.get(row.inventoryLotId)!.batch.batchNumber, row.units])
      ).toEqual([
        ['K-1', 10],
        [null, 5],
      ]);
    });
  });

  it('lets staff record the real batch and expiry once', async () => {
    const fixture = await scenario('record');
    const receipt = await importRows(fixture, ['LEGACY-REC,PACK,,,25.00,1.25,10,10']);
    const lotId = await inOrg(async (db) => {
      const line = await db.pharmacyOpeningStockLine.findFirstOrThrow({
        where: { organizationId: ORG, sessionId: receipt.sessionId },
      });
      return line.postedLotId!;
    });

    const recorded = await inOrg((db) =>
      deps.record.recordUnrecordedBatch(db, scopeOf(fixture), {
        inventoryLotId: lotId,
        batchNumber: `REAL-${suffix}`,
        expiry: { printedExpiry: new Date('2099-06-01T00:00:00.000Z'), precision: 'MONTH' },
      })
    );
    expect(recorded.batchNumber).toBe(`REAL-${suffix}`);
    expect(recorded.expiresAt).toBeInstanceOf(Date);

    await inOrg(async (db) => {
      const lot = await db.pharmacyInventoryLot.findFirstOrThrow({
        where: { organizationId: ORG, id: lotId },
        include: { batch: true },
      });
      expect(lot.batch).toMatchObject({ batchNumber: `REAL-${suffix}`, expiryPrecision: 'MONTH' });
      expect(lot.batch.expiresAt).not.toBeNull();
      expect(lot.receivedExpiryPrecision).toBe('MONTH');
    });

    const again = await expectRejection((db) =>
      deps.record.recordUnrecordedBatch(db, scopeOf(fixture), {
        inventoryLotId: lotId,
        expiry: { printedExpiry: new Date('2098-01-01T00:00:00.000Z'), precision: 'MONTH' },
      })
    );
    expect(again).toContain('EXPIRY_ALREADY_RECORDED');
  });

  it('refuses at the database a lot expiry without its precision, and a blank batch number', async () => {
    const fixture = await scenario('checks');
    const receipt = await importRows(fixture, ['LEGACY-CHK,PACK,,,25.00,1.25,10,10']);
    const lot = await inOrg(async (db) => {
      const line = await db.pharmacyOpeningStockLine.findFirstOrThrow({
        where: { organizationId: ORG, sessionId: receipt.sessionId },
      });
      return db.pharmacyInventoryLot.findFirstOrThrow({
        where: { organizationId: ORG, id: line.postedLotId! },
      });
    });

    const halfExpiry = await expectRejection((db) =>
      db.pharmacyInventoryLot.update({
        where: { organizationId_id: { organizationId: ORG, id: lot.id } },
        data: { receivedExpiresAt: new Date('2099-06-30T19:00:00.000Z') },
      })
    );
    expect(halfExpiry).toContain('pharmacy_inventory_lots_received_expiry_pair_check');

    const blank = await expectRejection((db) =>
      db.pharmacyManufacturingBatch.update({
        where: { organizationId_id: { organizationId: ORG, id: lot.manufacturingBatchId } },
        data: { batchNumber: '   ' },
      })
    );
    expect(blank).toContain('pharmacy_manufacturing_batches_number_check');
  });
});
