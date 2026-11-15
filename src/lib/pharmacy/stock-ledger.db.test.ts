/**
 * PH-INV / INV-01..04 against migrated PostgreSQL with FORCED row level
 * security.
 *
 * These cases only mean anything against a real database. "On-hand is a
 * projection" is a trigger; "negative stock is impossible" is a CHECK behind
 * that trigger; "the ledger is append-only" is a trigger; "another tenant's
 * lots are invisible" is an RLS predicate; and "concurrent last-unit sales
 * never oversell" is a row lock taken by two genuinely concurrent
 * transactions. A mocked client would assert that the code calls Prisma, not
 * that any of those hold. Skipped (never silently passed) when the database URL
 * is absent.
 *
 * The runtime role is asserted NOSUPERUSER/NOBYPASSRLS first: with either
 * attribute the tenant cases would read straight through every policy and pass
 * for the wrong reason.
 *
 * TWO STRUCTURAL RULES, both learned from this suite failing without them:
 *
 *   1. EVERY TEST GETS ITS OWN MEDICINE (`scenario()`). Allocation candidates
 *      are looked up by medicine, so tests sharing one would allocate each
 *      other's leftover stock and a refusal case could pass by drawing from a
 *      neighbour's lot.
 *   2. AN EXPECTED DATABASE ERROR GETS ITS OWN TRANSACTION. A failed statement
 *      aborts the whole PostgreSQL transaction, so a test that provokes a
 *      trigger and then reads back must do the read from a new one.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  retirePharmacyRegulatoryRules,
  seedPharmacyRegulatoryProfile,
} from '@/lib/test-support/pharmacy-regulatory';

import { PharmacyInventoryError } from './inventory';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_wha1165_a_${suffix}`;
const ORG_B = `org_wha1165_b_${suffix}`;
// A branch id is a primary key, so it is unique across the whole table and not
// only within one organization. Suffix them per run or a second run of this
// suite silently conflicts with the rows the first one left behind.
const BRANCH_A = `branch_a_${suffix}`;
const BRANCH_B = `branch_b_${suffix}`;
const BRANCH_A_TWO = `branch_a_two_${suffix}`;
const BRANCH_A_THREE = `branch_a_three_${suffix}`;
const BRANCH_GUC = `branch_guc_${suffix}`;
const ACTOR = 'user_pharmacist';
const ruleSetIds: string[] = [];

/** Fixed instants, so no case depends on the wall clock. */
const NOW = new Date('2026-09-02T09:00:00.000Z');
const SOON = new Date('2026-10-01T00:00:00.000Z');
const LATER = new Date('2027-10-01T00:00:00.000Z');

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  ledger: typeof import('./stock-ledger');
  operations: typeof import('./inventory-operations');
  drap: typeof import('./drap-monitoring');
};
let deps: Deps;

function inOrg<T>(organizationId: string, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(organizationId, work);
}

/** Distinct per call; several unique constraints key off these. */
let unique = 0;
function tag(label: string) {
  unique += 1;
  return `${suffix}-${label}-${unique}`;
}

type Scenario = {
  organizationId: string;
  branchId: string;
  medicineId: string;
  packLevelId: string;
  locationId: string;
  quarantineLocationId: string;
};

/**
 * PLAT-04: create the branch aggregate this scenario is scoped to, if some
 * earlier scenario in the same organization has not already created it.
 */
async function ensureBranch(db: ScopedDb, organizationId: string, branchId: string) {
  // `createMany`+`skipDuplicates` is ON CONFLICT DO NOTHING: one statement, so
  // two scenarios sharing a branch cannot race between a read and an insert.
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

/**
 * A private MED-01/MED-02 catalog and two branch locations for one test. Runs
 * as a tenant would, so RLS and every CHECK apply to the fixture too.
 */
async function scenario(
  organizationId: string,
  branchId: string,
  label: string
): Promise<Scenario> {
  return inOrg(organizationId, async (db) => {
    // PLAT-04: a branch-owned row now references the branch aggregate, so the
    // fixture has to create the branch before anything scoped to it.
    await ensureBranch(db, organizationId, branchId);
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: `Paracetamol 500mg ${tag(label)}`,
        productFamily: 'PHARMACEUTICAL',
        presentations: { create: { organizationId, presentation: 'Tablet, 10 per strip' } },
      },
      include: { presentations: true },
    });
    const packLevel = await db.packLevel.create({
      data: {
        organizationId,
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `strip-${tag(label)}`,
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    const [location, quarantine] = await Promise.all([
      db.pharmacyStockLocation.create({
        data: {
          organizationId,
          branchId,
          code: `MAIN-${tag(label)}`,
          name: 'Main store',
          kind: 'STORE',
        },
      }),
      db.pharmacyStockLocation.create({
        data: {
          organizationId,
          branchId,
          code: `QUAR-${tag(label)}`,
          name: 'Quarantine cage',
          kind: 'QUARANTINE',
        },
      }),
    ]);
    return {
      organizationId,
      branchId,
      medicineId: medicine.id,
      packLevelId: packLevel.id,
      locationId: location.id,
      quarantineLocationId: quarantine.id,
    };
  });
}

function scopeOf(fixture: Scenario) {
  return {
    organizationId: fixture.organizationId,
    branchId: fixture.branchId,
    actorId: ACTOR,
  };
}

/** One manufacturing batch plus a lot holding `units`, at 10 units per strip. */
async function stockLot(
  db: ScopedDb,
  fixture: Scenario,
  options: {
    expiresAt: Date;
    units: number;
    label: string;
    received?: boolean;
    branchId?: string;
    locationId?: string;
  }
) {
  const batch = await db.pharmacyManufacturingBatch.create({
    data: {
      organizationId: fixture.organizationId,
      medicineId: fixture.medicineId,
      batchNumber: `B-${tag(options.label)}`,
      expiresAt: options.expiresAt,
      expiryPrecision: 'DAY',
    },
  });
  const { lot } = await deps.ledger.receiveLot(
    db,
    { ...scopeOf(fixture), branchId: options.branchId ?? fixture.branchId },
    {
      manufacturingBatchId: batch.id,
      packLevelId: fixture.packLevelId,
      stockLocationId: options.locationId ?? fixture.locationId,
      unitsPerPack: 10,
      supplierName: 'Distributor Ltd',
      supplierInvoiceRef: `INV-${tag(options.label)}`,
      unitCostMinor: 1200,
      printedMrpMinor: 2000,
      receivedExpiresAt: options.expiresAt,
      receivedExpiryPrecision: 'DAY',
      quantityUnits: options.units,
      idempotencyKey: `receipt-${tag(options.label)}`,
      receivedAt: options.received === false ? undefined : new Date('2026-02-01T00:00:00.000Z'),
    }
  );
  return { batch, lot };
}

/** A live regulatory hold, optionally sharing its position with manual stock. */
async function recalledLot(db: ScopedDb, fixture: Scenario, manualUnits = 0) {
  const { batch, lot } = await stockLot(db, fixture, {
    expiresAt: LATER,
    units: 20 + manualUnits,
    label: 'drap-release-guard',
  });
  const moved = await deps.operations.quarantinePart(db, scopeOf(fixture), {
    inventoryLotId: lot.id,
    stockLocationId: fixture.locationId,
    units: 20,
    reason: 'DRAP recall quarantine',
    idempotencyKeyPrefix: tag('drap-release-guard-hold'),
  });
  const recall = await db.pharmacyRecallNotice.create({
    data: {
      organizationId: fixture.organizationId,
      batchId: batch.id,
      reference: tag('drap-recall'),
      reason: 'Regulatory recall',
      createdById: ACTOR,
    },
  });
  const ingest = await db.pharmacyDrapIngest.create({
    data: {
      organizationId: fixture.organizationId,
      sourceReference: tag('drap-source'),
      adapter: 'MANUAL',
      kind: 'RECALL',
      payloadHash: tag('drap-payload'),
      matchStatus: 'MATCHED',
      matchDetails: { batchIds: [batch.id] },
      recallNoticeId: recall.id,
      // DEV-692: a recall ingest that holds a recall notice was confirmed by a person.
      reviewStatus: 'CONFIRMED',
      reviewedById: ACTOR,
      reviewedAt: NOW,
      ingestedById: ACTOR,
    },
  });
  await db.pharmacyRecallQuarantineAction.create({
    data: {
      organizationId: fixture.organizationId,
      ingestId: ingest.id,
      recallNoticeId: recall.id,
      branchId: fixture.branchId,
      inventoryLotId: lot.id,
      stockLocationId: fixture.locationId,
      quantityUnits: 20,
      removedMovementId: moved.removed.id,
      heldMovementId: moved.held.id,
    },
  });
  await db.pharmacyManufacturingBatch.update({
    where: { organizationId_id: { organizationId: fixture.organizationId, id: batch.id } },
    data: { state: 'RECALLED', stateReason: 'Regulatory recall', stateChangedAt: NOW },
  });
  if (manualUnits) {
    await deps.operations.quarantinePart(db, scopeOf(fixture), {
      inventoryLotId: lot.id,
      stockLocationId: fixture.locationId,
      units: manualUnits,
      reason: 'Manual inspection hold',
      idempotencyKeyPrefix: tag('mixed-manual-hold'),
    });
  }
  return { lot, batch, recall };
}

/** Run one statement that is EXPECTED to fail, in its own transaction. */
async function expectRejection(
  organizationId: string,
  work: (db: ScopedDb) => Promise<unknown>
): Promise<string> {
  return inOrg(organizationId, (db) =>
    work(db)
      .then(() => 'ACCEPTED — the statement was expected to fail')
      .catch((error: Error) => error.message)
  );
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, ledger, operations, roleGuard, drap] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./stock-ledger'),
    import('./inventory-operations'),
    import('@/lib/testing/rls-role-guard'),
    import('./drap-monitoring'),
  ]);
  deps = { withTenantDb: scopedDb.withTenantDb, ledger, operations, drap };
  await roleGuard.assertRlsEnforcingRole(scopedDb.withPlatformDb);
}, 120_000);

afterAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
  await retirePharmacyRegulatoryRules(withPlatformDb, ruleSetIds);
});

// ── INV-01 — the append-only ledger and its projection ──────────────────────

describeIfDatabase('PH-INV ledger — INV-01 append-only stock ledger', () => {
  it('projects on-hand and the sealed/open arrangement from the receipt', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'projection');
    const projection = await inOrg(ORG_A, async (db) => {
      // 57 tablets at 10 per strip is the PRD's INV-04 example.
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 57,
        label: 'projection',
      });
      const rows = await deps.ledger.onHand(db, fixture, fixture.medicineId, NOW);
      return rows.find((row) => row.inventoryLotId === lot.id)!;
    });

    expect(projection.onHandUnits).toBe(57);
    expect(projection.sealedPacks).toBe(5);
    expect(projection.looseUnits).toBe(7);
    expect(projection.blockedBy).toBeNull();
  });

  it('refuses to update or delete a posted movement (§8A invariant 8)', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'append-only');
    const movementId = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 10,
        label: 'append-only',
      });
      return (await db.pharmacyStockMovement.findFirst({ where: { inventoryLotId: lot.id } }))!.id;
    });

    const updated = await expectRejection(ORG_A, (db) =>
      db.pharmacyStockMovement.update({
        where: { id: movementId },
        data: { quantityUnits: 9999 },
      })
    );
    const deleted = await expectRejection(ORG_A, (db) =>
      db.pharmacyStockMovement.delete({ where: { id: movementId } })
    );
    const survivor = await inOrg(ORG_A, (db) =>
      db.pharmacyStockMovement.findFirst({ where: { id: movementId } })
    );

    expect(updated).toContain('append-only');
    expect(deleted).toContain('append-only');
    expect(survivor?.quantityUnits).toBe(10);
  });

  it('refuses a balance written directly instead of through the ledger', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'projection-only');
    const lotId = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 10,
        label: 'projection-only',
      });
      return lot.id;
    });

    const inserted = await expectRejection(ORG_A, (db) =>
      db.$executeRawUnsafe(
        `INSERT INTO "pharmacy_stock_balances"
           ("organizationId","branchId","inventoryLotId","stockLocationId","disposition",
            "onHandUnits","sealedPacks","looseUnits","updatedAt")
         VALUES ($1,$2,$3,$4,'DAMAGED',5,0,5,CURRENT_TIMESTAMP)`,
        ORG_A,
        BRANCH_A,
        lotId,
        fixture.locationId
      )
    );
    const updated = await expectRejection(ORG_A, (db) =>
      db.$executeRawUnsafe(
        `UPDATE "pharmacy_stock_balances" SET "onHandUnits" = 9999 WHERE "inventoryLotId" = $1`,
        lotId
      )
    );
    const balance = await inOrg(ORG_A, (db) =>
      db.pharmacyStockBalance.findFirst({
        where: { inventoryLotId: lotId, disposition: 'AVAILABLE' },
      })
    );

    expect(inserted).toContain('projection of the ledger');
    expect(updated).toContain('projection of the ledger');
    expect(balance?.onHandUnits).toBe(10);
  });

  it('stamps the pack conversion as referenced, freezing it (MED-02)', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'freeze');
    const before = await inOrg(ORG_A, (db) =>
      db.packLevel.findFirst({ where: { id: fixture.packLevelId } })
    );
    const after = await inOrg(ORG_A, async (db) => {
      await stockLot(db, fixture, { expiresAt: LATER, units: 10, label: 'freeze' });
      return db.packLevel.findFirst({ where: { id: fixture.packLevelId } });
    });

    expect(before?.referencedAt).toBeNull();
    expect(after?.referencedAt).not.toBeNull();
  });

  it('refuses a movement whose arrangement does not reconcile to its units', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'reconcile');
    const lotId = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 20,
        label: 'reconcile',
      });
      return lot.id;
    });

    const message = await expectRejection(ORG_A, (db) =>
      db.pharmacyStockMovement.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          inventoryLotId: lotId,
          stockLocationId: fixture.locationId,
          kind: 'ADJUSTMENT',
          disposition: 'AVAILABLE',
          // 3 sealed strips of 10 is 30 units, not 10.
          quantityUnits: 10,
          sealedPackDelta: 3,
          looseUnitDelta: 0,
          actorId: ACTOR,
          idempotencyKey: tag('bad-arrangement'),
        },
      })
    );
    expect(message).toContain('reconcile');
  });
});

