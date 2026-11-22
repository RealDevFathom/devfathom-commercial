// @vitest-environment node
/**
 * DEV-957 phase 2 (review B3) on migrated PostgreSQL as the restricted runtime role
 * (forced RLS): units a manager set aside for an offline counter (an open OFF-03 device
 * quota) are protected from every ordinary online stock path, and every safety action
 * still wins.
 *
 * Each case: 12 units on hand, 10 set aside for the counter "Front till".
 *
 *  - ORDINARY: an inter-branch transfer dispatch, a supplier claim and a write-off of good
 *    stock may take only the 2 free units. Asking for more is refused with
 *    HELD_FOR_COUNTER and a sentence naming the counter; taking 2 goes, and the counter
 *    can still consume all 10 of its units (the replay's own quota step).
 *  - SAFETY: a recall, a batch quarantine, a quarantine of part of a lot and the write-off
 *    of expired stock are never refused because a counter holds units. In the same
 *    transaction they release the counter's quota with one audit row per quota, the
 *    released quota no longer reaches the counter's signed stock list (the snapshot reads
 *    open quotas only) and the counter's replay of that lot is refused (the replay reads
 *    `openDeviceLotQuota`, which finds none, and consuming it is refused).
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

// DEV-957 phase 2 (review): offline cash selling is off and cannot be switched on in the
// product; these tests force it on (the selling, replay and set-aside paths), and a test
// that needs it off sets `selling.on = false`.
const selling = vi.hoisted(() => ({ on: true }));
vi.mock('@/lib/pharmacy/offline-cash-selling', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/offline-cash-selling')>()),
  readOfflineCashSelling: vi.fn(async () => ({ enabled: selling.on, available: selling.on })),
  counterSetAsidesInForce: vi.fn(async () => selling.on),
}));


const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG = `org_dev957b3_${suffix}`;
const ACTOR = `user_dev957b3_${suffix}`;
const WITNESS = `user_dev957b3_witness_${suffix}`;
const LATER = new Date('2030-10-01T00:00:00.000Z');
const EARLIER = new Date('2026-01-31T19:00:00.000Z');
const COUNTER = 'Front till';

let unique = 0;
function tag(label: string) {
  unique += 1;
  return `${suffix}-${label}-${unique}`;
}

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  devices: typeof import('@/lib/pharmacy/offline-devices');
  quotas: typeof import('@/lib/pharmacy/offline-quotas');
  operations: typeof import('@/lib/pharmacy/inventory-operations');
};
let deps: Deps;

function inOrg<T>(work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(ORG, work);
}

type Fixture = {
  branchId: string;
  deviceId: string;
  locationId: string;
  lotId: string;
  batchId: string;
  quotaId: string;
};

const scopeOf = (fixture: Pick<Fixture, 'branchId'>) => ({
  organizationId: ORG,
  branchId: fixture.branchId,
  actorId: ACTOR,
});

async function branch(db: ScopedDb, label: string) {
  const branchId = `branch_${tag(label)}`;
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
  await db.pharmacyBranchAssignment.create({
    data: { organizationId: ORG, branchId, userId: WITNESS, active: true },
  });
  return branchId;
}

/** A private branch: 12 loose-countable units on hand, 10 set aside for "Front till". */
async function fixture(
  label: string,
  options: { expiresAt?: Date; legacyGrant?: boolean } = {}
): Promise<Fixture> {
  return inOrg(async (db) => {
    const branchId = await branch(db, label);
    const scope = scopeOf({ branchId });
    const { device } = await deps.devices.enrollPharmacyCounter(db, scope, { name: COUNTER });
    const medicine = await db.medicine.create({
      data: {
        organizationId: ORG,
        productName: `Panadol ${tag(label)}`,
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        otc: true,
        presentations: {
          create: { organizationId: ORG, presentation: 'Tablet', dosageForm: 'TABLET' },
        },
      },
      include: { presentations: true },
    });
    const pack = await db.packLevel.create({
      data: {
        organizationId: ORG,
        presentationId: medicine.presentations[0]!.id,
        versionGroupId: `UNIT-${tag(label)}`,
        version: 1,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        level: 'UNIT',
        unitsPerParent: 1,
      },
    });
    const location = await db.pharmacyStockLocation.create({
      data: { organizationId: ORG, branchId, code: `MAIN-${tag(label)}`, name: 'Main', kind: 'STORE' },
    });
    const expiresAt = options.expiresAt ?? LATER;
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        organizationId: ORG,
        medicineId: medicine.id,
        batchNumber: `B-${tag(label)}`,
        expiresAt,
        expiryPrecision: 'DAY',
      },
    });
    const lot = await db.pharmacyInventoryLot.create({
      data: {
        organizationId: ORG,
        branchId,
        manufacturingBatchId: batch.id,
        packLevelId: pack.id,
        unitsPerPack: 1,
        supplierName: 'Supplier',
        supplierInvoiceRef: `INV-${tag(label)}`,
        unitCostMinor: 10,
        printedMrpMinor: 100,
        receivedExpiresAt: expiresAt,
        receivedExpiryPrecision: 'DAY',
        receivedAt: new Date('2025-12-01T00:00:00.000Z'),
      },
    });
    await db.pharmacyStockMovement.create({
      data: {
        organizationId: ORG,
        branchId,
        inventoryLotId: lot.id,
        stockLocationId: location.id,
        kind: 'RECEIPT',
        disposition: 'AVAILABLE',
        quantityUnits: 12,
        sealedPackDelta: 12,
        looseUnitDelta: 0,
        actorId: ACTOR,
        idempotencyKey: `receipt-${tag(label)}`,
        occurredAt: new Date('2025-12-01T00:00:00.000Z'),
      },
    });
    const quota = options.legacyGrant
      ? await db.pharmacyDeviceLotQuota.create({
          data: {
            organizationId: ORG,
            branchId,
            deviceId: device.id,
            stockLocationId: location.id,
            inventoryLotId: lot.id,
            quotaUnits: 10,
            grantedByActorId: ACTOR,
            grantedAt: new Date('2020-01-01T00:00:00Z'),
          },
        })
      : await deps.quotas.grantDeviceLotQuota(db, scope, {
      deviceId: device.id,
      inventoryLotId: lot.id,
      stockLocationId: location.id,
      units: 10,
    });
    return {
      branchId,
      deviceId: device.id,
      locationId: location.id,
      lotId: lot.id,
      batchId: batch.id,
      quotaId: quota.id,
    };
  });
}

