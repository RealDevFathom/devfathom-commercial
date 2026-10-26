// @vitest-environment node
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `org_wha1191_a_${suffix}`;

// A branch id is a primary key, so it is unique across the whole table and not
// only within one organization. Suffix them per run or a second run of this
// suite silently conflicts with the rows the first one left behind.
const BRANCH_A = `branch_a_${suffix}`;

const ACTOR = 'user_pharmacist';

const NOW = new Date('2026-09-02T09:00:00.000Z');
const LATER = new Date('2027-10-01T00:00:00.000Z');

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  devices: typeof import('@/lib/pharmacy/offline-devices');
  snapshots: typeof import('@/lib/pharmacy/offline-snapshots');
  leases: typeof import('@/lib/pharmacy/offline-receipt-leases');
  quotas: typeof import('@/lib/pharmacy/offline-quotas');
  log: typeof import('@/lib/pharmacy/offline-command-log');
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

type Scenario = {
  deviceSecret: string;
  organizationId: string;
  branchId: string;
  deviceId: string;
  locationId: string;
  lotId: string;
  medicineId: string;
  packLevelId: string;
  presentationId: string;
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
        saleable: true,
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
        unitCostMinor: 50,
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
      packLevelId: packLevel.id,
      presentationId: medicine.presentations[0]!.id,
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
    import('@/lib/pharmacy/offline-devices'),
    import('@/lib/pharmacy/offline-snapshots'),
    import('@/lib/pharmacy/offline-receipt-leases'),
    import('@/lib/pharmacy/offline-quotas'),
    import('@/lib/pharmacy/offline-command-log'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    devices,
    snapshots,
    leases,
    quotas,
    log,
  };
  await roleGuard.assertRlsEnforcingRole(scopedDb.withPlatformDb);
  // Integrated tip (20261012120000_visibility_context_anchors): tenant rows must reference an
  // existing organization, so anchor this suite's synthetic tenants before any test runs.
  await scopedDb.withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       SELECT id, id, id, id, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now() FROM unnest($1::text[]) AS id
       ON CONFLICT (id) DO NOTHING`,
      [ORG_A]
    )
  );
}, 180_000);

// Mock only the web identity/entitlement boundary; transactions, signatures,
// stock, quota, command log, receipts and forced RLS use migrated PostgreSQL.
vi.mock('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: vi.fn(async () => ({
    organization: { id: ORG_A },
    session: { user: { id: ACTOR, role: 'ADMIN' } },
  })),
}));
vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: vi.fn(async () => ({})),
  hasModule: vi.fn(() => true),
}));
vi.mock('@/lib/abac', () => ({
  can: vi.fn(async () => true),
  subjectFromSession: (user: unknown) => user,
}));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ ok: true }),
  clientIp: () => '127.0.0.1',
}));

describeIfDatabase('offline quota stock reservation', () => {
  it('preserves granted stock from online movements until the quota is consumed', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'reserved-stock', { units: 10 });
    await inOrg(ORG_A, (db) =>
      deps.quotas.grantDeviceLotQuota(db, scopeOf(fixture), {
        deviceId: fixture.deviceId,
        ...bucketOf(fixture),
        units: 10,
      })
    );

    const decrement = {
      organizationId: ORG_A,
      branchId: BRANCH_A,
      inventoryLotId: fixture.lotId,
      stockLocationId: fixture.locationId,
      kind: 'ADJUSTMENT' as const,
      disposition: 'AVAILABLE' as const,
      quantityUnits: -10,
      sealedPackDelta: -1,
      looseUnitDelta: 0,
      actorId: ACTOR,
      occurredAt: NOW,
    };

    await expect(
      inOrg(ORG_A, (db) =>
        db.pharmacyStockMovement.create({
          data: { ...decrement, idempotencyKey: `online-${tag('reserved-stock')}` },
        })
      )
    ).rejects.toThrow('OFFLINE_QUOTA_RESERVES_STOCK');

    const reservedBalance = await inOrg(ORG_A, (db) =>
      db.pharmacyStockBalance.findFirstOrThrow({
        where: { organizationId: ORG_A, ...bucketOf(fixture), disposition: 'AVAILABLE' },
      })
    );
    expect(reservedBalance.onHandUnits).toBe(10);

    await inOrg(ORG_A, async (db) => {
      await deps.quotas.consumeDeviceLotQuota(db, scopeOf(fixture), {
        deviceId: fixture.deviceId,
        ...bucketOf(fixture),
        units: 10,
      });
      await db.pharmacyStockMovement.create({
        data: { ...decrement, idempotencyKey: `offline-${tag('reserved-stock')}` },
      });
    });

    const balance = await inOrg(ORG_A, (db) =>
      db.pharmacyStockBalance.findFirstOrThrow({
        where: { organizationId: ORG_A, ...bucketOf(fixture), disposition: 'AVAILABLE' },
      })
    );
    expect(balance.onHandUnits).toBe(0);
  });

  it('allows exactly the unreserved units and counts every device quota', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'partial-reservation', { units: 15 });
    const secondDevice = await inOrg(ORG_A, (db) =>
      deps.devices.enrollPharmacyCounter(db, scopeOf(fixture), {
        name: `Counter ${tag('second-reservation')}`,
      })
    );
    for (const [deviceId, units] of [
      [fixture.deviceId, 6],
      [secondDevice.device.id, 4],
    ] as const) {
      await inOrg(ORG_A, (db) =>
        deps.quotas.grantDeviceLotQuota(db, scopeOf(fixture), {
          deviceId,
          ...bucketOf(fixture),
          units,
        })
      );
    }

    const movement = (units: number, label: string) =>
      inOrg(ORG_A, (db) =>
        db.pharmacyStockMovement.create({
          data: {
            organizationId: ORG_A,
            branchId: BRANCH_A,
            ...bucketOf(fixture),
            kind: 'ADJUSTMENT',
            disposition: 'AVAILABLE',
            quantityUnits: units,
            sealedPackDelta: 0,
            looseUnitDelta: units,
            actorId: ACTOR,
            idempotencyKey: `partial-${tag(label)}`,
            occurredAt: NOW,
          },
        })
      );

    await movement(-5, 'unreserved');
    await expect(movement(-1, 'reserved')).rejects.toThrow('OFFLINE_QUOTA_RESERVES_STOCK');
  });

  it('rejects a multi-row insert whose combined decrement consumes reserved stock', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'batched-reservation', { units: 8 });
    await inOrg(ORG_A, (db) =>
      deps.quotas.grantDeviceLotQuota(db, scopeOf(fixture), {
        deviceId: fixture.deviceId,
        ...bucketOf(fixture),
        units: 3,
      })
    );

    await expect(
      inOrg(ORG_A, (db) =>
        db.pharmacyStockMovement.createMany({
          data: ['first', 'second'].map((label) => ({
            organizationId: ORG_A,
            branchId: BRANCH_A,
            ...bucketOf(fixture),
            kind: 'ADJUSTMENT' as const,
            disposition: 'AVAILABLE' as const,
            quantityUnits: -3,
            sealedPackDelta: 0,
            looseUnitDelta: -3,
            actorId: ACTOR,
            idempotencyKey: `batched-${tag(label)}`,
            occurredAt: NOW,
          })),
        })
      )
    ).rejects.toThrow('OFFLINE_QUOTA_RESERVES_STOCK');

    const balance = await inOrg(ORG_A, (db) =>
      db.pharmacyStockBalance.findFirstOrThrow({
        where: { organizationId: ORG_A, ...bucketOf(fixture), disposition: 'AVAILABLE' },
      })
    );
    expect(balance.onHandUnits).toBe(8);
  });

  it('ignores released quotas, positive movements, and non-AVAILABLE stock', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'released-reservation', { units: 10 });
    const quota = await inOrg(ORG_A, (db) =>
      deps.quotas.grantDeviceLotQuota(db, scopeOf(fixture), {
        deviceId: fixture.deviceId,
        ...bucketOf(fixture),
        units: 10,
      })
    );
    await inOrg(ORG_A, async (db) => {
      await db.pharmacyStockMovement.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          ...bucketOf(fixture),
          kind: 'ADJUSTMENT',
          disposition: 'QUARANTINED',
          quantityUnits: 1,
          sealedPackDelta: 0,
          looseUnitDelta: 1,
          actorId: ACTOR,
          idempotencyKey: `quarantine-in-${tag('released')}`,
          occurredAt: NOW,
        },
      });
      await db.pharmacyStockMovement.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          ...bucketOf(fixture),
          kind: 'ADJUSTMENT',
          disposition: 'QUARANTINED',
          quantityUnits: -1,
          sealedPackDelta: 0,
          looseUnitDelta: -1,
          actorId: ACTOR,
          idempotencyKey: `quarantine-out-${tag('released')}`,
          occurredAt: NOW,
        },
      });
      await db.pharmacyStockMovement.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          ...bucketOf(fixture),
          kind: 'ADJUSTMENT',
          disposition: 'AVAILABLE',
          quantityUnits: 1,
          sealedPackDelta: 0,
          looseUnitDelta: 1,
          actorId: ACTOR,
          idempotencyKey: `available-in-${tag('released')}`,
          occurredAt: NOW,
        },
      });
      await deps.quotas.releaseDeviceLotQuota(db, scopeOf(fixture), quota.id, NOW);
      await db.pharmacyStockMovement.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          ...bucketOf(fixture),
          kind: 'ADJUSTMENT',
          disposition: 'AVAILABLE',
          quantityUnits: -11,
          sealedPackDelta: -1,
          looseUnitDelta: -1,
          actorId: ACTOR,
          idempotencyKey: `released-out-${tag('released')}`,
          occurredAt: NOW,
        },
      });
    });
  });

  it('rejects a decrement whose statement snapshot predates a blocked quota grant', async () => {
    const fixture = await scenario(ORG_A, BRANCH_A, 'concurrent-reservation', { units: 10 });
    let grantReady!: () => void;
    let commitGrant!: () => void;
    let reportDecrementPid!: (pid: number) => void;
    const grantIsReady = new Promise<void>((resolve) => (grantReady = resolve));
    const mayCommitGrant = new Promise<void>((resolve) => (commitGrant = resolve));
    const decrementPid = new Promise<number>((resolve) => (reportDecrementPid = resolve));

    const grant = inOrg(ORG_A, async (db) => {
      const quota = await deps.quotas.grantDeviceLotQuota(db, scopeOf(fixture), {
        deviceId: fixture.deviceId,
        ...bucketOf(fixture),
        units: 10,
      });
      grantReady();
      await mayCommitGrant;
      return quota;
    });
    await grantIsReady;

    const decrement = inOrg(ORG_A, async (db) => {
      const [{ pid }] = await db.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      reportDecrementPid(pid!);
      return db.pharmacyStockMovement.create({
        data: {
          organizationId: ORG_A,
          branchId: BRANCH_A,
          ...bucketOf(fixture),
          kind: 'ADJUSTMENT',
          disposition: 'AVAILABLE',
          quantityUnits: -10,
          sealedPackDelta: -1,
          looseUnitDelta: 0,
          actorId: ACTOR,
          idempotencyKey: `concurrent-${tag('reservation')}`,
          occurredAt: NOW,
        },
      });
    });

    const pid = await decrementPid;
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
      blocked = await deps.withPlatformDb(async (db) => {
        const [row] = await db.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT cardinality(pg_blocking_pids(${pid})) > 0 AS blocked`;
        return row?.blocked ?? false;
      });
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    commitGrant();

    const [grantResult, decrementResult] = await Promise.allSettled([grant, decrement]);

    expect(blocked).toBe(true);
    expect(grantResult.status).toBe('fulfilled');
    expect(decrementResult.status).toBe('rejected');
    const [balance, outstanding] = await Promise.all([
      inOrg(ORG_A, (db) =>
        db.pharmacyStockBalance.findFirst({
          where: { organizationId: ORG_A, ...bucketOf(fixture), disposition: 'AVAILABLE' },
        })
      ),
      inOrg(ORG_A, (db) =>
        deps.quotas.outstandingQuotaUnits(db, scopeOf(fixture), bucketOf(fixture))
      ),
    ]);
    expect((balance?.onHandUnits ?? 0) - outstanding).toBe(0);
  });
});