describeIfDatabase('PH-INV operations — INV-06/07/08/09', () => {
  it('requires a second actor above the count variance threshold and posts the adjustment once approved', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'count-coauth');
    const count = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 40,
        label: 'count-coauth',
      });
      return deps.operations.createCount(db, scopeOf(fixture), {
        varianceThreshold: 2,
        readings: [
          {
            inventoryLotId: lot.id,
            stockLocationId: fixture.locationId,
            countedSealedPacks: 3,
            countedLooseUnits: 5,
          },
        ],
      });
    });
    expect(count.status).toBe('AWAITING_COAUTH');
    await expect(
      inOrg(ORG_A, (db) =>
        deps.operations.approveCount(
          db,
          scopeOf(fixture),
          count.id,
          tag('same-actor'),
          'Shelf recount'
        )
      )
    ).rejects.toMatchObject({ reason: 'COAUTH_REQUIRED' });
    const result = await inOrg(ORG_A, async (db) => {
      const approved = await deps.operations.approveCount(
        db,
        { ...scopeOf(fixture), actorId: 'user_second_pharmacist' },
        count.id,
        tag('coauth'),
        'Shelf recount'
      );
      const line = count.lines[0]!;
      const balance = await db.pharmacyStockBalance.findFirst({
        where: { inventoryLotId: line.inventoryLotId, disposition: 'AVAILABLE' },
      });
      return { approved, balance };
    });
    expect(result.approved.status).toBe('APPROVED');
    expect(result.balance?.onHandUnits).toBe(35);
  });

  it('serializes count approvals with different idempotency prefixes', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'count-approval-race');
    const count = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 40,
        label: 'count-approval-race',
      });
      return deps.operations.createCount(db, scopeOf(fixture), {
        varianceThreshold: 10,
        readings: [
          {
            inventoryLotId: lot.id,
            stockLocationId: fixture.locationId,
            countedSealedPacks: 3,
            countedLooseUnits: 5,
          },
        ],
      });
    });

    let releaseFirst: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalFirstApproved: () => void = () => {};
    const firstApproved = new Promise<void>((resolve) => {
      signalFirstApproved = resolve;
    });
    const first = inOrg(ORG_A, async (db) => {
      const approved = await deps.operations.approveCount(
        db,
        scopeOf(fixture),
        count.id,
        tag('count-race-first'),
        'Shelf recount'
      );
      signalFirstApproved();
      await held;
      return approved;
    });
    await firstApproved;

    const second = inOrg(ORG_A, (db) =>
      deps.operations.approveCount(
        db,
        scopeOf(fixture),
        count.id,
        tag('count-race-second'),
        'Shelf recount'
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    releaseFirst();

    const [firstOutcome, secondOutcome] = await Promise.allSettled([first, second]);
    expect(firstOutcome.status).toBe('fulfilled');
    expect(secondOutcome.status).toBe('rejected');
    const rejection = (secondOutcome as PromiseRejectedResult).reason;
    expect(rejection).toBeInstanceOf(PharmacyInventoryError);
    expect(rejection.reason).toBe('INVALID_STATE');

    const line = count.lines[0]!;
    const after = await inOrg(ORG_A, async (db) => ({
      balance: await db.pharmacyStockBalance.findFirst({
        where: { inventoryLotId: line.inventoryLotId, disposition: 'AVAILABLE' },
      }),
      adjustments: await db.pharmacyStockMovement.count({
        where: {
          inventoryLotId: line.inventoryLotId,
          kind: 'ADJUSTMENT',
          reason: `Inventory count ${count.id}`,
        },
      }),
    }));
    expect(after.balance?.onHandUnits).toBe(35);
    expect(after.adjustments).toBe(1);
  });

  it('quarantines only part of a lot and keeps the remainder available', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'partial-quarantine');
    const balances = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 40,
        label: 'partial-quarantine',
      });
      await deps.operations.quarantinePart(db, scopeOf(fixture), {
        inventoryLotId: lot.id,
        stockLocationId: fixture.locationId,
        units: 10,
        reason: 'Damaged carton inspection',
        idempotencyKeyPrefix: tag('partial-quarantine'),
      });
      return db.pharmacyStockBalance.findMany({
        where: { inventoryLotId: lot.id },
        orderBy: { disposition: 'asc' },
      });
    });
    expect(balances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ disposition: 'AVAILABLE', onHandUnits: 30 }),
        expect.objectContaining({ disposition: 'QUARANTINE', onHandUnits: 10 }),
      ])
    );
  });

  it('writes quarantined stock off with custody evidence', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'quarantine-write-off');
    const result = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 20,
        label: 'quarantine-write-off',
      });
      await deps.operations.quarantinePart(db, scopeOf(fixture), {
        inventoryLotId: lot.id,
        stockLocationId: fixture.locationId,
        units: 10,
        reason: 'Manual recall hold',
        idempotencyKeyPrefix: tag('quarantine-write-off-hold'),
      });
      const written = await deps.operations.writeOff(db, scopeOf(fixture), {
        inventoryLotId: lot.id,
        stockLocationId: fixture.locationId,
        units: 10,
        disposition: 'QUARANTINE',
        witnessId: 'user_witness',
        reason: 'Recall destruction',
        evidenceRef: 'destruction-certificate-1',
        idempotencyKey: tag('quarantine-write-off-destroy'),
      });
      const balances = await db.pharmacyStockBalance.findMany({
        where: { inventoryLotId: lot.id },
      });
      return { written, balances };
    });
    expect(result.written.movement).toMatchObject({
      disposition: 'QUARANTINE',
      kind: 'WRITE_OFF',
      quantityUnits: -10,
    });
    expect(result.written.custody).toMatchObject({
      witnessId: 'user_witness',
      evidenceRef: 'destruction-certificate-1',
    });
    expect(result.balances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ disposition: 'AVAILABLE', onHandUnits: 10 }),
        expect.objectContaining({ disposition: 'QUARANTINE', onHandUnits: 0 }),
      ])
    );
  });

  it('releases manually quarantined stock back to available', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'quarantine-release');
    const balances = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 20,
        label: 'quarantine-release',
      });
      await deps.operations.quarantinePart(db, scopeOf(fixture), {
        inventoryLotId: lot.id,
        stockLocationId: fixture.locationId,
        units: 10,
        reason: 'Inspection hold',
        idempotencyKeyPrefix: tag('quarantine-release-hold'),
      });
      await deps.operations.releaseQuarantinedPart(db, scopeOf(fixture), {
        inventoryLotId: lot.id,
        stockLocationId: fixture.locationId,
        units: 10,
        reason: 'Inspection passed',
        idempotencyKeyPrefix: tag('quarantine-release-clear'),
      });
      return db.pharmacyStockBalance.findMany({ where: { inventoryLotId: lot.id } });
    });
    expect(balances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ disposition: 'AVAILABLE', onHandUnits: 20 }),
        expect.objectContaining({ disposition: 'QUARANTINE', onHandUnits: 0 }),
      ])
    );
  });

  it.each(['release', 'write-off'] as const)(
    'does not %s units reserved by a live DRAP recall quarantine',
    async (operation) => {
      const fixture = await scenario(ORG_A, BRANCH_A, 'drap-release-guard');
      const result = await inOrg(ORG_A, async (db) => {
        const { lot } = await recalledLot(db, fixture);

        const input = {
          inventoryLotId: lot.id,
          stockLocationId: fixture.locationId,
          units: operation === 'release' ? 1 : 10,
          reason: 'Inventory-only bypass attempt',
          idempotencyKeyPrefix: tag('drap-release-guard-attempt'),
        };
        const refusal = await (
          operation === 'release'
            ? deps.operations.releaseQuarantinedPart(db, scopeOf(fixture), input)
            : deps.operations.writeOff(db, scopeOf(fixture), {
                ...input,
                disposition: 'QUARANTINE',
                witnessId: 'user_witness',
                evidenceRef: 'destruction-certificate',
                idempotencyKey: tag('drap-write-off-guard-attempt'),
              })
        )
          .then(() => null)
          .catch((error: PharmacyInventoryError) => error.reason);
        const balances = await db.pharmacyStockBalance.findMany({
          where: { organizationId: ORG_A, inventoryLotId: lot.id },
        });
        return { refusal, balances };
      });

      expect(result.refusal).toBe('INSUFFICIENT_STOCK');
      expect(result.balances).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ disposition: 'AVAILABLE', onHandUnits: 0 }),
          expect.objectContaining({ disposition: 'QUARANTINE', onHandUnits: 20 }),
        ])
      );
    }
  );

  it.each([
    ['release', 'sealed'],
    ['write-off', 'sealed'],
    ['release', 'loose'],
    ['write-off', 'loose'],
  ] as const)(
    'keeps a DRAP recall reversible after manual %s of %s stock',
    async (operation, manualArrangement) => {
      const { confirmDrapRecall, ingestDrapNotice, reverseRecallQuarantine } =
        await import('./drap-monitoring');
      const fixture = await scenario(ORG_A, BRANCH_A, 'mixed-recall-arrangement');
      const scope = scopeOf(fixture);
      const { lot, recallId } = await inOrg(ORG_A, async (db) => {
        const { lot } = await stockLot(db, fixture, {
          expiresAt: LATER,
          units: 30,
          label: 'mixed-recall-arrangement',
        });
        const position = { inventoryLotId: lot.id, stockLocationId: fixture.locationId };
        if (manualArrangement === 'loose') {
          await deps.ledger.breakPack(db, scope, {
            ...position,
            requiredLooseUnits: 10,
            idempotencyKey: tag('manual-loose-pack'),
            at: NOW,
          });
        }
        await deps.operations.quarantinePart(db, scope, {
          ...position,
          units: 10,
          reason: 'Manual inspection hold',
          idempotencyKeyPrefix: tag('manual-arrangement-hold'),
        });
        if (manualArrangement === 'sealed') {
          await deps.ledger.breakPack(db, scope, {
            ...position,
            requiredLooseUnits: 20,
            idempotencyKey: tag('recall-loose-packs'),
            at: NOW,
          });
        }
        const registration = tag('mixed-recall-registration');
        await db.medicine.update({
          where: { id: fixture.medicineId },
          data: { drapRegistrationNumber: registration },
        });
        const draft = await ingestDrapNotice(db, scope, 'MANUAL', {
          kind: 'RECALL',
          sourceReference: tag('mixed-arrangement-recall'),
          drapRegistrationNumber: registration,
          reason: 'Regulatory recall',
        });
        // DEV-692: nothing is quarantined until a person confirms the draft.
        expect(
          await db.pharmacyRecallQuarantineAction.count({ where: { ingestId: draft.id } })
        ).toBe(0);
        const ingest = await confirmDrapRecall(db, scope, draft.id);
        const action = await db.pharmacyRecallQuarantineAction.findFirstOrThrow({
          where: { ingestId: ingest.id },
        });
        expect(action.quantityUnits).toBe(20);
        return { lot, recallId: action.recallNoticeId };
      });

      await inOrg(ORG_A, async (db) => {
        const input = {
          inventoryLotId: lot.id,
          stockLocationId: fixture.locationId,
          units: 10,
          reason: 'Resolve manual inspection hold',
        };
        const result =
          operation === 'release'
            ? await deps.operations.releaseQuarantinedPart(db, scope, {
                ...input,
                idempotencyKeyPrefix: tag('manual-arrangement-release'),
              })
            : await deps.operations.writeOff(db, scope, {
                ...input,
                disposition: 'QUARANTINE',
                witnessId: 'user_witness',
                evidenceRef: 'destruction-certificate',
                idempotencyKey: tag('manual-arrangement-write-off'),
              });
        expect('removed' in result ? result.removed : result.movement).toMatchObject({
          quantityUnits: -10,
          sealedPackDelta: manualArrangement === 'sealed' ? -1 : 0,
          looseUnitDelta: manualArrangement === 'loose' ? -10 : 0,
        });
        expect(
          await db.pharmacyStockBalance.findFirst({
            where: { inventoryLotId: lot.id, disposition: 'QUARANTINE' },
          })
        ).toMatchObject({
          onHandUnits: 20,
          sealedPacks: manualArrangement === 'sealed' ? 0 : 2,
          looseUnits: manualArrangement === 'sealed' ? 20 : 0,
        });
      });

      // Reverse in a new transaction to exercise the persisted stock arrangement.
      await inOrg(ORG_A, async (db) => {
        expect(
          await reverseRecallQuarantine(db, scope, recallId, 'Regulatory clearance')
        ).toMatchObject({ status: 'CLOSED' });
        expect(
          await db.pharmacyStockBalance.findFirst({
            where: { inventoryLotId: lot.id, disposition: 'AVAILABLE' },
          })
        ).toMatchObject({ onHandUnits: operation === 'release' ? 30 : 20 });
        expect(
          await db.pharmacyStockBalance.findFirst({
            where: { inventoryLotId: lot.id, disposition: 'QUARANTINE' },
          })
        ).toMatchObject({ onHandUnits: 0, sealedPacks: 0, looseUnits: 0 });
        expect(
          await db.pharmacyRecallQuarantineAction.findFirst({ where: { recallNoticeId: recallId } })
        ).toMatchObject({ reversedById: ACTOR, reversedAt: expect.any(Date) });
      });
    }
  );

  it.each(['release', 'write-off'] as const)(
    'preserves the recall reserve during a concurrent manual release and %s',
    async (operation) => {
      const fixture = await scenario(ORG_A, BRANCH_A, 'mixed-quarantine-race');
      const { lot, recall } = await inOrg(ORG_A, (db) => recalledLot(db, fixture, 10));
      const input = {
        inventoryLotId: lot.id,
        stockLocationId: fixture.locationId,
        units: 10,
        reason: 'Manual inspection cleared',
      };
      let releaseFirst = () => {};
      const held = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstPosted = () => {};
      const posted = new Promise<void>((resolve) => {
        firstPosted = resolve;
      });
      const first = inOrg(ORG_A, async (db) => {
        await deps.operations.releaseQuarantinedPart(db, scopeOf(fixture), {
          ...input,
          idempotencyKeyPrefix: tag('mixed-release-first'),
        });
        firstPosted();
        await held;
      });
      // Propagate setup failures instead of leaving a pending barrier.
      await Promise.race([posted, first]);
      let secondPid = 0;
      let secondStarted = () => {};
      const started = new Promise<void>((resolve) => {
        secondStarted = resolve;
      });
      const second = inOrg(ORG_A, async (db) => {
        const [connection] = await db.$queryRawUnsafe<{ pid: number }[]>(
          'SELECT pg_backend_pid() AS pid'
        );
        secondPid = connection!.pid;
        secondStarted();
        return operation === 'release'
          ? deps.operations.releaseQuarantinedPart(db, scopeOf(fixture), {
              ...input,
              idempotencyKeyPrefix: tag('mixed-release-second'),
            })
          : deps.operations.writeOff(db, scopeOf(fixture), {
              ...input,
              disposition: 'QUARANTINE',
              witnessId: 'user_witness',
              evidenceRef: 'destruction-certificate',
              idempotencyKey: tag('mixed-write-off-second'),
            });
      });
      // Attach the rejection handler before unblocking either transaction.
      const outcomes = Promise.allSettled([first, second]);
      let blocked = false;
      try {
        await Promise.race([started, second]);
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const [connection] = await inOrg(ORG_A, (db) =>
            db.$queryRawUnsafe<{ waiting: boolean }[]>(
              `SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1`,
              secondPid
            )
          );
          if (connection?.waiting) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        releaseFirst();
      }
      const [firstOutcome, secondOutcome] = await outcomes;
      expect(blocked).toBe(true);
      expect(firstOutcome.status).toBe('fulfilled');
      expect(secondOutcome).toMatchObject({
        status: 'rejected',
        reason: { reason: 'INSUFFICIENT_STOCK' },
      });
      await inOrg(ORG_A, async (db) => {
        expect(
          await db.pharmacyStockBalance.findFirst({
            where: { inventoryLotId: lot.id, disposition: 'QUARANTINE' },
          })
        ).toMatchObject({ onHandUnits: 20 });
        expect(
          await db.pharmacyRecallQuarantineAction.findFirst({
            where: { recallNoticeId: recall.id },
          })
        ).toMatchObject({ reversedAt: null, quantityUnits: 20 });
        // A legitimate safety reversal still reconciles its full original pair.
        const { reverseRecallQuarantine } = await import('./drap-monitoring');
        await reverseRecallQuarantine(db, scopeOf(fixture), recall.id, 'Regulatory clearance');
        expect(
          await db.pharmacyStockBalance.findFirst({
            where: { inventoryLotId: lot.id, disposition: 'AVAILABLE' },
          })
        ).toMatchObject({ onHandUnits: 30 });
        expect(
          await db.pharmacyRecallQuarantineAction.findFirst({
            where: { recallNoticeId: recall.id },
          })
        ).toMatchObject({ reversedById: ACTOR, reversalReason: 'Regulatory clearance' });
      });
    }
  );

  it.each(['tenant', 'branch', 'location'] as const)(
    'rejects manual quarantine release across the %s boundary without moving stock',
    async (boundary) => {
      const fixture = await scenario(ORG_A, BRANCH_A, 'release-scope');
      const foreign = await scenario(ORG_B, BRANCH_B, 'release-scope-foreign');
      const { lot } = await inOrg(ORG_A, async (db) => {
        const result = await stockLot(db, fixture, {
          expiresAt: LATER,
          units: 10,
          label: 'release-scope',
        });
        await deps.operations.quarantinePart(db, scopeOf(fixture), {
          inventoryLotId: result.lot.id,
          stockLocationId: fixture.locationId,
          units: 10,
          reason: 'Manual hold',
          idempotencyKeyPrefix: tag('release-scope-hold'),
        });
        return result;
      });
      const scope =
        boundary === 'tenant'
          ? scopeOf(foreign)
          : { ...scopeOf(fixture), branchId: boundary === 'branch' ? BRANCH_A_TWO : BRANCH_A };
      await expect(
        inOrg(scope.organizationId, (db) =>
          deps.operations.releaseQuarantinedPart(db, scope, {
            inventoryLotId: lot.id,
            stockLocationId: boundary === 'location' ? foreign.locationId : fixture.locationId,
            units: 10,
            reason: 'Substituted reference',
            idempotencyKeyPrefix: tag('release-scope-attempt'),
          })
        )
      ).rejects.toMatchObject({
        reason: boundary === 'location' ? 'INSUFFICIENT_STOCK' : 'CROSS_BRANCH_REFERENCE',
      });
      await inOrg(ORG_A, async (db) => {
        expect(
          await db.pharmacyStockBalance.findFirst({
            where: { inventoryLotId: lot.id, disposition: 'QUARANTINE' },
          })
        ).toMatchObject({ onHandUnits: 10 });
        expect(await db.pharmacyStockMovement.count({ where: { inventoryLotId: lot.id } })).toBe(3);
      });
    }
  );

  it('dispatches into transit, records a batch receipt discrepancy, and enforces destination branch scope', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'transfer-workflow');
    const destinationBranch = `branch_transfer_destination_${suffix}`;
    const setup = await inOrg(ORG_A, async (db) => {
      await ensureBranch(db, ORG_A, destinationBranch);
      const destination = await db.pharmacyStockLocation.create({
        data: {
          organizationId: ORG_A,
          branchId: destinationBranch,
          code: `DEST-${tag('transfer')}`,
          name: 'Destination branch',
          kind: 'STORE',
        },
      });
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 40,
        label: 'transfer-workflow',
      });
      const transfer = await deps.operations.allocateTransfer(db, scopeOf(fixture), {
        toBranchId: destinationBranch,
        lines: [
          {
            sourceLotId: lot.id,
            sourceStockLocationId: fixture.locationId,
            destinationStockLocationId: destination.id,
            quantityUnits: 30,
          },
        ],
      });
      await deps.operations.approveTransfer(
        db,
        { ...scopeOf(fixture), actorId: 'transfer_approver' },
        transfer.id
      );
      await deps.operations.dispatchTransfer(db, scopeOf(fixture), transfer.id, tag('dispatch'));
      return { transferId: transfer.id, lineId: transfer.lines[0]!.id, lotId: lot.id };
    });
    const dispatched = await inOrg(ORG_A, (db) =>
      db.pharmacyStockBalance.findMany({ where: { inventoryLotId: setup.lotId } })
    );
    expect(dispatched).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ disposition: 'AVAILABLE', onHandUnits: 10 }),
        expect.objectContaining({ disposition: 'IN_TRANSIT', onHandUnits: 30 }),
      ])
    );
    const received = await inOrg(ORG_A, (db) =>
      deps.operations.receiveTransferLine(
        db,
        { organizationId: ORG_A, branchId: destinationBranch, actorId: 'receiver' },
        {
          transferId: setup.transferId,
          lineId: setup.lineId,
          receivedUnits: 20,
          idempotencyKeyPrefix: tag('receive'),
        }
      )
    );
    expect(received.status).toBe('EXCEPTION');
    await expect(
      inOrg(ORG_A, (db) =>
        deps.operations.receiveTransferLine(
          db,
          { organizationId: ORG_A, branchId: 'wrong_destination', actorId: 'receiver' },
          {
            transferId: setup.transferId,
            lineId: setup.lineId,
            receivedUnits: 10,
            idempotencyKeyPrefix: tag('wrong-branch'),
          }
        )
      )
    ).rejects.toMatchObject({ reason: 'CROSS_BRANCH_REFERENCE' });
  });

  it('serializes competing dispatches so the same units cannot leave twice', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'transfer-race');
    const ids = await inOrg(ORG_A, async (db) => {
      await ensureBranch(db, ORG_A, `branch_race_destination_${suffix}`);
      const destination = await db.pharmacyStockLocation.create({
        data: {
          organizationId: ORG_A,
          branchId: `branch_race_destination_${suffix}`,
          code: `RACE-${tag('destination')}`,
          name: 'Race destination',
          kind: 'STORE',
        },
      });
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 40,
        label: 'transfer-race',
      });
      const make = async (label: string) => {
        const transfer = await deps.operations.allocateTransfer(db, scopeOf(fixture), {
          toBranchId: destination.branchId,
          lines: [
            {
              sourceLotId: lot.id,
              sourceStockLocationId: fixture.locationId,
              destinationStockLocationId: destination.id,
              quantityUnits: 30,
            },
          ],
        });
        await deps.operations.approveTransfer(
          db,
          { ...scopeOf(fixture), actorId: `approver_${label}` },
          transfer.id
        );
        return transfer.id;
      };
      return { lotId: lot.id, transfers: [await make('a'), await make('b')] };
    });
    const results = await Promise.allSettled(
      ids.transfers.map((transferId, index) =>
        inOrg(ORG_A, (db) =>
          deps.operations.dispatchTransfer(db, scopeOf(fixture), transferId, tag(`race-${index}`))
        )
      )
    );
    expect(results.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((one) => one.status === 'rejected')).toHaveLength(1);
    const balances = await inOrg(ORG_A, (db) =>
      db.pharmacyStockBalance.findMany({ where: { inventoryLotId: ids.lotId } })
    );
    expect(balances.reduce((sum, row) => sum + row.onHandUnits, 0)).toBe(40);
    expect(balances.find((row) => row.disposition === 'AVAILABLE')?.onHandUnits).toBe(10);
  });

  it('globally recalls a batch, traces branch holdings, acknowledges, and reconciles closure', async () => {
    const a = await scenario(ORG_A, BRANCH_A, 'recall-a');
    const otherBranch = `branch_recall_b_${suffix}`;
    const setup = await inOrg(ORG_A, async (db) => {
      await ensureBranch(db, ORG_A, otherBranch);
      const destination = await db.pharmacyStockLocation.create({
        data: {
          organizationId: ORG_A,
          branchId: otherBranch,
          code: `RECALL-${tag('b')}`,
          name: 'Recall branch B',
          kind: 'STORE',
        },
      });
      const first = await stockLot(db, a, {
        expiresAt: LATER,
        units: 20,
        label: 'recall-global-a',
      });
      const second = await deps.ledger.receiveLot(
        db,
        { ...scopeOf(a), branchId: otherBranch },
        {
          manufacturingBatchId: first.batch.id,
          packLevelId: a.packLevelId,
          stockLocationId: destination.id,
          unitsPerPack: 10,
          supplierName: 'Other distributor',
          supplierInvoiceRef: tag('recall-b'),
          unitCostMinor: 100,
          printedMrpMinor: 200,
          receivedExpiresAt: LATER,
          receivedExpiryPrecision: 'DAY',
          quantityUnits: 10,
          idempotencyKey: tag('recall-receipt'),
          receivedAt: NOW,
        }
      );
      const notice = await deps.operations.createRecall(
        db,
        { organizationId: ORG_A, actorId: ACTOR },
        {
          batchId: first.batch.id,
          reference: tag('manual-recall'),
          reason: 'Manual regulator notice',
        }
      );
      return { notice, medicineId: a.medicineId, secondLotId: second.lot.id };
    });
    const trace = await inOrg(ORG_A, (db) =>
      deps.operations.recallTrace(db, ORG_A, setup.notice.id)
    );
    expect(new Set(trace.map((row) => row.branchId))).toEqual(new Set([BRANCH_A, otherBranch]));
    await expect(
      inOrg(ORG_A, (db) =>
        deps.ledger.allocateForSale(
          db,
          { ...scopeOf(a), branchId: otherBranch },
          {
            medicineId: setup.medicineId,
            requiredUnits: 1,
            at: NOW,
            idempotencyKeyPrefix: tag('recalled-sale'),
          }
        )
      )
    ).rejects.toMatchObject({ reason: 'BLOCKED_STOCK' });
    await inOrg(ORG_A, async (db) => {
      await deps.operations.acknowledgeRecall(db, scopeOf(a), setup.notice.id);
      await expect(
        deps.operations.closeRecall(db, { organizationId: ORG_A, actorId: ACTOR }, setup.notice.id)
      ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
      await deps.operations.acknowledgeRecall(
        db,
        { ...scopeOf(a), branchId: otherBranch },
        setup.notice.id
      );
      await deps.operations.closeRecall(
        db,
        { organizationId: ORG_A, actorId: ACTOR },
        setup.notice.id
      );
      const lot = await db.pharmacyInventoryLot.findFirstOrThrow({
        where: { id: setup.secondLotId },
        include: { batch: true },
      });
      expect(lot.batch.state).toBe('ACTIVE');
    });
  });

  it.each(['batch', 'medicine'] as const)(
    'rejects branch-scoped closure of a %s recall without hiding missing acknowledgements',
    async (target) => {
      const fixture = await scenario(ORG_A, BRANCH_A, 'recall-closure-scope');
      const { batch, notice } = await inOrg(ORG_A, async (db) => {
        const { batch } = await stockLot(db, fixture, {
          expiresAt: LATER,
          units: 10,
          label: 'recall-closure-scope',
        });
        await ensureBranch(db, ORG_A, BRANCH_A_TWO);
        const location = await db.pharmacyStockLocation.create({
          data: {
            organizationId: ORG_A,
            branchId: BRANCH_A_TWO,
            code: tag('recall-closure-scope'),
            name: 'Second branch store',
            kind: 'STORE',
          },
        });
        await deps.ledger.receiveLot(
          db,
          { ...scopeOf(fixture), branchId: BRANCH_A_TWO },
          {
            manufacturingBatchId: batch.id,
            packLevelId: fixture.packLevelId,
            stockLocationId: location.id,
            unitsPerPack: 10,
            supplierName: 'Distributor Ltd',
            supplierInvoiceRef: tag('recall-closure-scope'),
            unitCostMinor: 1200,
            printedMrpMinor: 2000,
            receivedExpiresAt: LATER,
            receivedExpiryPrecision: 'DAY',
            quantityUnits: 10,
            idempotencyKey: tag('recall-closure-scope'),
            receivedAt: NOW,
          }
        );
        const notice = await deps.operations.createRecall(db, scopeOf(fixture), {
          ...(target === 'batch' ? { batchId: batch.id } : { medicineId: fixture.medicineId }),
          reference: tag('recall-closure-scope'),
          reason: 'Both branches must acknowledge',
        });
        await deps.operations.acknowledgeRecall(db, scopeOf(fixture), notice.id);
        return { batch, notice };
      });
      await inOrg(ORG_A, async (db) => {
        await db.$queryRawUnsafe("SELECT set_config('app.current_branch_id', $1, true)", BRANCH_A);
        await expect(
          deps.operations.closeRecall(db, scopeOf(fixture), notice.id)
        ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
        const [binding] = await db.$queryRawUnsafe<Array<{ branchId: string }>>(
          'SELECT current_setting(\'app.current_branch_id\', true) AS "branchId"'
        );
        expect(binding.branchId).toBe(BRANCH_A);
      });
      await inOrg(ORG_A, async (db) => {
        expect(
          await db.pharmacyRecallNotice.findFirstOrThrow({ where: { id: notice.id } })
        ).toMatchObject({ status: 'OPEN' });
        expect(
          await db.pharmacyManufacturingBatch.findFirstOrThrow({ where: { id: batch.id } })
        ).toMatchObject({ state: 'RECALLED' });
        // An organization-wide attempt must still see the missing acknowledgement.
        await expect(
          deps.operations.closeRecall(db, scopeOf(fixture), notice.id)
        ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
        await deps.operations.acknowledgeRecall(
          db,
          { ...scopeOf(fixture), branchId: BRANCH_A_TWO },
          notice.id
        );
        await expect(
          deps.operations.closeRecall(db, scopeOf(fixture), notice.id)
        ).resolves.toMatchObject({ status: 'CLOSED' });
      });
    }
  );

  it.each(['batch', 'medicine'] as const)(
    'closes a %s recall raised before any inventory lots exist',
    async (target) => {
      const fixture = await scenario(ORG_A, BRANCH_A, 'recall-before-receipt');
      const { batch, notice } = await inOrg(ORG_A, async (db) => {
        const batch = await db.pharmacyManufacturingBatch.create({
          data: {
            organizationId: ORG_A,
            medicineId: fixture.medicineId,
            batchNumber: tag('recall-before-receipt'),
            expiresAt: LATER,
            expiryPrecision: 'DAY',
          },
        });
        const notice = await deps.operations.createRecall(db, scopeOf(fixture), {
          ...(target === 'batch' ? { batchId: batch.id } : { medicineId: fixture.medicineId }),
          reference: tag('recall-before-receipt'),
          reason: 'Recall registered before receipt',
        });
        return { batch, notice };
      });
      await inOrg(ORG_A, async (db) => {
        expect(
          await db.pharmacyInventoryLot.count({ where: { manufacturingBatchId: batch.id } })
        ).toBe(0);
        await expect(
          deps.operations.closeRecall(db, scopeOf(fixture), notice.id)
        ).resolves.toMatchObject({ status: 'CLOSED', closedById: ACTOR });
        expect(
          await db.pharmacyManufacturingBatch.findFirstOrThrow({ where: { id: batch.id } })
        ).toMatchObject({ state: 'ACTIVE' });
        expect(
          await db.pharmacyRecallAcknowledgement.count({ where: { recallNoticeId: notice.id } })
        ).toBe(0);
      });
      await expect(
        inOrg(ORG_A, (db) => deps.operations.acknowledgeRecall(db, scopeOf(fixture), notice.id))
      ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    }
  );

  it('refuses recall acknowledgements from unaffected branches and after closure', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'recall-ack-scope');
    const otherBranch = `branch_unaffected_${suffix}`;
    const notice = await inOrg(ORG_A, async (db) => {
      await ensureBranch(db, ORG_A, otherBranch);
      const { batch } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 10,
        label: 'recall-ack-scope',
      });
      return deps.operations.createRecall(
        db,
        { organizationId: ORG_A, actorId: ACTOR },
        { batchId: batch.id, reference: tag('ack-scope'), reason: 'Recall acknowledgement test' }
      );
    });
    await expect(
      inOrg(ORG_A, (db) =>
        deps.operations.acknowledgeRecall(
          db,
          { ...scopeOf(fixture), branchId: otherBranch },
          notice.id
        )
      )
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
    await inOrg(ORG_A, async (db) => {
      await deps.operations.acknowledgeRecall(db, scopeOf(fixture), notice.id);
      await deps.operations.closeRecall(db, { organizationId: ORG_A, actorId: ACTOR }, notice.id);
    });
    await expect(
      inOrg(ORG_A, (db) => deps.operations.acknowledgeRecall(db, scopeOf(fixture), notice.id))
    ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
  });

  it('keeps a batch recalled when closure races a newer recall for that batch', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'recall-close-create-race');
    const setup = await inOrg(ORG_A, async (db) => {
      const { batch } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 10,
        label: 'recall-close-create-race',
      });
      const notice = await deps.operations.createRecall(
        db,
        { organizationId: ORG_A, actorId: ACTOR },
        { batchId: batch.id, reference: tag('older-recall'), reason: 'Older recall' }
      );
      await deps.operations.acknowledgeRecall(db, scopeOf(fixture), notice.id);
      return { batchId: batch.id, noticeId: notice.id };
    });
    let releaseNewRecall: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseNewRecall = resolve;
    });
    const newerRecall = inOrg(ORG_A, async (db) => {
      const notice = await deps.operations.createRecall(
        db,
        { organizationId: ORG_A, actorId: ACTOR },
        { batchId: setup.batchId, reference: tag('newer-recall'), reason: 'Newer recall' }
      );
      await held;
      return notice;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const closure = inOrg(ORG_A, (db) =>
      deps.operations.closeRecall(db, { organizationId: ORG_A, actorId: ACTOR }, setup.noticeId)
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    releaseNewRecall();
    await expect(newerRecall).resolves.toMatchObject({ status: 'OPEN' });
    await expect(closure).resolves.toMatchObject({ status: 'CLOSED' });
    const state = await inOrg(ORG_A, (db) =>
      db.pharmacyManufacturingBatch.findFirstOrThrow({ where: { id: setup.batchId } })
    );
    expect(state.state).toBe('RECALLED');
  });

  it('serializes acknowledgement against concurrent recall closure', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'recall-ack-close-race');
    const notice = await inOrg(ORG_A, async (db) => {
      const { batch } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 10,
        label: 'recall-ack-close-race',
      });
      return deps.operations.createRecall(
        db,
        { organizationId: ORG_A, actorId: ACTOR },
        { batchId: batch.id, reference: tag('ack-close-race'), reason: 'Concurrent close' }
      );
    });
    let releaseAcknowledgement: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseAcknowledgement = resolve;
    });
    const acknowledgement = inOrg(ORG_A, async (db) => {
      const result = await deps.operations.acknowledgeRecall(db, scopeOf(fixture), notice.id);
      await held;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    let closureSettled = false;
    const closure = inOrg(ORG_A, (db) =>
      deps.operations.closeRecall(db, { organizationId: ORG_A, actorId: ACTOR }, notice.id)
    ).finally(() => {
      closureSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(closureSettled).toBe(false);
    releaseAcknowledgement();
    await expect(acknowledgement).resolves.toMatchObject({ recallNoticeId: notice.id });
    await expect(closure).resolves.toMatchObject({ status: 'CLOSED' });
  });

  it.each(['before', 'after'] as const)(
    'closes a disposed recall when the branch acknowledges %s disposal',
    async (acknowledgementOrder) => {
      const fixture = await scenario(ORG_A, BRANCH_A, 'disposed-recall');
      const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
      await withPlatformDb((db) =>
        db.organization.createMany({
          data: [
            { id: ORG_A, slug: ORG_A, legalName: 'Recall tests', displayName: 'Recall tests' },
          ],
          skipDuplicates: true,
        })
      );
      const witnessId = tag('disposal-witness');
      const { lot, notice } = await inOrg(ORG_A, async (db) => {
        await db.organizationDepartment.createMany({
          data: [{ organizationId: ORG_A, key: 'PHARMACY', name: 'Pharmacy' }],
          skipDuplicates: true,
        });
        await db.user.create({
          data: {
            id: witnessId,
            organizationId: ORG_A,
            name: 'Disposal witness',
            email: `${witnessId}@example.invalid`,
            department: 'PHARMACY',
            title: 'Pharmacist',
            status: 'ACTIVE',
          },
        });
        await db.pharmacyBranchAssignment.create({
          data: { organizationId: ORG_A, branchId: BRANCH_A, userId: witnessId, active: true },
        });
        const { lot, batch } = await stockLot(db, fixture, {
          expiresAt: LATER,
          units: 10,
          label: 'disposed-recall',
        });
        const notice = await deps.operations.createRecall(db, scopeOf(fixture), {
          batchId: batch.id,
          reference: tag('disposed-recall'),
          reason: 'Disposal required',
        });
        return { lot, notice };
      });
      const acknowledge = () =>
        inOrg(ORG_A, (db) => deps.operations.acknowledgeRecall(db, scopeOf(fixture), notice.id));
      if (acknowledgementOrder === 'before') await acknowledge();
      await inOrg(ORG_A, (db) =>
        deps.operations.writeOff(db, scopeOf(fixture), {
          inventoryLotId: lot.id,
          stockLocationId: fixture.locationId,
          units: 10,
          witnessId,
          reason: 'Recall disposal',
          evidenceRef: 'signed-disposal',
          idempotencyKey: tag('disposal'),
        })
      );
      if (acknowledgementOrder === 'after') {
        await expect(
          inOrg(ORG_A, (db) => deps.operations.closeRecall(db, scopeOf(fixture), notice.id))
        ).rejects.toMatchObject({ reason: 'INVALID_STATE' });
        await acknowledge();
      }
      const balance = await inOrg(ORG_A, (db) =>
        db.pharmacyStockBalance.findFirstOrThrow({ where: { inventoryLotId: lot.id } })
      );
      expect(balance.onHandUnits).toBe(0);
      await expect(
        inOrg(ORG_A, (db) => deps.operations.closeRecall(db, scopeOf(fixture), notice.id))
      ).resolves.toMatchObject({ status: 'CLOSED' });
    }
  );

  it.each(['medicine', 'batch'] as const)(
    'releases only batches without open recalls when the %s recall closes first',
    async (first) => {
      const fixture = await scenario(ORG_A, BRANCH_A, 'overlapping-recalls');
      const { a, b, medicineNotice, batchNotice } = await inOrg(ORG_A, async (db) => {
        const a = await stockLot(db, fixture, { expiresAt: LATER, units: 10, label: 'overlap-a' });
        const b = await stockLot(db, fixture, { expiresAt: LATER, units: 10, label: 'overlap-b' });
        const medicineNotice = await deps.operations.createRecall(db, scopeOf(fixture), {
          medicineId: fixture.medicineId,
          reference: tag('medicine-recall'),
          reason: 'Medicine recall',
        });
        const batchNotice = await deps.operations.createRecall(db, scopeOf(fixture), {
          batchId: a.batch.id,
          reference: tag('batch-recall'),
          reason: 'Batch recall',
        });
        await deps.operations.acknowledgeRecall(db, scopeOf(fixture), medicineNotice.id);
        await deps.operations.acknowledgeRecall(db, scopeOf(fixture), batchNotice.id);
        return { a, b, medicineNotice, batchNotice };
      });
      const states = () =>
        inOrg(ORG_A, async (db) => {
          const batches = await db.pharmacyManufacturingBatch.findMany({
            where: { id: { in: [a.batch.id, b.batch.id] } },
          });
          return [a.batch.id, b.batch.id].map(
            (id) => batches.find((batch) => batch.id === id)!.state
          );
        });
      const notices =
        first === 'medicine' ? [medicineNotice, batchNotice] : [batchNotice, medicineNotice];
      await inOrg(ORG_A, (db) => deps.operations.closeRecall(db, scopeOf(fixture), notices[0].id));
      expect(await states()).toEqual(
        first === 'medicine' ? ['RECALLED', 'ACTIVE'] : ['RECALLED', 'RECALLED']
      );
      await inOrg(ORG_A, (db) => deps.operations.closeRecall(db, scopeOf(fixture), notices[1].id));
      expect(await states()).toEqual(['ACTIVE', 'ACTIVE']);
    }
  );

  it('preserves a concurrent recall for a batch inserted after closure locks its batches', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'new-batch-recall');
    const { batch, notice } = await inOrg(ORG_A, async (db) => {
      const { batch } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 10,
        label: 'existing-batch',
      });
      const notice = await deps.operations.createRecall(db, scopeOf(fixture), {
        medicineId: fixture.medicineId,
        reference: tag('existing-medicine-recall'),
        reason: 'Medicine recall',
      });
      await deps.operations.acknowledgeRecall(db, scopeOf(fixture), notice.id);
      return { batch, notice };
    });
    let insertedBatchId = '';
    let insertedRecall: Promise<unknown> | undefined;
    let recallPid = 0;
    await inOrg(ORG_A, (db) => {
      const closureDb = new Proxy(db, {
        get(target, key) {
          if (key !== '$queryRaw') return Reflect.get(target, key);
          return async (...args: Parameters<ScopedDb['$queryRaw']>) => {
            const rows = await target.$queryRaw(...args);
            if (
              typeof args[0] === 'object' &&
              'strings' in args[0] &&
              args[0].strings.join('').includes('FROM "pharmacy_manufacturing_batches"')
            ) {
              // Commit a second transaction after closure has locked its batch list.
              await inOrg(ORG_A, async (other) => {
                const { batch: inserted } = await stockLot(other, fixture, {
                  expiresAt: LATER,
                  units: 10,
                  label: 'inserted-batch',
                });
                insertedBatchId = inserted.id;
              });
              // The upstream authority lock serializes this recall after closure.
              // Start it while closure holds its batch list, and prove it waits.
              insertedRecall = inOrg(ORG_A, async (other) => {
                const [backend] = await other.$queryRawUnsafe<Array<{ pid: number }>>(
                  'SELECT pg_backend_pid() AS pid'
                );
                recallPid = backend.pid;
                return deps.operations.createRecall(other, scopeOf(fixture), {
                  batchId: insertedBatchId,
                  reference: tag('inserted-batch-recall'),
                  reason: 'New batch recall',
                });
              });
              await vi.waitFor(async () => {
                expect(recallPid).not.toBe(0);
                const [backend] = await inOrg(ORG_A, (other) =>
                  other.$queryRawUnsafe<Array<{ waiting: boolean }>>(
                    'SELECT cardinality(pg_blocking_pids($1)) > 0 AS waiting',
                    recallPid
                  )
                );
                expect(backend.waiting).toBe(true);
              });
            }
            return rows;
          };
        },
      });
      return deps.operations.closeRecall(closureDb, scopeOf(fixture), notice.id);
    });
    expect(insertedRecall).toBeDefined();
    await expect(insertedRecall).resolves.toMatchObject({ status: 'OPEN' });
    const batches = await inOrg(ORG_A, (db) =>
      db.pharmacyManufacturingBatch.findMany({
        where: { id: { in: [batch.id, insertedBatchId] } },
      })
    );
    expect(batches.find(({ id }) => id === batch.id)?.state).toBe('ACTIVE');
    expect(batches.find(({ id }) => id === insertedBatchId)?.state).toBe('RECALLED');
    expect(
      await inOrg(ORG_A, (db) =>
        db.pharmacyRecallNotice.count({
          where: { batchId: insertedBatchId, status: 'OPEN' },
        })
      )
    ).toBe(1);
  });

  it('allows checkout to validate its batch while a supplier claim waits for its stock', async () => {
    const sales = await import('./sales');
    const safety = await import('./sale-batch-safety');
    const fixture = await scenario(ORG_A, BRANCH_A, 'claim-checkout');
    // createSale runs the persisted regulatory gate: an ACTIVE organization and a branch profile.
    const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
    await withPlatformDb((db) =>
      db.organization.upsert({
        where: { id: ORG_A },
        update: { status: 'ACTIVE' },
        create: {
          id: ORG_A,
          slug: ORG_A,
          legalName: 'Recall tests',
          displayName: 'Recall tests',
          status: 'ACTIVE',
        },
      })
    );
    ruleSetIds.push(
      await seedPharmacyRegulatoryProfile(withPlatformDb, (work) => inOrg(ORG_A, work), BRANCH_A)
    );
    const { lot, presentationId } = await inOrg(ORG_A, async (db) => {
      const medicine = await db.medicine.update({
        where: { id: fixture.medicineId },
        data: { saleable: true, otc: true },
        include: { presentations: true },
      });
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 20,
        label: 'claim-checkout',
      });
      await db.pharmacyInventoryLot.update({ where: { id: lot.id }, data: { unitCostMinor: 100 } });
      return { lot, presentationId: medicine.presentations[0]!.id };
    });
    let signalAllocated!: () => void;
    let releaseSale!: () => void;
    let claimPid = 0;
    const allocated = new Promise<void>((resolve) => {
      signalAllocated = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseSale = resolve;
    });
    const sale = inOrg(ORG_A, async (db) => {
      const created = await sales.createSale(db, scopeOf(fixture));
      await sales.addSaleLine(db, scopeOf(fixture), {
        saleId: created.id,
        medicineId: fixture.medicineId,
        presentationId,
        packLevelId: fixture.packLevelId,
        saleUnit: 'STRIP',
        quantity: 1,
        canonicalUnitsPerSaleUnit: 10,
        idempotencyKey: tag('claim-checkout-sale'),
      });
      signalAllocated();
      await held;
      await safety.assertSaleBatchesSellable(db, scopeOf(fixture), created.id);
      return created;
    });
    await Promise.race([allocated, sale]);
    const claim = inOrg(ORG_A, async (db) => {
      const [backend] = await db.$queryRawUnsafe<Array<{ pid: number }>>(
        'SELECT pg_backend_pid() AS pid'
      );
      claimPid = backend.pid;
      return deps.operations.reserveSupplierClaim(db, scopeOf(fixture), {
        inventoryLotId: lot.id,
        reservedUnits: 1,
        returnBy: LATER,
      });
    });
    const outcomes = Promise.allSettled([sale, claim]);
    try {
      await vi.waitFor(
        async () => {
          expect(claimPid).not.toBe(0);
          const [backend] = await inOrg(ORG_A, (db) =>
            db.$queryRawUnsafe<Array<{ waiting: boolean }>>(
              'SELECT cardinality(pg_blocking_pids($1)) > 0 AS waiting',
              claimPid
            )
          );
          expect(backend.waiting).toBe(true);
        },
        { timeout: 3000 }
      );
    } finally {
      releaseSale();
      const results = await outcomes;
      expect(results.map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled']);
    }
  });

  it('counts only completed, unreversed sale stock as sold in the recall trace', async () => {
    const sales = await import('./sales');
    const completion = await import('./sale-completion');
    const fixture = await scenario(ORG_A, BRANCH_A, 'recall-sold-units');
    const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
    await withPlatformDb((db) =>
      db.organization.upsert({
        where: { id: ORG_A },
        update: { status: 'ACTIVE' },
        create: {
          id: ORG_A,
          slug: ORG_A,
          legalName: 'Recall tests',
          displayName: 'Recall tests',
          status: 'ACTIVE',
        },
      })
    );
    ruleSetIds.push(
      await seedPharmacyRegulatoryProfile(withPlatformDb, (work) => inOrg(ORG_A, work), BRANCH_A)
    );
    const { batch, presentationId } = await inOrg(ORG_A, async (db) => {
      const medicine = await db.medicine.update({
        where: { id: fixture.medicineId },
        data: { saleable: true, otc: true },
        include: { presentations: true },
      });
      const { batch, lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 40,
        label: 'recall-sold-units',
      });
      await db.pharmacyInventoryLot.update({ where: { id: lot.id }, data: { unitCostMinor: 100 } });
      return { batch, presentationId: medicine.presentations[0]!.id };
    });
    const draft = (db: ScopedDb, strips: number, label: string) =>
      sales.createSale(db, scopeOf(fixture)).then(async (sale) => {
        await sales.addSaleLine(db, scopeOf(fixture), {
          saleId: sale.id,
          medicineId: fixture.medicineId,
          presentationId,
          packLevelId: fixture.packLevelId,
          saleUnit: 'STRIP',
          quantity: strips,
          canonicalUnitsPerSaleUnit: 10,
          idempotencyKey: tag(label),
        });
        return sale;
      });
    // 20 units leave with a customer on a completed receipt.
    await inOrg(ORG_A, async (db) => {
      const sale = await draft(db, 2, 'recall-sold-completed');
      const loaded = await db.pharmacySale.findFirstOrThrow({
        where: { id: sale.id },
        include: completion.completionSaleInclude,
      });
      await completion.completePaidPharmacySale(db, scopeOf(fixture), loaded, {
        deviceId: tag('recall-sold-device'),
        businessDate: NOW,
      });
    });
    // 10 units go to a draft that is voided, and 10 sit on a draft never completed.
    await inOrg(ORG_A, async (db) => {
      const voided = await draft(db, 1, 'recall-sold-voided');
      await sales.changeSaleStatus(db, scopeOf(fixture), voided.id, 'void', 'Customer left');
      await draft(db, 1, 'recall-sold-open');
    });
    const trace = await inOrg(ORG_A, async (db) => {
      const notice = await deps.operations.createRecall(
        db,
        { organizationId: ORG_A, actorId: ACTOR },
        { batchId: batch.id, reference: tag('sold-recall'), reason: 'Regulator notice' }
      );
      return deps.operations.recallTrace(db, ORG_A, notice.id);
    });
    expect(trace.length).toBeGreaterThan(0);
    for (const row of trace) expect(row.soldUnits).toBe(20);
  });

  it('does not reserve a supplier claim against a recalled batch', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'recalled-supplier-claim');
    const lotId = await inOrg(ORG_A, async (db) => {
      const { lot, batch } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 10,
        label: 'recalled-supplier-claim',
      });
      await deps.operations.createRecall(
        db,
        { organizationId: ORG_A, actorId: ACTOR },
        { batchId: batch.id, reference: tag('claim-recall'), reason: 'Supplier recall' }
      );
      return lot.id;
    });
    await expect(
      inOrg(ORG_A, (db) =>
        deps.operations.reserveSupplierClaim(db, scopeOf(fixture), {
          inventoryLotId: lotId,
          reservedUnits: 1,
          returnBy: LATER,
        })
      )
    ).rejects.toMatchObject({ reason: 'BLOCKED_STOCK' });
  });

  it('keeps open batch and medicine recalls authoritative across tenants and concurrent activation', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'recall-authority');
    const foreign = await scenario(ORG_B, BRANCH_B, 'recall-authority-foreign');
    const batches = await inOrg(ORG_A, async (db) => {
      const batchScoped = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 10,
        label: 'batch-recall-authority',
      });
      const medicineScoped = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 10,
        label: 'medicine-recall-authority',
      });
      await deps.operations.createRecall(db, scopeOf(fixture), {
        batchId: batchScoped.batch.id,
        reference: tag('batch-authority'),
        reason: 'Batch recall remains open',
      });
      await deps.operations.createRecall(db, scopeOf(fixture), {
        medicineId: fixture.medicineId,
        reference: tag('medicine-authority'),
        reason: 'Medicine recall remains open',
      });
      return { batchId: batchScoped.batch.id, medicineBatchId: medicineScoped.batch.id };
    });

    for (const manufacturingBatchId of [batches.batchId, batches.medicineBatchId]) {
      await expect(
        inOrg(ORG_A, (db) =>
          deps.operations.setManufacturingBatchState(db, ORG_A, {
            manufacturingBatchId,
            state: 'ACTIVE',
          })
        )
      ).rejects.toBeInstanceOf(deps.operations.OpenRecallConflictError);
    }

    const foreignBatch = await inOrg(ORG_B, (db) =>
      stockLot(db, foreign, {
        expiresAt: LATER,
        units: 10,
        label: 'foreign-recall-authority',
      })
    );
    await expect(
      inOrg(ORG_A, (db) =>
        deps.operations.setManufacturingBatchState(db, ORG_A, {
          manufacturingBatchId: foreignBatch.batch.id,
          state: 'ACTIVE',
        })
      )
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });

    const race = await scenario(ORG_A, BRANCH_A_TWO, 'recall-activation-race');
    const raceBatch = await inOrg(ORG_A, async (db) => {
      const { batch } = await stockLot(db, race, {
        expiresAt: LATER,
        units: 10,
        label: 'recall-activation-race',
      });
      await deps.operations.setManufacturingBatchState(db, ORG_A, {
        manufacturingBatchId: batch.id,
        state: 'QUARANTINED',
        reason: 'Awaiting regulator decision',
      });
      return batch;
    });
    const outcomes = await Promise.allSettled([
      inOrg(ORG_A, (db) =>
        deps.operations.setManufacturingBatchState(db, ORG_A, {
          manufacturingBatchId: raceBatch.id,
          state: 'ACTIVE',
        })
      ),
      inOrg(ORG_A, (db) =>
        deps.operations.createRecall(db, scopeOf(race), {
          batchId: raceBatch.id,
          reference: tag('concurrent-authority'),
          reason: 'Concurrent regulator notice',
        })
      ),
    ]);
    expect(outcomes[1]?.status).toBe('fulfilled');
    const final = await inOrg(ORG_A, async (db) => ({
      batch: await db.pharmacyManufacturingBatch.findFirstOrThrow({
        where: { id: raceBatch.id },
      }),
      openRecall: await db.pharmacyRecallNotice.count({
        where: { batchId: raceBatch.id, status: 'OPEN' },
      }),
    }));
    expect(final.openRecall).toBe(1);
    expect(final.batch.state).toBe('RECALLED');
  });

  it('excludes supplier-claim reserved units from sale allocation and reports expiry value windows', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'supplier-claim');
    const result = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, fixture, {
        expiresAt: new Date('2026-09-20T00:00:00Z'),
        units: 20,
        label: 'supplier-claim',
      });
      await deps.operations.reserveSupplierClaim(db, scopeOf(fixture), {
        inventoryLotId: lot.id,
        reservedUnits: 15,
        returnBy: new Date('2026-09-15T00:00:00Z'),
      });
      const board = await deps.operations.nearExpiryBoard(db, fixture, NOW);
      return board;
    });
    await expect(
      inOrg(ORG_A, (db) =>
        deps.ledger.allocateForSale(db, scopeOf(fixture), {
          medicineId: fixture.medicineId,
          requiredUnits: 10,
          at: NOW,
          idempotencyKeyPrefix: tag('claim-sale'),
        })
      )
    ).rejects.toMatchObject({ reason: 'INSUFFICIENT_STOCK' });
    expect(result.find((row) => row.bucketDays === 30)).toMatchObject({
      units: 20,
      valueAtRiskMinor: 24000,
      withinSupplierReturnWindow: true,
    });
  });

  it('does not sell units a concurrent claim reserved while the sale waited (#355, claim-first)', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'claim-first');
    const lotId = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 10,
        label: 'claim-first',
      });
      return lot.id;
    });
    let releaseClaim: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const claim = inOrg(ORG_A, async (db) => {
      const result = await deps.operations.reserveSupplierClaim(db, scopeOf(fixture), {
        inventoryLotId: lotId,
        reservedUnits: 10,
        returnBy: LATER,
      });
      await held;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const sale = inOrg(ORG_A, (db) =>
      deps.ledger.allocateForSale(db, scopeOf(fixture), {
        medicineId: fixture.medicineId,
        requiredUnits: 10,
        at: NOW,
        idempotencyKeyPrefix: `claim-first-${suffix}-sale`,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    releaseClaim();
    const [claimOutcome, saleOutcome] = await Promise.allSettled([claim, sale]);
    expect(claimOutcome.status).toBe('fulfilled');
    expect(saleOutcome.status).toBe('rejected');
    const claims = await inOrg(ORG_A, (db) =>
      db.pharmacySupplierClaim.count({ where: { inventoryLotId: lotId, status: 'RESERVED' } })
    );
    expect(claims).toBe(1);
  });

  it('serializes a supplier claim against a concurrent sale of the same units (#355)', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'claim-race');
    const lotId = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 10,
        label: 'claim-race',
      });
      return lot.id;
    });
    let releaseSale: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseSale = resolve;
    });
    const sale = inOrg(ORG_A, async (db) => {
      const result = await deps.ledger.allocateForSale(db, scopeOf(fixture), {
        medicineId: fixture.medicineId,
        requiredUnits: 10,
        at: NOW,
        idempotencyKeyPrefix: `claim-race-${suffix}-sale`,
      });
      await held;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const startedClaim = Date.now();
    const claim = inOrg(ORG_A, (db) =>
      deps.operations.reserveSupplierClaim(db, scopeOf(fixture), {
        inventoryLotId: lotId,
        reservedUnits: 10,
        returnBy: LATER,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    releaseSale();
    const [saleOutcome, claimOutcome] = await Promise.allSettled([sale, claim]);
    const waitedMs = Date.now() - startedClaim;
    expect(saleOutcome.status).toBe('fulfilled');
    expect(claimOutcome.status).toBe('rejected');
    // The claim was blocked on the balance-row lock the sale held, not run on a stale read.
    expect(waitedMs).toBeGreaterThanOrEqual(200);
    expect((claimOutcome as PromiseRejectedResult).reason).toMatchObject({
      reason: 'INSUFFICIENT_STOCK',
    });
    const claims = await inOrg(ORG_A, (db) =>
      db.pharmacySupplierClaim.count({ where: { inventoryLotId: lotId, status: 'RESERVED' } })
    );
    expect(claims).toBe(0);
  });
});

// ── §8A invariant 6 — negative stock is unrepresentable ─────────────────────

describeIfDatabase('PH-INV ledger — negative stock (§8A invariant 6)', () => {
  it('refuses a raw movement that would drive the balance below zero', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'no-negative');
    const lotId = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 10,
        label: 'no-negative',
      });
      return lot.id;
    });

    const message = await expectRejection(ORG_A, (db) =>
      db.pharmacyStockMovement.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          inventoryLotId: lotId,
          stockLocationId: fixture.locationId,
          kind: 'WRITE_OFF',
          disposition: 'AVAILABLE',
          quantityUnits: -30,
          sealedPackDelta: -3,
          looseUnitDelta: 0,
          actorId: ACTOR,
          idempotencyKey: tag('oversell'),
        },
      })
    );
    const balance = await inOrg(ORG_A, (db) =>
      db.pharmacyStockBalance.findFirst({ where: { inventoryLotId: lotId } })
    );

    expect(message).toContain('pharmacy_stock_balances_non_negative_check');
    expect(balance?.onHandUnits).toBe(10);
  });

  it('records a pending discrepancy instead of a negative balance on the emergency path', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'emergency');
    const outcome = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 3,
        label: 'emergency',
      });
      const result = await deps.ledger.allocateForSale(db, scopeOf(fixture), {
        medicineId: fixture.medicineId,
        requiredUnits: 8,
        at: NOW,
        idempotencyKeyPrefix: tag('emergency'),
        emergency: { reason: 'Prescriber authorised a partial emergency dispense.' },
      });
      return {
        result,
        discrepancy: await db.pharmacyStockDiscrepancy.findFirst({
          where: { id: result.discrepancyId! },
        }),
        balance: await db.pharmacyStockBalance.findFirst({
          where: { inventoryLotId: lot.id, disposition: 'AVAILABLE' },
        }),
      };
    });

    expect(outcome.result.allocations.reduce((total, one) => total + one.units, 0)).toBe(3);
    expect(outcome.discrepancy).toMatchObject({
      requestedUnits: 8,
      allocatedUnits: 3,
      shortfallUnits: 5,
      actorId: ACTOR,
    });
    expect(outcome.balance?.onHandUnits).toBe(0);
  });

  it('refuses a normal sale outright rather than partially filling it', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'no-partial');
    await expect(
      inOrg(ORG_A, async (db) => {
        await stockLot(db, fixture, { expiresAt: LATER, units: 2, label: 'no-partial' });
        return deps.ledger.allocateForSale(db, scopeOf(fixture), {
          medicineId: fixture.medicineId,
          requiredUnits: 500,
          at: NOW,
          idempotencyKeyPrefix: tag('no-partial'),
        });
      })
    ).rejects.toMatchObject({ reason: 'INSUFFICIENT_STOCK' });

    // Nothing was posted: an all-or-nothing refusal leaves no partial ledger.
    // Scoped to this test's own medicine — other cases share the branch.
    const movements = await inOrg(ORG_A, (db) =>
      db.pharmacyStockMovement.count({
        where: { kind: 'SALE', lot: { batch: { medicineId: fixture.medicineId } } },
      })
    );
    expect(movements).toBe(0);
  });
});

