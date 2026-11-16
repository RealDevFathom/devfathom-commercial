/**
 * PH-OFF / OFF-01..03 against migrated PostgreSQL with FORCED row level
 * security.
 *
 * These cases only mean anything against a real database. "The command log is
 * append-only" is a trigger; "a lease never overlaps another counter's block" is
 * a trigger holding a row lock; "the quotas of every counter cannot exceed what
 * the branch holds" is a trigger locking the balance row; "another tenant's
 * counters are invisible" is an RLS predicate; and "a concurrent last-unit grant
 * cannot oversell" is that lock taken by two genuinely concurrent transactions.
 * A mocked client would assert that the code calls Prisma, not that any of those
 * hold. Skipped (never silently passed) when the database URL is absent.
 *
 * The runtime role is asserted NOSUPERUSER/NOBYPASSRLS first: with either
 * attribute the tenant cases would read straight through every policy and pass
 * for the wrong reason.
 *
 * TWO STRUCTURAL RULES, both borrowed from the ledger suite next door:
 *
 *   1. EVERY TEST GETS ITS OWN COUNTER AND ITS OWN LOT (`scenario()`), because
 *      leases and quotas are keyed by device and bucket and tests sharing one
 *      would consume each other's numbers and units.
 *   2. AN EXPECTED DATABASE ERROR GETS ITS OWN TRANSACTION. A failed statement
 *      aborts the whole PostgreSQL transaction, so a test that provokes a
 *      trigger and then reads back must do the read from a new one.
 *
 * ON RLS ORDERING. The append-only tables have SELECT and INSERT policies and no
 * UPDATE/DELETE policy, so a tenant connection's UPDATE or DELETE matches zero
 * rows and the guard trigger never fires. That is the FIRST guard working, and
 * the assertions below say so honestly: they assert the row did not change,
 * rather than expecting an exception the policy pre-empts.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  retirePharmacyRegulatoryRules,
  seedPharmacyRegulatoryProfile,
} from '@/lib/test-support/pharmacy-regulatory';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_wha1191_a_${suffix}`;
const ORG_B = `org_wha1191_b_${suffix}`;
// A branch id is a primary key, so it is unique across the whole table and not
// only within one organization. Suffix them per run or a second run of this
// suite silently conflicts with the rows the first one left behind.
const BRANCH_A = `branch_a_${suffix}`;
const BRANCH_A_TWO = `branch_a_two_${suffix}`;
const BRANCH_B = `branch_b_${suffix}`;
const ACTOR = 'user_pharmacist';

const NOW = new Date('2026-09-02T09:00:00.000Z');
const LATER = new Date('2027-10-01T00:00:00.000Z');
const ISSUED_AT = new Date('2026-09-02T09:00:00.000Z');
const EXPIRES_AT = new Date('2026-09-02T21:00:00.000Z');

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  devices: typeof import('./offline-devices');
  snapshots: typeof import('./offline-snapshots');
  leases: typeof import('./offline-receipt-leases');
  quotas: typeof import('./offline-quotas');
  log: typeof import('./offline-command-log');
};
let deps: Deps;

function inOrg<T>(organizationId: string, work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(organizationId, work);
}

/** Run a statement expected to fail and return its message, in its own
 * transaction so the abort cannot poison a later read. */