async function setup() {
  const fixture = await scenario(ORG_A, BRANCH_A, 'transport');
  // A UNIT sale requires loose stock; sales never implicitly break a sealed pack.
  const { breakPack } = await import('@/lib/pharmacy/stock-ledger');
  await inOrg(ORG_A, (db) =>
    breakPack(db, scopeOf(fixture), {
      ...bucketOf(fixture),
      requiredLooseUnits: 1,
      idempotencyKey: tag('break-pack'),
      at: new Date(),
    })
  );
  const { openPharmacyDrawer } = await import('@/lib/pharmacy/settlement');
  await inOrg(ORG_A, (db) =>
    openPharmacyDrawer(db, scopeOf(fixture), {
      deviceId: fixture.deviceId,
      businessDate: new Date(),
      openingFloatMinor: 0,
    })
  );
  const { pharmacyCounterRoute } = await import('./pharmacy-offline');
  let token = '';
  async function call(
    operation: Parameters<typeof pharmacyCounterRoute>[0],
    body: unknown = {},
    headers: Record<string, string> = {}
  ) {
    return pharmacyCounterRoute(operation)(
      new Request(`https://tenant.test/api/pharmacy/counter/${operation}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${fixture.deviceSecret}`,
          'x-terminal-session': token,
          ...headers,
        },
        body: JSON.stringify(body),
      })
    );
  }
  const established = await call('establish');
  expect(established.status).toBe(201);
  token = (await established.json()).sessionToken;
  const leased = await call('lease', { size: 2 });
  expect(leased.status).toBe(200);
  const lease = await leased.json();
  const granted = await call('quota', { ...bucketOf(fixture), units: 10 });
  expect(granted.status).toBe(200);
  const refreshed = await call('snapshot');
  expect(refreshed.status).toBe(200);
  const { snapshots } = await refreshed.json();
  const rules = snapshots.find((s: { envelope: { kind: string } }) => s.envelope.kind === 'RULES');
  const command = {
    sequence: 1,
    idempotencyKey: tag('command'),
    action: 'CASH_OTC_SALE' as const,
    leasedReceipt: {
      leaseId: lease.id,
      receiptNumber: lease.blockStart,
      originalSaleAt: new Date().toISOString(),
      envelope: rules.envelope,
      signature: rules.signature,
    },
    snapshots,
    lines: [
      {
        medicineId: fixture.medicineId,
        presentationId: fixture.presentationId,
        packLevelId: fixture.packLevelId,
        saleUnit: 'UNIT' as const,
        quantity: 1,
        canonicalUnitsPerSaleUnit: 1,
        ...bucketOf(fixture),
      },
    ],
    amountMinor: 100,
    cashReceivedMinor: 100,
  };
  const { signPharmacyCommand } = await import('@/lib/pharmacy/sales');
  async function replay(input = command, headers: Record<string, string> = {}) {
    return call('replay', input, {
      'idempotency-key': input.idempotencyKey,
      'x-command-signature': signPharmacyCommand(
        scopeOf(fixture),
        fixture.deviceId,
        input,
        fixture.deviceSecret
      ),
      'x-receipt-signature': signPharmacyCommand(
        scopeOf(fixture),
        fixture.deviceId,
        input.leasedReceipt,
        fixture.deviceSecret
      ),
      ...headers,
    });
  }
  async function counts() {
    return inOrg(ORG_A, async (db) => ({
      commands: await db.pharmacyOfflineCommand.count({ where: { deviceId: fixture.deviceId } }),
      sales: await db.pharmacySale.count({
        where: { lines: { some: { medicineId: fixture.medicineId } } },
      }),
      consumed: (
        await db.pharmacyDeviceLotQuota.findFirstOrThrow({ where: { deviceId: fixture.deviceId } })
      ).consumedUnits,
      nextNumber: (
        await db.pharmacyReceiptNumberLease.findFirstOrThrow({ where: { id: lease.id } })
      ).nextNumber,
    }));
  }
  return { fixture, command, call, replay, counts, lease };
}