// ── INV-02 — FEFO, override evidence and concurrency ────────────────────────

describeIfDatabase('PH-INV allocation — INV-02 FEFO', () => {
  it('draws the earliest safe expiry first across real lots', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'fefo');
    const result = await inOrg(ORG_A, async (db) => {
      // Received far-dated FIRST, so nearest-expiry beats insertion order.
      await stockLot(db, fixture, { expiresAt: LATER, units: 50, label: 'fefo-far' });
      const near = await stockLot(db, fixture, {
        expiresAt: SOON,
        units: 20,
        label: 'fefo-near',
      });
      const allocation = await deps.ledger.allocateForSale(db, scopeOf(fixture), {
        medicineId: fixture.medicineId,
        requiredUnits: 20,
        at: NOW,
        idempotencyKeyPrefix: tag('fefo'),
      });
      return { allocation, nearLotId: near.lot.id };
    });

    expect(result.allocation.recommendedLotId).toBe(result.nearLotId);
    expect(result.allocation.allocations).toEqual([
      expect.objectContaining({ inventoryLotId: result.nearLotId, units: 20 }),
    ]);
    expect(result.allocation.overrideId).toBeNull();
  });

  it('spans lots in FEFO order when one cannot cover the quantity', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'fefo-span');
    const result = await inOrg(ORG_A, async (db) => {
      const far = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 50,
        label: 'span-far',
      });
      const near = await stockLot(db, fixture, {
        expiresAt: SOON,
        units: 20,
        label: 'span-near',
      });
      const allocation = await deps.ledger.allocateForSale(db, scopeOf(fixture), {
        medicineId: fixture.medicineId,
        requiredUnits: 30,
        at: NOW,
        idempotencyKeyPrefix: tag('span'),
      });
      return { allocation, nearLotId: near.lot.id, farLotId: far.lot.id };
    });

    expect(result.allocation.allocations).toEqual([
      expect.objectContaining({ inventoryLotId: result.nearLotId, units: 20 }),
      expect.objectContaining({ inventoryLotId: result.farLotId, units: 10 }),
    ]);
  });

  it('records actor, reason, policy and recommended-vs-selected on an override', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'override');
    const outcome = await inOrg(ORG_A, async (db) => {
      const far = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 50,
        label: 'override-far',
      });
      const near = await stockLot(db, fixture, {
        expiresAt: SOON,
        units: 50,
        label: 'override-near',
      });
      const allocation = await deps.ledger.allocateForSale(db, scopeOf(fixture), {
        medicineId: fixture.medicineId,
        requiredUnits: 10,
        at: NOW,
        idempotencyKeyPrefix: tag('override'),
        override: {
          inventoryLotId: far.lot.id,
          reason: 'Customer travelling; needs the longer-dated pack.',
          approvalPolicy: 'PHARMACIST_ON_DUTY',
        },
      });
      return {
        allocation,
        override: await db.pharmacyAllocationOverride.findFirst({
          where: { id: allocation.overrideId! },
        }),
        movement: await db.pharmacyStockMovement.findFirst({
          where: { id: allocation.movementIds[0] },
        }),
        nearLotId: near.lot.id,
        farLotId: far.lot.id,
      };
    });

    expect(outcome.override).toMatchObject({
      actorId: ACTOR,
      reason: 'Customer travelling; needs the longer-dated pack.',
      approvalPolicy: 'PHARMACIST_ON_DUTY',
      recommendedLotId: outcome.nearLotId,
      selectedLotId: outcome.farLotId,
    });
    // The evidence hangs off the ledger row, not only off a side table.
    expect(outcome.movement?.allocationOverrideId).toBe(outcome.override!.id);
    expect(outcome.allocation.allocations[0]!.inventoryLotId).toBe(outcome.farLotId);
  });

  it('refuses to rewrite recorded override evidence', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'override-immutable');
    const overrideId = await inOrg(ORG_A, async (db) => {
      const far = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 20,
        label: 'imm-far',
      });
      await stockLot(db, fixture, { expiresAt: SOON, units: 20, label: 'imm-near' });
      const allocation = await deps.ledger.allocateForSale(db, scopeOf(fixture), {
        medicineId: fixture.medicineId,
        requiredUnits: 10,
        at: NOW,
        idempotencyKeyPrefix: tag('imm'),
        override: {
          inventoryLotId: far.lot.id,
          reason: 'Original reason.',
          approvalPolicy: 'PHARMACIST_ON_DUTY',
        },
      });
      return allocation.overrideId!;
    });

    const message = await expectRejection(ORG_A, (db) =>
      db.pharmacyAllocationOverride.update({
        where: { id: overrideId },
        data: { reason: 'Rewritten after the fact.' },
      })
    );
    expect(message).toContain('append-only');
  });

  it('never oversells the last unit under two concurrent sales', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'last-unit');
    const lotId = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 1,
        label: 'last-unit',
      });
      return lot.id;
    });

    /*
     * THE OVERLAP IS FORCED, NOT HOPED FOR. Firing two allocations at once and
     * asserting "one failed" passes even when the pool happens to run them back
     * to back — measured: with the FOR UPDATE removed, an unsynchronised race
     * still produced one clean INSUFFICIENT_STOCK, so that shape proved nothing.
     *
     * Here the first counter holds its transaction open after allocating. The
     * second must then be inside the first's window, and only the row lock can
     * hold it there: without the lock it would read the stale 1, post its own
     * SALE, and fail later on the non-negative CHECK with a raw database error
     * instead of the domain refusal asserted below.
     */
    let releaseFirst: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const allocate = (db: ScopedDb, label: string) =>
      deps.ledger.allocateForSale(db, scopeOf(fixture), {
        medicineId: fixture.medicineId,
        requiredUnits: 1,
        at: NOW,
        idempotencyKeyPrefix: `race-${suffix}-${label}`,
      });

    const first = inOrg(ORG_A, async (db) => {
      const result = await allocate(db, 'a');
      await held;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));

    const startedSecond = Date.now();
    const second = inOrg(ORG_A, (db) => allocate(db, 'b'));
    await new Promise((resolve) => setTimeout(resolve, 250));
    releaseFirst();

    const [firstOutcome, secondOutcome] = await Promise.allSettled([first, second]);
    const waitedMs = Date.now() - startedSecond;

    expect(firstOutcome.status).toBe('fulfilled');
    expect(secondOutcome.status).toBe('rejected');
    // The second counter was genuinely blocked for the rest of the first's
    // window rather than finishing before it.
    expect(waitedMs).toBeGreaterThanOrEqual(200);
    const rejection = (secondOutcome as PromiseRejectedResult).reason;
    expect(rejection).toBeInstanceOf(PharmacyInventoryError);
    expect(rejection.reason).toBe('INSUFFICIENT_STOCK');

    const after = await inOrg(ORG_A, async (db) => ({
      balance: await db.pharmacyStockBalance.findFirst({
        where: { inventoryLotId: lotId, disposition: 'AVAILABLE' },
      }),
      sales: await db.pharmacyStockMovement.count({
        where: { inventoryLotId: lotId, kind: 'SALE' },
      }),
    }));
    expect(after.balance?.onHandUnits).toBe(0);
    expect(after.sales).toBe(1);
  });
});

