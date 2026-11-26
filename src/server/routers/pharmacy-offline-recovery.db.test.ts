// @vitest-environment node
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  retirePharmacyRegulatoryRules,
  seedPharmacyRegulatoryProfile,
} from '@/lib/test-support/pharmacy-regulatory';
import type { CounterReplay } from './pharmacy-offline';
import { offlineSaleChain } from '@/lib/test-support/offline-sale-seal';

/** A replay body before the counter's seal is added (`offlineSaleChain`). */
type UnsealedReplay = Omit<CounterReplay, 'seal'> & { seal?: CounterReplay['seal'] };

// Issue real signed receipts in this disposable database while the product stays hard-off.
vi.mock('@/lib/pharmacy/offline-cash-selling', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/offline-cash-selling')>()),
  readOfflineCashSelling: async () => ({ enabled: true, available: true }),
  counterSetAsidesInForce: async () => true,
}));

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG_A = `offline_recovery_${suffix}`;

const ACTOR = `user_pharmacist_${suffix}`;
/** Branches whose sale-gate regulatory profile is seeded, mapped to the rule-set id. */
const regulatedBranches = new Map<string, string>();

const NOW = new Date(Date.now() - 86_400_000);
const LATER = new Date(Date.now() + 365 * 86_400_000);

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  devices: typeof import('@/lib/pharmacy/offline-devices');
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
  label: string
): Promise<Scenario> {
  const units = 100;
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
  const [scopedDb, devices, roleGuard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/pharmacy/offline-devices'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = { withTenantDb: scopedDb.withTenantDb, devices };
  await roleGuard.assertRlsEnforcingRole(scopedDb.withPlatformDb);
  await scopedDb.withPlatformDb((db) =>
    db.$executeRawUnsafe(
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "createdAt", "updatedAt")
       SELECT id, id, id, id, 'PHARMACY', 'ACTIVE', 'SHARED', now(), now() FROM unnest($1::text[]) AS id
       ON CONFLICT (id) DO NOTHING`,
      [ORG_A]
    )
  );
  await inOrg(ORG_A, async (db) => {
    await db.organizationDepartment.create({ data: { key: 'PHARMACY', name: 'Pharmacy' } });
    await db.user.create({
      data: {
        id: ACTOR,
        name: 'Offline review supervisor',
        email: `${ACTOR}@example.test`,
        department: 'PHARMACY',
        title: 'Manager',
        role: 'ADMIN',
      },
    });
    // DEV-831: the counter operator gate reads the live counter-family grant.
    await db.userPermissionOverride.create({
      data: {
        userId: ACTOR,
        capability: 'pharmacy:counter',
        effect: 'ALLOW',
        reason: 'Offline counter test operator',
      },
    });
  });
}, 180_000);

afterAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
  await retirePharmacyRegulatoryRules(withPlatformDb, [...regulatedBranches.values()]);
});

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

async function setup(openDrawer = true) {
  const fixture = await scenario(ORG_A, tag('branch'), 'recovery');
  const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
  regulatedBranches.set(
    fixture.branchId,
    await seedPharmacyRegulatoryProfile(
      withPlatformDb,
      (work) => inOrg(ORG_A, work),
      fixture.branchId
    )
  );
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
  if (openDrawer)
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
  const command: UnsealedReplay = {
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
  // DEV-957 phase 2 (hardening 4): every sale is sealed as the counter seals it at the
  // moment of sale, chained to the sale before it on this counter.
  const chain = offlineSaleChain(scopeOf(fixture), fixture.deviceId, fixture.deviceSecret);
  async function replay(unsealed: UnsealedReplay = command, headers: Record<string, string> = {}) {
    const input = chain.seal(unsealed);
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
  return { fixture, command, call, replay, counts, lease, chain };
}

describeIfDatabase('Offline receipt recovery through the counter routes', () => {
  it('retains a refusal for branch review, then books a reviewed drawer receipt once', async () => {
    const counter = await setup(false);
    const sealed = counter.chain.seal(counter.command);
    const scope = scopeOf(counter.fixture);
    const { signPharmacyCommand } = await import('@/lib/pharmacy/sales');
    const sign = (o: unknown) =>
      signPharmacyCommand(scope, counter.fixture.deviceId, o, counter.fixture.deviceSecret);
    expect(await (await counter.replay(sealed)).json()).toEqual({ error: 'DRAWER_NOT_OPEN' });
    const list = () =>
      inOrg(ORG_A, async (db) => {
        await db.$queryRaw`SELECT set_config('app.current_branch_id',${scope.branchId},true)`;
        return db.pharmacyOfflineReceiptEvent.findMany({
          where: { deviceId: counter.fixture.deviceId },
          orderBy: { createdAt: 'asc' },
        });
      });
    expect(await list()).toMatchObject([
      { kind: 'REFUSED', reason: 'DRAWER_NOT_OPEN', receiptNumber: counter.lease.blockStart },
    ]);
    const { openPharmacyDrawer } = await import('@/lib/pharmacy/settlement');
    await inOrg(ORG_A, (db) =>
      openPharmacyDrawer(db, scope, {
        deviceId: counter.fixture.deviceId,
        businessDate: new Date(),
        openingFloatMinor: 0,
      })
    );
    expect(await (await counter.replay(sealed)).json()).toEqual({ error: 'DRAWER_NOT_OPEN' });
    const retry = () =>
      counter.call(
        'retry',
        { command: sealed, reason: 'Verified open drawer' },
        {
          'idempotency-key': sealed.idempotencyKey,
          'x-command-signature': sign(sealed),
          'x-receipt-signature': sign(sealed.leasedReceipt),
        }
      );
    const results = await Promise.all([retry(), retry()]);
    const bodies = await Promise.all(results.map((r) => r.json()));
    expect(
      results.map((r) => r.status),
      JSON.stringify(bodies)
    ).toEqual([200, 200]);
    expect(bodies[0].saleId).toBe(bodies[1].saleId);
    expect(await counter.counts()).toMatchObject({ commands: 1, sales: 1, consumed: 1 });
    expect(await list()).toMatchObject([{ kind: 'REFUSED' }, { kind: 'RETRIED', actorId: ACTOR }]);
  });
  it('books a reviewed price refusal at the signed printed price', async () => {
    const counter = await setup();
    const scope = scopeOf(counter.fixture),
      sealed = counter.chain.seal(counter.command);
    await inOrg(ORG_A, (db) =>
      db.pharmacyInventoryLot.update({
        where: { id: counter.fixture.lotId },
        data: { printedMrpMinor: 1400 },
      })
    );
    expect(await (await counter.replay(sealed)).json()).toEqual({ error: 'offline_total_changed' });
    const { signPharmacyCommand } = await import('@/lib/pharmacy/sales');
    const sign = (o: unknown) =>
      signPharmacyCommand(scope, counter.fixture.deviceId, o, counter.fixture.deviceSecret);
    const approval = await counter.call(
      'retry',
      { command: sealed, reason: 'Verified printed price' },
      {
        'idempotency-key': sealed.idempotencyKey,
        'x-command-signature': sign(sealed),
        'x-receipt-signature': sign(sealed.leasedReceipt),
      }
    );
    const body = await approval.json();
    expect(approval.status, JSON.stringify(body)).toBe(200);
    expect(
      await inOrg(ORG_A, (db) =>
        db.pharmacySaleLine.findFirstOrThrow({ where: { saleId: body.saleId } })
      )
    ).toMatchObject({ grossMinor: 100 });
  });
  it('audits a synthetic failed seal, quarantines only its position, and books its signed successor', async () => {
    const counter = await setup();
    const sealed = counter.chain.seal(counter.command);
    const failed = { ...sealed, seal: { ...sealed.seal, signature: '0'.repeat(64) } };
    const scope = scopeOf(counter.fixture);
    const next = counter.chain.seal({
      ...counter.command,
      sequence: 2,
      idempotencyKey: tag('second'),
      leasedReceipt: {
        ...counter.command.leasedReceipt,
        receiptNumber: counter.lease.blockStart + 1,
      },
    });
    expect(await (await counter.replay(failed)).json()).toEqual({ error: 'offline_chain_broken' });
    const review = {
      action: 'quarantine',
      command: failed,
      reason: 'Supervisor kept sealed evidence',
      originalHash: counter.chain.hashOf(1),
    };
    const { signPharmacyCommand } = await import('@/lib/pharmacy/sales');
    const headers = {
      'idempotency-key': failed.idempotencyKey,
      'x-command-signature': signPharmacyCommand(
        scope,
        counter.fixture.deviceId,
        review,
        counter.fixture.deviceSecret
      ),
    };
    const q = await counter.call('quarantine', review, headers);
    expect(await q.json()).toMatchObject({ status: 'QUARANTINED', replayed: false });
    expect(await (await counter.call('quarantine', review, headers)).json()).toMatchObject({
      status: 'QUARANTINED',
      replayed: true,
    });
    expect(await counter.counts()).toMatchObject({ commands: 1, sales: 0, consumed: 0 });
    const result = await counter.replay(next);
    expect(result.status, JSON.stringify(await result.json())).toBe(200);
    expect(await counter.counts()).toMatchObject({ commands: 2, sales: 1, consumed: 1 });
    await inOrg(ORG_A, async (db) => {
      await db.$queryRaw`SELECT set_config('app.current_branch_id',${scope.branchId},true)`;
      const rows = await db.pharmacyOfflineReceiptEvent.findMany({
        where: { deviceId: counter.fixture.deviceId },
        orderBy: { createdAt: 'asc' },
      });
      const audits = await db.auditLog.findMany({
        where: {
          action: 'pharmacyOffline.quarantineOfflineReceipt',
          organizationId: ORG_A,
          actorId: ACTOR,
        },
        select: { metadata: true },
      });
      expect(audits).toEqual([
        {
          metadata: {
            branchId: scope.branchId,
            deviceId: counter.fixture.deviceId,
            sequence: failed.sequence,
            receiptNumber: failed.leasedReceipt.receiptNumber,
            reason: review.reason,
          },
        },
      ]);
      expect(rows).toMatchObject([
        { kind: 'REFUSED', evidence: { command: failed } },
        { kind: 'QUARANTINED', reason: review.reason, actorId: ACTOR },
      ]);
    });
  });
});
