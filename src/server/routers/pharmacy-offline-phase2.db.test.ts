// @vitest-environment node
/**
 * DEV-957 phase 2 on migrated PostgreSQL as the restricted runtime role (forced RLS):
 *
 *  - units a manager set aside for a counter (an open device quota) cannot be sold online,
 *    the counter can still sell them offline, releasing frees them, and no unit is ever
 *    sold twice under 200 parallel online and offline-replay attempts;
 *  - the device secret expires on the server: an expired counter is handed no new price
 *    list, receipt block or quota, still replays what it signed, and an online counter
 *    renews (rotates) its own secret first;
 *  - a revoked counter is told so (device_revoked), so it can wipe itself;
 *  - receipt numbers a revoked or expired counter never printed are listed with the cause;
 *  - the signed RULES name the cashier signed in, and the replay audit records them;
 *  - an offline cash sale composed by the counter code itself (packs, strips, units of an
 *    odd 21-unit box with a 5-paisa rounding rule) is accepted at exactly its signed total;
 *  - prescription-only items are never signed for offline selling and are refused at
 *    replay, also with the owner's pharmacist check (DEV-911) switched off.
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  retirePharmacyRegulatoryRules,
  seedPharmacyRegulatoryProfile,
} from '@/lib/test-support/pharmacy-regulatory';
import type { CounterReplay } from './pharmacy-offline';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const ORG = `org_dev957p2_${suffix}`;
const ACTOR = `user_dev957p2_${suffix}`;
const ACTOR_NAME = 'Ayesha Khan';
const regulated = new Map<string, string>();
const LATER = new Date('2030-10-01T00:00:00.000Z');

let unique = 0;
function tag(label: string) {
  unique += 1;
  return `${suffix}-${label}-${unique}`;
}

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  devices: typeof import('@/lib/pharmacy/offline-devices');
  quotas: typeof import('@/lib/pharmacy/offline-quotas');
  ledger: typeof import('@/lib/pharmacy/stock-ledger');
  route: typeof import('./pharmacy-offline');
  sales: typeof import('@/lib/pharmacy/sales');
};
let deps: Deps;

function inOrg<T>(work: (db: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(ORG, work);
}

vi.mock('@/lib/tenancy/tenant-actor', () => ({
  resolveTenantActor: vi.fn(async () => ({
    organization: { id: ORG },
    session: { user: { id: ACTOR, role: 'ADMIN', name: ACTOR_NAME } },
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

type Pack = 'strip10' | 'box21';
type Fixture = {
  branchId: string;
  deviceId: string;
  secret: string;
  locationId: string;
  lotId: string;
  medicineId: string;
  presentationId: string;
  levels: { pack: string; strip?: string; unit?: string };
};

const scopeOf = (fixture: Pick<Fixture, 'branchId'>) => ({
  organizationId: ORG,
  branchId: fixture.branchId,
  actorId: ACTOR,
});

/** A private branch with one enrolled counter and one stocked lot. */
async function fixture(
  label: string,
  options: { units: number; pack?: Pack; rx?: boolean; looseUnits?: number }
): Promise<Fixture> {
  const branchId = `branch_${tag(label)}`;
  const pack = options.pack ?? 'strip10';
  const made = await inOrg(async (db) => {
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
    const scope = scopeOf({ branchId });
    const { device, secret } = await deps.devices.enrollPharmacyCounter(db, scope, {
      name: `Counter ${tag(label)}`,
    });
    const medicine = await db.medicine.create({
      data: {
        organizationId: ORG,
        productName: `${options.rx ? 'Amoxil' : 'Brufen'} ${tag(label)}`,
        productFamily: 'PHARMACEUTICAL',
        saleable: true,
        otc: !options.rx,
        rx: options.rx === true,
        presentations: {
          create: { organizationId: ORG, presentation: 'Tablet', dosageForm: 'TABLET' },
        },
      },
      include: { presentations: true },
    });
    const presentationId = medicine.presentations[0]!.id;
    const effectiveFrom = new Date('2026-01-01T00:00:00.000Z');
    const level = (data: { level: string; unitsPerParent: number; parentPackLevelId?: string }) =>
      db.packLevel.create({
        data: {
          organizationId: ORG,
          presentationId,
          versionGroupId: `${data.level}-${tag(label)}`,
          version: 1,
          effectiveFrom,
          ...data,
        },
      });
    let levels: Fixture['levels'];
    let unitsPerPack: number;
    if (pack === 'box21') {
      const box = await level({ level: 'BOX', unitsPerParent: 1 });
      const strip = await level({ level: 'STRIP', unitsPerParent: 3, parentPackLevelId: box.id });
      const unit = await level({ level: 'UNIT', unitsPerParent: 7, parentPackLevelId: strip.id });
      levels = { pack: box.id, strip: strip.id, unit: unit.id };
      unitsPerPack = 21;
    } else {
      const strip = await level({ level: 'STRIP', unitsPerParent: 10 });
      levels = { pack: strip.id };
      unitsPerPack = 10;
    }
    const location = await db.pharmacyStockLocation.create({
      data: { organizationId: ORG, branchId, code: `MAIN-${tag(label)}`, name: 'Main', kind: 'STORE' },
    });
    const batchNumber = `B-${tag(label)}`;
    const batch = await db.pharmacyManufacturingBatch.create({
      data: {
        organizationId: ORG,
        medicineId: medicine.id,
        batchNumber,
        expiresAt: LATER,
        expiryPrecision: 'DAY',
      },
    });
    if (pack === 'box21')
      await db.medicinePackMrp.create({
        data: {
          organizationId: ORG,
          packLevelId: levels.pack,
          batchReference: batchNumber,
          printedMrpMinor: 1_000,
          roundingIncrementMinor: 5,
        },
      });
    const lot = await db.pharmacyInventoryLot.create({
      data: {
        organizationId: ORG,
        branchId,
        manufacturingBatchId: batch.id,
        packLevelId: levels.pack,
        unitsPerPack,
        supplierName: 'Supplier',
        supplierInvoiceRef: `INV-${tag(label)}`,
        unitCostMinor: 10,
        printedMrpMinor: 1_000,
        receivedExpiresAt: LATER,
        receivedExpiryPrecision: 'DAY',
        receivedAt: new Date('2026-09-01T00:00:00.000Z'),
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
        quantityUnits: options.units,
        sealedPackDelta: Math.floor(options.units / unitsPerPack),
        looseUnitDelta: options.units % unitsPerPack,
        actorId: ACTOR,
        idempotencyKey: `receipt-${tag(label)}`,
        occurredAt: new Date(),
      },
    });
    return {
      branchId,
      deviceId: device.id,
      secret,
      locationId: location.id,
      lotId: lot.id,
      medicineId: medicine.id,
      presentationId,
      levels,
    };
  });
  if (options.looseUnits)
    await inOrg((db) =>
      deps.ledger.breakPack(db, scopeOf(made), {
        inventoryLotId: made.lotId,
        stockLocationId: made.locationId,
        requiredLooseUnits: options.looseUnits!,
        idempotencyKey: tag('break'),
        at: new Date(),
      })
    );
  return made;
}