// ── INV-03 — hard blocks on the sale and transfer paths ─────────────────────

describeIfDatabase('PH-INV hard blocks — INV-03', () => {
  const blockedBatches: Array<[string, 'RECALLED' | 'QUARANTINED']> = [
    ['a recalled batch', 'RECALLED'],
    ['a quarantined batch', 'QUARANTINED'],
  ];

  it.each(blockedBatches)('refuses to sell %s', async (_label, state) => {
    const fixture = await scenario(ORG_A, BRANCH_A, `block-${state}`);
    await expect(
      inOrg(ORG_A, async (db) => {
        const { batch } = await stockLot(db, fixture, {
          expiresAt: LATER,
          units: 40,
          label: `block-${state}`,
        });
        await db.pharmacyManufacturingBatch.update({
          where: { id: batch.id },
          data: { state, stateReason: 'DRAP notice', stateChangedAt: new Date() },
        });
        return deps.ledger.allocateForSale(db, scopeOf(fixture), {
          medicineId: fixture.medicineId,
          requiredUnits: 1,
          at: NOW,
          idempotencyKeyPrefix: tag(`block-${state}`),
        });
      })
    ).rejects.toMatchObject({ reason: 'BLOCKED_STOCK' });
  });

  it('refuses to sell an expired batch', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'block-expired');
    await expect(
      inOrg(ORG_A, async (db) => {
        await stockLot(db, fixture, {
          expiresAt: new Date('2026-08-01T00:00:00.000Z'),
          units: 40,
          label: 'block-expired',
        });
        return deps.ledger.allocateForSale(db, scopeOf(fixture), {
          medicineId: fixture.medicineId,
          requiredUnits: 1,
          at: NOW,
          idempotencyKeyPrefix: tag('block-expired'),
        });
      })
    ).rejects.toMatchObject({ reason: 'INSUFFICIENT_STOCK' });
  });

  it('names the blocking reason rather than reporting an empty shelf', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'block-reasons');
    const rows = await inOrg(ORG_A, async (db) => {
      const { batch } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 40,
        label: 'block-reasons',
      });
      await db.pharmacyManufacturingBatch.update({
        where: { id: batch.id },
        data: { state: 'RECALLED', stateReason: 'DRAP notice', stateChangedAt: new Date() },
      });
      return deps.ledger.onHand(db, fixture, fixture.medicineId, NOW);
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ onHandUnits: 40, blockedBy: 'RECALLED' });
  });

  it('refuses to move unreceived stock at all', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'block-unreceived');
    const lotId = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 40,
        label: 'block-unreceived',
        received: false,
      });
      return lot.id;
    });

    // No receipt was posted, so the lot has no projection at all…
    const balance = await inOrg(ORG_A, (db) =>
      db.pharmacyStockBalance.findFirst({ where: { inventoryLotId: lotId } })
    );
    expect(balance).toBeNull();

    // …and the ledger refuses the movement independently of the projection.
    const message = await expectRejection(ORG_A, (db) =>
      db.pharmacyStockMovement.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          inventoryLotId: lotId,
          stockLocationId: fixture.locationId,
          kind: 'SALE',
          disposition: 'AVAILABLE',
          quantityUnits: -1,
          looseUnitDelta: -1,
          actorId: ACTOR,
          idempotencyKey: tag('unreceived'),
        },
      })
    );
    expect(message).toContain('unreceived stock cannot move');
  });

  it('refuses to TRANSFER blocked stock, not only to sell it', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'block-transfer');
    await expect(
      inOrg(ORG_A, async (db) => {
        const { batch, lot } = await stockLot(db, fixture, {
          expiresAt: LATER,
          units: 40,
          label: 'block-transfer',
        });
        await db.pharmacyManufacturingBatch.update({
          where: { id: batch.id },
          data: { state: 'RECALLED', stateReason: 'DRAP notice', stateChangedAt: new Date() },
        });
        return deps.ledger.transferStock(db, scopeOf(fixture), {
          inventoryLotId: lot.id,
          fromStockLocationId: fixture.locationId,
          toStockLocationId: fixture.quarantineLocationId,
          units: 10,
          at: NOW,
          idempotencyKeyPrefix: tag('block-transfer'),
        });
      })
    ).rejects.toMatchObject({ reason: 'BLOCKED_STOCK' });
  });

  it('lands transferred units AVAILABLE at the destination, never available twice (DEV-608)', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'transfer-ok');
    const projection = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 40,
        label: 'transfer-ok',
      });
      await deps.ledger.transferStock(db, scopeOf(fixture), {
        inventoryLotId: lot.id,
        fromStockLocationId: fixture.locationId,
        toStockLocationId: fixture.quarantineLocationId,
        units: 10,
        at: NOW,
        idempotencyKeyPrefix: tag('transfer-ok'),
      });
      return deps.ledger.onHand(db, fixture, fixture.medicineId, NOW);
    });

    const origin = projection.find(
      (row) => row.disposition === 'AVAILABLE' && row.stockLocationId === fixture.locationId
    )!;
    const destination = projection.find(
      (row) =>
        row.disposition === 'AVAILABLE' && row.stockLocationId === fixture.quarantineLocationId
    )!;
    expect(origin.onHandUnits).toBe(30);
    expect(destination.onHandUnits).toBe(10);
    // The moved units are usable where they now sit, and none are stranded in
    // an IN_TRANSIT bucket that no transfer record can receive or cancel.
    expect(destination.blockedBy).toBeNull();
    expect(projection.some((row) => row.disposition === 'IN_TRANSIT' && row.onHandUnits > 0)).toBe(
      false
    );
    expect(projection.reduce((sum, row) => sum + row.onHandUnits, 0)).toBe(40);
  });
});

