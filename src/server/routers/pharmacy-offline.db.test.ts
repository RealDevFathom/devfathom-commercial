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
  deps = { withTenantDb: scopedDb.withTenantDb, devices, snapshots, leases, quotas, log };
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
  async function journalBalances(saleId: string) {
    return inOrg(ORG_A, async (db) => {
      const sale = await db.pharmacySale.findFirstOrThrow({
        where: { id: saleId },
        select: { lines: { select: { id: true } }, tenders: { select: { id: true } } },
      });
      const entries = await db.financeJournalEntry.findMany({
        where: {
          OR: [
            {
              sourceKind: 'PHARMACY_SALE_LINE',
              sourceId: { in: sale.lines.map((line) => line.id) },
            },
            {
              sourceKind: 'PHARMACY_TENDER',
              sourceId: { in: sale.tenders.map((tender) => tender.id) },
            },
          ],
        },
        include: { lines: { select: { side: true, amountMinor: true } } },
      });
      return entries.map((entry) => ({
        debit: entry.lines
          .filter((line) => line.side === 'DEBIT')
          .reduce((sum, line) => sum + line.amountMinor, 0),
        credit: entry.lines
          .filter((line) => line.side === 'CREDIT')
          .reduce((sum, line) => sum + line.amountMinor, 0),
      }));
    });
  }
  return { fixture, command, call, replay, counts, journalBalances, lease };
}

describeIfDatabase('offline counter REST on forced-RLS PostgreSQL', () => {
  it('rejects a sequence gap and accepts commands only in contiguous device order', async () => {
    const f = await setup();
    const second = {
      ...f.command,
      sequence: 2,
      idempotencyKey: tag('command-2'),
      leasedReceipt: {
        ...f.command.leasedReceipt,
        receiptNumber: f.lease.blockStart + 1,
      },
    };

    const gap = await f.replay(second);
    expect(gap.status).toBe(409);
    expect(await gap.json()).toEqual({ error: 'SEQUENCE_OUT_OF_ORDER' });
    expect((await f.counts()).commands).toBe(0);

    expect((await f.replay()).status).toBe(200);
    expect((await f.replay(second)).status).toBe(200);

    const late = await f.replay({
      ...f.command,
      idempotencyKey: tag('late-command-1'),
    });
    expect(late.status).toBe(409);
    expect(await late.json()).toEqual({ error: 'SEQUENCE_CONFLICT' });
    expect((await f.counts()).commands).toBe(2);
  });

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
    const journalBalances = await f.journalBalances(results[0].saleId);
    expect(journalBalances).toHaveLength(2);
    expect(journalBalances.every(({ debit, credit }) => debit > 0 && debit === credit)).toBe(true);
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