/** Replay prerequisites: the regulatory profile and this counter's drawer for today. */
async function readyForReplay(made: Fixture) {
  if (!regulated.has(made.branchId))
    regulated.set(
      made.branchId,
      await seedPharmacyRegulatoryProfile(deps.withPlatformDb, (work) => inOrg(work), made.branchId)
    );
  const { openPharmacyDrawer } = await import('@/lib/pharmacy/settlement');
  await inOrg((db) =>
    openPharmacyDrawer(db, scopeOf(made), {
      deviceId: made.deviceId,
      businessDate: new Date(),
      openingFloatMinor: 0,
    })
  );
}

/** The counter REST route as this fixture's device, bearer path. */
function counterClient(made: Fixture) {
  let token = '';
  const call = async (
    operation: Parameters<Deps['route']['pharmacyCounterRoute']>[0],
    body: unknown = {},
    headers: Record<string, string> = {}
  ) =>
    deps.route.pharmacyCounterRoute(operation)(
      new Request(`https://tenant.test/api/pharmacy/counter/${operation}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${made.secret}`,
          'x-terminal-session': token,
          ...headers,
        },
        body: JSON.stringify(body),
      })
    );
  return {
    call,
    /** The establish response; its JSON is read here once and kept as `body`. */
    async establish() {
      const response = await call('establish');
      const body = await response.json();
      if (response.status === 201) token = body.sessionToken;
      return { status: response.status, body };
    },
    replay(command: CounterReplay) {
      return call('replay', command, {
        'idempotency-key': command.idempotencyKey,
        'x-command-signature': deps.sales.signPharmacyCommand(
          scopeOf(made),
          made.deviceId,
          command,
          made.secret
        ),
        'x-receipt-signature': deps.sales.signPharmacyCommand(
          scopeOf(made),
          made.deviceId,
          command.leasedReceipt,
          made.secret
        ),
      });
    },
  };
}