describeIfDatabase('offline counter REST on forced-RLS PostgreSQL', () => {
  it('replays identical concurrent Idempotency-Key requests into exactly one sale', async () => {
    const f = await setup();
    const responses = await Promise.all([f.replay(), f.replay()]);
    const results = await Promise.all(responses.map((r) => r.json()));
    expect(
      responses.map((r) => r.status),
      JSON.stringify(results)
    ).toEqual([200, 200]);
    expect(results[0].saleId).toBe(results[1].saleId);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(await f.counts()).toEqual({
      commands: 1,
      sales: 1,
      consumed: 1,
      nextNumber: f.lease.blockStart + 1,
    });
  });
  it.each(['signature', 'scope', 'payload'] as const)(
    'rejects bad snapshot %s with no effects',
    async (mode) => {
      const f = await setup();
      if (mode === 'signature') f.command.snapshots[0].signature = 'bad';
      if (mode === 'scope') {
        f.command.snapshots[0].envelope.branchId = 'other-branch';
        f.command.snapshots[0].signature = deps.snapshots.signSnapshotEnvelope(
          f.command.snapshots[0].envelope
        );
      }
      if (mode === 'payload') f.command.snapshots[0].payload = { tampered: true };
      const r = await f.replay();
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'invalid_snapshot' });
      expect(await f.counts()).toEqual({
        commands: 0,
        sales: 0,
        consumed: 0,
        nextNumber: f.lease.blockStart,
      });
    }
  );
  it('denies controlled action per matrix', async () => {
    const f = await setup();
    const r = await f.replay({
      ...f.command,
      action: 'CONTROLLED_MEDICINE_SALE' as typeof f.command.action,
    });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'ACTION_DENIED' });
    expect((await f.counts()).commands).toBe(0);
  });
  it('caps receipt leases at 1000', async () => {
    const f = await setup();
    expect((await f.call('lease', { size: 1001 })).status).toBe(400);
    const r = await f.call('lease', { size: 1000 });
    expect(r.status).toBe(200);
    const lease = await r.json();
    expect(lease.blockEnd - lease.blockStart + 1).toBe(1000);
  });
  it('rolls back stock, quota and log when tender total changes', async () => {
    const f = await setup();
    const before = await f.counts();
    const r = await f.replay({ ...f.command, amountMinor: 1 });
    expect(r.status).toBe(409);
    expect(await f.counts()).toEqual(before);
    expect((await f.replay()).status).toBe(200);
  });
  it('rejects missing command MAC and mismatched idempotency header', async () => {
    const f = await setup();
    expect((await f.replay(f.command, { 'x-command-signature': '' })).status).toBe(401);
    expect((await f.replay(f.command, { 'idempotency-key': 'wrong' })).status).toBe(400);
    expect((await f.counts()).commands).toBe(0);
  });
  it('rejects a revoked device and old terminal session after secret rotation', async () => {
    const f = await setup();
    const rotated = await inOrg(ORG_A, async (db) => {
      const device = await db.pharmacyRegisteredDevice.findFirstOrThrow({
        where: { id: f.fixture.deviceId },
      });
      return deps.devices.rotatePharmacyCounterSecret(
        db,
        scopeOf(f.fixture),
        device.id,
        device.deviceSecretHash
      );
    });
    expect((await f.replay()).status).toBe(401);
    f.fixture.deviceSecret = rotated.secret;
    expect((await f.replay()).status).toBe(401);
    await inOrg(ORG_A, (db) =>
      deps.devices.revokePharmacyCounter(db, scopeOf(f.fixture), f.fixture.deviceId, new Date())
    );
    expect((await f.call('establish')).status).toBe(401);
  });
});

