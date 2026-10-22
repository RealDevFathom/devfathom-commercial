/**
 * @vitest-environment node
 *
 * Loyalty 3/6 points expiry against a REAL migrated PostgreSQL, as the restricted runtime
 * role under FORCE RLS, with two sessions contending for one customer:
 *
 * - two expiry runs: the second waits on the customer's points account, then plans from
 *   the first's committed debit, so exactly one EXPIRE row exists and only one caller
 *   reports it;
 * - an expiry run and a redemption: the redemption waits, then sees only live points;
 * - the database refuses malformed EXPIRE / ADJUST rows and a source lot of another
 *   customer.
 *
 * Requires TEST_DATABASE_URL (a disposable migrated database, runtime role). Without it the
 * suite reports skipped.
 */
import { randomUUID } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

type ScopedDb = import('@/lib/tenancy/scoped-db').ScopedDb;

let scoped: typeof import('@/lib/tenancy/scoped-db');
let points: typeof import('./loyalty-points');
let loyalty: typeof import('./customer-loyalty');
let sales: typeof import('./sales');
let ledger: typeof import('./stock-ledger');

const describeDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const run = randomUUID().slice(0, 8);
const organizationId = `loy3_${run}`;
const scope = { organizationId, branchId: `loy3_branch_${run}`, actorId: 'loy3-cashier' };
const businessDate = new Date('2026-10-22T00:00:00.000Z');
const DAY = 86_400_000;
let locationId: string;