/** Establish, lease, grant, snapshot: the order a prepared counter goes through. */
async function prepared(made: Fixture, input: { leaseSize: number; quotaUnits: number }) {
  const client = counterClient(made);
  expect((await client.establish()).status).toBe(201);
  const leased = await client.call('lease', { size: input.leaseSize });
  expect(leased.status).toBe(200);
  const lease = await leased.json();
  const granted = await client.call('quota', {
    inventoryLotId: made.lotId,
    stockLocationId: made.locationId,
    units: input.quotaUnits,
  });
  expect(granted.status).toBe(200);
  const refreshed = await client.call('snapshot');
  expect(refreshed.status).toBe(200);
  const { snapshots } = await refreshed.json();
  return { client, lease, snapshots };
}

type SignedSnapshot = {
  envelope: CounterReplay['leasedReceipt']['envelope'];
  signature: string;
  payload: unknown;
};

function unitCommand(
  made: Fixture,
  input: { lease: { id: string }; receiptNumber: number; sequence: number; snapshots: SignedSnapshot[]; units?: number }
): CounterReplay {
  const rules = input.snapshots.find((snapshot) => snapshot.envelope.kind === 'RULES')!;
  const units = input.units ?? 1;
  return {
    sequence: input.sequence,
    idempotencyKey: tag('command'),
    action: 'CASH_OTC_SALE',
    leasedReceipt: {
      leaseId: input.lease.id,
      receiptNumber: input.receiptNumber,
      originalSaleAt: new Date().toISOString(),
      envelope: rules.envelope,
      signature: rules.signature,
    },
    snapshots: input.snapshots as CounterReplay['snapshots'],
    lines: [
      {
        medicineId: made.medicineId,
        presentationId: made.presentationId,
        packLevelId: made.levels.pack,
        saleUnit: 'UNIT',
        quantity: units,
        canonicalUnitsPerSaleUnit: 1,
        inventoryLotId: made.lotId,
        stockLocationId: made.locationId,
      },
    ],
    // One tablet of a 10-tablet strip at 10.00 is 1.00.
    amountMinor: 100 * units,
    cashReceivedMinor: 100 * units,
  };
}

/** One online sale's allocation of `units` from this branch, in its own transaction. */
function onlineSale(made: Fixture, units: number) {
  return inOrg(async (db) => {
    await deps.ledger.allocateForSale(db, scopeOf(made), {
      medicineId: made.medicineId,
      requiredUnits: units,
      at: new Date(),
      idempotencyKeyPrefix: tag('online'),
    });
  });
}

async function onHand(made: Fixture) {
  return inOrg(async (db) =>
    (
      await db.pharmacyStockBalance.findMany({
        where: { inventoryLotId: made.lotId, disposition: 'AVAILABLE' },
        select: { onHandUnits: true },
      })
    ).reduce((total, row) => total + row.onHandUnits, 0)
  );
}

async function refusal(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return (error as { reason?: string; message?: string }).reason ?? String((error as Error).message);
  }
  return 'NO_ERROR';
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, devices, quotas, ledger, route, sales, roleGuard] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/pharmacy/offline-devices'),
    import('@/lib/pharmacy/offline-quotas'),
    import('@/lib/pharmacy/stock-ledger'),
    import('./pharmacy-offline'),
    import('@/lib/pharmacy/sales'),
    import('@/lib/testing/rls-role-guard'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    devices,
    quotas,
    ledger,
    route,
    sales,
  };
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
    await db.user.create({
      data: {
        id: ACTOR,
        name: ACTOR_NAME,
        email: `${ACTOR}@example.test`,
        department: 'PHARMACY',
        title: 'Manager',
        role: 'ADMIN',
      },
    });
    await db.userPermissionOverride.create({
      data: { userId: ACTOR, capability: 'pharmacy:counter', effect: 'ALLOW', reason: 'Offline counter test' },
    });
  });
}, 180_000);