function refusal(
  organizationId: string,
  work: (db: ScopedDb) => Promise<unknown>
): Promise<string> {
  return inOrg(organizationId, (db) =>
    work(db)
      .then(() => 'ACCEPTED — the statement was expected to fail')
      .catch((error: Error) => error.message)
  );
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

type Scenario = {
  deviceSecret: string;
  organizationId: string;
  branchId: string;
  deviceId: string;
  locationId: string;
  lotId: string;
  medicineId: string;
};

/**
 * A private branch fixture for one test: one enrolled counter, one stock
 * location, and one lot holding `units` canonical units at 10 per strip.
 */
async function scenario(
  organizationId: string,
  branchId: string,
  label: string,
  options: { units?: number } = {}
): Promise<Scenario> {
  const units = options.units ?? 100;
  return inOrg(organizationId, async (db) => {
    await ensureBranch(db, organizationId, branchId);
    const scope = { organizationId, branchId, actorId: ACTOR };
    const { device, secret } = await deps.devices.enrollPharmacyCounter(db, scope, {
      name: `Counter ${tag(label)}`,
    });

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
    const location = await db.pharmacyStockLocation.create({
      data: {
        organizationId,
        branchId,
        code: `MAIN-${tag(label)}`,
        name: 'Main store',
        kind: 'STORE',
      },
    });
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        organizationId,
        medicineId: medicine.id,
        batchNumber: `B-${tag(label)}`,
        expiresAt: LATER,
        expiryPrecision: 'DAY',
      },
    });
    const lot = await db.pharmacyInventoryLot.create({
      data: {
        organizationId,
        branchId,
        manufacturingBatchId: batch.id,
        packLevelId: packLevel.id,
        unitsPerPack: 10,
        supplierName: `Supplier ${tag(label)}`,
        supplierInvoiceRef: `INV-${tag(label)}`,
        unitCostMinor: 500,
        printedMrpMinor: 1_000,
        receivedExpiresAt: LATER,
        receivedExpiryPrecision: 'DAY',
        receivedAt: NOW,
      },
    });
    // The balance projection is maintained by the ledger trigger from movements,
    // so the fixture stocks the lot the way the product does.
    await db.pharmacyStockMovement.create({
      data: {
        organizationId,
        branchId,
        inventoryLotId: lot.id,
        stockLocationId: location.id,
        kind: 'RECEIPT',
        disposition: 'AVAILABLE',
        quantityUnits: units,
        sealedPackDelta: Math.floor(units / 10),
        looseUnitDelta: units % 10,
        actorId: ACTOR,
        idempotencyKey: `receipt-${tag(label)}`,
        occurredAt: NOW,
      },
    });

    return {
      organizationId,
      branchId,
      deviceId: device.id,
      deviceSecret: secret,
      locationId: location.id,
      lotId: lot.id,
      medicineId: medicine.id,
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

function bucketOf(fixture: Scenario) {
  return { inventoryLotId: fixture.lotId, stockLocationId: fixture.locationId };
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, devices, snapshots, leases, quotas, log, roleGuard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./offline-devices'),
    import('./offline-snapshots'),
    import('./offline-receipt-leases'),
    import('./offline-quotas'),
    import('./offline-command-log'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = { withTenantDb: scopedDb.withTenantDb, devices, snapshots, leases, quotas, log };
  await roleGuard.assertRlsEnforcingRole(scopedDb.withPlatformDb);
  // Integrated tip (20261012120000_visibility_context_anchors): tenant rows must reference an
  // existing organization, so anchor this suite's synthetic tenants before any test runs.
  await scopedDb.withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       SELECT id, id, id, id, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now() FROM unnest($1::text[]) AS id
       ON CONFLICT (id) DO NOTHING`,
      [ORG_A, ORG_B]
    )
  );
}, 180_000);

// ── OFF-01 — enrollment ─────────────────────────────────────────────────────

describeIfDatabase('PH-OFF OFF-01 — counter enrollment', () => {
  it('stores only the hash and returns the raw secret exactly once', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'enroll');
    const { secret, stored } = await inOrg(ORG_A, async (db) => {
      const enrolled = await deps.devices.enrollPharmacyCounter(db, scopeOf(fixture), {
        name: 'Counter 2',
      });
      return {
        secret: enrolled.secret,
        stored: await db.pharmacyRegisteredDevice.findFirstOrThrow({
          where: { id: enrolled.device.id },
        }),
      };
    });

    expect(secret.startsWith('pcd_')).toBe(true);
    expect(stored.deviceSecretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.deviceSecretHash).not.toContain(secret);
    expect(stored.kind).toBe('PHARMACY_COUNTER');
    expect(stored.status).toBe('ACTIVE');
  });

  it('resolves a counter by its raw secret and refuses a foreign-shaped token', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'resolve');
    const resolved = await inOrg(ORG_A, async (db) => {
      const enrolled = await deps.devices.enrollPharmacyCounter(db, scopeOf(fixture), {
        name: 'Counter 3',
      });
      return {
        byOwnSecret: await deps.devices.resolvePharmacyCounterBySecret(db, enrolled.secret),
        // A restaurant device secret must never resolve a pharmacy counter.
        byRestaurantSecret: await deps.devices.resolvePharmacyCounterBySecret(db, 'rdk_whatever'),
        byGarbage: await deps.devices.resolvePharmacyCounterBySecret(db, 'nonsense'),
      };
    });
    expect(resolved.byOwnSecret).not.toBeNull();
    expect(resolved.byRestaurantSecret).toBeNull();
    expect(resolved.byGarbage).toBeNull();
  });

  it('rotation invalidates the previous secret and refuses a stale rotation', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'rotate');
    const outcome = await inOrg(ORG_A, async (db) => {
      const enrolled = await deps.devices.enrollPharmacyCounter(db, scopeOf(fixture), {
        name: 'Counter 4',
      });
      const first = await db.pharmacyRegisteredDevice.findFirstOrThrow({
        where: { id: enrolled.device.id },
      });
      const rotated = await deps.devices.rotatePharmacyCounterSecret(
        db,
        scopeOf(fixture),
        enrolled.device.id,
        first.deviceSecretHash
      );
      return {
        oldResolves: await deps.devices.resolvePharmacyCounterBySecret(db, enrolled.secret),
        newResolves: await deps.devices.resolvePharmacyCounterBySecret(db, rotated.secret),
        staleRotation: await deps.devices
          .rotatePharmacyCounterSecret(
            db,
            scopeOf(fixture),
            enrolled.device.id,
            first.deviceSecretHash
          )
          .then(() => 'ACCEPTED')
          .catch((error: Error) => error.message),
      };
    });
    expect(outcome.oldResolves).toBeNull();
    expect(outcome.newResolves).not.toBeNull();
    expect(outcome.staleRotation).toBe('STALE_ROTATION');
  });

  it('a revoked counter keeps its row and cannot be rotated', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'revoke');
    const revoked = await inOrg(ORG_A, async (db) => {
      await deps.devices.revokePharmacyCounter(db, scopeOf(fixture), fixture.deviceId, NOW);
      return db.pharmacyRegisteredDevice.findFirstOrThrow({ where: { id: fixture.deviceId } });
    });
    expect(revoked).toMatchObject({ status: 'REVOKED', revokedAt: NOW });

    const rotate = await refusal(ORG_A, (db) =>
      deps.devices.rotatePharmacyCounterSecret(
        db,
        scopeOf(fixture),
        fixture.deviceId,
        revoked.deviceSecretHash
      )
    );
    expect(rotate).toBe('REVOKED');
  });

  it('the revocation state and its timestamp can never disagree', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'revocation-check');
    const message = await refusal(ORG_A, (db) =>
      db.pharmacyRegisteredDevice.update({
        where: { organizationId_id: { organizationId: ORG_A, id: fixture.deviceId } },
        data: { status: 'REVOKED' },
      })
    );
    expect(message).toContain('pharmacy_registered_devices_revocation_check');
  });

  it('another tenant cannot see or resolve this tenant’s counters', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'tenant');
    const secret = await inOrg(ORG_A, async (db) => {
      const enrolled = await deps.devices.enrollPharmacyCounter(db, scopeOf(fixture), {
        name: 'Counter 5',
      });
      return enrolled.secret;
    });
    await inOrg(ORG_B, async (db) => {
      await ensureBranch(db, ORG_B, BRANCH_B);
      expect(
        await db.pharmacyRegisteredDevice.findMany({ where: { id: fixture.deviceId } })
      ).toEqual([]);
      // The hash index is global, but row level security still filters the read.
      expect(await deps.devices.resolvePharmacyCounterBySecret(db, secret)).toBeNull();
    });
  });

  it('a counter cannot be enrolled against a sibling branch it does not belong to', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'branch-scope');
    await inOrg(ORG_A, (db) => ensureBranch(db, ORG_A, BRANCH_A_TWO));
    const sibling = await inOrg(ORG_A, (db) =>
      db.pharmacyRegisteredDevice.findMany({
        where: { organizationId: ORG_A, branchId: BRANCH_A_TWO, id: fixture.deviceId },
      })
    );
    // Branch is a scope INSIDE the tenant boundary; the predicate is the query's.
    expect(sibling).toEqual([]);
  });
});

// ── OFF-01 — signed snapshots ───────────────────────────────────────────────

describeIfDatabase('PH-OFF OFF-01 — signed snapshots', () => {
  it('issues monotonic versions per kind and signs what it stores', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'snapshot');
    const issued = await inOrg(ORG_A, async (db) => {
      const first = await deps.snapshots.issueOfflineSnapshot(db, scopeOf(fixture), {
        deviceId: fixture.deviceId,
        kind: 'PRICES',
        payload: { priceMinor: 100 },
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
      });
      const second = await deps.snapshots.issueOfflineSnapshot(db, scopeOf(fixture), {
        deviceId: fixture.deviceId,
        kind: 'PRICES',
        payload: { priceMinor: 120 },
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
      });
      const otherKind = await deps.snapshots.issueOfflineSnapshot(db, scopeOf(fixture), {
        deviceId: fixture.deviceId,
        kind: 'LICENCE',
        payload: { valid: true },
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
      });
      return { first, second, otherKind };
    });

    expect(issued.first.envelope.version).toBe(1);
    expect(issued.second.envelope.version).toBe(2);
    // Kinds version independently: refreshing prices does not invalidate licence.
    expect(issued.otherKind.envelope.version).toBe(1);
    expect(
      deps.snapshots.verifySnapshotSignature(issued.second.envelope, issued.second.signature)
    ).toBe(true);
  });

  it('a stored snapshot cannot be edited: the refresh is a new version', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'snapshot-append');
    const snapshot = await inOrg(ORG_A, (db) =>
      deps.snapshots.issueOfflineSnapshot(db, scopeOf(fixture), {
        deviceId: fixture.deviceId,
        kind: 'RULES',
        payload: { controlled: false },
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
      })
    );

    // No UPDATE policy exists for this table, so the tenant's UPDATE matches
    // zero rows and the append-only trigger is never reached. That IS the first
    // guard: the assertion is that nothing changed, not that a trigger fired.
    const updated = await inOrg(
      ORG_A,
      (db) =>
        db.$executeRaw`UPDATE pharmacy_offline_snapshots SET "payloadHash" = ${'0'.repeat(64)} WHERE id = ${snapshot.id}`
    );
    const deleted = await inOrg(
      ORG_A,
      (db) => db.$executeRaw`DELETE FROM pharmacy_offline_snapshots WHERE id = ${snapshot.id}`
    );
    expect(updated).toBe(0);
    expect(deleted).toBe(0);

    const after = await inOrg(ORG_A, (db) =>
      db.pharmacyOfflineSnapshot.findFirstOrThrow({ where: { id: snapshot.id } })
    );
    expect(after.payloadHash).toBe(snapshot.envelope.payloadHash);
  });

  it('refuses to hand a revoked counter fresh prices to act on', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'snapshot-revoked');
    await inOrg(ORG_A, (db) =>
      deps.devices.revokePharmacyCounter(db, scopeOf(fixture), fixture.deviceId, NOW)
    );
    const message = await refusal(ORG_A, (db) =>
      deps.snapshots.issueOfflineSnapshot(db, scopeOf(fixture), {
        deviceId: fixture.deviceId,
        kind: 'PRICES',
        payload: { priceMinor: 100 },
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
      })
    );
    expect(message).toBe('DEVICE_NOT_USABLE');
  });

  it('refuses a window that does not open', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'snapshot-window');
    const message = await refusal(ORG_A, (db) =>
      deps.snapshots.issueOfflineSnapshot(db, scopeOf(fixture), {
        deviceId: fixture.deviceId,
        kind: 'TAX',
        payload: {},
        issuedAt: EXPIRES_AT,
        expiresAt: ISSUED_AT,
      })
    );
    expect(message).toBe('INVALID_WINDOW');
  });
});

// ── OFF-01 / invariant 16 — receipt-number leases ───────────────────────────

describeIfDatabase('PH-OFF OFF-01 — pre-allocated receipt leases (§8A invariant 16)', () => {
  it('reserves a block below the sequence high-water mark and issues from it', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'lease');
    const outcome = await inOrg(ORG_A, async (db) => {
      const lease = await deps.leases.reserveReceiptNumberBlock(db, scopeOf(fixture), {
        deviceId: fixture.deviceId,
        size: 3,
      });
      const issued = [
        await deps.leases.issueLeasedReceiptNumber(db, scopeOf(fixture), fixture.deviceId),
        await deps.leases.issueLeasedReceiptNumber(db, scopeOf(fixture), fixture.deviceId),
        await deps.leases.issueLeasedReceiptNumber(db, scopeOf(fixture), fixture.deviceId),
      ];
      const exhausted = await deps.leases
        .issueLeasedReceiptNumber(db, scopeOf(fixture), fixture.deviceId)
        .then(() => 'ACCEPTED')
        .catch((error: Error) => error.message);
      const sequence = await db.pharmacyReceiptNumberSequence.findFirstOrThrow({
        where: { organizationId: ORG_A, branchId: BRANCH_A, deviceId: fixture.deviceId },
      });
      return { lease, issued: issued.map((row) => row.receiptNumber), exhausted, sequence };
    });

    expect(outcome.lease).toMatchObject({ blockStart: 1, blockEnd: 3, nextNumber: 1 });
    expect(outcome.issued).toEqual([1, 2, 3]);
    // Rather than inventing a number, the counter must reconnect.
    expect(outcome.exhausted).toBe('LEASE_EXHAUSTED');
    // The sequence already moved past the block, so the ONLINE path resumes at 4.
    expect(outcome.sequence.nextNumber).toBe(4);
  });

  it('a second reservation never overlaps the first', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'lease-two');
    const blocks = await inOrg(ORG_A, async (db) => [
      await deps.leases.reserveReceiptNumberBlock(db, scopeOf(fixture), {
        deviceId: fixture.deviceId,
        size: 5,
      }),
      await deps.leases.reserveReceiptNumberBlock(db, scopeOf(fixture), {
        deviceId: fixture.deviceId,
        size: 5,
      }),
    ]);
    expect(blocks[0]).toMatchObject({ blockStart: 1, blockEnd: 5 });
    expect(blocks[1]).toMatchObject({ blockStart: 6, blockEnd: 10 });
  });

  it('the database refuses a hand-written block that overlaps a reserved one', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'lease-overlap');
    await inOrg(ORG_A, (db) =>
      deps.leases.reserveReceiptNumberBlock(db, scopeOf(fixture), {
        deviceId: fixture.deviceId,
        size: 10,
      })
    );
    const message = await refusal(ORG_A, (db) =>
      db.pharmacyReceiptNumberLease.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          deviceId: fixture.deviceId,
          blockStart: 5,
          blockEnd: 8,
          nextNumber: 5,
          issuedToActorId: ACTOR,
        },
      })
    );
    expect(message).toContain('RECEIPT_LEASE_OVERLAP');
  });

  it('the database refuses a block the sequence has not reserved', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'lease-unreserved');
    await inOrg(ORG_A, (db) =>
      deps.leases.reserveReceiptNumberBlock(db, scopeOf(fixture), {
        deviceId: fixture.deviceId,
        size: 3,
      })
    );
    // Numbers 4..6 are still the online path's to give out.
    const message = await refusal(ORG_A, (db) =>
      db.pharmacyReceiptNumberLease.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          deviceId: fixture.deviceId,
          blockStart: 4,
          blockEnd: 6,
          nextNumber: 4,
          issuedToActorId: ACTOR,
        },
      })
    );
    expect(message).toContain('RECEIPT_LEASE_NOT_RESERVED');
  });

  it('a lease cursor never rewinds and its block is never rewritten', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'lease-immutable');
    const lease = await inOrg(ORG_A, async (db) => {
      const reserved = await deps.leases.reserveReceiptNumberBlock(db, scopeOf(fixture), {
        deviceId: fixture.deviceId,
        size: 4,
      });
      await deps.leases.issueLeasedReceiptNumber(db, scopeOf(fixture), fixture.deviceId);
      await deps.leases.issueLeasedReceiptNumber(db, scopeOf(fixture), fixture.deviceId);
      return reserved;
    });

    const rewind = await refusal(ORG_A, (db) =>
      db.pharmacyReceiptNumberLease.update({
        where: { organizationId_id: { organizationId: ORG_A, id: lease.id } },
        data: { nextNumber: 1 },
      })
    );
    expect(rewind).toContain('RECEIPT_LEASE_REWIND');

    const rewrite = await refusal(ORG_A, (db) =>
      db.pharmacyReceiptNumberLease.update({
        where: { organizationId_id: { organizationId: ORG_A, id: lease.id } },
        data: { blockEnd: 99 },
      })
    );
    expect(rewrite).toContain('RECEIPT_LEASE_IMMUTABLE');

    // As with the other append-only tables, the missing DELETE policy pre-empts
    // the no-delete trigger: zero rows match, so nothing is removed.
    const deleted = await inOrg(
      ORG_A,
      (db) => db.$executeRaw`DELETE FROM pharmacy_receipt_number_leases WHERE id = ${lease.id}`
    );
    expect(deleted).toBe(0);
    expect(
      await inOrg(ORG_A, (db) =>
        db.pharmacyReceiptNumberLease.findFirstOrThrow({ where: { id: lease.id } })
      )
    ).toMatchObject({ blockStart: 1, blockEnd: 4, nextNumber: 3 });
  });

  it('two counters of one branch are never handed the same number', async () => {
    const first = await scenario(ORG_A, BRANCH_A, 'lease-counter-a');
    const second = await inOrg(ORG_A, async (db) => {
      const enrolled = await deps.devices.enrollPharmacyCounter(db, scopeOf(first), {
        name: `Counter ${tag('lease-counter-b')}`,
      });
      return enrolled.device.id;
    });

    const blocks = await inOrg(ORG_A, async (db) => ({
      a: await deps.leases.reserveReceiptNumberBlock(db, scopeOf(first), {
        deviceId: first.deviceId,
        size: 5,
      }),
      b: await deps.leases.reserveReceiptNumberBlock(db, scopeOf(first), {
        deviceId: second,
        size: 5,
      }),
    }));

    // Sequences are per DEVICE, so the two counters number independently and a
    // collision is impossible by construction rather than by convention.
    expect(blocks.a).toMatchObject({ blockStart: 1, blockEnd: 5 });
    expect(blocks.b).toMatchObject({ blockStart: 1, blockEnd: 5 });
    expect(blocks.a.deviceId).not.toBe(blocks.b.deviceId);
  });
});

// ── OFF-01 — the append-only command log ────────────────────────────────────

describeIfDatabase('PH-OFF OFF-01 — the append-only command log', () => {
  const command = (fixture: Scenario, over: Record<string, unknown> = {}) => ({
    deviceId: fixture.deviceId,
    sequence: 1,
    idempotencyKey: `key-${fixture.deviceId}-1`,
    action: 'CASH_OTC_SALE' as const,
    payload: { lines: [{ medicineId: fixture.medicineId, units: 1 }] },
    clientOriginAt: NOW,
    receiptNumber: 1,
    ...over,
  });

  it('records once and reports a re-presented key as a replay', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'log');
    const outcome = await inOrg(ORG_A, async (db) => {
      const first = await deps.log.recordOfflineCommand(db, scopeOf(fixture), command(fixture));
      await deps.log.settleOfflineCommand(
        db,
        scopeOf(fixture),
        { commandId: first.command.id, outcome: 'ACCEPTED', serverRef: 'sale_1' },
        NOW
      );
      const replay = await deps.log.recordOfflineCommand(db, scopeOf(fixture), command(fixture));
      return {
        first,
        replay,
        rows: await db.pharmacyOfflineCommand.count({ where: { deviceId: fixture.deviceId } }),
      };
    });

    expect(outcome.first.replayed).toBe(false);
    // The crash window — server committed, response lost — resolves to ONE row.
    expect(outcome.replay.replayed).toBe(true);
    expect(outcome.replay.command.id).toBe(outcome.first.command.id);
    expect(outcome.rows).toBe(1);
  });

  it('refuses one key carrying two different payloads', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'log-conflict');
    await inOrg(ORG_A, (db) =>
      deps.log.recordOfflineCommand(db, scopeOf(fixture), command(fixture))
    );
    const message = await refusal(ORG_A, (db) =>
      deps.log.recordOfflineCommand(
        db,
        scopeOf(fixture),
        command(fixture, { payload: { lines: [{ medicineId: fixture.medicineId, units: 99 }] } })
      )
    );
    expect(message).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('refuses one device sequence carrying two different commands', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'log-sequence');
    await inOrg(ORG_A, (db) =>
      deps.log.recordOfflineCommand(db, scopeOf(fixture), command(fixture))
    );
    const message = await refusal(ORG_A, (db) =>
      deps.log.recordOfflineCommand(
        db,
        scopeOf(fixture),
        command(fixture, { idempotencyKey: 'other-key' })
      )
    );
    expect(message).toBe('SEQUENCE_CONFLICT');
  });

  it('rejects sequence gaps and late lower commands with a durable device cursor', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'log-fifo');

    const gap = await refusal(ORG_A, (db) =>
      deps.log.recordOfflineCommand(
        db,
        scopeOf(fixture),
        command(fixture, { sequence: 2, idempotencyKey: 'gap-key-2' })
      )
    );
    expect(gap).toBe('SEQUENCE_OUT_OF_ORDER');

    await inOrg(ORG_A, (db) =>
      deps.log.recordOfflineCommand(db, scopeOf(fixture), command(fixture))
    );
    await inOrg(ORG_A, (db) =>
      deps.log.recordOfflineCommand(
        db,
        scopeOf(fixture),
        command(fixture, { sequence: 2, idempotencyKey: 'fifo-key-2' })
      )
    );

    const late = await refusal(ORG_A, (db) =>
      deps.log.recordOfflineCommand(
        db,
        scopeOf(fixture),
        command(fixture, { sequence: 1, idempotencyKey: 'late-key-1' })
      )
    );
    expect(late).toBe('SEQUENCE_CONFLICT');
  });

  it('serializes concurrent retries without rejecting the identical command', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'log-concurrent-retry');
    const [first, second] = await Promise.all([
      inOrg(ORG_A, (db) => deps.log.recordOfflineCommand(db, scopeOf(fixture), command(fixture))),
      inOrg(ORG_A, (db) => deps.log.recordOfflineCommand(db, scopeOf(fixture), command(fixture))),
    ]);

    expect(first.command.id).toBe(second.command.id);
    expect(
      await inOrg(ORG_A, (db) =>
        db.pharmacyOfflineCommand.count({ where: { deviceId: fixture.deviceId } })
      )
    ).toBe(1);
  });

  it('the identity of a recorded command is immutable and it is never deleted', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'log-immutable');
    const recorded = await inOrg(ORG_A, (db) =>
      deps.log.recordOfflineCommand(db, scopeOf(fixture), command(fixture))
    );

    const rewrite = await refusal(ORG_A, (db) =>
      db.pharmacyOfflineCommand.update({
        where: { organizationId_id: { organizationId: ORG_A, id: recorded.command.id } },
        data: { payload: { tampered: true } },
      })
    );
    expect(rewrite).toContain('OFFLINE_COMMAND_IMMUTABLE');

    const renumber = await refusal(ORG_A, (db) =>
      db.pharmacyOfflineCommand.update({
        where: { organizationId_id: { organizationId: ORG_A, id: recorded.command.id } },
        data: { receiptNumber: 77 },
      })
    );
    // §8A invariant 16, at the row level.
    expect(renumber).toContain('ISSUED_RECEIPT_IMMUTABLE');

    // No DELETE policy exists for this table, so a tenant connection's DELETE
    // matches zero rows and the no-delete trigger is never reached. That IS the
    // first guard: the honest assertion is that nothing was removed.
    const deleted = await inOrg(
      ORG_A,
      (db) =>
        db.$executeRaw`DELETE FROM pharmacy_offline_commands WHERE id = ${recorded.command.id}`
    );
    expect(deleted).toBe(0);
    const survivor = await inOrg(ORG_A, (db) =>
      db.pharmacyOfflineCommand.findFirstOrThrow({ where: { id: recorded.command.id } })
    );
    expect(survivor.payloadHash).toBe(recorded.command.payloadHash);
  });

  it('a settled command is final and keeps the number it printed', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'log-settled');
    const settled = await inOrg(ORG_A, async (db) => {
      const recorded = await deps.log.recordOfflineCommand(db, scopeOf(fixture), command(fixture));
      return deps.log.settleOfflineCommand(
        db,
        scopeOf(fixture),
        // The server offers a DIFFERENT number; the already-issued one wins.
        {
          commandId: recorded.command.id,
          outcome: 'ACCEPTED',
          serverRef: 'sale_x',
          receiptNumber: 42,
        },
        NOW
      );
    });
    expect(settled).toMatchObject({ status: 'ACCEPTED', receiptNumber: 1, serverRef: 'sale_x' });

    const again = await refusal(ORG_A, (db) =>
      deps.log.settleOfflineCommand(
        db,
        scopeOf(fixture),
        { commandId: settled.id, outcome: 'REJECTED', reason: 'changed my mind' },
        NOW
      )
    );
    expect(again).toBe('ALREADY_SETTLED');
  });

  it('a transient failure keeps the command pending and schedules a backoff', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'log-defer');
    const deferred = await inOrg(ORG_A, async (db) => {
      const recorded = await deps.log.recordOfflineCommand(db, scopeOf(fixture), command(fixture));
      return deps.log.deferOfflineCommand(
        db,
        scopeOf(fixture),
        { commandId: recorded.command.id, error: 'connection reset' },
        NOW
      );
    });
    expect(deferred).toMatchObject({ status: 'PENDING', attempts: 1 });
    // The shared retail-terminal policy: 1s base, doubling per attempt.
    expect(deferred.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 1_000);
  });

  it('dead-letters a command that exhausts its attempts rather than looping', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'log-dead');
    const outcome = await inOrg(ORG_A, async (db) => {
      const recorded = await deps.log.recordOfflineCommand(db, scopeOf(fixture), command(fixture));
      let row = recorded.command;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (row.status !== 'PENDING') break;
        row = await deps.log.deferOfflineCommand(
          db,
          scopeOf(fixture),
          { commandId: recorded.command.id, error: 'connection reset' },
          NOW
        );
      }
      const recovered = await deps.log.recordOfflineCommand(
        db,
        scopeOf(fixture),
        command(fixture, { sequence: 2, idempotencyKey: 'after-dead-key-2' })
      );
      return { dead: row, recovered };
    });
    expect(outcome.dead).toMatchObject({ status: 'DEAD', attempts: 8, nextAttemptAt: null });
    expect(outcome.dead.rejectionReason).toContain('8 attempts');
    // Dead-lettering is the explicit recovery path: it settles the missing work
    // while preserving its sequence, so the next contiguous command can enter.
    expect(outcome.recovered.command).toMatchObject({ sequence: 2, status: 'PENDING' });
  });

  it('refuses to record anything for a revoked counter', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'log-revoked');
    await inOrg(ORG_A, (db) =>
      deps.devices.revokePharmacyCounter(db, scopeOf(fixture), fixture.deviceId, NOW)
    );
    const message = await refusal(ORG_A, (db) =>
      deps.log.recordOfflineCommand(db, scopeOf(fixture), command(fixture))
    );
    expect(message).toBe('DEVICE_NOT_USABLE');
  });

  it('another tenant cannot see this tenant’s command log', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'log-tenant');
    await inOrg(ORG_A, (db) =>
      deps.log.recordOfflineCommand(db, scopeOf(fixture), command(fixture))
    );
    const seen = await inOrg(ORG_B, async (db) => {
      await ensureBranch(db, ORG_B, BRANCH_B);
      return db.pharmacyOfflineCommand.findMany({ where: { deviceId: fixture.deviceId } });
    });
    expect(seen).toEqual([]);
  });
});

// ── OFF-03 — per-device lot quotas ──────────────────────────────────────────

describeIfDatabase('PH-OFF OFF-03 — per-device lot quotas', () => {
  it('grants, consumes and releases within the branch’s on-hand units', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'quota', { units: 30 });
    const outcome = await inOrg(ORG_A, async (db) => {
      const granted = await deps.quotas.grantDeviceLotQuota(db, scopeOf(fixture), {
        ...bucketOf(fixture),
        deviceId: fixture.deviceId,
        units: 12,
      });
      const consumed = await deps.quotas.consumeDeviceLotQuota(db, scopeOf(fixture), {
        ...bucketOf(fixture),
        deviceId: fixture.deviceId,
        units: 5,
      });
      const outstanding = await deps.quotas.outstandingQuotaUnits(
        db,
        scopeOf(fixture),
        bucketOf(fixture)
      );
      const released = await deps.quotas.releaseDeviceLotQuota(
        db,
        scopeOf(fixture),
        granted.id,
        NOW
      );
      const afterRelease = await deps.quotas.outstandingQuotaUnits(
        db,
        scopeOf(fixture),
        bucketOf(fixture)
      );
      return { granted, consumed, outstanding, released, afterRelease };
    });

    expect(outcome.granted.quotaUnits).toBe(12);
    expect(outcome.consumed.consumedUnits).toBe(5);
    expect(outcome.outstanding).toBe(7);
    expect(outcome.released.releasedAt).toEqual(NOW);
    // A released quota returns its units to the branch but keeps its row.
    expect(outcome.afterRelease).toBe(0);
  });

  it('refuses a grant beyond what the bucket holds', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'quota-cap', { units: 10 });
    const message = await refusal(ORG_A, (db) =>
      deps.quotas.grantDeviceLotQuota(db, scopeOf(fixture), {
        ...bucketOf(fixture),
        deviceId: fixture.deviceId,
        units: 11,
      })
    );
    expect(message).toBe('QUOTA_EXCEEDS_ON_HAND');
  });

  it('refuses a second counter’s grant once the first holds every unit', async () => {
    const first = await scenario(ORG_A, BRANCH_A, 'quota-partition', { units: 4 });
    const second = await inOrg(ORG_A, async (db) => {
      const enrolled = await deps.devices.enrollPharmacyCounter(db, scopeOf(first), {
        name: `Counter ${tag('quota-partition-b')}`,
      });
      return enrolled.device.id;
    });

    await inOrg(ORG_A, (db) =>
      deps.quotas.grantDeviceLotQuota(db, scopeOf(first), {
        ...bucketOf(first),
        deviceId: first.deviceId,
        units: 4,
      })
    );
    // "No independent full-stock snapshots": the sum across counters is capped.
    const message = await refusal(ORG_A, (db) =>
      deps.quotas.grantDeviceLotQuota(db, scopeOf(first), {
        ...bucketOf(first),
        deviceId: second,
        units: 1,
      })
    );
    expect(message).toBe('QUOTA_EXCEEDS_ON_HAND');
  });

  it('consumption is monotonic and cannot pass the granted amount', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'quota-monotonic', { units: 20 });
    const quota = await inOrg(ORG_A, (db) =>
      deps.quotas.grantDeviceLotQuota(db, scopeOf(fixture), {
        ...bucketOf(fixture),
        deviceId: fixture.deviceId,
        units: 3,
      })
    );

    const over = await refusal(ORG_A, (db) =>
      deps.quotas.consumeDeviceLotQuota(db, scopeOf(fixture), {
        ...bucketOf(fixture),
        deviceId: fixture.deviceId,
        units: 4,
      })
    );
    expect(over).toBe('QUOTA_EXHAUSTED');

    await inOrg(ORG_A, (db) =>
      deps.quotas.consumeDeviceLotQuota(db, scopeOf(fixture), {
        ...bucketOf(fixture),
        deviceId: fixture.deviceId,
        units: 2,
      })
    );
    const rewind = await refusal(ORG_A, (db) =>
      db.pharmacyDeviceLotQuota.update({
        where: { organizationId_id: { organizationId: ORG_A, id: quota.id } },
        data: { consumedUnits: 0 },
      })
    );
    expect(rewind).toContain('QUOTA_CONSUMPTION_MONOTONIC');
  });

  it('a released quota is final and a quota row is never deleted', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'quota-release', { units: 20 });
    const quota = await inOrg(ORG_A, async (db) => {
      const granted = await deps.quotas.grantDeviceLotQuota(db, scopeOf(fixture), {
        ...bucketOf(fixture),
        deviceId: fixture.deviceId,
        units: 2,
      });
      await deps.quotas.releaseDeviceLotQuota(db, scopeOf(fixture), granted.id, NOW);
      return granted;
    });

    const again = await refusal(ORG_A, (db) =>
      deps.quotas.releaseDeviceLotQuota(db, scopeOf(fixture), quota.id, LATER)
    );
    expect(again).toBe('ALREADY_RELEASED');

    // As above: the missing DELETE policy pre-empts the no-delete trigger.
    const deleted = await inOrg(
      ORG_A,
      (db) => db.$executeRaw`DELETE FROM pharmacy_device_lot_quotas WHERE id = ${quota.id}`
    );
    expect(deleted).toBe(0);
    expect(
      await inOrg(ORG_A, (db) =>
        db.pharmacyDeviceLotQuota.findFirstOrThrow({ where: { id: quota.id } })
      )
    ).toMatchObject({ releasedAt: NOW });
  });

  it('refuses a grant to a revoked counter', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'quota-revoked', { units: 20 });
    await inOrg(ORG_A, (db) =>
      deps.devices.revokePharmacyCounter(db, scopeOf(fixture), fixture.deviceId, NOW)
    );
    const message = await refusal(ORG_A, (db) =>
      deps.quotas.grantDeviceLotQuota(db, scopeOf(fixture), {
        ...bucketOf(fixture),
        deviceId: fixture.deviceId,
        units: 1,
      })
    );
    expect(message).toBe('DEVICE_NOT_USABLE');
  });

  it('another tenant cannot see this tenant’s quotas', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'quota-tenant', { units: 20 });
    await inOrg(ORG_A, (db) =>
      deps.quotas.grantDeviceLotQuota(db, scopeOf(fixture), {
        ...bucketOf(fixture),
        deviceId: fixture.deviceId,
        units: 1,
      })
    );
    const seen = await inOrg(ORG_B, async (db) => {
      await ensureBranch(db, ORG_B, BRANCH_B);
      return db.pharmacyDeviceLotQuota.findMany({ where: { inventoryLotId: fixture.lotId } });
    });
    expect(seen).toEqual([]);
  });

  it('never lets two counters own the same last unit under concurrent grants', async () => {
    const first = await scenario(ORG_A, BRANCH_A, 'quota-race', { units: 1 });
    const second = await inOrg(ORG_A, async (db) => {
      const enrolled = await deps.devices.enrollPharmacyCounter(db, scopeOf(first), {
        name: `Counter ${tag('quota-race-b')}`,
      });
      return enrolled.device.id;
    });

    /*
     * THE OVERLAP IS FORCED, NOT HOPED FOR. Firing two grants at once and
     * asserting "one failed" would also pass if the pool ran them back to back,
     * which proves nothing about the lock.
     *
     * Here the first counter holds its transaction open after being granted the
     * only unit. The second must then be INSIDE the first's window, and only the
     * balance-row lock the guard takes can hold it there: without it, the second
     * would read a stale outstanding total of 0 and be granted the same unit.
     */
    let releaseFirst: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const grant = (db: ScopedDb, deviceId: string) =>
      deps.quotas.grantDeviceLotQuota(db, scopeOf(first), {
        ...bucketOf(first),
        deviceId,
        units: 1,
      });

    const a = inOrg(ORG_A, async (db) => {
      const result = await grant(db, first.deviceId);
      await held;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 250));

    const startedSecond = Date.now();
    const b = inOrg(ORG_A, (db) => grant(db, second));
    await new Promise((resolve) => setTimeout(resolve, 250));
    releaseFirst();

    const [firstOutcome, secondOutcome] = await Promise.allSettled([a, b]);
    const waitedMs = Date.now() - startedSecond;

    expect(firstOutcome.status).toBe('fulfilled');
    expect(secondOutcome.status).toBe('rejected');
    // The second counter was genuinely blocked for the rest of the first's
    // window rather than finishing before it.
    expect(waitedMs).toBeGreaterThanOrEqual(200);
    const rejection = (secondOutcome as PromiseRejectedResult).reason;
    expect(rejection.reason).toBe('QUOTA_EXCEEDS_ON_HAND');

    const after = await inOrg(ORG_A, async (db) => ({
      outstanding: await deps.quotas.outstandingQuotaUnits(db, scopeOf(first), bucketOf(first)),
      rows: await db.pharmacyDeviceLotQuota.count({ where: { inventoryLotId: first.lotId } }),
    }));
    // Exactly one counter owns the last unit, and the branch is not oversold.
    expect(after.outstanding).toBe(1);
    expect(after.rows).toBe(1);
  });
});

// Real transaction evidence for the additive settlement path (not a mocked cursor).
describeIfDatabase('leased receipt settlement', () => {
  // applyPharmacyTender runs the persisted regulatory gate, which needs the branch's profile.
  const ruleSetIds: string[] = [];
  beforeAll(async () => {
    const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
    await inOrg(ORG_A, (db) => ensureBranch(db, ORG_A, BRANCH_A));
    ruleSetIds.push(
      await seedPharmacyRegulatoryProfile(withPlatformDb, (work) => inOrg(ORG_A, work), BRANCH_A)
    );
  });
  afterAll(async () => {
    const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
    await retirePharmacyRegulatoryRules(withPlatformDb, ruleSetIds);
  });

  async function setup() {
    const fixture = await scenario(ORG_A, BRANCH_A, 'leased-settlement');
    const scope = scopeOf(fixture);
    const lease = await inOrg(ORG_A, (db) =>
      deps.leases.reserveReceiptNumberBlock(db, scope, { deviceId: fixture.deviceId, size: 2 })
    );
    const originalSaleAt = new Date().toISOString();
    const signed = await inOrg(ORG_A, (db) =>
      deps.snapshots.issueOfflineSnapshot(db, scope, {
        deviceId: fixture.deviceId,
        kind: 'RULES',
        payload: {},
        issuedAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() + 60_000),
      })
    );
    async function sale() {
      return inOrg(ORG_A, async (db) => {
        const lot = await db.pharmacyInventoryLot.findFirstOrThrow({
          where: { id: fixture.lotId },
          include: { packLevel: true },
        });
        const sale = await db.pharmacySale.create({
          data: {
            organizationId: ORG_A,
            branchId: BRANCH_A,
            createdByUserId: ACTOR,
          },
        });
        const line = await db.pharmacySaleLine.create({
          data: {
            organizationId: ORG_A,
            branchId: BRANCH_A,
            saleId: sale.id,
            medicineId: fixture.medicineId,
            presentationId: lot.packLevel.presentationId,
            packLevelId: lot.packLevelId,
            saleUnit: 'UNIT',
            quantity: 1,
            canonicalUnitsPerSaleUnit: 1,
            canonicalUnits: 1,
            unitPriceMinor: 100,
            grossMinor: 100,
            proRataCeilingMinor: 100,
            unitCostMinor: 50,
            idempotencyKey: tag('line'),
          },
        });
        await db.pharmacySaleLineAllocation.create({
          data: {
            organizationId: ORG_A,
            branchId: BRANCH_A,
            saleLineId: line.id,
            inventoryLotId: fixture.lotId,
            stockLocationId: fixture.locationId,
            canonicalUnits: 1,
            stockMovementId: tag('movement'),
          },
        });
        return sale;
      });
    }
    const { applyPharmacyTender } = await import('./settlement');
    const { signPharmacyCommand } = await import('./sales');
    const firstSale = await sale();
    const input = {
      saleId: firstSale.id,
      deviceId: fixture.deviceId,
      businessDate: new Date(),
      type: 'BANK_TRANSFER' as const,
      providerRef: 'BANK-TEST-123',
      amountMinor: 100,
      idempotencyKey: tag('tender'),
      leasedReceipt: {
        leaseId: lease.id,
        receiptNumber: lease.blockStart,
        originalSaleAt,
        envelope: signed.envelope,
        signature: signed.signature,
      },
    };
    return {
      fixture,
      lease,
      input,
      sale,
      apply: (command = input) =>
        inOrg(ORG_A, (db) =>
          applyPharmacyTender(db, scope, command, {
            deviceSecret: fixture.deviceSecret,
            signature: signPharmacyCommand(
              scope,
              fixture.deviceId,
              command.leasedReceipt,
              fixture.deviceSecret
            ),
          })
        ),
    };
  }

  it('serializes identical retries into one tender and immutable receipt', async () => {
    const f = await setup();
    const results = await Promise.all([f.apply(), f.apply()]);
    expect(results.filter((r) => r.replayed)).toHaveLength(1);
    for (const result of results)
      expect(result).toMatchObject({ receiptNumber: f.lease.blockStart });
    await inOrg(ORG_A, async (db) => {
      expect(await db.pharmacyTender.count({ where: { saleId: f.input.saleId } })).toBe(1);
      expect(
        await db.pharmacySaleEvent.count({ where: { saleId: f.input.saleId, kind: 'COMPLETED' } })
      ).toBe(1);
      const leases = await deps.leases.listReceiptLeases(
        db,
        scopeOf(f.fixture),
        f.fixture.deviceId
      );
      expect(leases[0]!.nextNumber).toBe(f.lease.blockStart + 1);
    });
  });

  it('allows only one of two concurrent sales claiming the same leased number', async () => {
    const f = await setup();
    const second = await f.sale();
    const results = await Promise.allSettled([
      f.apply(),
      f.apply({ ...f.input, saleId: second.id, idempotencyKey: tag('other-tender') }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason.message).toBe(
      'INVALID_RECEIPT_LEASE'
    );
    await inOrg(ORG_A, async (db) => {
      expect(
        await db.pharmacyTender.count({ where: { saleId: { in: [f.input.saleId, second.id] } } })
      ).toBe(1);
    });
  });

  it('rolls back cursor consumption when tender creation fails', async () => {
    const f = await setup();
    const { applyPharmacyTender } = await import('./settlement');
    const { signPharmacyCommand } = await import('./sales');
    await expect(
      inOrg(ORG_A, (db) =>
        applyPharmacyTender(
          db,
          scopeOf(f.fixture),
          {
            ...f.input,
            type: 'CASH',
            providerRef: undefined,
          },
          {
            deviceSecret: f.fixture.deviceSecret,
            signature: signPharmacyCommand(
              scopeOf(f.fixture),
              f.fixture.deviceId,
              f.input.leasedReceipt,
              f.fixture.deviceSecret
            ),
          }
        )
      )
    ).rejects.toThrow('DRAWER_NOT_OPEN');
    const leases = await inOrg(ORG_A, (db) =>
      deps.leases.listReceiptLeases(db, scopeOf(f.fixture), f.fixture.deviceId)
    );
    expect(leases[0]!.nextNumber).toBe(f.lease.blockStart);
    await expect(f.apply()).resolves.toMatchObject({ receiptNumber: f.lease.blockStart });
  });
});
