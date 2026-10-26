/**
 * M5-L3 drawer sessions — the pure expected-cash fold plus the named integration
 * checks only a real database establishes: opening float + OPENING_FLOAT movement,
 * one-OPEN-per-register enforcement (including a concurrent race against the
 * partial unique), append-only movements on an OPEN drawer only, the expected-cash
 * ledger fold to a write-once close, and device-scoped idempotent replay against
 * `restaurant_money_idempotency_keys`.
 *
 * Requires TEST_DATABASE_URL (a migrated, throwaway database, never DATABASE_URL);
 * without it the DB suite reports itself skipped rather than passing vacuously. The
 * pure fold runs regardless. One per-run-unique organization; a fresh register
 * device per test isolates the one-OPEN-per-register constraint.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { foldExpectedCash } from './drawer-sessions';

// ── Pure fold (no database) ───────────────────────────────────────────────────

describe('foldExpectedCash (pure, exact Decimal)', () => {
  it('folds the ledger with the right sign per kind and ignores the closing count', () => {
    const fold = foldExpectedCash([
      { kind: 'OPENING_FLOAT', amount: '100.00' },
      { kind: 'CASH_SALE', amount: '30.00' },
      { kind: 'CASH_REFUND', amount: '5.00' },
      { kind: 'PAID_IN', amount: '10.00' },
      { kind: 'PAID_OUT', amount: '4.00' },
      { kind: 'DROP', amount: '20.00' },
      { kind: 'CLOSING_COUNT', amount: '999.99' },
    ]);
    // 100 + 30 - 5 + 10 - 4 - 20 = 111 (closing count excluded)
    expect(fold.toString()).toBe('111');
  });

  it('is zero for an empty ledger and exact on odd cents', () => {
    expect(foldExpectedCash([]).toString()).toBe('0');
    expect(
      foldExpectedCash([
        { kind: 'OPENING_FLOAT', amount: '0.01' },
        { kind: 'CASH_SALE', amount: '0.02' },
        { kind: 'CASH_REFUND', amount: '0.01' },
      ]).toString()
    ).toBe('0.02');
  });
});

// ── Real-database integration ─────────────────────────────────────────────────

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha56d_${suffix}`;
const ids = {
  branch: `branch_${suffix}`,
  operator: `staff_op_${suffix}`,
  manager: `staff_mgr_${suffix}`,
};
const AT = new Date('2026-08-19T18:00:00.000Z');

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  enrollDevice: (typeof import('@/lib/restaurant/devices'))['enrollDevice'];
  drawer: typeof import('./drawer-sessions');
  close: typeof import('./daily-close');
};

let deps: Deps;
let keyCounter = 0;
const key = () => `k_${suffix}_${++keyCounter}`;
const actor = (deviceId: string, idempotencyKey = key()) => ({
  staffProfileId: ids.operator,
  deviceId,
  idempotencyKey,
});

function read<T>(fn: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(orgId, fn);
}

async function newDevice(label: string): Promise<string> {
  return deps.withTenantDb(orgId, async (tx) => {
    const enrolled = await deps.enrollDevice(tx, { branchId: ids.branch, name: label });
    return enrolled.device.id;
  });
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, devices, drawer, close] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/devices'),
    import('./drawer-sessions'),
    import('./daily-close'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    createTenantDb: scopedDb.createTenantDb,
    enrollDevice: devices.enrollDevice,
    drawer,
    close,
  };

  await deps.withPlatformDb((tx) =>
    tx.organization.create({
      data: {
        id: orgId,
        slug: `wha56d-${suffix}`,
        legalName: 'Drawers Test Co',
        displayName: 'Drawers Test',
        status: 'ACTIVE',
      },
    })
  );

  await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantBranch.create({
      data: { id: ids.branch, name: 'Main', timezone: 'UTC', businessDayCutoff: '00:00' },
    });
    await tx.restaurantStaffProfile.create({
      data: { id: ids.operator, displayName: 'Operator', status: 'ACTIVE' },
    });
    await tx.restaurantStaffProfile.create({
      data: { id: ids.manager, displayName: 'Manager', status: 'ACTIVE' },
    });
  });
});

describeIfDatabase('drawer session command layer (real DB)', () => {
  it('opens a drawer: stamps business date, writes an OPENING_FLOAT movement', async () => {
    const deviceId = await newDevice('POS-open');
    const db = deps.createTenantDb(orgId);
    const opened = await deps.drawer.openDrawerSession(db, {
      organizationId: orgId,
      entitlementLimits: { 'pos.concurrentRegisters.max': 1000000 },
      branchId: ids.branch,
      openingFloat: '150.00',
      actor: actor(deviceId),
      now: AT,
    });
    expect(opened.businessDate.toISOString().slice(0, 10)).toBe('2026-08-19');

    const session = await read((tx) =>
      tx.restaurantDrawerSession.findUnique({
        where: { id: opened.drawerSessionId },
        select: {
          status: true,
          openingFloat: true,
          expectedCash: true,
          deviceId: true,
          staffProfileId: true,
          movements: { select: { kind: true, amount: true } },
        },
      })
    );
    expect(session?.status).toBe('OPEN');
    expect(session?.openingFloat.toString()).toBe('150');
    expect(session?.expectedCash).toBeNull();
    expect(session?.deviceId).toBe(deviceId);
    expect(session?.staffProfileId).toBe(ids.operator);
    expect(session?.movements).toEqual([{ kind: 'OPENING_FLOAT', amount: expect.anything() }]);
    expect(session?.movements[0].amount.toString()).toBe('150');
  });

  it('rejects opening a drawer after its business day has been closed', async () => {
    const date = '2026-08-20';
    const closingDeviceId = await newDevice('POS-day-close');
    const openingDeviceId = await newDevice('POS-after-day-close');
    const openingActor = actor(openingDeviceId);
    const db = deps.createTenantDb(orgId);

    await deps.close.cutClose(db, {
      branchId: ids.branch,
      businessDate: date,
      actor: actor(closingDeviceId),
    });

    await expect(
      deps.drawer.openDrawerSession(db, {
        organizationId: orgId,
        entitlementLimits: { 'pos.concurrentRegisters.max': 1000000 },
        branchId: ids.branch,
        openingFloat: '100.00',
        actor: openingActor,
        now: new Date(`${date}T12:00:00.000Z`),
      })
    ).rejects.toMatchObject({ reason: 'CLOSE_EXISTS' });

    const [sessions, movements, idempotencyKeys] = await read((tx) =>
      Promise.all([
        tx.restaurantDrawerSession.count({ where: { deviceId: openingDeviceId } }),
        tx.restaurantDrawerMovement.count({ where: { deviceId: openingDeviceId } }),
        tx.restaurantMoneyIdempotencyKey.count({
          where: { deviceId: openingDeviceId, key: openingActor.idempotencyKey },
        }),
      ])
    );
    expect(sessions).toBe(0);
    expect(movements).toBe(0);
    expect(idempotencyKeys).toBe(0);
  });

  it('serializes a concurrent drawer open against closing the same business day', async () => {
    const date = '2026-08-21';
    const closingDeviceId = await newDevice('POS-concurrent-close');
    const openingDeviceId = await newDevice('POS-concurrent-open');
    const closingActor = actor(closingDeviceId);
    const openingActor = actor(openingDeviceId);

    const [closeResult, openResult] = await Promise.allSettled([
      deps.close.cutClose(deps.createTenantDb(orgId), {
        branchId: ids.branch,
        businessDate: date,
        actor: closingActor,
      }),
      deps.drawer.openDrawerSession(deps.createTenantDb(orgId), {
        organizationId: orgId,
        entitlementLimits: { 'pos.concurrentRegisters.max': 1000000 },
        branchId: ids.branch,
        openingFloat: '100.00',
        actor: openingActor,
        now: new Date(`${date}T12:00:00.000Z`),
      }),
    ]);

    expect([closeResult.status, openResult.status].sort()).toEqual(['fulfilled', 'rejected']);
    if (closeResult.status === 'rejected') {
      expect(closeResult.reason).toMatchObject({ reason: 'OPEN_DRAWER' });
      expect(openResult).toMatchObject({ status: 'fulfilled', value: { replayed: false } });
    } else {
      expect(openResult).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ reason: 'CLOSE_EXISTS' }),
      });
    }

    const [closes, sessions, movements, closingIdempotencyKeys, openingIdempotencyKeys] = await read(
      (tx) =>
        Promise.all([
          tx.restaurantDailyClose.count({
            where: { branchId: ids.branch, businessDate: new Date(`${date}T00:00:00.000Z`) },
          }),
          tx.restaurantDrawerSession.findMany({
            where: { deviceId: openingDeviceId },
            select: { openingFloat: true },
          }),
          tx.restaurantDrawerMovement.findMany({
            where: { deviceId: openingDeviceId },
            select: { amount: true, kind: true },
          }),
          tx.restaurantMoneyIdempotencyKey.count({
            where: { deviceId: closingDeviceId, key: closingActor.idempotencyKey },
          }),
          tx.restaurantMoneyIdempotencyKey.count({
            where: { deviceId: openingDeviceId, key: openingActor.idempotencyKey },
          }),
        ])
    );
    if (closeResult.status === 'fulfilled') {
      expect([closes, sessions, movements, closingIdempotencyKeys, openingIdempotencyKeys]).toEqual([
        1,
        [],
        [],
        1,
        0,
      ]);
    } else {
      expect(closes).toBe(0);
      expect(closingIdempotencyKeys).toBe(0);
      expect(openingIdempotencyKeys).toBe(1);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.openingFloat.toString()).toBe('100');
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({ kind: 'OPENING_FLOAT' });
      expect(movements[0]?.amount.toString()).toBe('100');
    }
  });

  it('rejects a second OPEN drawer on the same register', async () => {
    const deviceId = await newDevice('POS-dupe');
    const db = deps.createTenantDb(orgId);
    await deps.drawer.openDrawerSession(db, {
      organizationId: orgId,
      entitlementLimits: { 'pos.concurrentRegisters.max': 1000000 },
      branchId: ids.branch,
      openingFloat: '50.00',
      actor: actor(deviceId),
      now: AT,
    });
    await expect(
      deps.drawer.openDrawerSession(db, {
        organizationId: orgId,
        entitlementLimits: { 'pos.concurrentRegisters.max': 1000000 },
        branchId: ids.branch,
        openingFloat: '50.00',
        actor: actor(deviceId),
        now: AT,
      })
    ).rejects.toMatchObject({ reason: 'DRAWER_ALREADY_OPEN' });
  });

  it('allows at most one OPEN session per register under a concurrent race', async () => {
    const deviceId = await newDevice('POS-race');
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        deps.drawer.openDrawerSession(deps.createTenantDb(orgId), {
          organizationId: orgId,
          entitlementLimits: { 'pos.concurrentRegisters.max': 1000000 },
          branchId: ids.branch,
          openingFloat: '10.00',
          actor: actor(deviceId),
          now: AT,
        })
      )
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);

    const openCount = await read((tx) =>
      tx.restaurantDrawerSession.count({ where: { deviceId, status: 'OPEN' } })
    );
    expect(openCount).toBe(1);
  });

  it('records paid-in/paid-out adjustments (reason required) on an open drawer', async () => {
    const deviceId = await newDevice('POS-adjust');
    const db = deps.createTenantDb(orgId);
    const opened = await deps.drawer.openDrawerSession(db, {
      organizationId: orgId,
      entitlementLimits: { 'pos.concurrentRegisters.max': 1000000 },
      branchId: ids.branch,
      openingFloat: '100.00',
      actor: actor(deviceId),
      now: AT,
    });
    await deps.drawer.recordDrawerAdjustment(db, {
      drawerSessionId: opened.drawerSessionId,
      kind: 'PAID_IN',
      amount: '25.00',
      reason: 'float top-up',
      actor: actor(deviceId),
    });
    await expect(
      deps.drawer.recordDrawerAdjustment(db, {
        drawerSessionId: opened.drawerSessionId,
        kind: 'PAID_OUT',
        amount: '5.00',
        reason: '   ',
        actor: actor(deviceId),
      })
    ).rejects.toMatchObject({ reason: 'REASON_REQUIRED' });
  });

  it('appendMovement is rejected on a closed drawer', async () => {
    const deviceId = await newDevice('POS-appendclosed');
    const db = deps.createTenantDb(orgId);
    const opened = await deps.drawer.openDrawerSession(db, {
      organizationId: orgId,
      entitlementLimits: { 'pos.concurrentRegisters.max': 1000000 },
      branchId: ids.branch,
      openingFloat: '20.00',
      actor: actor(deviceId),
      now: AT,
    });
    await deps.drawer.closeDrawerSession(db, {
      drawerSessionId: opened.drawerSessionId,
      countedCash: '20.00',
      actor: actor(deviceId),
    });
    await expect(
      deps.withTenantDb(orgId, (tx) =>
        deps.drawer.appendMovement(tx, {
          drawerSessionId: opened.drawerSessionId,
          kind: 'CASH_SALE',
          amount: '5.00',
          staffProfileId: ids.operator,
          deviceId,
        })
      )
    ).rejects.toMatchObject({ reason: 'DRAWER_NOT_OPEN' });
  });

  it('folds the ledger to expected cash and writes counted + variance once at close', async () => {
    const deviceId = await newDevice('POS-close');
    const db = deps.createTenantDb(orgId);
    const opened = await deps.drawer.openDrawerSession(db, {
      organizationId: orgId,
      entitlementLimits: { 'pos.concurrentRegisters.max': 1000000 },
      branchId: ids.branch,
      openingFloat: '100.00',
      actor: actor(deviceId),
      now: AT,
    });
    // A cash sale posted the way L4's tender flow does — inside a tenant tx.
    await deps.withTenantDb(orgId, (tx) =>
      deps.drawer.appendMovement(tx, {
        drawerSessionId: opened.drawerSessionId,
        kind: 'CASH_SALE',
        amount: '30.00',
        staffProfileId: ids.operator,
        deviceId,
      })
    );
    await deps.drawer.recordDrawerAdjustment(db, {
      drawerSessionId: opened.drawerSessionId,
      kind: 'PAID_OUT',
      amount: '4.00',
      reason: 'supplies',
      actor: actor(deviceId),
    });

    const closed = await deps.drawer.closeDrawerSession(db, {
      drawerSessionId: opened.drawerSessionId,
      countedCash: '130.00',
      actor: actor(deviceId),
    });
    // expected = 100 + 30 - 4 = 126; variance = 130 - 126 = 4
    expect(closed.expectedCash.toString()).toBe('126');
    expect(closed.countedCash.toString()).toBe('130');
    expect(closed.variance.toString()).toBe('4');

    const session = await read((tx) =>
      tx.restaurantDrawerSession.findUnique({
        where: { id: opened.drawerSessionId },
        select: {
          status: true,
          expectedCash: true,
          countedCash: true,
          variance: true,
          movements: { where: { kind: 'CLOSING_COUNT' }, select: { amount: true } },
        },
      })
    );
    expect(session?.status).toBe('CLOSED');
    expect(session?.expectedCash?.toString()).toBe('126');
    expect(session?.variance?.toString()).toBe('4');
    expect(session?.movements[0]?.amount.toString()).toBe('130');

    // Write-once: a second close is rejected.
    await expect(
      deps.drawer.closeDrawerSession(db, {
        drawerSessionId: opened.drawerSessionId,
        countedCash: '130.00',
        actor: actor(deviceId),
      })
    ).rejects.toMatchObject({ reason: 'ALREADY_CLOSED' });
  });

  it('replays an idempotent open: same key returns the original and creates nothing', async () => {
    const deviceId = await newDevice('POS-idem');
    const db = deps.createTenantDb(orgId);
    const reuse = key();
    const first = await deps.drawer.openDrawerSession(db, {
      organizationId: orgId,
      entitlementLimits: { 'pos.concurrentRegisters.max': 1000000 },
      branchId: ids.branch,
      openingFloat: '75.00',
      actor: actor(deviceId, reuse),
      now: AT,
    });
    const replay = await deps.drawer.openDrawerSession(db, {
      organizationId: orgId,
      entitlementLimits: { 'pos.concurrentRegisters.max': 1000000 },
      branchId: ids.branch,
      openingFloat: '75.00',
      actor: actor(deviceId, reuse),
      now: AT,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.drawerSessionId).toBe(first.drawerSessionId);

    const count = await read((tx) => tx.restaurantDrawerSession.count({ where: { deviceId } }));
    expect(count).toBe(1);
  });
});