afterAll(async () => {
  if (!TEST_DATABASE_URL) return;
  await retirePharmacyRegulatoryRules(deps.withPlatformDb, [...regulated.values()]);
});

describeIfDatabase('DEV-957 phase 2: units set aside for a counter are not sold online', () => {
  it('on hand 12 with 10 set aside: an online sale of 3 is refused, 2 goes; the counter still sells its 10', async () => {
    const made = await fixture('held', { units: 12, looseUnits: 12 });
    await readyForReplay(made);
    const { client, lease, snapshots } = await prepared(made, { leaseSize: 10, quotaUnits: 10 });

    expect(await refusal(() => onlineSale(made, 3))).toBe('INSUFFICIENT_STOCK');
    expect(await onHand(made)).toBe(12);
    await onlineSale(made, 2);
    expect(await onHand(made)).toBe(10);
    expect(await refusal(() => onlineSale(made, 1))).toBe('INSUFFICIENT_STOCK');

    // The counter's offline sale of all ten still replays: its own units are not held from it.
    const response = await client.replay(
      unitCommand(made, { lease, receiptNumber: lease.blockStart, sequence: 1, snapshots, units: 10 })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ replayed: false });
    expect(await onHand(made)).toBe(0);
  });

  it('releasing (or revoking) the counter frees the units for online sales again', async () => {
    const made = await fixture('released', { units: 12, looseUnits: 12 });
    await prepared(made, { leaseSize: 1, quotaUnits: 10 });
    expect(await refusal(() => onlineSale(made, 3))).toBe('INSUFFICIENT_STOCK');
    await inOrg(async (db) => {
      await deps.devices.revokePharmacyCounter(db, scopeOf(made), made.deviceId, new Date());
      const open = await db.pharmacyDeviceLotQuota.findMany({
        where: { deviceId: made.deviceId, releasedAt: null },
        select: { id: true },
      });
      for (const quota of open)
        await deps.quotas.releaseDeviceLotQuota(db, scopeOf(made), quota.id, new Date());
    });
    await onlineSale(made, 12);
    expect(await onHand(made)).toBe(0);
  });

  it('the counter search offers only the units not set aside for an offline counter', async () => {
    const made = await fixture('search', { units: 12, looseUnits: 12 });
    const name = await inOrg(
      async (db) =>
        (await db.medicine.findFirstOrThrow({ where: { id: made.medicineId } })).productName
    );
    const { searchCounterCatalog } = await import('@/lib/pharmacy/counter');
    const sellable = async () =>
      (
        await inOrg((db) =>
          searchCounterCatalog(db, scopeOf(made), { query: name })
        )
      ).rows.find((row) => row.medicineId === made.medicineId)?.onHandUnits;
    expect(await sellable()).toBe(12);
    await prepared(made, { leaseSize: 1, quotaUnits: 10 });
    expect(await sellable()).toBe(2);
  });

  it(
    'never sells a unit twice under 200 parallel online sales and offline replays',
    async () => {
      const made = await fixture('race', { units: 12, looseUnits: 12 });
      await readyForReplay(made);
      const { client, lease, snapshots } = await prepared(made, { leaseSize: 10, quotaUnits: 10 });
      const commands = Array.from({ length: 10 }, (_, index) =>
        unitCommand(made, {
          lease,
          receiptNumber: lease.blockStart + index,
          sequence: index + 1,
          snapshots,
        })
      );
      // Replays go in their FIFO order (the server refuses a later one first); 190 online
      // sales of one unit each race them the whole time.
      const replays = (async () => {
        const statuses: number[] = [];
        for (const command of commands) statuses.push((await client.replay(command)).status);
        return statuses;
      })();
      const online = await Promise.allSettled(
        Array.from({ length: 190 }, () => onlineSale(made, 1))
      );
      const replayed = await replays;
      const onlineSold = online.filter((result) => result.status === 'fulfilled').length;
      expect(replayed).toEqual(Array(10).fill(200));
      expect(onlineSold).toBe(2);
      for (const result of online)
        if (result.status === 'rejected')
          expect((result.reason as { reason?: string }).reason).toBe('INSUFFICIENT_STOCK');
      expect(await onHand(made)).toBe(0);
      const movements = await inOrg((db) =>
        db.pharmacyStockMovement.aggregate({
          where: { inventoryLotId: made.lotId, kind: 'SALE' },
          _sum: { quantityUnits: true },
        })
      );
      expect(movements._sum.quantityUnits).toBe(-12);
      const quota = await inOrg((db) =>
        db.pharmacyDeviceLotQuota.findFirstOrThrow({ where: { deviceId: made.deviceId } })
      );
      expect(quota.consumedUnits).toBe(10);
    },
    240_000
  );
});

