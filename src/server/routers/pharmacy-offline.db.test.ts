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
import type { ManualTenderType } from '@/lib/pharmacy/manual-payments';

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

const ACTOR = `user_pharmacist_${suffix}`;
/** Branches whose sale-gate regulatory profile is seeded, mapped to the rule-set id. */
const regulatedBranches = new Map<string, string>();

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
  await inOrg(ORG_A, async (db) => {
    await db.organizationDepartment.create({ data: { key: 'PHARMACY', name: 'Pharmacy' } });
    await db.user.create({
      data: {
        id: ACTOR,
        name: 'Recovery manager',
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

async function setup(
  manualType?: ManualTenderType,
  allowReferenceSkip = false,
  privateBranch = false
) {
  const fixture = await scenario(
    ORG_A,
    manualType || privateBranch ? tag('merchant-branch') : BRANCH_A,
    'transport'
  );
  // Replay creates and tenders the sale through the persisted regulatory gate.
  if (!regulatedBranches.has(fixture.branchId)) {
    const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
    regulatedBranches.set(
      fixture.branchId,
      await seedPharmacyRegulatoryProfile(
        withPlatformDb,
        (work) => inOrg(ORG_A, work),
        fixture.branchId
      )
    );
  }
  if (manualType) await inOrg(ORG_A, (db) => db.pharmacyBranch.update({
    where: { id: fixture.branchId }, data: { manualPaymentSettings: {
      [manualType]: { destination: 'Merchant till', allowReferenceSkip },
    } },
  }));
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
  if (manualType) {
    command.action = 'MANUAL_OTC_SALE';
    delete command.cashReceivedMinor;
    command.manualCapture = { type: manualType, providerRef: '001234', payerName: 'Ayesha' };
  }
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
  async function reject(unsealed: UnsealedReplay = command, headers: Record<string, string> = {}) {
    const input = chain.seal(unsealed);
    return call(
      'reject',
      { command: input, reason: 'Reviewed failed offline sale' },
      {
        'idempotency-key': input.idempotencyKey,
        'x-command-signature': signPharmacyCommand(
          scopeOf(fixture),
          fixture.deviceId,
          input,
          fixture.deviceSecret
        ),
        ...headers,
      }
    );
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
  return { fixture, command, call, replay, reject, counts, lease };
}

describeIfDatabase('offline counter REST on forced-RLS PostgreSQL', () => {
  it.each(['ORGANIZATION_NOT_ACTIVE', 'PROFILE_MISSING'] as const)(
    'DEV-152 rejects offline replay with %s and rolls back every sale effect',
    async (reason) => {
      // A private branch with valid snapshots, quota and a leased receipt proves
      // admission uses current persisted state, rather than the offline snapshot.
      const f = await setup('RAAST');
      const { withPlatformDb } = await import('@/lib/tenancy/scoped-db');
      const saleEffects = () =>
        inOrg(ORG_A, async (db) => ({
          sales: await db.pharmacySale.count({ where: { branchId: f.fixture.branchId } }),
          tenders: await db.pharmacyTender.count({ where: { deviceId: f.fixture.deviceId } }),
          movements: await db.pharmacyStockMovement.count({
            where: { inventoryLotId: f.fixture.lotId },
          }),
        }));
      const before = await f.counts();
      const effectsBefore = await saleEffects();

      if (reason === 'ORGANIZATION_NOT_ACTIVE') {
        await withPlatformDb((db) =>
          db.organization.update({ where: { id: ORG_A }, data: { status: 'ONBOARDING' } })
        );
      } else {
        await inOrg(ORG_A, (db) =>
          db.branchRegulatoryProfile.updateMany({
            where: { branchId: f.fixture.branchId, effectiveTo: null },
            data: { effectiveTo: new Date() },
          })
        );
      }

      try {
        const response = await f.replay();
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: reason });
        expect(await f.counts()).toEqual(before);
        expect(await saleEffects()).toEqual(effectsBefore);
      } finally {
        if (reason === 'ORGANIZATION_NOT_ACTIVE') {
          await withPlatformDb((db) =>
            db.organization.update({ where: { id: ORG_A }, data: { status: 'ACTIVE' } })
          );
        }
      }
    }
  );

  it.each(['RAAST', 'JAZZCASH', 'EASYPAISA'] as const)('#710 replays a %s sale exactly once with its leased receipt and capture', async (type) => {
    const f = await setup(type);
    const responses = await Promise.all([f.replay(), f.replay()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const results = await Promise.all(responses.map((response) => response.json()));
    expect(results[0].saleId).toBe(results[1].saleId);
    await inOrg(ORG_A, async (db) => {
      const sale = await db.pharmacySale.findFirstOrThrow({ where: { id: results[0].saleId }, include: { tenders: true } });
      expect(sale).toMatchObject({ status: 'COMPLETED', receiptNumber: f.lease.blockStart });
      expect(sale.tenders).toHaveLength(1);
      expect(sale.tenders[0]).toMatchObject({ type, amountMinor: 100, provider: 'MANUAL_MERCHANT', providerRef: '001234', payerName: 'Ayesha', referenceSkipped: false, drawerSessionId: null, confirmedById: ACTOR });
      expect(await db.pharmacyDrawerMovement.count({ where: { drawerSession: { deviceId: f.fixture.deviceId }, kind: 'CASH_SALE' } })).toBe(0);
    });
    expect(await f.counts()).toMatchObject({ commands: 1, sales: 1, consumed: 1, nextNumber: f.lease.blockStart + 1 });
  });
  it('#710 records manual totals in the immutable close and matches expected receipts without posting twice', async () => {
    const f = await setup('RAAST');
    const response = await f.replay();
    expect(response.status).toBe(200);
    const { saleId } = await response.json();
    const scope = scopeOf(f.fixture);
    const businessDate = new Date(f.command.leasedReceipt.originalSaleAt.slice(0, 10));
    const close = await import('@/lib/pharmacy/day-close');
    const bookkeeping = await import('@/lib/pharmacy/bookkeeping');
    const preview = await inOrg(ORG_A, (db) => close.readPharmacyClose(db, scope, businessDate));
    const report = await inOrg(ORG_A, (db) => close.closePharmacyDay(db, scope, {
      businessDate, sourceHash: preview.totals.sourceHash, varianceNote: '',
      counts: preview.drawers.filter((row) => row.status === 'OPEN').map((row) => ({ drawerSessionId: row.id, countedCashMinor: 0 })),
    }));
    expect(report.cashExpectedMinor).toBe(0);
    // DEV-713: the close lists who confirmed each manual tender, by type.
    expect(report.tenderTotals).toEqual([{ type: 'RAAST', amountMinor: 100, refundMinor: 0, netMinor: 100,
      confirmers: [{ id: ACTOR, name: 'Recovery manager', count: 1, amountMinor: 100 }] }]);
    const batch = await inOrg(ORG_A, async (db) => {
      const tender = await db.pharmacyTender.findFirstOrThrow({ where: { saleId } });
      return bookkeeping.createSettlementBatch(db, scope, { reference: tag('RAAST'), provider: 'Raast', tenderType: 'RAAST', businessDate, tenderIds: [tender.id] });
    });
    expect(batch.expectedMinor).toBe(100);
    const lines = await inOrg(ORG_A, async (db) => Promise.all([1, 2].map((number) => db.pharmacyBankStatementLine.create({ data: {
      organizationId: ORG_A, branchId: scope.branchId, statementRef: tag('statement'), lineReference: `line-${number}`, bookedAt: new Date(), amountMinor: 100, description: 'Merchant receipt',
    } }))));
    const journalCount = await inOrg(ORG_A, (db) => db.financeJournalEntry.count());
    const attempts = await Promise.allSettled(lines.map((line) => inOrg(ORG_A, (db) => bookkeeping.reconcileSettlementBankLine(db, scope, { statementLineId: line.id, settlementBatchId: batch.id, amountMinor: 100 }))));
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    await inOrg(ORG_A, async (db) => {
      expect(await db.financeJournalEntry.count()).toBe(journalCount);
      expect(await db.pharmacySettlementBatch.findFirstOrThrow({ where: { id: batch.id } })).toMatchObject({ settledMinor: 100 });
      expect(await db.pharmacyBankReconciliation.count({ where: { settlementBatchId: batch.id } })).toBe(1);
    });
    await expect(inOrg(ORG_A, (db) => bookkeeping.reconcileSettlementBankLine(db, { ...scope, branchId: BRANCH_A }, { statementLineId: lines[0].id, settlementBatchId: batch.id, amountMinor: 1 }))).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    expect(await deps.withTenantDb(`other-org-${suffix}`, (db) => db.pharmacyTender.findMany({ where: { saleId } }))).toEqual([]);
  });
  it.each([false, true])('#710 checks explicit reference skipping against signed and current policy (%s)', async (allowSkip) => {
    const f = await setup('RAAST', allowSkip);
    f.command.manualCapture = { type: 'RAAST', payerName: 'Ayesha', referenceSkipped: true };
    const response = await f.replay();
    expect(response.status).toBe(allowSkip ? 200 : 409);
    expect((await f.counts()).consumed).toBe(allowSkip ? 1 : 0);
  });
  it('#710 database rejects missing references and forbidden skips even outside the service', async () => {
    const f = await setup('RAAST');
    const response = await f.replay();
    expect(response.status).toBe(200);
    const { saleId } = await response.json();
    const data = {
      organizationId: ORG_A, branchId: f.fixture.branchId, saleId, type: 'RAAST' as const,
      amountMinor: 1, provider: 'MANUAL_MERCHANT', payerName: 'Ayesha',
      businessDate: new Date(f.command.leasedReceipt.originalSaleAt.slice(0, 10)), actorId: ACTOR, deviceId: f.fixture.deviceId,
    };
    await expect(inOrg(ORG_A, (db) => db.pharmacyTender.create({ data }))).rejects.toThrow();
    await expect(inOrg(ORG_A, (db) => db.pharmacyTender.create({ data: { ...data, referenceSkipped: true } }))).rejects.toThrow();
    expect(await inOrg(ORG_A, (db) => db.pharmacyTender.count({ where: { saleId } }))).toBe(1);
  });
  it('#710 rejects references removed or policy revoked during an outage with no partial writes', async () => {
    const f = await setup('RAAST', true);
    f.command.manualCapture = { type: 'RAAST', payerName: 'Ayesha' };
    expect((await f.replay()).status).toBe(400);
    f.command.manualCapture = { type: 'RAAST', payerName: 'Ayesha', referenceSkipped: true };
    await inOrg(ORG_A, (db) => db.pharmacyBranch.update({ where: { id: f.fixture.branchId }, data: { manualPaymentSettings: { RAAST: { destination: 'Merchant till', allowReferenceSkip: false } } } }));
    expect((await f.replay()).status).toBe(409);
    expect(await f.counts()).toMatchObject({ commands: 0, sales: 0, consumed: 0, nextNumber: f.lease.blockStart });
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
  // DEV-877: an offline sale is journaled at the server's replay time, never
  // back-dated to the device's originalSaleAt. A sale whose business day sits in
  // a period closed before replay posts into the open period covering the
  // replay; a replay whose own period is closed is refused and rolls back.
  it('DEV-877 posts an offline cash sale replayed after its business day closed into the open replay period', async () => {
    const f = await setup(undefined, false, true);
    const scope = scopeOf(f.fixture);
    const soldAt = new Date(f.command.leasedReceipt.originalSaleAt);
    const closedFrom = new Date(soldAt.getTime() - 24 * 60 * 60 * 1000);
    const closedUntil = new Date(soldAt.getTime() + 1);
    const bookkeeping = await import('@/lib/pharmacy/bookkeeping');
    await inOrg(ORG_A, (db) =>
      bookkeeping.closeAccountingPeriod(db, scope, { startsAt: closedFrom, endsAt: closedUntil })
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    const response = await f.replay();
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    const { saleId } = await response.json();
    await inOrg(ORG_A, async (db) => {
      const sale = await db.pharmacySale.findFirstOrThrow({
        where: { id: saleId },
        include: { tenders: true, lines: true },
      });
      expect(sale.status).toBe('COMPLETED');
      // The drawer still records the original business day.
      expect(sale.tenders[0]!.businessDate.toISOString().slice(0, 10)).toBe(
        f.command.leasedReceipt.originalSaleAt.slice(0, 10)
      );
      const entries = await db.financeJournalEntry.findMany({
        where: {
          branchId: f.fixture.branchId,
          OR: [
            { sourceKind: 'PHARMACY_TENDER', sourceId: sale.tenders[0]!.id },
            { sourceKind: 'PHARMACY_SALE_LINE', sourceId: { in: sale.lines.map((l) => l.id) } },
          ],
        },
      });
      expect(entries.map((entry) => entry.sourceKind).sort()).toEqual([
        'PHARMACY_SALE_LINE',
        'PHARMACY_TENDER',
      ]);
      for (const entry of entries) {
        expect(entry.occurredAt.getTime()).toBeGreaterThanOrEqual(closedUntil.getTime());
      }
      expect(
        await db.financeJournalEntry.count({
          where: {
            branchId: f.fixture.branchId,
            occurredAt: { gte: closedFrom, lt: closedUntil },
          },
        })
      ).toBe(0);
    });
  });

  it('DEV-877 refuses an offline replay whose replay period is closed and accepts it after reopen', async () => {
    const f = await setup(undefined, false, true);
    const scope = scopeOf(f.fixture);
    const bookkeeping = await import('@/lib/pharmacy/bookkeeping');
    const soldAt = new Date(f.command.leasedReceipt.originalSaleAt);
    const period = await inOrg(ORG_A, (db) =>
      bookkeeping.closeAccountingPeriod(db, scope, {
        startsAt: new Date(soldAt.getTime() - 24 * 60 * 60 * 1000),
        endsAt: new Date(soldAt.getTime() + 24 * 60 * 60 * 1000),
      })
    );
    const before = await f.counts();
    const journalCount = () =>
      inOrg(ORG_A, (db) =>
        db.financeJournalEntry.count({ where: { branchId: f.fixture.branchId } })
      );
    const journalBefore = await journalCount();

    const refused = await f.replay();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'PERIOD_CLOSED' });
    expect(await f.counts()).toEqual(before);
    expect(await journalCount()).toBe(journalBefore);

    await inOrg(ORG_A, (db) =>
      bookkeeping.reopenAccountingPeriod(db, scope, {
        periodId: period.id,
        reason: 'Post the late offline sale',
      })
    );
    const accepted = await f.replay();
    expect(accepted.status).toBe(200);
    expect(await f.counts()).toMatchObject({ commands: 1, sales: 1, consumed: 1 });
  });

  it('rolls back stock, quota and log when tender total changes', async () => {
    const f = await setup();
    const before = await f.counts();
    const r = await f.replay({ ...f.command, amountMinor: 1 });
    expect(r.status).toBe(409);
    expect(await f.counts()).toEqual(before);
    expect((await f.replay()).status).toBe(200);
  });
  it('recovers a rolled-back replay with an audited rejection before accepting the next command', async () => {
    const f = await setup();
    const failed = { ...f.command, amountMinor: 1 };
    const before = await f.counts();
    expect((await f.replay(failed)).status).toBe(409);
    expect(await f.counts()).toEqual(before);

    const next = {
      ...f.command,
      sequence: 2,
      idempotencyKey: tag('after-rejection'),
      leasedReceipt: {
        ...f.command.leasedReceipt,
        receiptNumber: f.lease.blockStart + 1,
      },
    };
    const gap = await f.replay(next);
    expect(gap.status).toBe(409);
    expect(await gap.json()).toEqual({ error: 'SEQUENCE_OUT_OF_ORDER' });
    const rejected = await f.reject(failed);
    expect(rejected.status).toBe(200);
    const result = await rejected.json();
    expect(result).toMatchObject({ status: 'REJECTED', replayed: false });
    expect(await f.counts()).toEqual({
      ...before,
      commands: 1,
      nextNumber: f.lease.blockStart + 1,
    });
    const [retryA, retryB] = await Promise.all([f.reject(failed), f.reject(failed)]);
    expect(await retryA.json()).toEqual({ ...result, replayed: true });
    expect(await retryB.json()).toEqual({ ...result, replayed: true });
    const audits = await inOrg(ORG_A, (db) =>
      db.auditLog.findMany({
        where: { action: 'pharmacyOffline.rejectCommand', targetId: result.commandId },
      })
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: ACTOR,
      organizationId: ORG_A,
      metadata: {
        branchId: f.fixture.branchId,
        deviceId: f.fixture.deviceId,
        sequence: 1,
        reason: 'Reviewed failed offline sale',
      },
    });
    expect(JSON.stringify(audits)).not.toContain(f.fixture.deviceSecret);
    expect((await f.replay(failed)).status).toBe(409);
    const accepted = await f.replay(next);
    expect(accepted.status, JSON.stringify(await accepted.json())).toBe(200);
    expect(await f.counts()).toEqual({
      ...before,
      commands: 2,
      sales: 1,
      consumed: 1,
      nextNumber: f.lease.blockEnd + 1,
    });
    expect((await f.reject(next)).status).toBe(409);
    expect((await f.counts()).sales).toBe(1);
  });
  it('refuses a new sale using the printed number of a rejected command', async () => {
    const f = await setup();
    const failed = { ...f.command, amountMinor: 1 };
    expect((await f.reject(failed)).status).toBe(200);
    const before = await f.counts();
    const reused = await f.replay({
      ...f.command,
      sequence: 2,
      idempotencyKey: tag('reused-rejected-receipt'),
    });
    expect(reused.status).toBe(409);
    expect(await reused.json()).toEqual({ error: 'INVALID_RECEIPT_LEASE' });
    expect(await f.counts()).toEqual(before);
  });
  it.each(['missing', 'other-device', 'outside-block', 'skip-number', 'before-lease'] as const)(
    'refuses recovery with a %s receipt lease without advancing either cursor',
    async (mode) => {
      const f = await setup();
      const before = await f.counts();
      const receipt = { ...f.command.leasedReceipt };
      if (mode === 'missing') receipt.leaseId = tag('missing-lease');
      if (mode === 'other-device') {
        const other = await setup();
        receipt.leaseId = other.lease.id;
      }
      if (mode === 'outside-block') receipt.receiptNumber = f.lease.blockEnd + 1;
      if (mode === 'skip-number') receipt.receiptNumber += 1;
      if (mode === 'before-lease') receipt.originalSaleAt = NOW.toISOString();
      const rejected = await f.reject({ ...f.command, leasedReceipt: receipt });
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toEqual({ error: 'INVALID_RECEIPT_LEASE' });
      expect(await f.counts()).toEqual(before);
      const device = await inOrg(ORG_A, (db) =>
        db.pharmacyRegisteredDevice.findFirstOrThrow({ where: { id: f.fixture.deviceId } })
      );
      expect(device.nextOfflineCommandSequence).toBe(BigInt(1));
      expect((await f.reject()).status).toBe(200);
    }
  );
  it('requires manager authorization, a valid session and the signed original for recovery', async () => {
    const f = await setup();
    const before = await f.counts();
    const { can } = await import('@/lib/abac');
    vi.mocked(can).mockResolvedValueOnce(false);
    expect((await f.reject()).status).toBe(403);
    expect(vi.mocked(can).mock.calls.at(-1)?.[1]).toBe('admin:access');
    expect((await f.reject(f.command, { 'x-terminal-session': 'bad' })).status).toBe(401);
    expect((await f.reject(f.command, { 'x-command-signature': '' })).status).toBe(401);
    expect((await f.reject(f.command, { 'idempotency-key': 'wrong' })).status).toBe(400);
    expect((await f.reject({ ...f.command, sequence: 2 })).status).toBe(409);
    expect(await f.counts()).toEqual(before);
    const audits = await inOrg(ORG_A, (db) =>
      db.auditLog.count({
        where: {
          action: 'pharmacyOffline.rejectCommand',
          metadata: { path: ['deviceId'], equals: f.fixture.deviceId },
        },
      })
    );
    expect(audits).toBe(0);
  });
  it('rolls back recovery and its cursor when the audit cannot be written', async () => {
    const f = await setup();
    const before = await f.counts();
    const { resolveTenantActor } = await import('@/lib/tenancy/tenant-actor');
    const managerId = tag('removed-manager');
    const missingActor = {
      organization: { id: ORG_A },
      session: { user: { id: managerId, role: 'ADMIN' } },
    } as Awaited<ReturnType<typeof resolveTenantActor>>;
    // DEV-831: establishment only issues a terminal session to a live member
    // holding the counter grant, so the manager exists when the session opens.
    await inOrg(ORG_A, async (db) => {
      await db.user.create({
        data: { id: managerId, name: 'Removed manager', email: `${managerId}@example.test`,
          department: 'PHARMACY', title: 'Manager', role: 'ADMIN' },
      });
      await db.userPermissionOverride.create({
        data: { userId: managerId, capability: 'pharmacy:counter', effect: 'ALLOW', reason: 'Offline counter test operator' },
      });
    });
    vi.mocked(resolveTenantActor).mockResolvedValueOnce(missingActor);
    const established = await f.call('establish');
    expect(established.status).toBe(201);
    const { sessionToken } = await established.json();
    // Remove the manager's User row while the session is live, so the recovery
    // audit has no User FK target. It must fail in PostgreSQL, rolling back the
    // rejection and cursor with it.
    await inOrg(ORG_A, async (db) => {
      await db.userPermissionOverride.deleteMany({ where: { userId: managerId } });
      await db.user.delete({ where: { id: managerId } });
    });
    expect(await inOrg(ORG_A, (db) => db.user.count({ where: { id: managerId } }))).toBe(0);
    vi.mocked(resolveTenantActor).mockResolvedValueOnce(missingActor);
    const rejected = await f.reject(f.command, { 'x-terminal-session': sessionToken });
    expect(rejected.status).toBe(500);
    expect(await rejected.json()).toEqual({ error: 'internal_error' });
    expect(await f.counts()).toEqual(before);
    const device = await inOrg(ORG_A, (db) =>
      db.pharmacyRegisteredDevice.findFirstOrThrow({
        where: { id: f.fixture.deviceId },
      })
    );
    expect(device.nextOfflineCommandSequence).toBe(BigInt(1));
    expect((await f.reject()).status).toBe(200);
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
    // DEV-767: a lease is refused once neither the manager grant nor the
    // counter operator's orders grant allows it.
    vi.mocked(can).mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    expect((await f.call('lease', { size: 1 })).status).toBe(403);
    expect(vi.mocked(can).mock.calls.slice(-2).map((args) => args[1])).toEqual([
      'admin:access',
      'pharmacy:orders',
    ]);
    expect((await f.call('snapshot', {}, { origin: 'https://other.test' })).status).toBe(403);
    expect((await f.call('snapshot', {}, { 'x-terminal-session': 'bad' })).status).toBe(401);
  });
  it('DEV-831 denies establishment, snapshots and replay once branch access is lost', async () => {
    const f = await setup();
    const before = await f.counts();
    const { resolveTenantActor } = await import('@/lib/tenancy/tenant-actor');
    const cashier = {
      organization: { id: ORG_A },
      session: { user: { id: ACTOR, role: 'EMPLOYEE' } },
    } as unknown as Awaited<ReturnType<typeof resolveTenantActor>>;
    const asCashier = () => vi.mocked(resolveTenantActor).mockResolvedValueOnce(cashier);
    await inOrg(ORG_A, (db) =>
      db.pharmacyBranchAssignment.create({
        data: { branchId: f.fixture.branchId, userId: ACTOR, active: true },
      })
    );
    try {
      asCashier();
      expect((await f.call('snapshot')).status).toBe(200);
      await inOrg(ORG_A, (db) =>
        db.pharmacyBranchAssignment.updateMany({
          where: { branchId: f.fixture.branchId, userId: ACTOR },
          data: { active: false },
        })
      );
      asCashier();
      expect((await f.call('establish')).status).toBe(403);
      asCashier();
      expect((await f.call('snapshot')).status).toBe(403);
      asCashier();
      const replay = await f.replay();
      expect(replay.status).toBe(403);
      expect(await replay.json()).toEqual({ error: 'branch_forbidden' });
      expect(await f.counts()).toEqual(before);
    } finally {
      await inOrg(ORG_A, (db) =>
        db.pharmacyBranchAssignment.deleteMany({
          where: { branchId: f.fixture.branchId, userId: ACTOR },
        })
      );
    }
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
  it.each(['highAlert', 'lasa'] as const)(
    'DEV-957 refuses a %s medicine at replay and rolls back the log',
    async (flag) => {
      const f = await setup();
      const before = await f.counts();
      await inOrg(ORG_A, (db) =>
        db.medicine.update({ where: { id: f.fixture.medicineId }, data: { [flag]: true } })
      );
      const r = await f.replay();
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'medicine_not_offline_otc' });
      expect(await f.counts()).toEqual(before);
    }
  );
  it('DEV-957 leaves high-alert and look-alike medicines out of the signed catalogue', async () => {
    const f = await setup();
    const catalogIds = async () => {
      const response = await f.call('snapshot');
      expect(response.status).toBe(200);
      const { snapshots } = await response.json();
      const catalog = snapshots.find(
        (snapshot: { envelope: { kind: string } }) => snapshot.envelope.kind === 'CATALOG'
      );
      return (catalog.payload as Array<{ id: string }>).map((row) => row.id);
    };
    expect(await catalogIds()).toContain(f.fixture.medicineId);
    for (const flag of ['highAlert', 'lasa'] as const) {
      await inOrg(ORG_A, (db) =>
        db.medicine.update({ where: { id: f.fixture.medicineId }, data: { [flag]: true } })
      );
      expect(await catalogIds()).not.toContain(f.fixture.medicineId);
      await inOrg(ORG_A, (db) =>
        db.medicine.update({ where: { id: f.fixture.medicineId }, data: { [flag]: false } })
      );
    }
    expect(await catalogIds()).toContain(f.fixture.medicineId);
  });
  it('DEV-957 binds the browser cookie to a real device and accepts it only from this site', async () => {
    const f = await setup();
    const { bindPharmacyCounterBrowser } = await import('./pharmacy-offline-bind');
    const { pharmacyCounterRoute } = await import('./pharmacy-offline');
    const bound = await bindPharmacyCounterBrowser(
      new Request('https://tenant.test/api/pharmacy/counter/bind', {
        method: 'POST',
        headers: { origin: 'https://tenant.test', 'content-type': 'application/json' },
        body: JSON.stringify({ secret: f.fixture.deviceSecret }),
      })
    );
    expect(bound.status).toBe(200);
    expect((await bound.json()).device.id).toBe(f.fixture.deviceId);
    const setCookie = bound.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/HttpOnly/i);
    const cookie = setCookie.split(';')[0]!;
    const audit = await inOrg(ORG_A, (db) =>
      db.auditLog.findFirst({
        where: { action: 'pharmacyOffline.bindCounterBrowser', targetId: f.fixture.deviceId },
      })
    );
    expect(audit?.actorId).toBe(ACTOR);
    expect(JSON.stringify(audit)).not.toContain(f.fixture.deviceSecret);
    const establish = (headers: Record<string, string>) =>
      pharmacyCounterRoute('establish')(
        new Request('https://tenant.test/api/pharmacy/counter/establish', {
          method: 'POST',
          headers,
          body: '{}',
        })
      );
    const ok = await establish({ cookie, origin: 'https://tenant.test' });
    expect(ok.status).toBe(201);
    expect((await ok.json()).device.id).toBe(f.fixture.deviceId);
    expect((await establish({ cookie, origin: 'https://evil.test' })).status).toBe(403);
    expect((await establish({ cookie })).status).toBe(403);
    expect(
      (
        await establish({
          cookie,
          origin: 'https://tenant.test',
          authorization: `Bearer ${f.fixture.deviceSecret}`,
        })
      ).status
    ).toBe(401);
    // A revoked device's cookie is refused like its bearer secret.
    await inOrg(ORG_A, (db) =>
      deps.devices.revokePharmacyCounter(db, scopeOf(f.fixture), f.fixture.deviceId, new Date())
    );
    expect((await establish({ cookie, origin: 'https://tenant.test' })).status).toBe(401);
  });
});