const tenant = <T>(work: (db: ScopedDb) => Promise<T>) =>
  scoped.withTenantDb(organizationId, work, { userId: scope.actorId });

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  scoped = await import('@/lib/tenancy/scoped-db');
  points = await import('./loyalty-points');
  loyalty = await import('./customer-loyalty');
  sales = await import('./sales');
  ledger = await import('./stock-ledger');
  const { assertRlsEnforcingRole } = await import('@/lib/testing/rls-role-guard');
  await assertRlsEnforcingRole(scoped.withPlatformDb);
  await scoped.withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $1, $1, $1, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now())`,
      organizationId
    )
  );
  locationId = await tenant(async (db) => {
    await db.pharmacyBranch.create({
      data: {
        id: scope.branchId,
        organizationId,
        code: scope.branchId,
        name: 'Loyalty points',
        addressLine: 'Test',
        city: 'Test',
        provinceCode: 'PB',
      },
    });
    const location = await db.pharmacyStockLocation.create({
      data: {
        organizationId,
        branchId: scope.branchId,
        code: randomUUID(),
        name: 'Stock',
        kind: 'STORE',
      },
    });
    return location.id;
  });
}, 60_000);

/** A consenting loyalty customer with one expired and one live earning. */
async function customerWithPoints(label: string, expired = 300, live = 200) {
  return tenant(async (db) => {
    const patient = await db.pharmacyPatient.create({
      data: { organizationId, displayName: `Patient ${label}` },
    });
    await db.patientConsent.create({
      data: {
        organizationId,
        patientId: patient.id,
        purpose: 'LOYALTY',
        channel: 'IN_PERSON',
        version: 1,
        granted: true,
        recordedByUserId: scope.actorId,
      },
    });
    const customer = await db.pharmacyCustomer.create({
      data: { organizationId, patientId: patient.id, displayName: `Customer ${label}` },
    });
    const earnSale = await db.pharmacySale.create({
      data: {
        organizationId,
        branchId: scope.branchId,
        customerId: customer.id,
        createdByUserId: scope.actorId,
      },
    });
    const earned = (pointsValue: number, ageDays: number, expiresInDays: number, key: string) =>
      db.pharmacyLoyaltyPointsEntry.create({
        data: {
          organizationId,
          branchId: scope.branchId,
          customerId: customer.id,
          saleId: earnSale.id,
          kind: 'EARN',
          points: pointsValue,
          netPaidMinor: pointsValue * 10_000,
          expiresAt: new Date(Date.now() + expiresInDays * DAY),
          occurredAt: new Date(Date.now() - ageDays * DAY),
          actorId: scope.actorId,
          idempotencyKey: `loy3:${label}:${key}`,
        },
      });
    const old = await earned(expired, 240, -60, 'expired');
    const fresh = await earned(live, 10, 170, 'live');
    return {
      customerId: customer.id,
      expiredLotId: old.id,
      liveLotId: fresh.id,
      saleId: earnSale.id,
    };
  });
}

/** An OPEN sale of Rs 300 linked to the customer, so a points tender has room. */
async function billFor(customerId: string, label: string) {
  return tenant(async (db) => {
    const medicine = await db.medicine.create({
      data: {
        organizationId,
        productName: `Points ${label}`,
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        presentations: { create: { organizationId, presentation: 'Tablet' } },
      },
      include: { presentations: true },
    });
    const presentation = medicine.presentations[0]!;
    const pack = await db.packLevel.create({
      data: {
        organizationId,
        presentationId: presentation.id,
        versionGroupId: randomUUID(),
        version: 1,
        level: 'STRIP',
        unitsPerParent: 10,
        effectiveFrom: new Date('2026-01-01'),
      },
    });
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        organizationId,
        medicineId: medicine.id,
        batchNumber: `LOY3-${label}`,
        expiresAt: new Date('2031-01-01T00:00:00.000Z'),
        expiryPrecision: 'DAY',
      },
    });
    await ledger.receiveLot(db, scope, {
      manufacturingBatchId: batch.id,
      packLevelId: pack.id,
      stockLocationId: locationId,
      unitsPerPack: 10,
      supplierName: 'Test',
      supplierInvoiceRef: randomUUID(),
      unitCostMinor: 1,
      printedMrpMinor: 30_000,
      receivedExpiresAt: new Date('2031-01-01T00:00:00.000Z'),
      receivedExpiryPrecision: 'DAY',
      quantityUnits: 10,
      idempotencyKey: randomUUID(),
      receivedAt: new Date('2026-01-01'),
    });
    const sale = await sales.createSale(db, scope);
    await sales.addSaleLine(db, scope, {
      saleId: sale.id,
      medicineId: medicine.id,
      presentationId: presentation.id,
      packLevelId: pack.id,
      // A whole sealed pack: Rs 300 at Rs 30 a unit.
      saleUnit: 'UNIT',
      quantity: 10,
      canonicalUnitsPerSaleUnit: 1,
      idempotencyKey: randomUUID(),
    });
    await db.pharmacySale.update({
      where: { organizationId_id: { organizationId, id: sale.id } },
      data: { customerId },
    });
    return sale.id;
  });
}

async function ledgerOf(customerId: string) {
  return tenant((db) =>
    db.pharmacyLoyaltyPointsEntry.findMany({
      where: { customerId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: { kind: true, points: true, sourceEntryId: true },
    })
  );
}

/**
 * A tenant client whose next transaction runs its work and then waits, uncommitted and
 * holding its locks, until `commit()`.
 */
function heldOpen() {
  const base = scoped.createTenantDb(organizationId, scope.actorId);
  let reached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const db = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
      return (work: (tx: ScopedDb) => Promise<unknown>) =>
        target.$transaction(async (tx) => {
          const result = await work(tx as ScopedDb);
          reached();
          await gate;
          return result;
        });
    },
  }) as ScopedDb;
  // A caller that never opens a transaction never reaches the gate: give up after 3 s.
  const holding = Promise.race([
    reachedPromise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
  ]);
  return { db, holding, commit: () => release() };
}

async function waitForLockWaiter() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const [row] = await scoped.withPlatformDb(
      (db) =>
        db.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`
    );
    if ((row?.waiting ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

describeDatabase('loyalty points expiry under concurrency (FORCE RLS)', () => {
  it('two expiry runs write one debit: the second waits, then plans nothing', async () => {
    const c = await customerWithPoints('expiry-race');
    const first = heldOpen();
    const firstRun = points.expireCustomerPoints(first.db, scope, c.customerId);
    const holding = await first.holding;
    const secondRun = points.expireCustomerPoints(
      scoped.createTenantDb(organizationId, scope.actorId),
      scope,
      c.customerId
    );
    const waited = holding ? await waitForLockWaiter() : false;
    first.commit();
    const [a, b] = await Promise.all([firstRun, secondRun]);

    expect(holding).toBe(true);
    expect(waited).toBe(true);
    expect(a).toEqual([
      expect.objectContaining({ sourceEntryId: c.expiredLotId, points: -300, expiredTotal: 300 }),
    ]);
    expect(b).toEqual([]);
    const rows = await ledgerOf(c.customerId);
    expect(rows.filter((row) => row.kind === 'EXPIRE')).toEqual([
      { kind: 'EXPIRE', points: -300, sourceEntryId: c.expiredLotId },
    ]);
    expect(rows.reduce((sum, row) => sum + row.points, 0)).toBe(200);
  });

  it('a redemption queued behind an expiry run spends only live points', async () => {
    const c = await customerWithPoints('redeem-race');
    const saleId = await billFor(c.customerId, 'redeem-race');
    const first = heldOpen();
    const expiry = points.expireCustomerPoints(first.db, scope, c.customerId);
    expect(await first.holding).toBe(true);
    const redeem = (requested: number) =>
      scoped.withTenantDb(
        organizationId,
        (tx) =>
          loyalty.redeemSalePoints(tx, scope, {
            saleId,
            points: requested,
            deviceId: 'loy3-device',
            businessDate,
            idempotencyKey: `loy3-${requested}-${randomUUID()}`,
          }),
        { userId: scope.actorId }
      );
    // 500 points were earned, but 300 of them expired two months ago.
    const tooMany = redeem(300).then(
      () => 'redeemed',
      (error: { reason?: string }) => error.reason ?? String(error)
    );
    const waited = await waitForLockWaiter();
    first.commit();
    await expiry;
    expect(waited).toBe(true);
    expect(await tooMany).toBe('INSUFFICIENT_POINTS');

    await expect(redeem(200)).resolves.toMatchObject({ points: 200, amountMinor: 20_000 });
    const rows = await ledgerOf(c.customerId);
    expect(rows.filter((row) => row.kind === 'EXPIRE')).toHaveLength(1);
    expect(rows.map((row) => [row.kind, row.points])).toEqual([
      ['EARN', 300],
      ['EARN', 200],
      ['EXPIRE', -300],
      ['REDEEM', -200],
    ]);
  });

  it('requires the customer lock to find exactly the tenant-scoped customer', async () => {
    await expect(
      points.expireCustomerPoints(
        scoped.createTenantDb(organizationId, scope.actorId),
        scope,
        `missing_${run}`
      )
    ).rejects.toMatchObject({ reason: 'CUSTOMER_NOT_FOUND' });
  });

  it('refuses malformed expiry and adjustment rows, and another customer as the source lot', async () => {
    const c = await customerWithPoints('constraints');
    const other = await customerWithPoints('constraints-other');
    const insert = (data: Record<string, unknown>) =>
      tenant((db) =>
        db.pharmacyLoyaltyPointsEntry.create({
          data: {
            organizationId,
            branchId: scope.branchId,
            customerId: c.customerId,
            saleId: c.saleId,
            actorId: scope.actorId,
            idempotencyKey: `loy3:bad:${randomUUID()}`,
            ...data,
          } as never,
        })
      );
    // EXPIRE must name its lot and debit.
    await expect(insert({ kind: 'EXPIRE', points: -10 })).rejects.toThrow();
    await expect(
      insert({ kind: 'EXPIRE', points: 10, sourceEntryId: c.expiredLotId })
    ).rejects.toThrow();
    // The lot must be this customer's own.
    await expect(
      insert({ kind: 'EXPIRE', points: -10, sourceEntryId: other.expiredLotId })
    ).rejects.toThrow();
    // A credit adjustment is a lot and needs an expiry; a debit adjustment has none.
    await expect(insert({ kind: 'ADJUST', points: 10 })).rejects.toThrow();
    await expect(
      insert({ kind: 'ADJUST', points: -10, expiresAt: new Date(Date.now() + DAY) })
    ).rejects.toThrow();
    // A new earning carries its expiry.
    await expect(insert({ kind: 'EARN', points: 10, netPaidMinor: 100_000 })).rejects.toThrow();
    // Well-formed rows are accepted.
    await expect(
      insert({ kind: 'ADJUST', points: 10, expiresAt: new Date(Date.now() + DAY) })
    ).resolves.toBeTruthy();
    await expect(
      insert({ kind: 'EXPIRE', points: -10, sourceEntryId: c.liveLotId })
    ).resolves.toBeTruthy();
  });
});