describeIfDatabase('DEV-957 phase 2: the device secret expires on the server', () => {
  it('a new counter expires 30 days after enrolment', async () => {
    const before = Date.now();
    const made = await fixture('enrol-expiry', { units: 10 });
    const device = await inOrg((db) =>
      db.pharmacyRegisteredDevice.findFirstOrThrow({ where: { id: made.deviceId } })
    );
    const days = (device.secretExpiresAt.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThan(30.01);
  });

  it('an expired counter gets no price list, receipt block or stock, but replays what it signed', async () => {
    const made = await fixture('expired', { units: 12, looseUnits: 12 });
    await readyForReplay(made);
    const { lease, snapshots } = await prepared(made, { leaseSize: 2, quotaUnits: 5 });
    const signedWhileValid = unitCommand(made, {
      lease,
      receiptNumber: lease.blockStart,
      sequence: 1,
      snapshots,
    });
    await inOrg((db) =>
      db.pharmacyRegisteredDevice.update({
        where: { organizationId_id: { organizationId: ORG, id: made.deviceId } },
        data: { secretExpiresAt: new Date(Date.now() - 60_000) },
      })
    );
    const client = counterClient(made);
    const established = await client.establish();
    expect(established.status).toBe(201);
    expect(established.body.credential).toMatchObject({ expired: true, renewDue: false });
    for (const [operation, body] of [
      ['snapshot', {}],
      ['lease', { size: 1 }],
      ['quota', { inventoryLotId: made.lotId, stockLocationId: made.locationId, units: 1 }],
      ['renew', {}],
    ] as const) {
      const response = await client.call(operation, body);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'device_credential_expired' });
    }
    const replayed = await client.replay(signedWhileValid);
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({ replayed: false, receiptNumber: lease.blockStart });
  });

  it('renews its own secret while valid: the old secret stops, the new one works, no secret is audited', async () => {
    const made = await fixture('renew', { units: 10 });
    await inOrg((db) =>
      db.pharmacyRegisteredDevice.update({
        where: { organizationId_id: { organizationId: ORG, id: made.deviceId } },
        data: { secretExpiresAt: new Date(Date.now() + 3 * 86_400_000) },
      })
    );
    const client = counterClient(made);
    const established = await client.establish();
    expect(established.body.credential).toMatchObject({ expired: false, renewDue: true });
    const renewed = await client.call('renew', {});
    expect(renewed.status).toBe(200);
    const body = await renewed.json();
    expect(body.secret).toMatch(/^pcd_[A-Za-z0-9_-]{43}$/);
    expect(body.secret).not.toBe(made.secret);
    expect((Date.parse(body.credentialExpiresAt) - Date.now()) / 86_400_000).toBeGreaterThan(29.9);
    // A bearer client keeps its own copy: no cookie is set on that path.
    expect(renewed.headers.get('set-cookie')).toBeNull();

    expect((await counterClient(made).establish()).status).toBe(401);
    expect((await counterClient({ ...made, secret: body.secret }).establish()).status).toBe(201);
    const audit = await inOrg((db) =>
      db.auditLog.findMany({
        where: { action: 'pharmacyOffline.renewCounterCredential', targetId: made.deviceId },
      })
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(body.secret);
    expect(JSON.stringify(audit)).not.toContain(made.secret);
  });

  it('renewing on the cookie path moves the httpOnly cookie to the new secret', async () => {
    const made = await fixture('renew-cookie', { units: 10 });
    const cookie = `df_pharmacy_counter_device=${encodeURIComponent(made.secret)}`;
    const request = (operation: 'establish' | 'renew', token = '') =>
      deps.route.pharmacyCounterRoute(operation)(
        new Request(`https://tenant.test/api/pharmacy/counter/${operation}`, {
          method: 'POST',
          headers: { cookie, origin: 'https://tenant.test', 'x-terminal-session': token },
          body: '{}',
        })
      );
    const established = await request('establish');
    expect(established.status).toBe(201);
    const renewed = await request('renew', (await established.json()).sessionToken);
    expect(renewed.status).toBe(200);
    const { secret } = await renewed.json();
    const setCookie = renewed.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`df_pharmacy_counter_device=${secret}`);
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=strict');
    expect(setCookie).toContain('Path=/api/pharmacy/counter');
  });

  it('a manager rotation moves the expiry 30 days on', async () => {
    const made = await fixture('rotate-expiry', { units: 10 });
    const rotated = await inOrg(async (db) => {
      await db.pharmacyRegisteredDevice.update({
        where: { organizationId_id: { organizationId: ORG, id: made.deviceId } },
        data: { secretExpiresAt: new Date(Date.now() - 86_400_000) },
      });
      const device = await db.pharmacyRegisteredDevice.findFirstOrThrow({
        where: { id: made.deviceId },
      });
      return deps.devices.rotatePharmacyCounterSecret(
        db,
        scopeOf(made),
        device.id,
        device.deviceSecretHash
      );
    });
    expect((rotated.device.secretExpiresAt.getTime() - Date.now()) / 86_400_000).toBeGreaterThan(29.9);
  });
});