// ── INV-04 — break-pack against the real projection ─────────────────────────

describeIfDatabase('PH-INV break-pack — INV-04', () => {
  it('changes only the arrangement, never the canonical total', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'break-pack');
    const outcome = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 60,
        label: 'break-pack',
      });
      const before = await db.pharmacyStockBalance.findFirst({
        where: { inventoryLotId: lot.id, disposition: 'AVAILABLE' },
      });
      const broken = await deps.ledger.breakPack(db, scopeOf(fixture), {
        inventoryLotId: lot.id,
        stockLocationId: fixture.locationId,
        requiredLooseUnits: 7,
        idempotencyKey: tag('break'),
        at: NOW,
      });
      const after = await db.pharmacyStockBalance.findFirst({
        where: { inventoryLotId: lot.id, disposition: 'AVAILABLE' },
      });
      return { before, broken, after };
    });

    expect(outcome.before).toMatchObject({ onHandUnits: 60, sealedPacks: 6, looseUnits: 0 });
    expect(outcome.broken.packsToBreak).toBe(1);
    expect(outcome.broken.movement?.quantityUnits).toBe(0);
    expect(outcome.after).toMatchObject({ onHandUnits: 60, sealedPacks: 5, looseUnits: 10 });
  });

  it('reconciles the PRD arrangement: 57 tablets is 5 strips and 7 loose', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'break-then-sell');
    const after = await inOrg(ORG_A, async (db) => {
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 60,
        label: 'break-then-sell',
      });
      await deps.ledger.breakPack(db, scopeOf(fixture), {
        inventoryLotId: lot.id,
        stockLocationId: fixture.locationId,
        requiredLooseUnits: 3,
        idempotencyKey: tag('break-sell'),
        at: NOW,
      });
      await deps.ledger.allocateForSale(db, scopeOf(fixture), {
        medicineId: fixture.medicineId,
        requiredUnits: 3,
        at: NOW,
        idempotencyKeyPrefix: tag('break-sell'),
      });
      return db.pharmacyStockBalance.findFirst({
        where: { inventoryLotId: lot.id, disposition: 'AVAILABLE' },
      });
    });

    expect(after).toMatchObject({ onHandUnits: 57, sealedPacks: 5, looseUnits: 7 });
  });

  it('refuses to break more packs than the shelf holds', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'break-too-many');
    await expect(
      inOrg(ORG_A, async (db) => {
        const { lot } = await stockLot(db, fixture, {
          expiresAt: LATER,
          units: 10,
          label: 'break-too-many',
        });
        return deps.ledger.breakPack(db, scopeOf(fixture), {
          inventoryLotId: lot.id,
          stockLocationId: fixture.locationId,
          requiredLooseUnits: 40,
          idempotencyKey: tag('break-too-many'),
          at: NOW,
        });
      })
    ).rejects.toMatchObject({ reason: 'INSUFFICIENT_STOCK' });
  });
});