function onHand(made: Fixture, disposition = 'AVAILABLE' as const) {
  return inOrg(async (db) => {
    const balance = await db.pharmacyStockBalance.findFirst({
      where: {
        organizationId: ORG,
        branchId: made.branchId,
        inventoryLotId: made.lotId,
        stockLocationId: made.locationId,
        disposition,
      },
      select: { onHandUnits: true },
    });
    return balance?.onHandUnits ?? 0;
  });
}

/** The replay's own quota step: a counter sale draws its units from its open quota. */
function counterConsumes(made: Fixture, units: number) {
  return inOrg((db) =>
    deps.quotas.consumeDeviceLotQuota(db, scopeOf(made), {
      deviceId: made.deviceId,
      inventoryLotId: made.lotId,
      stockLocationId: made.locationId,
      units,
    })
  );
}

/** What the counter's replay and its next signed LOT_BALANCES see. */
function counterView(made: Fixture) {
  return inOrg(async (db) => ({
    replayQuota: await deps.quotas.openDeviceLotQuota(db, scopeOf(made), {
      deviceId: made.deviceId,
      inventoryLotId: made.lotId,
      stockLocationId: made.locationId,
    }),
    // The exact filter the snapshot route signs LOT_BALANCES from.
    signedQuotas: await db.pharmacyDeviceLotQuota.findMany({
      where: {
        organizationId: ORG,
        branchId: made.branchId,
        deviceId: made.deviceId,
        releasedAt: null,
      },
    }),
    audit: await db.auditLog.findMany({
      where: {
        organizationId: ORG,
        action: 'pharmacyOffline.releaseOfflineQuotaForSafety',
        targetId: made.quotaId,
      },
    }),
  }));
}