describeIfDatabase('DEV-957 phase 2: remote revoke and receipt-number gaps', () => {
  it('tells a revoked counter so in so many words, and an unknown secret only that it is unknown', async () => {
    const made = await fixture('revoked', { units: 10 });
    await inOrg((db) =>
      deps.devices.revokePharmacyCounter(db, scopeOf(made), made.deviceId, new Date())
    );
    const revoked = await counterClient(made).establish();
    expect(revoked).toEqual({ status: 401, body: { error: 'device_revoked' } });
    const unknown = await counterClient({ ...made, secret: `pcd_${'z'.repeat(43)}` }).establish();
    expect(unknown).toEqual({ status: 401, body: { error: 'unauthorized_device' } });
  });

  it('lists the numbers a revoked or expired counter never printed, with the cause, and nothing else', async () => {
    const revoked = await fixture('gap-revoked', { units: 10 });
    const branch = { branchId: revoked.branchId };
    const { lease } = await prepared(revoked, { leaseSize: 10, quotaUnits: 1 });
    const revokedAt = new Date();
    // A second, still active counter of the same branch, and a third whose credential expired.
    const [active, expired] = await inOrg(async (db) => {
      const one = await deps.devices.enrollPharmacyCounter(db, scopeOf(branch), { name: 'Active' });
      const two = await deps.devices.enrollPharmacyCounter(db, scopeOf(branch), { name: 'Expired' });
      return [one.device, two.device];
    });
    const { reserveReceiptNumberBlock } = await import('@/lib/pharmacy/offline-receipt-leases');
    const [activeLease, expiredLease] = await inOrg(async (db) => {
      const a = await reserveReceiptNumberBlock(db, scopeOf(branch), { deviceId: active.id, size: 5 });
      const b = await reserveReceiptNumberBlock(db, scopeOf(branch), { deviceId: expired.id, size: 5 });
      await deps.devices.revokePharmacyCounter(db, scopeOf(branch), revoked.deviceId, revokedAt);
      await db.pharmacyRegisteredDevice.update({
        where: { organizationId_id: { organizationId: ORG, id: expired.id } },
        data: { secretExpiresAt: new Date(Date.now() - 60_000) },
      });
      return [a, b];
    });
    const gaps = await inOrg((db) =>
      deps.route.receiptNumberGaps(db, { organizationId: ORG, branchId: revoked.branchId }, new Date())
    );
    expect(gaps).toHaveLength(2);
    expect(gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deviceId: revoked.deviceId,
          leaseId: lease.id,
          firstUnused: lease.blockStart,
          lastUnused: lease.blockEnd,
          unused: 10,
          cause: 'REVOKED',
          since: revokedAt.toISOString(),
        }),
        expect.objectContaining({
          deviceId: expired.id,
          leaseId: expiredLease.id,
          unused: 5,
          cause: 'EXPIRED',
        }),
      ])
    );
    expect(gaps.some((gap) => gap.leaseId === activeLease.id)).toBe(false);
    // Another branch's counters are never listed here.
    const other = await inOrg((db) =>
      deps.route.receiptNumberGaps(db, { organizationId: ORG, branchId: 'branch_absent' }, new Date())
    );
    expect(other).toEqual([]);
  });
});

