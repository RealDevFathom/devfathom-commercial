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

import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

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
        deps.operations.approveCount(db, scopeOf(fixture), count.id, tag('same-actor'))
      )
    ).rejects.toMatchObject({ reason: 'COAUTH_REQUIRED' });
    const result = await inOrg(ORG_A, async (db) => {
      const approved = await deps.operations.approveCount(
        db,
        { ...scopeOf(fixture), actorId: 'user_second_pharmacist' },
        count.id,
        tag('coauth')
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
    const receiptBalances = await inOrg(ORG_A, (db) =>
      db.pharmacyStockBalance.findMany({
        where: {
          OR: [
            { inventoryLotId: setup.lotId, disposition: 'IN_TRANSIT' },
            { branchId: destinationBranch, disposition: 'AVAILABLE' },
          ],
        },
      })
    );
    expect(receiptBalances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          inventoryLotId: setup.lotId,
          disposition: 'IN_TRANSIT',
          onHandUnits: 10,
          sealedPacks: 1,
          looseUnits: 0,
        }),
        expect.objectContaining({
          branchId: destinationBranch,
          disposition: 'AVAILABLE',
          onHandUnits: 20,
          sealedPacks: 2,
          looseUnits: 0,
        }),
      ])
    );
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

  it.each([
    { label: 'sealed', quantityUnits: 1, breakPackFirst: false },
    { label: 'loose', quantityUnits: 10, breakPackFirst: true },
  ])(
    'dispatches $quantityUnits units from the real $label source arrangement',
    async ({ label, quantityUnits, breakPackFirst }) => {
      const fixture = await scenario(ORG_A, BRANCH_A, `transfer-${label}-arrangement`);
      const destinationBranch = `${BRANCH_A}_${label}_destination`;
      const dispatchKey = tag(`${label}-dispatch`);
      const result = await inOrg(ORG_A, async (db) => {
        await ensureBranch(db, ORG_A, destinationBranch);
        const destination = await db.pharmacyStockLocation.create({
          data: {
            organizationId: ORG_A,
            branchId: destinationBranch,
            code: `DEST-${tag(label)}`,
            name: `${label} destination`,
            kind: 'STORE',
          },
        });
        const { lot } = await stockLot(db, fixture, {
          expiresAt: LATER,
          units: 10,
          label: `transfer-${label}-arrangement`,
        });
        if (breakPackFirst) {
          await deps.ledger.breakPack(db, scopeOf(fixture), {
            inventoryLotId: lot.id,
            stockLocationId: fixture.locationId,
            requiredLooseUnits: 10,
            idempotencyKey: tag(`${label}-break`),
            at: NOW,
          });
        }
        const transfer = await deps.operations.allocateTransfer(db, scopeOf(fixture), {
          toBranchId: destinationBranch,
          lines: [
            {
              sourceLotId: lot.id,
              sourceStockLocationId: fixture.locationId,
              destinationStockLocationId: destination.id,
              quantityUnits,
            },
          ],
        });
        await deps.operations.approveTransfer(
          db,
          { ...scopeOf(fixture), actorId: `${label}_approver` },
          transfer.id
        );
        await deps.operations.dispatchTransfer(db, scopeOf(fixture), transfer.id, dispatchKey);
        return {
          balances: await db.pharmacyStockBalance.findMany({ where: { inventoryLotId: lot.id } }),
          dispatchMovements: await db.pharmacyStockMovement.findMany({
            where: { inventoryLotId: lot.id, idempotencyKey: { startsWith: dispatchKey } },
            orderBy: { idempotencyKey: 'asc' },
          }),
        };
      });

      expect(result.balances.find((row) => row.disposition === 'IN_TRANSIT')).toMatchObject({
        onHandUnits: quantityUnits,
        sealedPacks: 0,
        looseUnits: quantityUnits,
      });
      expect(result.balances.find((row) => row.disposition === 'AVAILABLE')).toMatchObject({
        onHandUnits: 10 - quantityUnits,
        sealedPacks: 0,
        looseUnits: 10 - quantityUnits,
      });
      expect(result.dispatchMovements.map((movement) => movement.kind)).toEqual(
        label === 'sealed'
          ? ['BREAK_PACK', 'TRANSFER_OUT', 'TRANSFER_IN']
          : ['TRANSFER_OUT', 'TRANSFER_IN']
      );
      expect(result.dispatchMovements.slice(-2)).toEqual([
        expect.objectContaining({
          kind: 'TRANSFER_OUT',
          sealedPackDelta: 0,
          looseUnitDelta: -quantityUnits,
        }),
        expect.objectContaining({
          kind: 'TRANSFER_IN',
          sealedPackDelta: 0,
          looseUnitDelta: quantityUnits,
        }),
      ]);
      const receipt = await inOrg(ORG_A, async (db) => {
        const transfer = await db.pharmacyInterbranchTransfer.findFirstOrThrow({
          where: { toBranchId: destinationBranch },
          include: { lines: true },
        });
        const received = await deps.operations.receiveTransferLine(
          db,
          { ...scopeOf(fixture), branchId: destinationBranch },
          {
            transferId: transfer.id,
            lineId: transfer.lines[0]!.id,
            receivedUnits: quantityUnits,
            idempotencyKeyPrefix: tag(`${label}-receipt`),
          }
        );
        return {
          status: received.status,
          balances: await db.pharmacyStockBalance.findMany({
            where: { branchId: destinationBranch },
          }),
        };
      });
      expect(receipt.status).toBe('RECEIVED');
      expect(receipt.balances).toEqual([
        expect.objectContaining({
          disposition: 'AVAILABLE',
          onHandUnits: quantityUnits,
          sealedPacks: 0,
          looseUnits: quantityUnits,
        }),
      ]);
    }
  );

  it.each([
    {
      label: 'loose',
      stock: 20,
      breakUnits: 10,
      quantity: 10,
      receipts: [
        [3, 0, 3],
        [7, 0, 7],
      ],
    },
    {
      label: 'legacy loose',
      stock: 20,
      breakUnits: 10,
      quantity: 10,
      receipts: [
        [3, 0, 3],
        [7, 0, 7],
      ],
    },
    {
      label: 'sealed',
      stock: 30,
      breakUnits: 0,
      quantity: 30,
      receipts: [
        [3, 0, 3],
        [17, 1, 7],
        [10, 1, 0],
      ],
    },
    {
      label: 'mixed',
      stock: 30,
      breakUnits: 10,
      quantity: 20,
      receipts: [
        [3, 0, 3],
        [7, 0, 7],
        [10, 1, 0],
      ],
    },
    {
      label: 'mixed full',
      stock: 30,
      breakUnits: 10,
      quantity: 20,
      receipts: [[20, 1, 10]],
    },
  ])('preserves $label packaging through partial and closing receipts', async (testCase) => {
    const fixture = await scenario(ORG_A, BRANCH_A, `partial-${testCase.label}`);
    const setup = await inOrg(ORG_A, async (db) => {
      const destinationBranchId = tag('partial-destination');
      await ensureBranch(db, ORG_A, destinationBranchId);
      const destination = await db.pharmacyStockLocation.create({
        data: {
          organizationId: ORG_A,
          branchId: destinationBranchId,
          code: tag('partial-destination'),
          name: 'Partial receipt destination',
          kind: 'STORE',
        },
      });
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: testCase.stock,
        label: testCase.label,
      });
      if (testCase.breakUnits) {
        await deps.ledger.breakPack(db, scopeOf(fixture), {
          inventoryLotId: lot.id,
          stockLocationId: fixture.locationId,
          requiredLooseUnits: testCase.breakUnits,
          idempotencyKey: tag('partial-break'),
          at: NOW,
        });
      }
      const transfer = await deps.operations.allocateTransfer(db, scopeOf(fixture), {
        toBranchId: destinationBranchId,
        lines: [
          {
            sourceLotId: lot.id,
            sourceStockLocationId: fixture.locationId,
            destinationStockLocationId: destination.id,
            quantityUnits: testCase.quantity,
          },
        ],
      });
      await deps.operations.approveTransfer(
        db,
        { ...scopeOf(fixture), actorId: 'partial_approver' },
        transfer.id
      );
      if (testCase.label === 'legacy loose') {
        // Reproduce dispatch evidence written before line attribution existed.
        await db.pharmacyStockMovement.createMany({
          data: [
            { kind: 'TRANSFER_OUT' as const, disposition: 'AVAILABLE' as const, sign: -1 },
            { kind: 'TRANSFER_IN' as const, disposition: 'IN_TRANSIT' as const, sign: 1 },
          ].map(({ kind, disposition, sign }) => ({
            ...scopeOf(fixture),
            inventoryLotId: lot.id,
            stockLocationId: fixture.locationId,
            kind,
            disposition,
            quantityUnits: sign * 10,
            sealedPackDelta: 0,
            looseUnitDelta: sign * 10,
            idempotencyKey: tag('legacy-dispatch'),
          })),
        });
        await db.pharmacyInterbranchTransfer.update({
          where: { id: transfer.id },
          data: { status: 'DISPATCHED', dispatchedById: ACTOR, dispatchedAt: NOW },
        });
      } else {
        await deps.operations.dispatchTransfer(
          db,
          scopeOf(fixture),
          transfer.id,
          tag('partial-dispatch')
        );
      }
      return { transfer, lot, destinationBranchId };
    });
    if (testCase.label === 'sealed') {
      const rollbackKey = tag('receipt-rollback');
      await expect(
        inOrg(ORG_A, async (db) => {
          await deps.operations.receiveTransferLine(
            db,
            { ...scopeOf(fixture), branchId: setup.destinationBranchId },
            {
              transferId: setup.transfer.id,
              lineId: setup.transfer.lines[0]!.id,
              receivedUnits: 3,
              idempotencyKeyPrefix: rollbackKey,
            }
          );
          throw new Error('Roll back receipt after pack breaking');
        })
      ).rejects.toThrow('Roll back receipt after pack breaking');
      const rolledBack = await inOrg(ORG_A, async (db) => ({
        movements: await db.pharmacyStockMovement.count({
          where: { idempotencyKey: { startsWith: rollbackKey } },
        }),
        line: await db.pharmacyInterbranchTransferLine.findUniqueOrThrow({
          where: { id: setup.transfer.lines[0]!.id },
        }),
        transit: await db.pharmacyStockBalance.findMany({
          where: { inventoryLotId: setup.lot.id, disposition: 'IN_TRANSIT' },
        }),
      }));
      expect(rolledBack.movements).toBe(0);
      expect(rolledBack.line.receivedUnits).toBe(0);
      expect(rolledBack.transit).toEqual([
        expect.objectContaining({ onHandUnits: 30, sealedPacks: 3, looseUnits: 0 }),
      ]);
    }
    for (const [index, [units, sealedPacks, looseUnits]] of testCase.receipts.entries()) {
      const receiptKey = tag('partial-receipt');
      const result = await inOrg(ORG_A, async (db) => {
        const received = await deps.operations.receiveTransferLine(
          db,
          { ...scopeOf(fixture), branchId: setup.destinationBranchId },
          {
            transferId: setup.transfer.id,
            lineId: setup.transfer.lines[0]!.id,
            receivedUnits: units!,
            idempotencyKeyPrefix: receiptKey,
          }
        );
        return {
          received,
          movements: await db.pharmacyStockMovement.findMany({
            where: { idempotencyKey: { startsWith: receiptKey } },
          }),
        };
      });
      expect(result.received.status).toBe(
        index === testCase.receipts.length - 1 ? 'RECEIVED' : 'EXCEPTION'
      );
      expect(result.movements.find((row) => row.disposition === 'AVAILABLE')).toMatchObject({
        kind: 'TRANSFER_IN',
        quantityUnits: units,
        sealedPackDelta: sealedPacks,
        looseUnitDelta: looseUnits,
      });
      expect(result.movements.find((row) => row.kind === 'BREAK_PACK')).toEqual(
        testCase.label === 'sealed' && index === 0
          ? expect.objectContaining({
              disposition: 'IN_TRANSIT',
              quantityUnits: 0,
              sealedPackDelta: -1,
              looseUnitDelta: 10,
            })
          : undefined
      );
    }
    const transit = await inOrg(ORG_A, (db) =>
      db.pharmacyStockBalance.findMany({
        where: { inventoryLotId: setup.lot.id, disposition: 'IN_TRANSIT' },
      })
    );
    expect(transit).toEqual([
      expect.objectContaining({ onHandUnits: 0, sealedPacks: 0, looseUnits: 0 }),
    ]);
  });

  it.each([
    { sealedFirst: false, legacySealed: false },
    { sealedFirst: true, legacySealed: false },
    { sealedFirst: false, legacySealed: true },
    { sealedFirst: true, legacySealed: true },
  ])(
    'keeps shared transit shipments separate (sealed first: $sealedFirst, legacy: $legacySealed)',
    async ({ sealedFirst, legacySealed }) => {
      const fixture = await scenario(ORG_A, BRANCH_A, 'shared-transit');
      const setup = await inOrg(ORG_A, async (db) => {
        const destinationBranchId = tag('shared-destination');
        await ensureBranch(db, ORG_A, destinationBranchId);
        const destination = await db.pharmacyStockLocation.create({
          data: {
            organizationId: ORG_A,
            branchId: destinationBranchId,
            code: tag('shared-destination'),
            name: 'Shared transit destination',
            kind: 'STORE',
          },
        });
        const { lot } = await stockLot(db, fixture, {
          expiresAt: LATER,
          units: 20,
          label: 'shared',
        });
        await deps.ledger.breakPack(db, scopeOf(fixture), {
          inventoryLotId: lot.id,
          stockLocationId: fixture.locationId,
          requiredLooseUnits: 10,
          idempotencyKey: tag('shared-break'),
          at: NOW,
        });
        const transfers = [];
        for (let i = 0; i < 2; i++) {
          const transfer = await deps.operations.allocateTransfer(db, scopeOf(fixture), {
            toBranchId: destinationBranchId,
            lines: [
              {
                sourceLotId: lot.id,
                sourceStockLocationId: fixture.locationId,
                destinationStockLocationId: destination.id,
                quantityUnits: 10,
              },
            ],
          });
          await deps.operations.approveTransfer(
            db,
            { ...scopeOf(fixture), actorId: 'shared_approver' },
            transfer.id
          );
          if (legacySealed && i === 1) {
            // Legacy dispatches have no line attribution and must leave the
            // newer shipment's loose units available for its own receiver.
            await db.pharmacyStockMovement.createMany({
              data: [
                { kind: 'TRANSFER_OUT' as const, disposition: 'AVAILABLE' as const, sign: -1 },
                { kind: 'TRANSFER_IN' as const, disposition: 'IN_TRANSIT' as const, sign: 1 },
              ].map(({ kind, disposition, sign }) => ({
                ...scopeOf(fixture),
                inventoryLotId: lot.id,
                stockLocationId: fixture.locationId,
                kind,
                disposition,
                quantityUnits: sign * 10,
                sealedPackDelta: sign,
                looseUnitDelta: 0,
                idempotencyKey: tag('shared-legacy-dispatch'),
              })),
            });
            await db.pharmacyInterbranchTransfer.update({
              where: { id: transfer.id },
              data: { status: 'DISPATCHED', dispatchedById: ACTOR, dispatchedAt: NOW },
            });
          } else {
            await deps.operations.dispatchTransfer(
              db,
              scopeOf(fixture),
              transfer.id,
              tag('shared-dispatch')
            );
          }
          transfers.push(transfer);
        }
        return { transfers, lot, destinationBranchId };
      });
      for (const index of sealedFirst ? [1, 0] : [0, 1]) {
        const transfer = setup.transfers[index]!;
        const receive = async (units: number) => {
          const key = tag('shared-receipt');
          return inOrg(ORG_A, async (db) => {
            await deps.operations.receiveTransferLine(
              db,
              { ...scopeOf(fixture), branchId: setup.destinationBranchId },
              {
                transferId: transfer.id,
                lineId: transfer.lines[0]!.id,
                receivedUnits: units,
                idempotencyKeyPrefix: key,
              }
            );
            return db.pharmacyStockMovement.findFirstOrThrow({
              where: { idempotencyKey: `${key}:received` },
            });
          });
        };
        if (sealedFirst && index === 1) {
          const results = await Promise.allSettled([receive(10), receive(10)]);
          expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
          expect(results.find((result) => result.status === 'rejected')).toMatchObject({
            reason: { reason: 'CROSS_BRANCH_REFERENCE' },
          });
          expect(results.find((result) => result.status === 'fulfilled')).toMatchObject({
            value: { sealedPackDelta: 1, looseUnitDelta: 0 },
          });
          continue;
        }
        for (const units of index === 0 && sealedFirst ? [3, 7] : [10]) {
          const movement = await receive(units);
          expect(movement).toMatchObject({
            sealedPackDelta: index === 0 ? 0 : 1,
            looseUnitDelta: index === 0 ? units : 0,
          });
        }
      }
      const transit = await inOrg(ORG_A, (db) =>
        db.pharmacyStockBalance.findMany({
          where: { inventoryLotId: setup.lot.id, disposition: 'IN_TRANSIT' },
        })
      );
      expect(transit).toEqual([
        expect.objectContaining({ onHandUnits: 0, sealedPacks: 0, looseUnits: 0 }),
      ]);
    }
  );

  describe('closing receipts attribute transit packaging to their own shipment', () => {
    const WITNESS = 'user_transfer_witness';

    /** The witness lookup reads the platform user table; stand it in for this suite. */
    function withWitness(db: ScopedDb): ScopedDb {
      return new Proxy(db, {
        get(target, prop) {
          if (prop === 'user') return { findFirst: async () => ({ id: WITNESS }) };
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    }

    /**
     * Two 10-unit shipments of one lot share a transit bucket. The source holds
     * one sealed pack and ten loose units, so the first dispatch ships the loose
     * units and the second ships the sealed pack (or is written as a legacy,
     * unattributed sealed dispatch).
     */
    async function sharedShipments(label: string, legacySealed: boolean) {
      const fixture = await scenario(ORG_A, BRANCH_A, label);
      const setup = await inOrg(ORG_A, async (db) => {
        const destinationBranchId = tag(`${label}-destination`);
        await ensureBranch(db, ORG_A, destinationBranchId);
        const destination = await db.pharmacyStockLocation.create({
          data: {
            organizationId: ORG_A,
            branchId: destinationBranchId,
            code: tag(`${label}-destination`),
            name: `${label} destination`,
            kind: 'STORE',
          },
        });
        const { lot } = await stockLot(db, fixture, { expiresAt: LATER, units: 20, label });
        await deps.ledger.breakPack(db, scopeOf(fixture), {
          inventoryLotId: lot.id,
          stockLocationId: fixture.locationId,
          requiredLooseUnits: 10,
          idempotencyKey: tag(`${label}-break`),
          at: NOW,
        });
        const transfers = [];
        for (let i = 0; i < 2; i++) {
          const transfer = await deps.operations.allocateTransfer(db, scopeOf(fixture), {
            toBranchId: destinationBranchId,
            lines: [
              {
                sourceLotId: lot.id,
                sourceStockLocationId: fixture.locationId,
                destinationStockLocationId: destination.id,
                quantityUnits: 10,
              },
            ],
          });
          await deps.operations.approveTransfer(
            db,
            { ...scopeOf(fixture), actorId: `${label}_approver` },
            transfer.id
          );
          if (legacySealed && i === 1) {
            await db.pharmacyStockMovement.createMany({
              data: [
                { kind: 'TRANSFER_OUT' as const, disposition: 'AVAILABLE' as const, sign: -1 },
                { kind: 'TRANSFER_IN' as const, disposition: 'IN_TRANSIT' as const, sign: 1 },
              ].map(({ kind, disposition, sign }) => ({
                ...scopeOf(fixture),
                inventoryLotId: lot.id,
                stockLocationId: fixture.locationId,
                kind,
                disposition,
                quantityUnits: sign * 10,
                sealedPackDelta: sign,
                looseUnitDelta: 0,
                idempotencyKey: tag(`${label}-legacy-dispatch`),
              })),
            });
            await db.pharmacyInterbranchTransfer.update({
              where: { id: transfer.id },
              data: { status: 'DISPATCHED', dispatchedById: ACTOR, dispatchedAt: NOW },
            });
          } else {
            await deps.operations.dispatchTransfer(
              db,
              scopeOf(fixture),
              transfer.id,
              tag(`${label}-dispatch`)
            );
          }
          transfers.push(transfer);
        }
        return { transfers, lot, destinationBranchId };
      });
      const destinationScope = { ...scopeOf(fixture), branchId: setup.destinationBranchId };
      const closingReceipt = (index: number, receivedUnits: number) =>
        inOrg(ORG_A, (db) =>
          deps.operations.receiveTransferWithVariance(withWitness(db), destinationScope, {
            transferId: setup.transfers[index]!.id,
            lines: [{ lineId: setup.transfers[index]!.lines[0]!.id, receivedUnits }],
            variance:
              receivedUnits < 10
                ? { reason: 'Damaged in transit', witnessId: WITNESS, evidenceRef: 'photo-1' }
                : undefined,
            idempotencyKeyPrefix: tag(`${label}-closing`),
          })
        );
      const lineReceipt = (index: number, receivedUnits: number) => {
        const key = tag(`${label}-line-receipt`);
        return inOrg(ORG_A, async (db) => {
          await deps.operations.receiveTransferLine(db, destinationScope, {
            transferId: setup.transfers[index]!.id,
            lineId: setup.transfers[index]!.lines[0]!.id,
            receivedUnits,
            idempotencyKeyPrefix: key,
          });
          return db.pharmacyStockMovement.findFirstOrThrow({
            where: { idempotencyKey: `${key}:received` },
          });
        });
      };
      const transit = () =>
        inOrg(ORG_A, (db) =>
          db.pharmacyStockBalance.findMany({
            where: { inventoryLotId: setup.lot.id, disposition: 'IN_TRANSIT' },
          })
        );
      return { setup, closingReceipt, lineReceipt, transit };
    }

    it('receives a loose shipment in full through the closing receipt', async () => {
      const { closingReceipt, lineReceipt, transit } = await sharedShipments(
        'closing-loose',
        false
      );
      const result = await closingReceipt(0, 10);
      expect(result.transfer.status).toBe('RECEIVED');
      expect(result.variances).toEqual([]);
      expect(await lineReceipt(1, 10)).toMatchObject({ sealedPackDelta: 1, looseUnitDelta: 0 });
      expect(await transit()).toEqual([
        expect.objectContaining({ onHandUnits: 0, sealedPacks: 0, looseUnits: 0 }),
      ]);
    });

    it.each([0, 3])(
      'writes off only the sealed shipment packaging after receiving %i units',
      async (receivedUnits) => {
        const { closingReceipt, lineReceipt, transit } = await sharedShipments(
          `variance-sealed-${receivedUnits}`,
          false
        );
        const result = await closingReceipt(1, receivedUnits);
        expect(result.variances).toEqual([
          expect.objectContaining({
            units: 10 - receivedUnits,
            movement: expect.objectContaining({
              kind: 'WRITE_OFF',
              quantityUnits: receivedUnits - 10,
              sealedPackDelta: receivedUnits === 0 ? -1 : 0,
              looseUnitDelta: receivedUnits === 0 ? 0 : receivedUnits - 10,
            }),
          }),
        ]);
        // The loose shipment still owns its ten loose units.
        expect(await lineReceipt(0, 10)).toMatchObject({ sealedPackDelta: 0, looseUnitDelta: 10 });
        expect(await transit()).toEqual([
          expect.objectContaining({ onHandUnits: 0, sealedPacks: 0, looseUnits: 0 }),
        ]);
      }
    );

    it('breaks only its own pack for a partial receipt with a loose variance', async () => {
      const { setup, closingReceipt, lineReceipt, transit } = await sharedShipments(
        'variance-sealed-break',
        false
      );
      // Seven of the sealed shipment's ten units arrive and three are lost. Its
      // own pack is broken; neither leg takes the loose shipment's units.
      const result = await closingReceipt(1, 7);
      expect(result.variances[0]?.movement).toMatchObject({
        quantityUnits: -3,
        sealedPackDelta: 0,
        looseUnitDelta: -3,
      });
      const breaks = await inOrg(ORG_A, (db) =>
        db.pharmacyStockMovement.findMany({
          where: {
            inventoryLotId: setup.lot.id,
            disposition: 'IN_TRANSIT',
            kind: 'BREAK_PACK',
          },
        })
      );
      expect(breaks).toEqual([
        expect.objectContaining({
          reason: `Interbranch transfer line ${setup.transfers[1]!.lines[0]!.id}`,
          sealedPackDelta: -1,
          looseUnitDelta: 10,
        }),
      ]);
      expect(await lineReceipt(0, 10)).toMatchObject({ sealedPackDelta: 0, looseUnitDelta: 10 });
      expect(await transit()).toEqual([
        expect.objectContaining({ onHandUnits: 0, sealedPacks: 0, looseUnits: 0 }),
      ]);
    });

    it('releases written-off packaging so a legacy shipment can still be received', async () => {
      const { closingReceipt, lineReceipt, transit } = await sharedShipments(
        'variance-legacy',
        true
      );
      const result = await closingReceipt(0, 0);
      expect(result.variances[0]?.movement).toMatchObject({
        quantityUnits: -10,
        sealedPackDelta: 0,
        looseUnitDelta: -10,
      });
      expect(await lineReceipt(1, 10)).toMatchObject({ sealedPackDelta: 1, looseUnitDelta: 0 });
      expect(await transit()).toEqual([
        expect.objectContaining({ onHandUnits: 0, sealedPacks: 0, looseUnits: 0 }),
      ]);
    });
  });

  it('serializes competing dispatches so the same units cannot leave twice', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'transfer-race');
    const ids = await inOrg(ORG_A, async (db) => {
      const destinationBranchId = `branch_race_destination_${suffix}`;
      await ensureBranch(db, ORG_A, destinationBranchId);
      const destination = await db.pharmacyStockLocation.create({
        data: {
          organizationId: ORG_A,
          branchId: destinationBranchId,
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

  it('serializes concurrent replays of the same transfer', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'transfer-replay-race');
    const ids = await inOrg(ORG_A, async (db) => {
      const destinationBranchId = `branch_replay_destination_${suffix}`;
      await ensureBranch(db, ORG_A, destinationBranchId);
      const destination = await db.pharmacyStockLocation.create({
        data: {
          organizationId: ORG_A,
          branchId: destinationBranchId,
          code: `REPLAY-${tag('destination')}`,
          name: 'Replay destination',
          kind: 'STORE',
        },
      });
      const { lot } = await stockLot(db, fixture, {
        expiresAt: LATER,
        units: 40,
        label: 'transfer-replay-race',
      });
      const transfer = await deps.operations.allocateTransfer(db, scopeOf(fixture), {
        toBranchId: destination.branchId,
        lines: [
          {
            sourceLotId: lot.id,
            sourceStockLocationId: fixture.locationId,
            destinationStockLocationId: destination.id,
            quantityUnits: 10,
          },
        ],
      });
      await deps.operations.approveTransfer(
        db,
        { ...scopeOf(fixture), actorId: 'replay_approver' },
        transfer.id
      );
      return { lotId: lot.id, transferId: transfer.id };
    });
    const results = await Promise.allSettled(
      ['replay-a', 'replay-b'].map((label) =>
        inOrg(ORG_A, (db) =>
          deps.operations.dispatchTransfer(db, scopeOf(fixture), ids.transferId, tag(label))
        )
      )
    );
    expect(results.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((one) => one.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ reason: 'INVALID_STATE' }),
      }),
    ]);
    const state = await inOrg(ORG_A, async (db) => ({
      balances: await db.pharmacyStockBalance.findMany({ where: { inventoryLotId: ids.lotId } }),
      movements: await db.pharmacyStockMovement.findMany({
        where: { inventoryLotId: ids.lotId, kind: { in: ['TRANSFER_OUT', 'TRANSFER_IN'] } },
      }),
    }));
    expect(state.movements).toHaveLength(2);
    expect(state.balances.reduce((sum, row) => sum + row.onHandUnits, 0)).toBe(40);
    expect(state.balances.find((row) => row.disposition === 'AVAILABLE')?.onHandUnits).toBe(30);
    expect(state.balances.find((row) => row.disposition === 'IN_TRANSIT')?.onHandUnits).toBe(10);
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

  it('leaves transferred units IN_TRANSIT, never available twice', async () => {
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

    const available = projection.find((row) => row.disposition === 'AVAILABLE')!;
    const inTransit = projection.find((row) => row.disposition === 'IN_TRANSIT')!;
    expect(available.onHandUnits).toBe(30);
    expect(inTransit.onHandUnits).toBe(10);
    // The in-transit half is on hand but not sellable.
    expect(inTransit.blockedBy).toBe('IN_TRANSIT');
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

function drapRecall(db: ScopedDb, fixture: RecallFixture, scope: 'batch' | 'medicine') {
  return deps.drap.ingestDrapNotice(db, scopeOf(fixture), 'MANUAL', {
    kind: 'RECALL',
    sourceReference: tag('drap-overlap'),
    drapRegistrationNumber: fixture.registration,
    ...(scope === 'batch' ? { batchNumbers: [fixture.first.batch.batchNumber] } : {}),
    reason: 'Regulator recall',
  });
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