// ── Tenant and branch boundaries ────────────────────────────────────────────

describeIfDatabase('PH-INV boundaries — cross-tenant and cross-branch', () => {
  it("hides another tenant's lots and refuses to allocate them", async () => {
    const foreignFixture = await scenario(ORG_B, BRANCH_B, 'foreign');
    const mine = await scenario(ORG_A, BRANCH_A, 'mine');
    const foreignLotId = await inOrg(ORG_B, async (db) => {
      const { lot } = await stockLot(db, foreignFixture, {
        expiresAt: LATER,
        units: 40,
        label: 'foreign',
      });
      return lot.id;
    });

    const seenByA = await inOrg(ORG_A, (db) =>
      db.pharmacyInventoryLot.findFirst({ where: { id: foreignLotId } })
    );
    expect(seenByA).toBeNull();

    // Naming the other tenant's medicine directly yields no candidates at all.
    await expect(
      inOrg(ORG_A, (db) =>
        deps.ledger.allocateForSale(db, scopeOf(mine), {
          medicineId: foreignFixture.medicineId,
          requiredUnits: 1,
          at: NOW,
          idempotencyKeyPrefix: tag('cross-tenant'),
        })
      )
    ).rejects.toMatchObject({ reason: 'INSUFFICIENT_STOCK' });
  });

  it('refuses a cross-branch lot substitution inside one tenant', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'cross-branch');
    const other = await inOrg(ORG_A, async (db) => {
      await ensureBranch(db, ORG_A, BRANCH_A_TWO);
      const location = await db.pharmacyStockLocation.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A_TWO,
          code: `MAIN2-${tag('cross-branch')}`,
          name: 'Second branch store',
          kind: 'STORE',
        },
      });
      // NEARER expiry than anything in branch_a, so a branch-blind FEFO would
      // pick it and the assertion below would fail.
      const { lot } = await stockLot(db, fixture, {
        expiresAt: SOON,
        units: 40,
        label: 'other-branch',
        branchId: BRANCH_A_TWO,
        locationId: location.id,
      });
      await stockLot(db, fixture, { expiresAt: LATER, units: 40, label: 'own-branch' });
      return lot.id;
    });

    const allocation = await inOrg(ORG_A, (db) =>
      deps.ledger.allocateForSale(db, scopeOf(fixture), {
        medicineId: fixture.medicineId,
        requiredUnits: 10,
        at: NOW,
        idempotencyKeyPrefix: tag('cross-branch-fefo'),
      })
    );
    expect(allocation.allocations.map((one) => one.inventoryLotId)).not.toContain(other);

    // Naming it explicitly as an override is a refusal, not a fallback.
    await expect(
      inOrg(ORG_A, (db) =>
        deps.ledger.allocateForSale(db, scopeOf(fixture), {
          medicineId: fixture.medicineId,
          requiredUnits: 1,
          at: NOW,
          idempotencyKeyPrefix: tag('cross-branch-override'),
          override: {
            inventoryLotId: other,
            reason: 'Attempted substitution from another branch.',
            approvalPolicy: 'PHARMACIST_ON_DUTY',
          },
        })
      )
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });

    // And so is breaking a pack that belongs to the other branch.
    await expect(
      inOrg(ORG_A, (db) =>
        deps.ledger.breakPack(db, scopeOf(fixture), {
          inventoryLotId: other,
          stockLocationId: fixture.locationId,
          requiredLooseUnits: 1,
          idempotencyKey: tag('cross-branch-break'),
          at: NOW,
        })
      )
    ).rejects.toMatchObject({ reason: 'CROSS_BRANCH_REFERENCE' });
  });

  it('refuses a movement naming a location in another branch', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'cross-branch-location');
    const setup = await inOrg(ORG_A, async (db) => {
      await ensureBranch(db, ORG_A, BRANCH_A_THREE);
      const location = await db.pharmacyStockLocation.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A_THREE,
          code: `MAIN3-${tag('cross-branch-location')}`,
          name: 'Third branch store',
          kind: 'STORE',
        },
      });
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 20,
        label: 'cross-branch-location',
      });
      return { locationId: location.id, lotId: lot.id };
    });

    const message = await expectRejection(ORG_A, (db) =>
      db.pharmacyStockMovement.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          inventoryLotId: setup.lotId,
          stockLocationId: setup.locationId,
          kind: 'ADJUSTMENT',
          disposition: 'AVAILABLE',
          quantityUnits: 10,
          sealedPackDelta: 1,
          looseUnitDelta: 0,
          actorId: ACTOR,
          idempotencyKey: tag('cross-branch-location'),
        },
      })
    );
    expect(message).toContain('location in its own tenant and branch');
  });

  it('narrows reads to one branch when the branch GUC is set (NFR-03)', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'branch-guc');
    await inOrg(ORG_A, async (db) => {
      await ensureBranch(db, ORG_A, BRANCH_GUC);
      return db.pharmacyStockLocation.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_GUC,
          code: `GUC-${tag('branch-guc')}`,
          name: 'GUC branch store',
          kind: 'STORE',
        },
      });
    });

    const narrowed = await inOrg(ORG_A, async (db) => {
      const all = await db.pharmacyStockLocation.count();
      await db.$executeRawUnsafe(
        `SELECT set_config('app.current_branch_id', $1, true)`,
        BRANCH_GUC
      );
      return {
        all,
        scoped: await db.pharmacyStockLocation.count(),
        // The branch_a location cannot be reached by id from this session.
        otherBranch: await db.pharmacyStockLocation.findFirst({
          where: { id: fixture.locationId },
        }),
      };
    });

    expect(narrowed.scoped).toBe(1);
    expect(narrowed.all).toBeGreaterThan(narrowed.scoped);
    expect(narrowed.otherBranch).toBeNull();
  });

  it("refuses to transfer a sibling branch's lot without revealing that it holds stock", async () => {
    // DEV-660: the source balance is read under the acting branch, so a real,
    // AVAILABLE balance in another branch answers exactly like a missing one
    // and is never locked or moved.
    const fixture = await scenario(ORG_A, BRANCH_A, 'transfer-cross-branch');
    const other = await inOrg(ORG_A, async (db) => {
      await ensureBranch(db, ORG_A, BRANCH_A_TWO);
      const location = await db.pharmacyStockLocation.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A_TWO,
          code: `MAIN2-${tag('transfer-cross-branch')}`,
          name: 'Second branch store',
          kind: 'STORE',
        },
      });
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 40,
        label: 'transfer-cross-branch',
        branchId: BRANCH_A_TWO,
        locationId: location.id,
      });
      return { lotId: lot.id, locationId: location.id };
    });

    await expect(
      inOrg(ORG_A, (db) =>
        deps.ledger.transferStock(db, scopeOf(fixture), {
          inventoryLotId: other.lotId,
          fromStockLocationId: other.locationId,
          toStockLocationId: fixture.quarantineLocationId,
          units: 1,
          at: NOW,
          idempotencyKeyPrefix: tag('transfer-cross-branch'),
        })
      )
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });

    const untouched = await inOrg(ORG_A, (db) =>
      db.pharmacyStockBalance.findFirst({
        where: {
          inventoryLotId: other.lotId,
          stockLocationId: other.locationId,
          disposition: 'AVAILABLE',
        },
        select: { onHandUnits: true },
      })
    );
    expect(untouched?.onHandUnits).toBe(40);
  });
});