describeIfDatabase('DEV-957 phase 2: who an offline sale is recorded for', () => {
  it('the signed RULES name the cashier signed in, and the replay audit records them', async () => {
    const made = await fixture('operator', { units: 12, looseUnits: 12 });
    await readyForReplay(made);
    const { client, lease, snapshots } = await prepared(made, { leaseSize: 1, quotaUnits: 2 });
    const rules = (snapshots as SignedSnapshot[]).find((s) => s.envelope.kind === 'RULES')!;
    expect(rules.payload).toMatchObject({
      operator: { userId: ACTOR, name: ACTOR_NAME },
      branchName: 'Branch operator',
    });
    const response = await client.replay(
      unitCommand(made, { lease, receiptNumber: lease.blockStart, sequence: 1, snapshots })
    );
    expect(response.status).toBe(200);
    const { saleId } = await response.json();
    const audit = await inOrg((db) =>
      db.auditLog.findFirstOrThrow({
        where: { action: 'pharmacyOffline.replayOfflineSale', targetId: saleId },
      })
    );
    expect(audit.metadata).toMatchObject({ offlineOperatorId: ACTOR, deviceId: made.deviceId });
  });
});

describeIfDatabase('DEV-957 phase 2: the counter code signs exactly what the server charges', () => {
  it('replays a pack, a strip and loose tablets of an odd 21-tablet box at the signed total', async () => {
    // Loose tablets for the strip and the tablets; a pack line takes loose units first.
    const made = await fixture('parity', { units: 63, pack: 'box21', looseUnits: 31 });
    await readyForReplay(made);
    const { lease, snapshots, client } = await prepared(made, { leaseSize: 3, quotaUnits: 40 });

    // The browser runtime, verifier and composer, fed what the server just issued.
    const [{ PharmacyCounterRuntime, createMemoryDriver }, verifier, catalogue, sale, queue] =
      await Promise.all([
        import('@/lib/pharmacy/counter-offline-runtime'),
        import('@/lib/pharmacy/counter-snapshot-verifier'),
        import('@/lib/pharmacy/counter-offline-catalogue'),
        import('@/lib/pharmacy/counter-offline-sale'),
        import('@/lib/pharmacy/counter-command-queue'),
      ]);
    const { snapshotPublicKey } = await import('@/lib/pharmacy/offline-snapshots');
    const runtime = new PharmacyCounterRuntime(
      { organizationId: ORG, branchId: made.branchId, deviceId: made.deviceId },
      createMemoryDriver(),
      verifier.webCryptoSnapshotVerifier(),
      snapshotPublicKey()
    );
    await runtime.hydrate();
    for (const snapshot of snapshots as SignedSnapshot[]) {
      const installed = await runtime.installSnapshot({
        ...snapshot,
        payloadHash: await verifier.browserSnapshotPayloadHash(snapshot.payload),
        nowMs: Date.now(),
      });
      expect(installed.ok).toBe(true);
    }
    await runtime.adoptQuotas(runtime.payloadFor('LOT_BALANCES') as never);
    await runtime.adoptLeases([
      { leaseId: lease.id, blockStart: lease.blockStart, blockEnd: lease.blockEnd, nextNumber: lease.nextNumber },
    ]);
    const rows = catalogue.offlineSaleRows(runtime.snapshot(), Date.now());
    const row = rows.find((candidate) => candidate.inventoryLotId === made.lotId)!;
    expect(row.roundingIncrementMinor).toBe(5);
    expect(row.saleUnits.map((unit) => [unit.kind, unit.canonicalUnitsPerSaleUnit])).toEqual([
      ['PACK', 21],
      ['STRIP', 7],
      ['UNIT', 1],
    ]);
    let draft = sale.newOfflineDraft(ACTOR, new Date());
    for (const [kind, times] of [['PACK', 1], ['STRIP', 1], ['UNIT', 3]] as const)
      for (let index = 0; index < times; index += 1)
        draft = sale.addToOfflineDraft(
          draft,
          row,
          row.saleUnits.find((unit) => unit.kind === kind)!,
          new Date()
        );
    const composed = sale.composeOfflineCashSale({
      state: runtime.snapshot(),
      rows,
      draft,
      cashReceivedMinor: 2_000,
      nowMs: Date.now(),
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    // 1000 for the box, floor(1000 x 7 / 21) = 333 -> 330 for a strip, 47 -> 45 a tablet.
    expect(composed.totalMinor).toBe(1_000 + 330 + 3 * 45);
    const queued = await runtime.enqueue(composed.input, composed.matrix);
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    const request = await queue.buildCounterReplayRequest(
      runtime.snapshot().queue!,
      queued.command,
      (body, receipt) => ({
        command: deps.sales.signPharmacyCommand(scopeOf(made), made.deviceId, body, made.secret),
        receipt: deps.sales.signPharmacyCommand(scopeOf(made), made.deviceId, receipt, made.secret),
      })
    );
    const response = await client.call('replay', request.body, request.headers);
    expect({ status: response.status, body: response.status === 200 ? null : await response.clone().json() }).toEqual({ status: 200, body: null });
    const accepted = await response.json();
    expect(accepted).toMatchObject({ replayed: false, receiptNumber: lease.blockStart });
    const tender = await inOrg((db) =>
      db.pharmacyTender.findFirstOrThrow({ where: { saleId: accepted.saleId } })
    );
    expect(tender.amountMinor).toBe(1_465);
    expect(await onHand(made)).toBe(63 - 31);
  });
});

describeIfDatabase('DEV-957 phase 2: prescription-only items never sell offline', () => {
  it('leaves them out of the signed list and refuses them at replay, with the pharmacist check off', async () => {
    // The owner's switch, through the real writer (its trigger stamps the actor and audits).
    const [{ writePharmacistCheckPolicy, readPharmacistCheckPolicy }, { PHARMACIST_CHECK_DISCLAIMER }] =
      await Promise.all([
        import('@/lib/pharmacy/pharmacist-check-policy'),
        import('@/lib/pharmacy/pharmacist-check'),
      ]);
    const owner = `user_owner_${suffix}`;
    await inOrg(async (db) => {
      const role = await db.organizationRole.create({
        data: {
          key: 'owner',
          name: 'Owner',
          isSystem: true,
          permissions: { create: [{ capability: 'pharmacy:*', effect: 'ALLOW' }] },
        },
      });
      await db.user.create({
        data: {
          id: owner,
          name: 'Owner',
          email: `${owner}@example.test`,
          department: 'PHARMACY',
          title: 'Owner',
          role: 'ADMIN',
          organizationRoleId: role.id,
        },
      });
    });
    await deps.withTenantDb(
      ORG,
      async (db) => {
        const current = await readPharmacistCheckPolicy(db, ORG);
        await writePharmacistCheckPolicy(
          db,
          { organizationId: ORG, actorId: owner },
          {
            enabled: false,
            expectedVersion: current.version,
            disclaimer: { accepted: true, version: PHARMACIST_CHECK_DISCLAIMER.version },
          }
        );
      },
      { userId: owner }
    );
    expect((await inOrg((db) => readPharmacistCheckPolicy(db, ORG))).enabled).toBe(false);
    const made = await fixture('rx', { units: 12, rx: true, looseUnits: 12 });
    await readyForReplay(made);
    const { client, lease, snapshots } = await prepared(made, { leaseSize: 1, quotaUnits: 5 });
    const catalog = (snapshots as SignedSnapshot[]).find((s) => s.envelope.kind === 'CATALOG')!;
    expect((catalog.payload as Array<{ id: string }>).some((row) => row.id === made.medicineId)).toBe(false);
    const before = await onHand(made);
    const response = await client.replay(
      unitCommand(made, { lease, receiptNumber: lease.blockStart, sequence: 1, snapshots })
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'medicine_not_offline_otc' });
    expect(await onHand(made)).toBe(before);
    const sales = await inOrg((db) =>
      db.pharmacySale.count({ where: { branchId: made.branchId } })
    );
    expect(sales).toBe(0);
  });
});