describeIfDatabase('offline transport authorization and conflicts', () => {
  it('requires actor, entitlement, capability and same-origin session', async () => {
    const f = await setup();
    const { resolveTenantActor } = await import('@/lib/tenancy/tenant-actor');
    const { hasModule } = await import('@/lib/entitlements');
    const { can } = await import('@/lib/abac');
    vi.mocked(resolveTenantActor).mockResolvedValueOnce(null);
    expect((await f.call('establish')).status).toBe(401);
    vi.mocked(hasModule).mockReturnValueOnce(false);
    expect((await f.call('establish')).status).toBe(403);
    vi.mocked(can).mockResolvedValueOnce(false);
    expect((await f.call('lease', { size: 1 })).status).toBe(403);
    expect(vi.mocked(can).mock.calls.at(-1)?.[1]).toBe('admin:access');
    expect((await f.call('snapshot', {}, { origin: 'https://other.test' })).status).toBe(403);
    expect((await f.call('snapshot', {}, { 'x-terminal-session': 'bad' })).status).toBe(401);
  });
  it('refuses changed payload under an accepted key without another sale', async () => {
    const f = await setup();
    expect((await f.replay()).status).toBe(200);
    const before = await f.counts();
    const r = await f.replay({ ...f.command, cashReceivedMinor: 200 });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: 'IDEMPOTENCY_CONFLICT' });
    expect(await f.counts()).toEqual(before);
  });
  it('denies a controlled medicine mislabeled as OTC and rolls back the log', async () => {
    const f = await setup();
    await inOrg(ORG_A, (db) =>
      db.medicine.update({ where: { id: f.fixture.medicineId }, data: { controlled: true } })
    );
    const r = await f.replay();
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'medicine_not_offline_otc' });
    expect((await f.counts()).commands).toBe(0);
  });
});