// Shared real-stock fixture for overlapping manual and DRAP recall decisions.
async function recallFixture() {
  const fixture = await scenario(ORG_A, BRANCH_A, 'overlapping-recalls');
  return inOrg(ORG_A, async (db) => {
    const registration = tag('recall-registration');
    await db.medicine.update({
      where: { id: fixture.medicineId },
      data: { drapRegistrationNumber: registration },
    });
    const first = await stockLot(db, fixture, {
      expiresAt: LATER,
      units: 10,
      label: 'overlap-first',
    });
    const second = await stockLot(db, fixture, {
      expiresAt: LATER,
      units: 10,
      label: 'overlap-second',
    });
    return { ...fixture, registration, first, second };
  });
}

type RecallFixture = Awaited<ReturnType<typeof recallFixture>>;

async function drapRecall(db: ScopedDb, fixture: RecallFixture, scope: 'batch' | 'medicine') {
  const draft = await deps.drap.ingestDrapNotice(db, scopeOf(fixture), 'MANUAL', {
    kind: 'RECALL',
    sourceReference: tag('drap-overlap'),
    drapRegistrationNumber: fixture.registration,
    ...(scope === 'batch' ? { batchNumbers: [fixture.first.batch.batchNumber] } : {}),
    reason: 'Regulator recall',
  });
  // DEV-692: a matched alert is only a draft until a person confirms it.
  expect(draft).toMatchObject({ reviewStatus: 'PENDING_REVIEW', recallNoticeId: null });
  return deps.drap.confirmDrapRecall(db, scopeOf(fixture), draft.id);
}

