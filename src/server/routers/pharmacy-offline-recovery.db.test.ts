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
        cashShiftsEnabled: true,
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
      `INSERT INTO organizations (id, slug, "legalName", "displayName", vertical, status, "deploymentMode", "requireApprovalAuthenticator", "createdAt", "updatedAt")
       SELECT id, id, id, id, 'PHARMACY', 'ACTIVE', 'SHARED', false, now(), now() FROM unnest($1::text[]) AS id
       ON CONFLICT (id) DO NOTHING`,
      [ORG_A]
    )
  );
  await inOrg(ORG_A, async (db) => {
    await db.organizationDepartment.create({ data: { key: 'PHARMACY', name: 'Pharmacy' } });
    const role = await db.organizationRole.create({
      data: {
        key: 'owner',
        name: 'Owner',
        isSystem: true,
        permissions: { create: [{ capability: '*', effect: 'ALLOW' }] },
      },
    });
    await db.user.create({
      data: {
        id: ACTOR,
        organizationRoleId: role.id,
        status: 'ACTIVE',
        name: 'Offline review supervisor',
        email: `${ACTOR}@example.test`,
        department: 'PHARMACY',
        title: 'Manager',
        role: 'ADMIN',
      },
    });
    const { saveOwnPin } = await import('@/lib/pharmacy/own-pin');
    await saveOwnPin(db, { organizationId: ORG_A, userId: ACTOR, pin: '2651' });
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
    session: {
      user: {
        id: ACTOR,
        role: 'ADMIN',
        status: 'ACTIVE',
        department: 'PHARMACY',
        organizationId: ORG_A,
      },
    },
  })),
}));
vi.mock('@/lib/entitlements', () => ({
  resolveOrganizationEntitlements: vi.fn(async () => ({})),
  hasModule: vi.fn(() => true),
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
  async function establish() {
    const established = await call('establish');
    expect(established.status).toBe(201);
    token = (await established.json()).sessionToken;
  }
  await establish();
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
  return { fixture, command, call, replay, counts, lease, chain, establish };
}

async function supervisor<T>(
  work: (
    api: ReturnType<(typeof import('./pharmacy-offline'))['pharmacyOfflineRouter']['createCaller']>
  ) => Promise<T>,
  userId = ACTOR,
  role = 'ADMIN'
) {
  const { router } = await import('../trpc');
  const { pharmacyOfflineRouter } = await import('./pharmacy-offline');
  const mounted = router({ pharmacyOffline: pharmacyOfflineRouter });
  return inOrg(ORG_A, (db) =>
    work(
      mounted.createCaller({
        db,
        entitlements: {
          organizationId: ORG_A,
          vertical: 'PHARMACY',
          enabledModules: ['pharmacy-core', 'pharmacy-counter'],
          modules: [],
        },
        session: {
          expires: 'later',
          user: {
            id: userId,
            role,
            status: 'ACTIVE',
            department: 'PHARMACY',
            organizationId: ORG_A,
          },
        },
        organization: { id: ORG_A, vertical: 'PHARMACY' },
        support: null,
        requestMeta: { ip: null, userAgent: null },
        audit: { detail: {}, db },
      } as unknown as import('../trpc').TRPCContext).pharmacyOffline
    )
  );
}

describeIfDatabase('Offline receipt recovery through the counter routes', () => {
  it('signs each price list for the branch reconnect limit, including the 72 hour default', async () => {
    const counter = await setup();
    for (const hours of [72, 24]) {
      if (hours !== 72)
        await supervisor((api) =>
          api.setReconnectLimit({ branchId: counter.fixture.branchId, hours })
        );
      const response = await counter.call('snapshot');
      expect(response.status).toBe(200);
      const { snapshots } = await response.json();
      const price = snapshots.find(
        (s: { envelope: { kind: string } }) => s.envelope.kind === 'PRICES'
      );
      expect(Date.parse(price.envelope.expiresAt) - Date.parse(price.envelope.issuedAt)).toBe(
        hours * 3600000
      );
      expect(price.envelope.safetyLease.expiresAt).toBe(price.envelope.expiresAt);
    }
  });
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
  it.each(['REBOOK', 'REFUND', 'WRITE_OFF'] as const)(
    'clears held cash once with fresh approval for %s',
    async (outcome) => {
      const counter = await setup();
      const scope = scopeOf(counter.fixture);
      const { createSale, addSaleLine, signPharmacyCommand } = await import('@/lib/pharmacy/sales');
      const command = counter.chain.seal(counter.command);
      const rejected = await counter.call(
        'reject',
        { command, reason: 'Confirmed receipt refused' },
        {
          'idempotency-key': command.idempotencyKey,
          'x-command-signature': signPharmacyCommand(
            scope,
            counter.fixture.deviceId,
            command,
            counter.fixture.deviceSecret
          ),
        }
      );
      const body = await rejected.json();
      expect(rejected.status, JSON.stringify(body)).toBe(200);
      let saleId: string | undefined;
      if (outcome === 'REBOOK') {
        saleId = await inOrg(ORG_A, async (db) => {
          const { breakPack } = await import('@/lib/pharmacy/stock-ledger');
          await breakPack(db, scope, {
            ...bucketOf(counter.fixture),
            requiredLooseUnits: 11,
            idempotencyKey: tag('loose-stock'),
            at: new Date(),
          });
          const sale = await createSale(db, scope);
          await addSaleLine(db, scope, {
            ...command.lines[0]!,
            saleId: sale.id,
            idempotencyKey: tag('replacement-line'),
          });
          return sale.id;
        });
      }
      const [event] = await supervisor((api) => api.refusedReceipts({ branchId: scope.branchId }));
      expect(event?.cashState).toBe('held');
      const input = {
        branchId: scope.branchId,
        eventId: event!.id,
        outcome,
        reason: 'Supervisor reconciled printed receipt',
        managerPin: '2651',
        saleId,
      };
      await expect(
        supervisor((api) => api.resolveCash({ ...input, managerPin: '0000' }))
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const results = await Promise.all([
        supervisor((api) => api.resolveCash(input)),
        supervisor((api) => api.resolveCash(input)),
      ]);
      expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
      await expect(
        supervisor((api) => api.resolveCash({ ...input, reason: 'Changed disposition' }))
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await inOrg(ORG_A, async (db) => {
        const entry = await db.financeJournalEntry.findFirstOrThrow({
          where: { branchId: scope.branchId, sourceKind: 'PHARMACY_OFFLINE_CASH_RESOLUTION' },
          include: { lines: true },
        });
        expect(
          entry.lines.map((l) => [l.accountCode, l.side, Number(l.amountMinor)]).sort()
        ).toEqual([
          [outcome === 'WRITE_OFF' ? 'CASH_OVER_SHORT' : 'CASH', 'CREDIT', command.amountMinor],
          ['OFFLINE_CASH_SUSPENSE', 'DEBIT', command.amountMinor],
        ]);
        const movements = await db.pharmacyDrawerMovement.findMany({
          where: { drawerSession: { deviceId: counter.fixture.deviceId } },
        });
        expect(movements.filter((m) => m.kind === 'PAID_OUT')).toHaveLength(
          outcome === 'REFUND' ? 1 : 0
        );
        expect(movements.filter((m) => m.kind === 'CASH_SALE')).toHaveLength(0);
        expect(await db.pharmacyTender.count({ where: { branchId: scope.branchId } })).toBe(
          outcome === 'REBOOK' ? 1 : 0
        );
      });
    }
  );
  it('rebooks a closed-day receipt on the current open day and preserves its printed sale date', async () => {
    const counter = await setup();
    const scope = scopeOf(counter.fixture),
      command = counter.chain.seal(counter.command);
    const { closePharmacyCashShift } = await import('@/lib/pharmacy/cash-shifts');
    const { readPharmacyClose, closePharmacyDay } = await import('@/lib/pharmacy/day-close');
    const { openPharmacyDrawer } = await import('@/lib/pharmacy/settlement');
    const { readCounterReceipt } = await import('@/lib/pharmacy/counter');
    const { receiptOfflineReferenceLine } = await import('@/lib/pharmacy/counter-receipt');
    const { signPharmacyCommand } = await import('@/lib/pharmacy/sales');
    const soldDay = await inOrg(ORG_A, async (db) => {
      const shift = await db.pharmacyCashShift.findFirstOrThrow({
        where: { deviceId: counter.fixture.deviceId },
      });
      await closePharmacyCashShift(
        db,
        scope,
        { shiftId: shift.id, countedCashMinor: 0 },
        { actorIsManager: true }
      );
      const day = await readPharmacyClose(db, scope, shift.businessDate);
      await closePharmacyDay(db, scope, {
        businessDate: shift.businessDate,
        sourceHash: day.totals.sourceHash,
        counts: [{ drawerSessionId: shift.drawerSessionId, countedCashMinor: 0 }],
        varianceNote: '',
      });
      return shift.businessDate;
    });
    const today = new Date(soldDay.getTime() + 86400000);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 86400000));
    try {
      await counter.establish();
      expect(await (await counter.replay(command)).json()).toEqual({ error: 'DAY_CLOSED' });
      await inOrg(ORG_A, (db) =>
        openPharmacyDrawer(db, scope, {
          deviceId: counter.fixture.deviceId,
          businessDate: today,
          openingFloatMinor: 0,
        })
      );
      const sign = (data: unknown) =>
        signPharmacyCommand(scope, counter.fixture.deviceId, data, counter.fixture.deviceSecret);
      const response = await counter.call(
        'retry',
        { command, reason: 'Approved prior business day' },
        {
          'idempotency-key': command.idempotencyKey,
          'x-command-signature': sign(command),
          'x-receipt-signature': sign(command.leasedReceipt),
        }
      );
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      await inOrg(ORG_A, async (db) => {
        const receipt = await readCounterReceipt(db, scope, result.saleId, {
          name: 'Counter',
          currency: 'PKR',
        });
        expect(receipt.businessDate).toBe(today.toISOString().slice(0, 10));
        expect(receiptOfflineReferenceLine(receipt, 'en')).toBe(
          'Sold offline on ' + soldDay.toISOString().slice(0, 10)
        );
        expect((await readPharmacyClose(db, scope, soldDay)).close?.reopen).toBeNull();
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it('shows rejected cash as a dated late receipt on its closed shift and recording day', async () => {
    const counter = await setup();
    const scope = scopeOf(counter.fixture);
    const { closePharmacyCashShift, readPharmacyCashShiftReport } =
      await import('@/lib/pharmacy/cash-shifts');
    const { readPharmacyClose, closePharmacyDay } = await import('@/lib/pharmacy/day-close');
    const { signPharmacyCommand } = await import('@/lib/pharmacy/sales');
    const command = counter.chain.seal(counter.command);
    const shift = await inOrg(ORG_A, (db) =>
      db.pharmacyCashShift.findFirstOrThrow({ where: { deviceId: counter.fixture.deviceId } })
    );
    const frozen = await inOrg(ORG_A, async (db) => {
      const result = await closePharmacyCashShift(
        db,
        scope,
        { shiftId: shift.id, countedCashMinor: 0 },
        { actorIsManager: true }
      );
      const preview = await readPharmacyClose(db, scope, shift.businessDate);
      await closePharmacyDay(db, scope, {
        businessDate: shift.businessDate,
        sourceHash: preview.totals.sourceHash,
        counts: [{ drawerSessionId: shift.drawerSessionId, countedCashMinor: 0 }],
        varianceNote: '',
      });
      return result.report;
    });
    const response = await counter.call(
      'reject',
      { command, reason: 'Late cash after close' },
      {
        'idempotency-key': command.idempotencyKey,
        'x-command-signature': signPharmacyCommand(
          scope,
          counter.fixture.deviceId,
          command,
          counter.fixture.deviceSecret
        ),
      }
    );
    expect(response.status, JSON.stringify(await response.json())).toBe(200);
    await inOrg(ORG_A, async (db) => {
      const report = await readPharmacyCashShiftReport(db, scope, shift.id, {
        actorIsManager: true,
      });
      expect(report.cash).toEqual(frozen.cash);
      expect(report.lateOfflineCash).toMatchObject([
        {
          receiptNumber: command.leasedReceipt.receiptNumber,
          amountMinor: command.amountMinor,
          shiftId: shift.id,
          soldAt: command.leasedReceipt.originalSaleAt,
        },
      ]);
      const day = await readPharmacyClose(db, scope, shift.businessDate);
      expect(day.lateOfflineCash).toEqual(report.lateOfflineCash);
      expect(day.close?.reopen).toBeNull();
    });
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
      const movement = await db.pharmacyDrawerMovement.findFirstOrThrow({
        where: {
          kind: 'REJECTED_OFFLINE_CASH',
          drawerSession: { deviceId: counter.fixture.deviceId },
        },
      });
      expect(movement.shiftId).toBeTruthy();
      expect(movement.amountMinor).toBe(failed.amountMinor);
      const postings = await db.financeJournalLine.findMany({
        where: { sourceLineId: movement.id },
        orderBy: { accountCode: 'asc' },
      });
      expect(
        postings.map((row) => [row.accountCode, row.side, Number(row.amountMinor)]).sort()
      ).toEqual([
        ['CASH', 'DEBIT', failed.amountMinor],
        ['OFFLINE_CASH_SUSPENSE', 'CREDIT', failed.amountMinor],
      ]);
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