async function expectReleased(made: Fixture, cause: string) {
  const view = await counterView(made);
  expect(view.replayQuota).toBeNull();
  expect(view.signedQuotas).toEqual([]);
  expect(view.audit).toHaveLength(1);
  expect(view.audit[0]).toMatchObject({
    actorId: ACTOR,
    targetType: 'PharmacyDeviceLotQuota',
    metadata: {
      branchId: made.branchId,
      deviceId: made.deviceId,
      inventoryLotId: made.lotId,
      stockLocationId: made.locationId,
      releasedUnits: 10,
      cause,
    },
  });
  // The counter's replay of this lot is refused: it owns no quota on it any more.
  await expect(counterConsumes(made, 1)).rejects.toMatchObject({ reason: 'NOT_FOUND' });
}

async function expectHeldForCounter(work: Promise<unknown>) {
  const error = await work.then(
    () => null,
    (failure: unknown) => failure
  );
  expect(error).toMatchObject({ reason: 'HELD_FOR_COUNTER' });
  const message = (error as { userMessage?: string }).userMessage ?? '';
  expect(message).toContain(`counter ${COUNTER}`);
  expect(message).toContain('10 of these units are set aside for offline selling');
  expect(message).toContain('only 2 can be');
}

async function writeOff(made: Fixture, units: number) {
  return inOrg((db) =>
    deps.operations.writeOff(db, scopeOf(made), {
      inventoryLotId: made.lotId,
      stockLocationId: made.locationId,
      units,
      witnessId: WITNESS,
      reason: 'Damaged on the shelf',
      evidenceRef: `photo-${tag('write-off')}`,
      idempotencyKey: tag('write-off'),
    })
  );
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, devices, quotas, operations, roleGuard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/pharmacy/offline-devices'),
    import('@/lib/pharmacy/offline-quotas'),
    import('@/lib/pharmacy/inventory-operations'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = { withTenantDb: scopedDb.withTenantDb, devices, quotas, operations };
  await roleGuard.assertRlsEnforcingRole(scopedDb.withPlatformDb);
  await scopedDb.withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now()) ON CONFLICT (id) DO NOTHING`,
      ORG
    )
  );
  await inOrg(async (db) => {
    await db.organizationDepartment.create({ data: { key: 'PHARMACY', name: 'Pharmacy' } });
    for (const [id, name, title] of [
      [ACTOR, 'Ayesha Khan', 'Manager'],
      [WITNESS, 'Bilal Ahmed', 'Pharmacist'],
    ] as const)
      await db.user.create({
        data: {
          id,
          name,
          email: `${id}@example.test`,
          department: 'PHARMACY',
          title,
          status: 'ACTIVE',
        },
      });
  });
}, 120_000);

describeIfDatabase('DEV-957 phase 2: units set aside for a counter stay out of ordinary removals', () => {
  it('an inter-branch transfer of 9 is refused naming the counter; 2 goes and the counter keeps its 10', async () => {
    const made = await fixture('transfer');
    const destination = await inOrg(async (db) => {
      const branchId = await branch(db, 'transfer-to');
      return db.pharmacyStockLocation.create({
        data: { organizationId: ORG, branchId, code: `DEST-${tag('to')}`, name: 'Dest', kind: 'STORE' },
      });
    });
    const transfer = (units: number) =>
      inOrg(async (db) => {
        const allocated = await deps.operations.allocateTransfer(db, scopeOf(made), {
          toBranchId: destination.branchId,
          lines: [
            {
              sourceLotId: made.lotId,
              sourceStockLocationId: made.locationId,
              destinationStockLocationId: destination.id,
              quantityUnits: units,
            },
          ],
        });
        await deps.operations.approveTransfer(
          db,
          { ...scopeOf(made), actorId: WITNESS },
          allocated.id
        );
        return allocated.id;
      });
    const nine = await transfer(9);
    await expectHeldForCounter(
      inOrg((db) => deps.operations.dispatchTransfer(db, scopeOf(made), nine, tag('dispatch')))
    );
    expect(await onHand(made)).toBe(12);
    const two = await transfer(2);
    const dispatched = await inOrg((db) =>
      deps.operations.dispatchTransfer(db, scopeOf(made), two, tag('dispatch'))
    );
    expect(dispatched.status).toBe('DISPATCHED');
    expect(await onHand(made)).toBe(10);
    await expect(counterConsumes(made, 10)).resolves.toMatchObject({ consumedUnits: 10 });
  });

  it('a supplier claim of 12 is refused naming the counter; 2 goes and the counter keeps its 10', async () => {
    const made = await fixture('claim');
    const claim = (units: number) =>
      inOrg((db) =>
        deps.operations.reserveSupplierClaim(db, scopeOf(made), {
          inventoryLotId: made.lotId,
          reservedUnits: units,
          returnBy: LATER,
        })
      );
    await expectHeldForCounter(claim(12));
    await expect(claim(2)).resolves.toMatchObject({ reservedUnits: 2, status: 'RESERVED' });
    // The claim of 2 and the counter's 10 now hold all 12: a third unit is refused.
    await expect(claim(1)).rejects.toMatchObject({ reason: 'HELD_FOR_COUNTER' });
    await expect(counterConsumes(made, 10)).resolves.toMatchObject({ consumedUnits: 10 });
  });

  it('a write-off of 9 good units is refused naming the counter; 2 goes and the counter keeps its 10', async () => {
    const made = await fixture('write-off');
    await expectHeldForCounter(writeOff(made, 9));
    expect(await onHand(made)).toBe(12);
    await expect(writeOff(made, 2)).resolves.toMatchObject({
      movement: { kind: 'WRITE_OFF', quantityUnits: -2 },
    });
    expect(await onHand(made)).toBe(10);
    await expect(counterConsumes(made, 10)).resolves.toMatchObject({ consumedUnits: 10 });
    // Nothing was released by an ordinary removal.
    expect((await counterView(made)).audit).toEqual([]);
  });

  it('more than is on hand still says there is not enough stock, not that a counter holds it', async () => {
    const made = await fixture('over');
    await expect(writeOff(made, 13)).rejects.toMatchObject({ reason: 'INSUFFICIENT_STOCK' });
  });
});

describeIfDatabase('DEV-957 phase 2: safety actions always win over units set aside for a counter', () => {
  it('a recall goes through and releases the quota in the same transaction, audited', async () => {
    const made = await fixture('recall');
    await inOrg((db) =>
      deps.operations.createRecall(db, scopeOf(made), {
        batchId: made.batchId,
        reference: `RC-${tag('recall')}`,
        reason: 'Manufacturer recall',
      })
    );
    await expectReleased(made, 'RECALL');
  });

  it('a recall that fails afterwards releases nothing: the release is in its transaction', async () => {
    const made = await fixture('recall-rollback');
    await expect(
      inOrg(async (db) => {
        await deps.operations.createRecall(db, scopeOf(made), {
          batchId: made.batchId,
          reference: `RC-${tag('rollback')}`,
          reason: 'Manufacturer recall',
        });
        throw new Error('later step failed');
      })
    ).rejects.toThrow('later step failed');
    const view = await counterView(made);
    expect(view.replayQuota).toMatchObject({ id: made.quotaId, releasedAt: null });
    expect(view.audit).toEqual([]);
  });

  it('quarantining the batch goes through and releases the quota, audited', async () => {
    const made = await fixture('batch-quarantine');
    await inOrg((db) =>
      deps.operations.setManufacturingBatchState(
        db,
        ORG,
        { manufacturingBatchId: made.batchId, state: 'QUARANTINED', reason: 'Suspect storage' },
        ACTOR
      )
    );
    await expectReleased(made, 'QUARANTINE');
  });

  it('quarantining 5 units (into the counter’s 10) goes through and releases the quota, audited', async () => {
    const made = await fixture('part-quarantine');
    await inOrg((db) =>
      deps.operations.quarantinePart(db, scopeOf(made), {
        inventoryLotId: made.lotId,
        stockLocationId: made.locationId,
        units: 5,
        reason: 'Packs damaged by water',
        idempotencyKeyPrefix: tag('quarantine'),
      })
    );
    expect(await onHand(made)).toBe(7);
    await expectReleased(made, 'QUARANTINE');
  });

  it('quarantining only the 2 free units leaves the counter its 10', async () => {
    const made = await fixture('free-quarantine');
    await inOrg((db) =>
      deps.operations.quarantinePart(db, scopeOf(made), {
        inventoryLotId: made.lotId,
        stockLocationId: made.locationId,
        units: 2,
        reason: 'Returned from a failed delivery',
        idempotencyKeyPrefix: tag('quarantine'),
      })
    );
    const view = await counterView(made);
    expect(view.replayQuota).toMatchObject({ id: made.quotaId, releasedAt: null });
    expect(view.audit).toEqual([]);
    await expect(counterConsumes(made, 10)).resolves.toMatchObject({ consumedUnits: 10 });
  });

  it('moving expiring stock off sale goes through and releases the quota as an expiry, audited', async () => {
    const made = await fixture('expiry-quarantine');
    await inOrg((db) =>
      deps.operations.quarantinePart(db, scopeOf(made), {
        inventoryLotId: made.lotId,
        stockLocationId: made.locationId,
        units: 12,
        reason: 'Expires this month',
        idempotencyKeyPrefix: tag('expiry'),
        cause: 'EXPIRY',
      })
    );
    expect(await onHand(made)).toBe(0);
    await expectReleased(made, 'EXPIRY');
  });

  it('writing off expired stock is never refused for a counter and releases its quota, audited', async () => {
    const made = await fixture('expired-write-off', { expiresAt: EARLIER });
    await expect(writeOff(made, 12)).resolves.toMatchObject({
      movement: { kind: 'WRITE_OFF', quantityUnits: -12 },
    });
    expect(await onHand(made)).toBe(0);
    await expectReleased(made, 'EXPIRY');
  });
});

describeIfDatabase('DEV-957 phase 2 (review round 2): with offline cash selling off a set-aside holds nothing', () => {
  it('a transfer of 9, a supplier claim of 12 and a write-off of 9 all go past an existing set-aside of 10, which is kept', async () => {
    selling.on = false;
    try {
      const claimed = await fixture('off-claim');
      await expect(
        inOrg((db) =>
          deps.operations.reserveSupplierClaim(db, scopeOf(claimed), {
            inventoryLotId: claimed.lotId,
            reservedUnits: 12,
            returnBy: LATER,
          })
        )
      ).resolves.toMatchObject({ reservedUnits: 12, status: 'RESERVED' });

      const written = await fixture('off-write-off');
      await expect(writeOff(written, 9)).resolves.toMatchObject({
        movement: { kind: 'WRITE_OFF', quantityUnits: -9 },
      });
      expect(await onHand(written)).toBe(3);

      const moved = await fixture('off-transfer');
      const destination = await inOrg(async (db) => {
        const branchId = await branch(db, 'off-transfer-to');
        return db.pharmacyStockLocation.create({
          data: { organizationId: ORG, branchId, code: `DEST-${tag('off')}`, name: 'Dest', kind: 'STORE' },
        });
      });
      const transferId = await inOrg(async (db) => {
        const allocated = await deps.operations.allocateTransfer(db, scopeOf(moved), {
          toBranchId: destination.branchId,
          lines: [
            {
              sourceLotId: moved.lotId,
              sourceStockLocationId: moved.locationId,
              destinationStockLocationId: destination.id,
              quantityUnits: 9,
            },
          ],
        });
        await deps.operations.approveTransfer(db, { ...scopeOf(moved), actorId: WITNESS }, allocated.id);
        return allocated.id;
      });
      const dispatched = await inOrg((db) =>
        deps.operations.dispatchTransfer(db, scopeOf(moved), transferId, tag('dispatch'))
      );
      expect(dispatched.status).toBe('DISPATCHED');
      expect(await onHand(moved)).toBe(3);

      // Nothing was deleted or released: each set-aside is still there, open, untouched.
      for (const made of [claimed, written, moved]) {
        const quota = await inOrg((db) =>
          db.pharmacyDeviceLotQuota.findFirstOrThrow({ where: { id: made.quotaId } })
        );
        expect(quota).toMatchObject({ quotaUnits: 10, consumedUnits: 0, releasedAt: null });
      }
    } finally {
      selling.on = true;
    }
  });
});

describeIfDatabase('DEV-957 phase 3 stock promises', () => {
  it('only offers the two unpromised units to a customer order or a refill', async () => {
    const made = await fixture('ordering');
    const { reservationCandidates, listStorefrontCatalog } = await import('./customer-ordering');
    await inOrg(async (db) => {
      const batch = await db.pharmacyManufacturingBatch.findUniqueOrThrow({
        where: { id: made.batchId },
      });
      const lot = await db.pharmacyInventoryLot.findUniqueOrThrow({ where: { id: made.lotId } });
      const rows = await reservationCandidates(
        db,
        scopeOf(made),
        batch.medicineId,
        lot.packLevelId!
      );
      expect(rows.find((row) => row.inventoryLotId === made.lotId)?.availableUnits).toBe(2);
      const catalog = await listStorefrontCatalog(db, scopeOf(made));
      expect(catalog.find((row) => row.medicineId === batch.medicineId)?.availableUnits).toBe(2);
    });
  });

  it('stops a stock-take approval from reducing free stock below outstanding promises', async () => {
    const made = await fixture('stocktake');
    const count = await inOrg((db) =>
      deps.operations.createCount(db, scopeOf(made), {
        readings: [
          {
            inventoryLotId: made.lotId,
            stockLocationId: made.locationId,
            countedSealedPacks: 8,
            countedLooseUnits: 0,
          },
        ],
        varianceThreshold: 100,
      })
    );
    await expect(
      inOrg((db) =>
        deps.operations.approveCount(
          db,
          scopeOf(made),
          count.id,
          tag('approval'),
          'Counted on shelf'
        )
      )
    ).rejects.toMatchObject({ reason: 'HELD_FOR_COUNTER' });
    expect(await onHand(made)).toBe(12);
  });
});

describeIfDatabase('DEV-957 historical set-asides', () => {
  it('replays in an empty shadow schema without the deployment ledger', async () => {
    const owner = new pg.Client({
      connectionString:
        process.env.M8_TEST_OWNER_DATABASE_URL ?? process.env.PHARMACY_TEST_OWNER_DATABASE_URL,
    });
    await owner.connect();
    try {
      await owner.query('CREATE TEMP TABLE organizations (id text)');
      await owner.query('SET search_path = pg_temp');
      expect(
        (await owner.query("SELECT to_regclass('_prisma_migrations') AS ledger")).rows[0].ledger
      ).toBeNull();
      const sql = readFileSync(
        'prisma/migrations/20261121231800_reconcile_offline_set_asides/migration.sql',
        'utf8'
      );
      await expect(owner.query(sql)).resolves.toBeDefined();
    } finally {
      await owner.end();
    }
  });

  it('retires pre-replay grants once with an audit and preserves newer grants', async () => {
    const old = await fixture('old-set-aside', { legacyGrant: true });
    const current = await fixture('current-set-aside');
    const owner = new pg.Client({
      connectionString:
        process.env.M8_TEST_OWNER_DATABASE_URL ?? process.env.PHARMACY_TEST_OWNER_DATABASE_URL,
    });
    await owner.connect();
    try {
      const sql = readFileSync(
        'prisma/migrations/20261121231800_reconcile_offline_set_asides/migration.sql',
        'utf8'
      );
      await owner.query(sql);
      await owner.query(sql);
    } finally {
      await owner.end();
    }
    await inOrg(async (db) => {
      expect(
        (await db.pharmacyDeviceLotQuota.findFirstOrThrow({ where: { id: old.quotaId } }))
          .releasedAt
      ).toBeInstanceOf(Date);
      expect(
        (await db.pharmacyDeviceLotQuota.findFirstOrThrow({ where: { id: current.quotaId } }))
          .releasedAt
      ).toBeNull();
      expect(
        await db.auditLog.count({
          where: { action: 'pharmacyOffline.releaseLegacyQuota', targetId: old.quotaId },
        })
      ).toBe(1);
    });
  });
});

describeIfDatabase('DEV-957 quota grant after reservations', () => {
  it('keeps the last two units reserved when another counter prepares', async () => {
    const made = await fixture('last-two');
    await inOrg((db) =>
      deps.operations.reserveSupplierClaim(db, scopeOf(made), {
        inventoryLotId: made.lotId,
        reservedUnits: 2,
        returnBy: LATER,
      })
    );
    const other = await inOrg((db) =>
      deps.devices.enrollPharmacyCounter(db, scopeOf(made), { name: 'Other counter' })
    );
    await expect(
      inOrg((db) =>
        deps.quotas.grantDeviceLotQuota(db, scopeOf(made), {
          deviceId: other.device.id,
          inventoryLotId: made.lotId,
          stockLocationId: made.locationId,
          units: 2,
        })
      )
    ).rejects.toThrow();
  });
});