async function closeAcknowledgedRecall(db: ScopedDb, fixture: RecallFixture, noticeId: string) {
  await deps.operations.acknowledgeRecall(db, scopeOf(fixture), noticeId);
  return deps.operations.closeRecall(db, scopeOf(fixture), noticeId);
}

async function recallStates(fixture: RecallFixture) {
  return inOrg(ORG_A, async (db) => {
    const first = await db.pharmacyManufacturingBatch.findFirstOrThrow({
      where: { id: fixture.first.batch.id },
    });
    const second = await db.pharmacyManufacturingBatch.findFirstOrThrow({
      where: { id: fixture.second.batch.id },
    });
    return [first.state, second.state];
  });
}

/** Assert an actual advisory-lock wait, then let both transactions commit. */
async function expectRecallLockWait(
  holder: (db: ScopedDb) => Promise<unknown>,
  waiter: (db: ScopedDb) => Promise<unknown>
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held!: () => void;
  const ready = new Promise<void>((resolve) => {
    held = resolve;
  });
  const blocking = inOrg(ORG_A, async (db) => {
    await holder(db);
    held();
    await gate;
  });
  // A failed holder must reject rather than leave the test waiting for its gate.
  await Promise.race([ready, blocking]);
  let started!: (pid: number) => void;
  const backend = new Promise<number>((resolve) => {
    started = resolve;
  });
  const waiting = inOrg(ORG_A, async (db) => {
    const [row] = await db.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    started(row!.pid);
    return waiter(db);
  });
  const outcomes = Promise.allSettled([blocking, waiting]);
  try {
    const pid = await Promise.race([
      backend,
      waiting.then(() => {
        throw new Error('Waiter finished before locking');
      }),
    ]);
    await expect
      .poll(
        async () =>
          inOrg(ORG_A, async (db) => {
            const [row] = await db.$queryRaw<Array<{ waiting: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM pg_locks
          WHERE pid = ${pid} AND locktype = 'advisory' AND NOT granted) AS waiting`;
            return row?.waiting;
          }),
        { timeout: 2000 }
      )
      .toBe(true);
  } finally {
    release();
    const results = await outcomes;
    for (const result of results) expect(result.status).toBe('fulfilled');
  }
}

describeIfDatabase('PH-INV recall authority across manual and DRAP workflows', () => {
  const scopes = [
    ['batch', 'batch'],
    ['batch', 'medicine'],
    ['medicine', 'batch'],
    ['medicine', 'medicine'],
  ] as const;

  it.each(scopes)(
    'closing a %s recall preserves an overlapping %s recall',
    async (closingScope, remainingScope) => {
      const fixture = await recallFixture();
      const [closing, remaining] = await inOrg(ORG_A, async (db) => {
        const notices = [];
        for (const scope of [closingScope, remainingScope]) {
          notices.push(
            await deps.operations.createRecall(db, scopeOf(fixture), {
              ...(scope === 'batch'
                ? { batchId: fixture.first.batch.id }
                : { medicineId: fixture.medicineId }),
              reference: tag('overlap'),
              reason: 'Independent recall',
            })
          );
        }
        return notices;
      });
      await inOrg(ORG_A, (db) => closeAcknowledgedRecall(db, fixture, closing!.id));
      expect(await recallStates(fixture)).toEqual([
        'RECALLED',
        remainingScope === 'medicine' ? 'RECALLED' : 'ACTIVE',
      ]);
      const holdings = await inOrg(ORG_A, (db) =>
        deps.ledger.onHand(db, scopeOf(fixture), fixture.medicineId, NOW)
      );
      expect(holdings.find((row) => row.inventoryLotId === fixture.first.lot.id)?.blockedBy).toBe(
        'RECALLED'
      );
      await inOrg(ORG_A, (db) => closeAcknowledgedRecall(db, fixture, remaining!.id));
      expect(await recallStates(fixture)).toEqual(['ACTIVE', 'ACTIVE']);
    }
  );

  it.each(scopes)(
    'reversing a DRAP %s recall preserves an overlapping %s recall and stock history',
    async (drapScope, remainingScope) => {
      const fixture = await recallFixture();
      const ingest = await inOrg(ORG_A, (db) => drapRecall(db, fixture, drapScope));
      const remaining = await inOrg(ORG_A, (db) =>
        deps.operations.createRecall(db, scopeOf(fixture), {
          ...(remainingScope === 'batch'
            ? { batchId: fixture.first.batch.id }
            : { medicineId: fixture.medicineId }),
          reference: tag('independent-recall'),
          reason: 'Independent recall remains authoritative',
        })
      );
      const closed = await inOrg(ORG_A, (db) =>
        deps.drap.reverseRecallQuarantine(
          db,
          scopeOf(fixture),
          ingest.recallNoticeId!,
          'Regulator withdrew only the DRAP notice'
        )
      );
      expect(closed.status).toBe('CLOSED');
      expect(await recallStates(fixture)).toEqual([
        'RECALLED',
        remainingScope === 'medicine' ? 'RECALLED' : 'ACTIVE',
      ]);
      const restored = await inOrg(ORG_A, async (db) => ({
        available: await db.pharmacyStockBalance.findMany({
          where: { inventoryLotId: fixture.first.lot.id, disposition: 'AVAILABLE' },
        }),
        actions: await db.pharmacyRecallQuarantineAction.findMany({
          where: { recallNoticeId: ingest.recallNoticeId! },
        }),
        reversals: await db.pharmacyStockMovement.count({
          where: { inventoryLotId: fixture.first.lot.id, reversesMovementId: { not: null } },
        }),
        remaining: await db.pharmacyRecallNotice.findFirstOrThrow({ where: { id: remaining.id } }),
      }));
      expect(restored.available.reduce((sum, row) => sum + row.onHandUnits, 0)).toBe(10);
      expect(restored.actions).toHaveLength(drapScope === 'batch' ? 1 : 2);
      expect(
        restored.actions.every((action) => action.reversedAt && action.reversedById === ACTOR)
      ).toBe(true);
      expect(restored.reversals).toBe(2);
      expect(restored.remaining.status).toBe('OPEN');
      await inOrg(ORG_A, (db) => closeAcknowledgedRecall(db, fixture, remaining.id));
      expect(await recallStates(fixture)).toEqual(['ACTIVE', 'ACTIVE']);
    }
  );

  it.each(['activate', 'close', 'reverse'] as const)(
    'serializes DRAP ingestion behind %s until commit',
    async (operation) => {
      const fixture = await recallFixture();
      const existing =
        operation === 'activate'
          ? null
          : await inOrg(ORG_A, (db) => drapRecall(db, fixture, 'batch'));
      await expectRecallLockWait(
        async (db) => {
          if (operation === 'activate')
            return deps.operations.setManufacturingBatchState(db, ORG_A, {
              manufacturingBatchId: fixture.first.batch.id,
              state: 'ACTIVE',
            });
          if (operation === 'close')
            return closeAcknowledgedRecall(db, fixture, existing!.recallNoticeId!);
          return deps.drap.reverseRecallQuarantine(
            db,
            scopeOf(fixture),
            existing!.recallNoticeId!,
            'Recall withdrawn'
          );
        },
        (db) => drapRecall(db, fixture, 'batch')
      );
      expect(await recallStates(fixture)).toEqual(['RECALLED', 'ACTIVE']);
    }
  );

  it('serializes DRAP reversal behind a concurrent recall and rechecks overlapping authority', async () => {
    const fixture = await recallFixture();
    const ingest = await inOrg(ORG_A, (db) => drapRecall(db, fixture, 'batch'));
    await expectRecallLockWait(
      (db) =>
        deps.operations.createRecall(db, scopeOf(fixture), {
          medicineId: fixture.medicineId,
          reference: tag('concurrent-medicine-recall'),
          reason: 'Independent medicine recall',
        }),
      (db) =>
        deps.drap.reverseRecallQuarantine(
          db,
          scopeOf(fixture),
          ingest.recallNoticeId!,
          'DRAP notice withdrawn'
        )
    );
    expect(await recallStates(fixture)).toEqual(['RECALLED', 'RECALLED']);
  });
});
