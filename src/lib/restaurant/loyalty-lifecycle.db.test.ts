/**
 * WHA-132 / M8 correction B — the loyalty ↔ bill lifecycle invariants that only a
 * real database and real transactions can establish. Drives the ACTUAL command layer
 * (`cutBills`, `compLine`, `redeemLoyaltyPoints`, `applyTender`, `refundTender`,
 * `closeOrder`) through `createTenantDb`, exactly as a route handler does.
 *
 * The named checks:
 *   - B3 a comp on a redeemed bill releases only the redemption it cannot absorb,
 *     keeps `subtotal = grandTotal + compTotal + discountTotal` exact, and never
 *     leaves `grandTotal` below zero — partial release first, then full;
 *   - B3 a comp that would still overdraw a bill carrying no releasable redemption
 *     is REFUSED rather than recorded as a negative total;
 *   - the DB CHECK rejects a negative `grandTotal` even by raw SQL;
 *   - B4 void-and-recut of a discounted bill hands the points back and rolls the
 *     discount off the voided record, so the fresh bill loses none of the guest's
 *     value;
 *   - M2 a refund taken BEFORE the close reduces the earn, and a later refund
 *     reverses only the remainder — the same money is never charged twice;
 *   - M2 a close and a refund racing for the SAME bill, in two overlapping
 *     transactions with the loser provably queued on the row lock, converge on the
 *     same net balance in BOTH orderings — no earn on refunded money, no double
 *     reversal;
 *   - B3 the comped bill goes out through the REAL register path — zero tender, settle,
 *     close — with the identity intact and nothing earned on comped money;
 *   - B4 the re-cut lifecycle end to end: a failed re-cut rolls back whole, the retry
 *     compensates the redemption EXACTLY once, and a same-key replay answers with the
 *     bills the first call cut without re-planning or writing;
 *   - B4 a cut serializes on the ORDER, not only on the bills it can see: a concurrent
 *     first cut is provably queued on a key that exists before any bill does, and is
 *     then refused rather than billing one order twice;
 *   - the guard migration FAILS the deployment on a database that already holds a
 *     negative grand total, whether or not row-level security lets its precondition
 *     see the row, and leaks no bill or tenant identifier while doing so;
 *   - the release and the bill mutation commit or roll back together (injected
 *     failure), and a money-key replay releases nothing a second time while still
 *     REPORTING what the call it replays released — including at a FRACTIONAL point
 *     value, where the same one point is worth 0.03 to one comp and 0.04 to the next,
 *     and a replay re-derived from the ledger would answer with the wrong one;
 *   - the role this all ran as is neither SUPERUSER nor BYPASSRLS (asked of `pg_roles`,
 *     not assumed), a second tenant can see and touch none of it, and a cross-tenant
 *     ledger write is refused by the INSERT policy and by the composite tenant key.
 *
 * Requires TEST_DATABASE_URL — a migrated throwaway database with an unprivileged
 * (NOSUPERUSER / NOBYPASSRLS) application role, never DATABASE_URL. Every read is
 * filtered by a per-run-unique id.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import { ensureRestaurantTaxProfile } from '@/lib/test-support/restaurant-tax-profile';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const M8_TEST_OWNER_DATABASE_URL = process.env.M8_TEST_OWNER_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase =
  TEST_DATABASE_URL && M8_TEST_OWNER_DATABASE_URL ? describe : describe.skip;

/** Assert a money value by Decimal VALUE (never a float, never an epsilon). */
const eqMoney = (actual: unknown, expected: string) =>
  expect(
    new Prisma.Decimal(String(actual)).equals(expected),
    `${String(actual)} ≠ ${expected}`
  ).toBe(true);

const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha132_${suffix}`;
const TODAY = new Date().toISOString().slice(0, 10);
const businessDate = new Date(`${TODAY}T00:00:00.000Z`);

type Deps = {
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  enrollDevice: (typeof import('./devices'))['enrollDevice'];
  bills: typeof import('./bills');
  loyalty: typeof import('./loyalty');
  tenders: typeof import('./tenders');
  refunds: typeof import('./refunds');
  drawers: typeof import('./drawer-sessions');
  orders: typeof import('./orders');
};

let deps: Deps;
let db: ScopedDb;

/** Everything a scenario needs to drive the command layer as ONE organization. The
 * battery runs two: `ctx` (the default) and `ctxB`, whose loyalty program prices points
 * FRACTIONALLY so cumulative rounding is observable. */
type Tenant = {
  orgId: string;
  branch: string;
  product: string;
  operator: string;
  manager: string;
  deviceId: string;
  db: ScopedDb;
};

const ctx: Tenant = {
  orgId,
  branch: `branch_${suffix}`,
  product: `product_${suffix}`,
  operator: `staff_op_${suffix}`,
  manager: `staff_mgr_${suffix}`,
  deviceId: '',
  db: undefined as unknown as ScopedDb,
};

const orgB = `org_wha132b_${suffix}`;
const ctxB: Tenant = {
  orgId: orgB,
  branch: `branchb_${suffix}`,
  product: `productb_${suffix}`,
  operator: `staff_opb_${suffix}`,
  manager: `staff_mgrb_${suffix}`,
  deviceId: '',
  db: undefined as unknown as ScopedDb,
};

/** One loyalty customer + funded account per scenario, so every count is absolute. */
async function seedGuest(label: string, points: number, t: Tenant = ctx) {
  const customerId = `cust_${label}_${suffix}`;
  await deps.withTenantDb(t.orgId, (tx) =>
    tx.restaurantCustomer.create({ data: { id: customerId, displayName: label } })
  );
  const enrolled = await deps.loyalty.enrollLoyaltyAccount(t.db, {
    customerId,
    activeCustomersMax: 50,
  });
  if (points !== 0) {
    await deps.loyalty.adjustLoyaltyPoints(t.db, {
      accountId: enrolled.id,
      points,
      actorId: t.operator,
      reason: 'opening balance for the lifecycle battery',
      idempotencyKey: `seed:${label}:${suffix}`,
    });
  }
  return { customerId, accountId: enrolled.id };
}

let orderSeq = 0;

async function seedOrder(customerId: string | null, prices: string[], t: Tenant = ctx) {
  orderSeq += 1;
  const orderNumber = orderSeq;
  return deps.withTenantDb(t.orgId, async (tx) => {
    const order = await tx.restaurantOrder.create({
      data: {
        branchId: t.branch,
        orderNumber,
        businessDate,
        status: 'SERVED',
        channel: 'DINE_IN',
        staffProfileId: t.operator,
        deviceId: t.deviceId,
        customerId,
      },
      select: { id: true },
    });
    const itemIds: string[] = [];
    for (const unitPrice of prices) {
      const item = await tx.restaurantOrderItem.create({
        data: {
          orderId: order.id,
          productId: t.product,
          name: 'Plate',
          unitPrice,
          quantity: 1,
          status: 'SERVED',
        },
        select: { id: true },
      });
      itemIds.push(item.id);
    }
    return { orderId: order.id, itemIds };
  });
}

const actor = (label: string, t: Tenant = ctx) => ({
  staffProfileId: t.operator,
  deviceId: t.deviceId,
  idempotencyKey: `${label}-${suffix}-${randomBytes(3).toString('hex')}`,
});

/** Seed one organization's branch / catalog / staff / device / loyalty program. */
async function provisionTenant(t: Tenant, slug: string, program: { redemptionValue: string }) {
  const owner = new Client({ connectionString: M8_TEST_OWNER_DATABASE_URL });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query(`SET LOCAL app.is_platform_admin = 'true'`);
    await owner.query(
      `INSERT INTO "organizations"
        ("id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $2, 'WHA132 Test Co', 'WHA132 Test', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [t.orgId, slug]
    );
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await owner.end();
  }
  await deps.withTenantDb(t.orgId, async (tx) => {
    await tx.restaurantBranch.create({ data: { id: t.branch, name: 'Lifecycle' } });
    await ensureRestaurantTaxProfile(tx, t.orgId, t.branch);
    await tx.restaurantProduct.create({ data: { id: t.product, name: 'Plate' } });
    await tx.restaurantStaffProfile.create({
      data: { id: t.operator, displayName: 'Operator', status: 'ACTIVE' },
    });
    await tx.restaurantStaffProfile.create({
      data: { id: t.manager, displayName: 'Manager', status: 'ACTIVE' },
    });
  });
  const enrolled = await deps.withTenantDb(t.orgId, (tx) =>
    deps.enrollDevice(tx, { branchId: t.branch, name: 'POS' })
  );
  t.deviceId = enrolled.device.id;
  t.db = deps.createTenantDb(t.orgId);
  await deps.loyalty.configureLoyaltyProgram(t.db, {
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    earnRate: '1.000000',
    redemptionValue: program.redemptionValue,
    expiryDays: null,
  });
}

/**
 * A `db` whose next command runs to completion inside its transaction and then HOLDS
 * that transaction open — every row lock taken and every write still uncommitted —
 * until `commit()` is called. `reached` settles the moment the command's own work is
 * done, which is the window a test needs in order to start the competing command
 * against locks that are provably still held.
 */
function heldOpen(base: ScopedDb) {
  let signalReached!: () => void;
  let openGate!: () => void;
  const reached = new Promise<void>((resolve) => {
    signalReached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const held = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
      return (run: (tx: ScopedDb) => Promise<unknown>) =>
        (
          target.$transaction as unknown as (
            fn: (tx: ScopedDb) => Promise<unknown>
          ) => Promise<unknown>
        )(async (tx: ScopedDb) => {
          const result = await run(tx);
          signalReached();
          await gate;
          return result;
        });
    },
  }) as ScopedDb;
  return { db: held, reached, commit: () => openGate() };
}

/**
 * Block until some backend on this database is WAITING ON A LOCK.
 *
 * This is the deterministic barrier the concurrency battery turns on. Without it a
 * test can only hope the second command reached the contended row lock before the
 * first one committed, and the interleaving it claims to exercise may never have
 * happened — the race would then pass against the very bug it exists to catch. Here
 * the test does not continue until PostgreSQL itself reports the queue.
 */
async function awaitBlockedBackend(observer: Client) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'`
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    'no backend ever waited on a lock: the interleaving under test never happened, ' +
      'so this run proves nothing about serialization'
  );
}

/**
 * A `db` whose next command runs its whole transaction and then FAILS, after every write
 * it makes — the injected-failure seam the atomicity checks turn on.
 */
function failAfterWrites(base: ScopedDb) {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
      return (run: (tx: ScopedDb) => Promise<unknown>) =>
        (
          target.$transaction as unknown as (
            fn: (tx: ScopedDb) => Promise<unknown>
          ) => Promise<unknown>
        )(async (tx: ScopedDb) => {
          await run(tx);
          throw new Error('injected failure after the command wrote');
        });
    },
  }) as ScopedDb;
}

/** Settle a promise into a value/error record without ever leaving it unhandled. */
const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: undefined as unknown }),
    (error: unknown) => ({ value: undefined as unknown as T, error })
  );

function moneyKeyCount(idempotencyKey: string, t: Tenant = ctx) {
  return deps.withTenantDb(t.orgId, (tx) =>
    tx.restaurantMoneyIdempotencyKey.count({ where: { key: idempotencyKey } })
  );
}

function liveBills(orderId: string, t: Tenant = ctx) {
  return deps.withTenantDb(t.orgId, (tx) =>
    tx.restaurantBill.findMany({
      where: { orderId, status: { not: 'VOID' } },
      orderBy: { id: 'asc' },
      select: { id: true, status: true, grandTotal: true, discountTotal: true },
    })
  );
}

function readBill(billId: string, t: Tenant = ctx) {
  return deps.withTenantDb(t.orgId, (tx) =>
    tx.restaurantBill.findUniqueOrThrow({
      where: { id: billId },
      select: {
        status: true,
        subtotal: true,
        compTotal: true,
        discountTotal: true,
        grandTotal: true,
        roundingAdjustment: true,
      },
    })
  );
}

/** subtotal + rounding ≡ grandTotal + compTotal + discountTotal, by exact Decimal. */
function assertMoneyIdentity(bill: {
  subtotal: Prisma.Decimal;
  compTotal: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  grandTotal: Prisma.Decimal;
  roundingAdjustment: Prisma.Decimal;
}) {
  const left = bill.subtotal.plus(bill.roundingAdjustment);
  const right = bill.grandTotal.plus(bill.compTotal).plus(bill.discountTotal);
  expect(left.equals(right), `${left.toString()} ≠ ${right.toString()}`).toBe(true);
  expect(bill.grandTotal.isNegative()).toBe(false);
}

function ledger(accountId: string, t: Tenant = ctx) {
  return deps.withTenantDb(t.orgId, (tx) =>
    tx.loyaltyPointsEntry.findMany({
      where: { accountId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: {
        kind: true,
        points: true,
        billId: true,
        refundId: true,
        reversesEntryId: true,
        idempotencyKey: true,
      },
    })
  );
}

function billLines(billId: string, t: Tenant = ctx) {
  return deps.withTenantDb(t.orgId, (tx) =>
    tx.restaurantBillLine.findMany({
      where: { billId },
      orderBy: { id: 'asc' },
      select: { id: true, lineSubtotal: true },
    })
  );
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL || !M8_TEST_OWNER_DATABASE_URL) return;
  expect(M8_TEST_OWNER_DATABASE_URL).not.toBe(TEST_DATABASE_URL);
  const [scopedDb, devices, bills, loyalty, tenders, refunds, drawers, orders] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('./devices'),
    import('./bills'),
    import('./loyalty'),
    import('./tenders'),
    import('./refunds'),
    import('./drawer-sessions'),
    import('./orders'),
  ]);
  deps = {
    createTenantDb: scopedDb.createTenantDb,
    withTenantDb: scopedDb.withTenantDb,
    enrollDevice: devices.enrollDevice,
    bills,
    loyalty,
    tenders,
    refunds,
    drawers,
    orders,
  };

  // Tenant A: 1 point per currency unit earned; 1 point redeems 0.05 — a value that
  // divides the cent exactly, which keeps the lifecycle arithmetic readable.
  await provisionTenant(ctx, `wha132-${suffix}`, { redemptionValue: '0.050000' });
  db = ctx.db;

  // Tenant B: the SAME code under a redemption value that does NOT divide the cent
  // (0.0335), so cumulative rounding is observable — and a second tenant to prove the
  // isolation this battery's own reads depend on.
  await provisionTenant(ctxB, `wha132b-${suffix}`, { redemptionValue: '0.033500' });

  // Cash tenders and cash refunds both require this register to have an OPEN drawer.
  await deps.drawers.openDrawerSession(db, {
    organizationId: orgId,
    entitlementLimits: { 'pos.concurrentRegisters.max': 1000000 },
    branchId: ctx.branch,
    openingFloat: '100.00',
    actor: actor('drawer'),
  });
});

describeIfDatabase('M8/B3 — comp against a loyalty-discounted bill', () => {
  it('releases only what the comp cannot absorb, then the rest, and never goes negative', async () => {
    const guest = await seedGuest('comp', 1000);
    const { orderId } = await seedOrder(guest.customerId, ['10.00', '10.00']);
    const cut = await deps.bills.cutBills(db, {
      orderId,
      branchId: ctx.branch,
      split: { kind: 'NONE' },
      actor: actor('cut'),
    });
    const billId = cut.billIds[0]!;

    // 360 points × 0.05 = 18.00 off a 20.00 bill.
    const redeemed = await deps.loyalty.redeemLoyaltyPoints(db, {
      accountId: guest.accountId,
      billId,
      points: 360,
      actorId: ctx.operator,
      idempotencyKey: `redeem-${suffix}`,
    });
    eqMoney(redeemed.value, '18.00');
    let bill = await readBill(billId);
    eqMoney(bill.grandTotal, '2.00');
    eqMoney(bill.discountTotal, '18.00');
    expect(await deps.loyalty.loyaltyBalance(db, guest.accountId)).toBe(640);

    const lines = await billLines(billId);
    expect(lines).toHaveLength(2);

    // PARTIAL: the comp needs 10.00 but the bill only owes 2.00 — release 8.00
    // (160 points), the guest keeps the other 200.
    const firstComp = await deps.bills.compLine(db, {
      billId,
      branchId: ctx.branch,
      billLineId: lines[0]!.id,
      reason: 'kitchen error',
      approvingStaffProfileId: ctx.manager,
      actor: actor('comp1'),
    });
    eqMoney(firstComp.releasedDiscount, '8.00');
    bill = await readBill(billId);
    eqMoney(bill.grandTotal, '0.00');
    eqMoney(bill.compTotal, '10.00');
    eqMoney(bill.discountTotal, '10.00');
    assertMoneyIdentity(bill);
    expect(await deps.loyalty.loyaltyBalance(db, guest.accountId)).toBe(800);

    // FULL: the second comp needs the whole remaining 10.00 discount back.
    const secondComp = await deps.bills.compLine(db, {
      billId,
      branchId: ctx.branch,
      billLineId: lines[1]!.id,
      reason: 'kitchen error',
      approvingStaffProfileId: ctx.manager,
      actor: actor('comp2'),
    });
    eqMoney(secondComp.releasedDiscount, '10.00');
    bill = await readBill(billId);
    eqMoney(bill.grandTotal, '0.00');
    eqMoney(bill.compTotal, '20.00');
    eqMoney(bill.discountTotal, '0.00');
    assertMoneyIdentity(bill);

    // The guest spent nothing: every redeemed point is back.
    expect(await deps.loyalty.loyaltyBalance(db, guest.accountId)).toBe(1000);
    const entries = await ledger(guest.accountId);
    expect(entries.map((e) => [e.kind, e.points])).toEqual([
      ['ADJUSTMENT', 1000],
      ['REDEEM', -360],
      ['ADJUSTMENT', 160],
      ['ADJUSTMENT', 200],
    ]);
    // Both releases are compensations pinned to the redemption they gave back.
    const releases = entries.filter((e) => e.kind === 'ADJUSTMENT' && e.billId === billId);
    expect(releases.map((e) => e.points)).toEqual([160, 200]);
    expect(releases.every((e) => e.reversesEntryId !== null)).toBe(true);
  });

  it('refuses a comp that would overdraw a bill carrying no releasable redemption', async () => {
    const { orderId } = await seedOrder(null, ['10.00']);
    const cut = await deps.bills.cutBills(db, {
      orderId,
      branchId: ctx.branch,
      split: { kind: 'NONE' },
      actor: actor('cut-guard'),
    });
    const billId = cut.billIds[0]!;
    // Simulate a deduction this lane cannot release (grandTotal already at zero with
    // no loyalty discount behind it) — the comp must refuse, not record −10.00.
    await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantBill.update({ where: { id: billId }, data: { grandTotal: '0.00' } })
    );
    const lines = await billLines(billId);

    await expect(
      deps.bills.compLine(db, {
        billId,
        branchId: ctx.branch,
        billLineId: lines[0]!.id,
        reason: 'kitchen error',
        approvingStaffProfileId: ctx.manager,
        actor: actor('comp-guard'),
      })
    ).rejects.toMatchObject({ reason: 'COMP_EXCEEDS_BILL' });

    const bill = await readBill(billId);
    eqMoney(bill.compTotal, '0.00');
    eqMoney(bill.grandTotal, '0.00');
  });

  it('rejects a negative grand total at the database itself', async () => {
    const { orderId } = await seedOrder(null, ['10.00']);
    const cut = await deps.bills.cutBills(db, {
      orderId,
      branchId: ctx.branch,
      split: { kind: 'NONE' },
      actor: actor('cut-check'),
    });
    await expect(
      deps.withTenantDb(orgId, (tx) =>
        tx.restaurantBill.update({
          where: { id: cut.billIds[0]! },
          data: { grandTotal: '-0.01' },
        })
      )
    ).rejects.toThrow(/restaurant_bills_grandTotal_nonneg_ck/);
  });
});

describeIfDatabase('M8/B4 — void-and-recut of a discounted bill', () => {
  it('returns the spent points and rolls the discount off the voided bill', async () => {
    const guest = await seedGuest('recut', 500);
    const { orderId, itemIds } = await seedOrder(guest.customerId, ['12.00', '8.00']);
    const cut = await deps.bills.cutBills(db, {
      orderId,
      branchId: ctx.branch,
      split: { kind: 'NONE' },
      actor: actor('cut-recut'),
    });
    const originalBillId = cut.billIds[0]!;
    await deps.loyalty.redeemLoyaltyPoints(db, {
      accountId: guest.accountId,
      billId: originalBillId,
      points: 200,
      actorId: ctx.operator,
      idempotencyKey: `redeem-recut-${suffix}`,
    });
    eqMoney((await readBill(originalBillId)).discountTotal, '10.00');
    expect(await deps.loyalty.loyaltyBalance(db, guest.accountId)).toBe(300);

    const recut = await deps.bills.cutBills(db, {
      orderId,
      branchId: ctx.branch,
      split: { kind: 'BY_ITEM', groups: [[itemIds[0]!], [itemIds[1]!]] },
      recut: { reason: 'guest asked to split the check', approvingStaffProfileId: ctx.manager },
      actor: actor('recut'),
    });
    expect(recut.billIds).toHaveLength(2);

    // The void record no longer claims a discount nobody paid for…
    const voided = await readBill(originalBillId);
    expect(voided.status).toBe('VOID');
    eqMoney(voided.discountTotal, '0.00');
    eqMoney(voided.grandTotal, '20.00');
    assertMoneyIdentity(voided);

    // …and the guest can spend the points again on the bill they actually pay.
    expect(await deps.loyalty.loyaltyBalance(db, guest.accountId)).toBe(500);
    const entries = await ledger(guest.accountId);
    expect(entries.map((e) => [e.kind, e.points])).toEqual([
      ['ADJUSTMENT', 500],
      ['REDEEM', -200],
      ['ADJUSTMENT', 200],
    ]);
    expect(entries[2]!.reversesEntryId).toBeTruthy();

    const fresh = await Promise.all(recut.billIds.map((billId) => readBill(billId)));
    eqMoney(fresh[0]!.grandTotal, '12.00');
    eqMoney(fresh[1]!.grandTotal, '8.00');
    for (const bill of fresh) {
      eqMoney(bill.discountTotal, '0.00');
      assertMoneyIdentity(bill);
    }
  });
});

describeIfDatabase('M8/M2 — refunds around the order close', () => {
  it('earns net of a pre-close refund and reverses only the post-close remainder', async () => {
    const guest = await seedGuest('refund', 0);
    const { orderId } = await seedOrder(guest.customerId, ['10.00']);
    const cut = await deps.bills.cutBills(db, {
      orderId,
      branchId: ctx.branch,
      split: { kind: 'NONE' },
      actor: actor('cut-refund'),
    });
    const billId = cut.billIds[0]!;
    const tender = await deps.tenders.applyTender(db, {
      billId,
      tender: { type: 'CASH', amount: '10.00', cashReceived: '10.00' },
      actor: actor('tender'),
    });
    expect(tender.settled).toBe(true);

    // Settlement earns on the tax-exclusive merchandise value; a pre-close refund
    // reverses only the points attributable to the refunded inclusive amount.
    await deps.refunds.refundTender(db, {
      originalTenderId: tender.tenderId,
      amount: '4.00',
      reason: 'wrong dish',
      approvingStaffProfileId: ctx.manager,
      actor: actor('refund-pre'),
    });
    let entries = await ledger(guest.accountId);
    expect(entries.map((e) => [e.kind, e.points])).toEqual([
      ['EARN', 8],
      ['REVERSAL', -2],
    ]);

    await deps.orders.closeOrder(db, { orderId, actor: actor('close') });
    entries = await ledger(guest.accountId);
    expect(entries.map((e) => [e.kind, e.points])).toEqual([
      ['EARN', 8],
      ['REVERSAL', -2],
    ]);
    expect(entries[0]!.billId).toBe(billId);
    expect(await deps.loyalty.loyaltyBalance(db, guest.accountId)).toBe(6);

    // A second refund AFTER the close reverses only the 2 points the earn still
    // covers — the pre-close 4.00 is not charged twice.
    await deps.refunds.refundTender(db, {
      originalTenderId: tender.tenderId,
      amount: '2.00',
      reason: 'second correction',
      approvingStaffProfileId: ctx.manager,
      actor: actor('refund-post'),
    });
    entries = await ledger(guest.accountId);
    expect(entries.map((e) => [e.kind, e.points])).toEqual([
      ['EARN', 8],
      ['REVERSAL', -2],
      ['REVERSAL', -2],
    ]);
    expect(entries[2]!.refundId).toBeTruthy();
    expect(await deps.loyalty.loyaltyBalance(db, guest.accountId)).toBe(4);

    // Refunding the rest strands nothing: the balance lands exactly at zero.
    await deps.refunds.refundTender(db, {
      originalTenderId: tender.tenderId,
      amount: '4.00',
      reason: 'final correction',
      approvingStaffProfileId: ctx.manager,
      actor: actor('refund-rest'),
    });
    expect(await deps.loyalty.loyaltyBalance(db, guest.accountId)).toBe(0);
  });
});

describeIfDatabase('M8/M2 — close ↔ refund serialization under real concurrency', () => {
  /**
   * Drive a close and a refund of the SAME bill in two overlapping transactions, with
   * `ordering` deciding which one takes the bill row lock first and the other one
   * provably queued behind it. A 10.00 bill, 4.00 refunded, 1 point per unit: the
   * guest must end on 6 points either way.
   *
   * The unserialized version of this loses that: the close reads refunds without the
   * lock, so with `refund-first` it earns 10 on a refund it cannot see while the
   * refund, finding no committed earn, writes no reversal — 10 points on 6.00 of kept
   * money, with nothing left to correct it.
   */
  async function raceCloseAndRefund(ordering: 'close-first' | 'refund-first', observer: Client) {
    const guest = await seedGuest(`race-${ordering}`, 0);
    const { orderId } = await seedOrder(guest.customerId, ['10.00']);
    const cut = await deps.bills.cutBills(db, {
      orderId,
      branchId: ctx.branch,
      split: { kind: 'NONE' },
      actor: actor(`cut-${ordering}`),
    });
    const tender = await deps.tenders.applyTender(db, {
      billId: cut.billIds[0]!,
      tender: { type: 'CASH', amount: '10.00', cashReceived: '10.00' },
      actor: actor(`tender-${ordering}`),
    });
    expect(tender.settled).toBe(true);

    const close = (target: ScopedDb) =>
      deps.orders.closeOrder(target, { orderId, actor: actor(`close-${ordering}`) });
    const refund = (target: ScopedDb) =>
      deps.refunds.refundTender(target, {
        originalTenderId: tender.tenderId,
        amount: '4.00',
        reason: 'wrong dish',
        approvingStaffProfileId: ctx.manager,
        actor: actor(`refund-${ordering}`),
      });

    const held = heldOpen(db);
    const holder = ordering === 'close-first' ? close(held.db) : refund(held.db);
    // The holder has finished its writes and still owns every lock it took…
    await held.reached;
    const contender = ordering === 'close-first' ? refund(db) : close(db);
    // …and the contender is now demonstrably stuck on one of them.
    await awaitBlockedBackend(observer);
    held.commit();
    await Promise.all([holder, contender]);

    return {
      entries: (await ledger(guest.accountId)).map((entry) => [entry.kind, entry.points]),
      balance: await deps.loyalty.loyaltyBalance(db, guest.accountId),
    };
  }

  it('converges on the same net balance whichever side wins the bill lock', async () => {
    const observer = new Client({ connectionString: TEST_DATABASE_URL });
    await observer.connect();
    let closeFirst: Awaited<ReturnType<typeof raceCloseAndRefund>>;
    let refundFirst: Awaited<ReturnType<typeof raceCloseAndRefund>>;
    try {
      closeFirst = await raceCloseAndRefund('close-first', observer);
      refundFirst = await raceCloseAndRefund('refund-first', observer);
    } finally {
      await observer.end();
    }

    // Settlement earned eight points on the tax-exclusive basis. Whichever contender
    // wins the bill lock, the inclusive refund reverses the same two attributable points.
    expect(closeFirst.entries).toEqual([
      ['EARN', 8],
      ['REVERSAL', -2],
    ]);
    expect(refundFirst.entries).toEqual([
      ['EARN', 8],
      ['REVERSAL', -2],
    ]);

    // Neither ordering double-earns or double-reverses…
    for (const outcome of [closeFirst, refundFirst]) {
      expect(outcome.entries.filter(([kind]) => kind === 'EARN')).toHaveLength(1);
      expect(outcome.entries.filter(([kind]) => kind === 'REVERSAL').length).toBeLessThanOrEqual(1);
    }
    // …and both land on the identical net ledger balance: 6 points for 6.00 kept.
    expect(closeFirst.balance).toBe(refundFirst.balance);
    expect(closeFirst.balance).toBe(6);
  }, 120_000);
});

describeIfDatabase('M8 grandTotal guard migration — fails closed', () => {
  // The SHIPPED file, read from the repo root (vitest's root) — never a copy, so this
  // battery cannot pass against SQL that is not the SQL a deploy would run.
  const MIGRATION = join(
    process.cwd(),
    'prisma/migrations/20260824120000_restaurant_m8_bill_grand_total_guard/migration.sql'
  );
  const CHECK_VIOLATION = '23514';
  const constraint = 'restaurant_bills_grandTotal_nonneg_ck';

  async function connect() {
    const client = new Client({ connectionString: M8_TEST_OWNER_DATABASE_URL });
    await client.connect();
    return client;
  }

  /**
   * Run the SHIPPED migration file against a database deliberately holding one negative
   * grand total, then roll the whole thing back.
   *
   * `visible` selects whether the session can SEE the offending row. A real migration
   * runs with no `app.current_organization_id`, and `restaurant_bills` is FORCE ROW
   * LEVEL SECURITY, so the migration's own precondition SELECT is policy-filtered to
   * nothing — which is exactly why the unguarded `VALIDATE` has to be there as well.
   * Both settings must abort the deployment.
   */
  async function deployOverNegativeBill(visible: boolean) {
    const { orderId } = await seedOrder(null, ['10.00']);
    const cut = await deps.bills.cutBills(db, {
      orderId,
      branchId: ctx.branch,
      split: { kind: 'NONE' },
      actor: actor(`cut-mig-${visible}`),
    });
    const billId = cut.billIds[0]!;
    const sql = await readFile(MIGRATION, 'utf8');

    const client = await connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL lock_timeout = 15000');
      await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [orgId]);
      // Reach the corrupt state this guard exists to refuse: take the CHECK away, write
      // a negative grand total, then put the migration back in front of it.
      await client.query(`ALTER TABLE "restaurant_bills" DROP CONSTRAINT "${constraint}"`);
      const corrupted = await client.query(
        'UPDATE "restaurant_bills" SET "grandTotal" = -1 WHERE id = $1',
        [billId]
      );
      expect(corrupted.rowCount).toBe(1);
      if (!visible) {
        await client.query(`SELECT set_config('app.current_organization_id', '', true)`);
      }

      const error = await client.query(sql).then(
        () => {
          throw new Error('the migration COMPLETED on a table holding a negative grand total');
        },
        (failure: Error & { code?: string }) => failure
      );
      return { error, billId };
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      await client.end();
    }
  }

  it('aborts the deployment when its precondition can see the offending rows', async () => {
    const { error, billId } = await deployOverNegativeBill(true);
    expect(error.code).toBe(CHECK_VIOLATION);
    expect(error.message).toMatch(/1 row\(s\) with grandTotal < 0/);
    expect(error.message).toContain(constraint);
    // Aggregate diagnostics only — a deploy log must not carry bill, order or tenant
    // identifiers out of a financial table.
    expect(error.message).not.toContain(billId);
    expect(error.message).not.toContain(orgId);
  }, 60_000);

  it('still aborts when row-level security hides those rows from the precondition', async () => {
    const { error, billId } = await deployOverNegativeBill(false);
    expect(error.code).toBe(CHECK_VIOLATION);
    // This is the VALIDATE scan speaking, not the precondition: it reads the heap
    // directly, so no policy can talk it out of the violation.
    expect(error.message).toMatch(/violated by some row/i);
    expect(error.message).toContain(constraint);
    expect(error.message).not.toContain(billId);
  }, 60_000);

  it('re-runs clean on a healthy database and leaves the constraint VALID', async () => {
    const sql = await readFile(MIGRATION, 'utf8');
    const client = await connect();
    try {
      await client.query(sql);
      const { rows } = await client.query(
        `SELECT convalidated FROM pg_constraint WHERE conname = $1`,
        [constraint]
      );
      expect(rows).toEqual([{ convalidated: true }]);
    } finally {
      await client.end();
    }
  }, 60_000);
});

describeIfDatabase('M8/B3 — atomicity and replay', () => {
  it('rolls the release back with the comp when the transaction fails', async () => {
    const guest = await seedGuest('rollback', 400);
    const { orderId } = await seedOrder(guest.customerId, ['10.00']);
    const cut = await deps.bills.cutBills(db, {
      orderId,
      branchId: ctx.branch,
      split: { kind: 'NONE' },
      actor: actor('cut-rollback'),
    });
    const billId = cut.billIds[0]!;
    await deps.loyalty.redeemLoyaltyPoints(db, {
      accountId: guest.accountId,
      billId,
      points: 180,
      actorId: ctx.operator,
      idempotencyKey: `redeem-rollback-${suffix}`,
    });
    const before = await readBill(billId);
    eqMoney(before.grandTotal, '1.00');
    const entriesBefore = await ledger(guest.accountId);
    const lines = await billLines(billId);

    // Fail INSIDE the command's own transaction, after every write it makes.
    const failing = failAfterWrites(db);
    const failedActor = actor('comp-rollback');
    await expect(
      deps.bills.compLine(failing, {
        billId,
        branchId: ctx.branch,
        billLineId: lines[0]!.id,
        reason: 'kitchen error',
        approvingStaffProfileId: ctx.manager,
        actor: failedActor,
      })
    ).rejects.toThrow(/injected failure/);

    // Nothing survived: no release entry, no comp, no money-idempotency claim.
    expect(await ledger(guest.accountId)).toEqual(entriesBefore);
    expect(await readBill(billId)).toEqual(before);
    expect(await deps.loyalty.loyaltyBalance(db, guest.accountId)).toBe(220);
    const claimed = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantMoneyIdempotencyKey.count({ where: { key: failedActor.idempotencyKey } })
    );
    expect(claimed).toBe(0);

    // The retry then succeeds exactly once, releasing 9.00 (180 points).
    const retryActor = actor('comp-retry');
    const comped = await deps.bills.compLine(db, {
      billId,
      branchId: ctx.branch,
      billLineId: lines[0]!.id,
      reason: 'kitchen error',
      approvingStaffProfileId: ctx.manager,
      actor: retryActor,
    });
    eqMoney(comped.releasedDiscount, '9.00');
    const after = await readBill(billId);
    eqMoney(after.grandTotal, '0.00');
    eqMoney(after.discountTotal, '0.00');
    eqMoney(after.compTotal, '10.00');
    assertMoneyIdentity(after);
    expect(await deps.loyalty.loyaltyBalance(db, guest.accountId)).toBe(400);

    // A replay of the SAME money key writes nothing and releases nothing twice — but
    // it REPORTS the same 9.00 its first run released. A replay answering 0.00 would
    // describe a comp that never gave the guest's points back.
    const afterEntries = await ledger(guest.accountId);
    const replay = await deps.bills.compLine(db, {
      billId,
      branchId: ctx.branch,
      billLineId: lines[0]!.id,
      reason: 'kitchen error',
      approvingStaffProfileId: ctx.manager,
      actor: retryActor,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.billLineId).toBe(lines[0]!.id);
    eqMoney(replay.releasedDiscount, '9.00');
    expect(await ledger(guest.accountId)).toEqual(afterEntries);
    expect(await readBill(billId)).toEqual(after);
  });

  it('reports zero released when the comp needed no redemption, on both calls', async () => {
    // The contract cuts both ways: a comp the bill absorbs on its own releases nothing,
    // and its replay must not invent a release either.
    const { orderId } = await seedOrder(null, ['10.00', '10.00']);
    const cut = await deps.bills.cutBills(db, {
      orderId,
      branchId: ctx.branch,
      split: { kind: 'NONE' },
      actor: actor('cut-plain'),
    });
    const billId = cut.billIds[0]!;
    const lines = await billLines(billId);
    const plainActor = actor('comp-plain');
    const args = {
      billId,
      branchId: ctx.branch,
      billLineId: lines[0]!.id,
      reason: 'kitchen error',
      approvingStaffProfileId: ctx.manager,
      actor: plainActor,
    };

    const first = await deps.bills.compLine(db, args);
    expect(first.replayed).toBe(false);
    eqMoney(first.releasedDiscount, '0.00');
    const replay = await deps.bills.compLine(db, args);
    expect(replay.replayed).toBe(true);
    eqMoney(replay.releasedDiscount, '0.00');

    const bill = await readBill(billId);
    eqMoney(bill.compTotal, '10.00');
    eqMoney(bill.grandTotal, '10.00');
    assertMoneyIdentity(bill);
  });
});

describeIfDatabase('M8/B3 — the comped bill survives a real settle and close', () => {
  it('zero-tenders, settles and closes with the money identity intact and nothing earned', async () => {
    const guest = await seedGuest('comp-close', 1000);
    const { orderId } = await seedOrder(guest.customerId, ['10.00', '10.00']);
    const cut = await deps.bills.cutBills(db, {
      orderId,
      branchId: ctx.branch,
      split: { kind: 'NONE' },
      actor: actor('cut-comp-close'),
    });
    const billId = cut.billIds[0]!;
    // 300 points × 0.05 = 15.00 off a 20.00 bill.
    await deps.loyalty.redeemLoyaltyPoints(db, {
      accountId: guest.accountId,
      billId,
      points: 300,
      actorId: ctx.operator,
      idempotencyKey: `redeem-comp-close-${suffix}`,
    });
    eqMoney((await readBill(billId)).grandTotal, '5.00');

    const lines = await billLines(billId);
    for (const [index, line] of lines.entries()) {
      await deps.bills.compLine(db, {
        billId,
        branchId: ctx.branch,
        billLineId: line.id,
        reason: 'kitchen error',
        approvingStaffProfileId: ctx.manager,
        actor: actor(`comp-close-${index}`),
      });
    }
    const comped = await readBill(billId);
    eqMoney(comped.grandTotal, '0.00');
    eqMoney(comped.compTotal, '20.00');
    eqMoney(comped.discountTotal, '0.00');
    assertMoneyIdentity(comped);

    // The bill goes out through the REAL register path — a zero cash tender is the only
    // way a fully comped bill settles — not a direct status write.
    const tender = await deps.tenders.applyTender(db, {
      billId,
      tender: { type: 'CASH', amount: '0.00', cashReceived: '0.00' },
      actor: actor('tender-comp-close'),
    });
    expect(tender.settled).toBe(true);
    expect(tender.receiptNumber).toBeTruthy();
    eqMoney(tender.remainingDue, '0.00');

    await deps.orders.closeOrder(db, { orderId, actor: actor('close-comp-close') });
    const order = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantOrder.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } })
    );
    expect(order.status).toBe('CLOSED');

    // The invariant holds THROUGH the close — the earn ran against this bill and had to
    // find a non-negative grand total to work on — and no points were earned on money
    // the house comped, so the guest is exactly where they started.
    const settled = await readBill(billId);
    expect(settled.status).toBe('SETTLED');
    eqMoney(settled.grandTotal, '0.00');
    assertMoneyIdentity(settled);
    const entries = await ledger(guest.accountId);
    expect(entries.filter((entry) => entry.kind === 'EARN')).toEqual([]);
    expect(await deps.loyalty.loyaltyBalance(db, guest.accountId)).toBe(1000);
  });
});

describeIfDatabase('M8/B4 — re-cut lifecycle: rollback, retry, exact replay', () => {
  const recutOf = (approver: string) => ({
    reason: 'guest asked to split the check',
    approvingStaffProfileId: approver,
  });

  it('rolls a failed re-cut back whole, compensates exactly once, and replays exactly', async () => {
    const guest = await seedGuest('recut-life', 500);
    const { orderId, itemIds } = await seedOrder(guest.customerId, ['12.00', '8.00']);
    const cut = await deps.bills.cutBills(db, {
      orderId,
      branchId: ctx.branch,
      split: { kind: 'NONE' },
      actor: actor('cut-recut-life'),
    });
    const originalBillId = cut.billIds[0]!;
    await deps.loyalty.redeemLoyaltyPoints(db, {
      accountId: guest.accountId,
      billId: originalBillId,
      points: 200,
      actorId: ctx.operator,
      idempotencyKey: `redeem-recut-life-${suffix}`,
    });
    const before = await readBill(originalBillId);
    eqMoney(before.discountTotal, '10.00');
    const entriesBefore = await ledger(guest.accountId);
    expect(await deps.loyalty.loyaltyBalance(db, guest.accountId)).toBe(300);

    const split = { kind: 'BY_ITEM' as const, groups: [[itemIds[0]!], [itemIds[1]!]] };

    // (a) A re-cut that fails after its writes leaves NOTHING behind — not the
    // compensation, not the void, not even the money-key claim that would block a retry.
    const failedActor = actor('recut-fail');
    await expect(
      deps.bills.cutBills(failAfterWrites(db), {
        orderId,
        branchId: ctx.branch,
        split,
        recut: recutOf(ctx.manager),
        actor: failedActor,
      })
    ).rejects.toThrow(/injected failure/);
    expect(await readBill(originalBillId)).toEqual(before);
    expect(await ledger(guest.accountId)).toEqual(entriesBefore);
    expect(await moneyKeyCount(failedActor.idempotencyKey)).toBe(0);
    expect(await deps.loyalty.loyaltyBalance(db, guest.accountId)).toBe(300);

    // (b) The retry succeeds, and the redemption is compensated EXACTLY ONCE — the
    // failed attempt did not consume it and the retry did not double it.
    const recutActor = actor('recut-retry');
    const recut = await deps.bills.cutBills(db, {
      orderId,
      branchId: ctx.branch,
      split,
      recut: recutOf(ctx.manager),
      actor: recutActor,
    });
    expect(recut.replayed).toBe(false);
    expect(recut.billIds).toHaveLength(2);
    const compensations = (await ledger(guest.accountId)).filter((entry) =>
      entry.idempotencyKey.startsWith(`loyalty:release:void:${originalBillId}:`)
    );
    expect(compensations).toHaveLength(1);
    expect(compensations[0]!.points).toBe(200);
    expect(compensations[0]!.kind).toBe('ADJUSTMENT');
    expect(compensations[0]!.reversesEntryId).toBeTruthy();
    expect(await deps.loyalty.loyaltyBalance(db, guest.accountId)).toBe(500);
    const voided = await readBill(originalBillId);
    expect(voided.status).toBe('VOID');
    eqMoney(voided.discountTotal, '0.00');
    assertMoneyIdentity(voided);

    // (c) An exact same-key, same-payload replay answers from the recorded result,
    // never re-plans, and touches nothing.
    const afterEntries = await ledger(guest.accountId);
    const afterBills = await liveBills(orderId);
    const replay = await deps.bills.cutBills(db, {
      orderId,
      branchId: ctx.branch,
      split,
      recut: recutOf(ctx.manager),
      actor: recutActor,
    });
    expect(replay.replayed).toBe(true);
    // By set, not by sequence: both bills were INSERTed in one transaction, so they
    // share a `createdAt` and their read-back order is not a contract.
    expect([...replay.billIds].sort()).toEqual([...recut.billIds].sort());
    expect(await ledger(guest.accountId)).toEqual(afterEntries);
    expect(await liveBills(orderId)).toEqual(afterBills);

    await expect(
      deps.bills.cutBills(db, {
        orderId,
        branchId: ctx.branch,
        split: { kind: 'NONE' },
        recut: recutOf(ctx.manager),
        actor: recutActor,
      })
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
    expect(await ledger(guest.accountId)).toEqual(afterEntries);
    expect(await liveBills(orderId)).toEqual(afterBills);

    // A later re-cut replaces the live set, but it cannot rewrite what the first
    // command's key means. Replaying the first key still returns ITS now-void bill IDs.
    const laterRecut = await deps.bills.cutBills(db, {
      orderId,
      branchId: ctx.branch,
      split: { kind: 'NONE' },
      recut: recutOf(ctx.manager),
      actor: actor('later-recut'),
    });
    expect(laterRecut.billIds).not.toEqual(recut.billIds);
    const afterLaterEntries = await ledger(guest.accountId);
    const afterLaterBills = await liveBills(orderId);
    const delayedReplay = await deps.bills.cutBills(db, {
      orderId,
      branchId: ctx.branch,
      split,
      recut: recutOf(ctx.manager),
      actor: recutActor,
    });
    expect(delayedReplay.replayed).toBe(true);
    expect([...delayedReplay.billIds].sort()).toEqual([...recut.billIds].sort());
    expect(await ledger(guest.accountId)).toEqual(afterLaterEntries);
    expect(await liveBills(orderId)).toEqual(afterLaterBills);

    // The device-scoped key is also bound to its original order. A caller cannot
    // reuse it on another order and receive that order's unrelated live bills.
    const other = await seedOrder(null, ['5.00']);
    await expect(
      deps.bills.cutBills(db, {
        orderId: other.orderId,
        branchId: ctx.branch,
        split: { kind: 'NONE' },
        actor: recutActor,
      })
    ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
    expect(await liveBills(other.orderId)).toEqual([]);
  }, 60_000);
});

describeIfDatabase('M8/B4 — a cut serializes on the order, not only on bills it can see', () => {
  /**
   * The bill rows are the wrong lock alone, because the dangerous row is the one that is
   * not there yet: a cut cannot lock — or even see — a bill a concurrent cut has not
   * committed. Two first cuts of the same order would then each find no live bills and
   * each create a full bill set, leaving the order billed twice; and a re-cut's
   * "void every live bill" would reach a split it never locked or compensated.
   *
   * `cutBills` therefore takes the ORDER row first. Both checks hold one cut open with
   * all its locks and prove, through PostgreSQL's own wait state, that the second one is
   * queued behind it rather than running past it — but they carry different weight, and
   * it is worth being exact about which:
   *
   *   - the FIRST is the regression for the order key itself. The order has no committed
   *     bill, so there is no row the second cut could have locked; drop the order lock
   *     and `awaitBlockedBackend` reports that nothing ever waited, because nothing did;
   *   - the SECOND is lifecycle evidence under real contention. Two re-cuts of a redeemed
   *     order converge on exactly one compensation with no VOID bill left holding a
   *     discount. It also passes on bill-row locking alone (the bills exist, so they can
   *     be locked), and is here for the convergence, not to discriminate the lock.
   */
  let observer: Client;

  beforeAll(async () => {
    if (!TEST_DATABASE_URL) return;
    observer = new Client({ connectionString: TEST_DATABASE_URL });
    await observer.connect();
  });

  afterAll(async () => {
    await observer?.end();
  });

  it('queues a concurrent first cut and refuses to give one order two bill sets', async () => {
    const { orderId } = await seedOrder(null, ['10.00']);

    const held = heldOpen(db);
    const first = deps.bills.cutBills(held.db, {
      orderId,
      branchId: ctx.branch,
      split: { kind: 'NONE' },
      actor: actor('cut-race-a'),
    });
    // The first cut has created its bill and still holds every lock it took…
    await held.reached;
    // …and the second cut is now stuck. Note what it is stuck ON: there is no committed
    // bill row for it to have locked, so this wait can only be the order row.
    const second = settle(
      deps.bills.cutBills(db, {
        orderId,
        branchId: ctx.branch,
        split: { kind: 'NONE' },
        actor: actor('cut-race-b'),
      })
    );
    await awaitBlockedBackend(observer);
    held.commit();

    const firstResult = await first;
    const secondResult = await second;
    // Released, the second cut sees the committed bill and refuses to re-split it
    // without authorization — instead of quietly billing the order a second time.
    expect(secondResult.error).toMatchObject({ reason: 'RESPLIT_LOCKED' });
    const live = await liveBills(orderId);
    expect(live.map((bill) => bill.id)).toEqual(firstResult.billIds);
  }, 60_000);

  it('holds the order across a re-cut, so a racing cut cannot void an uncompensated bill', async () => {
    const guest = await seedGuest('recut-race', 500);
    const { orderId, itemIds } = await seedOrder(guest.customerId, ['12.00', '8.00']);
    const cut = await deps.bills.cutBills(db, {
      orderId,
      branchId: ctx.branch,
      split: { kind: 'NONE' },
      actor: actor('cut-recut-race'),
    });
    const originalBillId = cut.billIds[0]!;
    await deps.loyalty.redeemLoyaltyPoints(db, {
      accountId: guest.accountId,
      billId: originalBillId,
      points: 200,
      actorId: ctx.operator,
      idempotencyKey: `redeem-recut-race-${suffix}`,
    });
    eqMoney((await readBill(originalBillId)).discountTotal, '10.00');

    const recutArgs = {
      reason: 'guest asked to split the check',
      approvingStaffProfileId: ctx.manager,
    };
    const held = heldOpen(db);
    // Re-cut A: compensates the redemption, voids the redeemed bill, cuts two fresh
    // ones — all uncommitted, all held.
    const recutA = deps.bills.cutBills(held.db, {
      orderId,
      branchId: ctx.branch,
      split: { kind: 'BY_ITEM', groups: [[itemIds[0]!], [itemIds[1]!]] },
      recut: recutArgs,
      actor: actor('recut-race-a'),
    });
    await held.reached;
    // Re-cut B wants the same order. The bills it would have locked are the ones A just
    // voided; the bills it will actually void are ones A has not committed yet. Only the
    // order row keeps it out of that window.
    const recutB = settle(
      deps.bills.cutBills(db, {
        orderId,
        branchId: ctx.branch,
        split: { kind: 'NONE' },
        recut: recutArgs,
        actor: actor('recut-race-b'),
      })
    );
    await awaitBlockedBackend(observer);
    held.commit();

    const resultA = await recutA;
    const resultB = await recutB;
    expect(resultB.error).toBeUndefined();
    expect(resultA.billIds).toHaveLength(2);

    // B ran on A's committed result: it voided A's two fresh bills — which carried no
    // discount — and cut its own. Across the whole order the redemption was compensated
    // exactly once, and no VOID bill was left holding a discount nobody paid for.
    const releases = (await ledger(guest.accountId)).filter(
      (entry) => entry.kind === 'ADJUSTMENT' && entry.reversesEntryId !== null
    );
    expect(releases).toHaveLength(1);
    expect(releases[0]!.points).toBe(200);
    // …and it is the ORIGINAL bill's void that compensated it, not a later one.
    expect(releases[0]!.idempotencyKey).toBe(
      `loyalty:release:void:${originalBillId}:${releases[0]!.reversesEntryId}`
    );
    expect(await deps.loyalty.loyaltyBalance(db, guest.accountId)).toBe(500);

    const all = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantBill.findMany({
        where: { orderId },
        orderBy: { id: 'asc' },
        select: { id: true, status: true, discountTotal: true, grandTotal: true, subtotal: true },
      })
    );
    for (const bill of all.filter((row) => row.status === 'VOID')) {
      eqMoney(bill.discountTotal, '0.00');
    }
    const live = await liveBills(orderId);
    expect(live).toHaveLength(1);
    expect(live.map((bill) => bill.id)).not.toContain(originalBillId);
    eqMoney(live[0]!.grandTotal, '20.00');
    eqMoney(live[0]!.discountTotal, '0.00');
  }, 60_000);
});

describeIfDatabase('M8/B3 — a comp replay reports the money ITS OWN call released', () => {
  /**
   * Tenant B prices a point at 0.0335, which does not divide the cent. Two points took
   * round(0.067) = 0.07 off the bill, but the first point alone is worth
   * round(0.0335) = 0.03 — so the second point has to be worth 0.07 − 0.03 = 0.04. The
   * SAME one point is worth 0.03 or 0.04 depending only on what was released before it.
   *
   * That is why a replay cannot re-derive its money from the ledger: reconstructing the
   * "before" of comp 1 means looking at rows comp 2 wrote afterwards, and one ordering
   * mistake turns comp 1's honest 0.03 into 0.04. Each comp's exact result is persisted
   * with its own idempotency record instead, so its replay is a lookup — and this test
   * replays comp 1 AFTER comp 2 has moved the ledger underneath it.
   */
  it('is stable under a later release of the same redemption, at a fractional point value', async () => {
    const guest = await seedGuest('fractional', 100, ctxB);
    const { orderId } = await seedOrder(guest.customerId, ['0.03', '0.04'], ctxB);
    const cut = await deps.bills.cutBills(ctxB.db, {
      orderId,
      branchId: ctxB.branch,
      split: { kind: 'NONE' },
      actor: actor('cut-fractional', ctxB),
    });
    const billId = cut.billIds[0]!;

    const redeemed = await deps.loyalty.redeemLoyaltyPoints(ctxB.db, {
      accountId: guest.accountId,
      billId,
      points: 2,
      actorId: ctxB.operator,
      idempotencyKey: `redeem-fractional-${suffix}`,
    });
    // round(2 × 0.0335) = 0.07 — the whole bill.
    eqMoney(redeemed.value, '0.07');
    eqMoney((await readBill(billId, ctxB)).grandTotal, '0.00');

    const lines = await billLines(billId, ctxB);
    const compArgs = (billLineId: string, label: string) => ({
      billId,
      branchId: ctxB.branch,
      billLineId,
      reason: 'kitchen error',
      approvingStaffProfileId: ctxB.manager,
      actor: actor(label, ctxB),
    });

    // Comp 1 needs 0.03 back and releases ONE point for it.
    const firstArgs = compArgs(lines[0]!.id, 'comp-fractional-1');
    const first = await deps.bills.compLine(ctxB.db, firstArgs);
    expect(first.replayed).toBe(false);
    eqMoney(first.releasedDiscount, '0.03');

    // Comp 2 needs 0.04 and releases the OTHER point — worth a cent more than the first
    // one was, because cumulative rounding prices it against the point already given
    // back. Together they hand back exactly the 0.07 the redemption took.
    const secondArgs = compArgs(lines[1]!.id, 'comp-fractional-2');
    const second = await deps.bills.compLine(ctxB.db, secondArgs);
    expect(second.replayed).toBe(false);
    eqMoney(second.releasedDiscount, '0.04');

    const bill = await readBill(billId, ctxB);
    eqMoney(bill.discountTotal, '0.00');
    eqMoney(bill.grandTotal, '0.00');
    eqMoney(bill.compTotal, '0.07');
    assertMoneyIdentity(bill);
    expect(await deps.loyalty.loyaltyBalance(ctxB.db, guest.accountId)).toBe(100);

    // THE REGRESSION. Comp 1 is replayed only now, with comp 2's release sitting in the
    // ledger against the same redemption. It must still answer 0.03 — the number its own
    // call returned — and comp 2 must still answer 0.04.
    const entriesBefore = await ledger(guest.accountId, ctxB);
    const firstReplay = await deps.bills.compLine(ctxB.db, firstArgs);
    expect(firstReplay.replayed).toBe(true);
    expect(firstReplay.billLineId).toBe(lines[0]!.id);
    eqMoney(firstReplay.releasedDiscount, '0.03');

    const secondReplay = await deps.bills.compLine(ctxB.db, secondArgs);
    expect(secondReplay.replayed).toBe(true);
    eqMoney(secondReplay.releasedDiscount, '0.04');

    // Two replays, two different answers for one point each, and not a row written.
    expect(await ledger(guest.accountId, ctxB)).toEqual(entriesBefore);
    expect(await readBill(billId, ctxB)).toEqual(bill);
  }, 60_000);
});

describeIfDatabase('M8 correction B — the role and the tenancy this battery ran under', () => {
  it('runs as an unprivileged application role, so every RLS result above is real', async () => {
    const [role] = await deps.withTenantDb(
      orgId,
      (tx) =>
        tx.$queryRaw<
          { current_user: string; rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }[]
        >`SELECT current_user::text AS current_user, r.rolcanlogin, r.rolsuper, r.rolbypassrls
          FROM pg_roles r
         WHERE r.rolname = current_user`
    );
    // Not "we believe the URL points at the app role" — the catalog's own answer. A
    // SUPERUSER or BYPASSRLS role would silently satisfy every isolation check below by
    // ignoring the policies entirely, so this battery's verdict would be worthless.
    expect(role).toBeDefined();
    expect(role!.rolcanlogin, `${role!.current_user} cannot LOGIN`).toBe(true);
    expect(role!.rolsuper, `${role!.current_user} is SUPERUSER`).toBe(false);
    expect(role!.rolbypassrls, `${role!.current_user} has BYPASSRLS`).toBe(false);
  });

  it('hides one tenant’s bills and loyalty ledger from the other, in both directions', async () => {
    const guest = await seedGuest('isolation', 200);
    const { orderId } = await seedOrder(guest.customerId, ['10.00']);
    const cut = await deps.bills.cutBills(db, {
      orderId,
      branchId: ctx.branch,
      split: { kind: 'NONE' },
      actor: actor('cut-isolation'),
    });
    const billId = cut.billIds[0]!;
    await deps.loyalty.redeemLoyaltyPoints(db, {
      accountId: guest.accountId,
      billId,
      points: 100,
      actorId: ctx.operator,
      idempotencyKey: `redeem-isolation-${suffix}`,
    });

    // Tenant B cannot see the bill, its lines, the order, or a single ledger entry.
    await deps.withTenantDb(orgB, async (tx) => {
      expect(await tx.restaurantBill.findUnique({ where: { id: billId } })).toBeNull();
      expect(await tx.restaurantBillLine.count({ where: { billId } })).toBe(0);
      expect(await tx.restaurantOrder.findUnique({ where: { id: orderId } })).toBeNull();
      expect(await tx.loyaltyPointsEntry.count({ where: { accountId: guest.accountId } })).toBe(0);
      expect(await tx.loyaltyAccount.findUnique({ where: { id: guest.accountId } })).toBeNull();
    });
    // The balance A reads is therefore A's alone.
    expect(await deps.loyalty.loyaltyBalance(db, guest.accountId)).toBe(100);
    expect(await deps.loyalty.loyaltyBalance(ctxB.db, guest.accountId)).toBe(0);

    // And a write from B cannot reach A's bill either: the UPDATE is policy-filtered to
    // no rows rather than silently applied.
    const touched = await deps.withTenantDb(orgB, (tx) =>
      tx.restaurantBill.updateMany({ where: { id: billId }, data: { grandTotal: '1.00' } })
    );
    expect(touched.count).toBe(0);
    eqMoney((await readBill(billId)).grandTotal, '5.00');
  });

  it('refuses a cross-tenant ledger write at the policy and at the composite FK', async () => {
    const guest = await seedGuest('cross-tenant', 50);
    const { orderId } = await seedOrder(guest.customerId, ['10.00']);
    const cut = await deps.bills.cutBills(db, {
      orderId,
      branchId: ctx.branch,
      split: { kind: 'NONE' },
      actor: actor('cut-cross'),
    });
    const billId = cut.billIds[0]!;
    const program = await deps.withTenantDb(orgId, (tx) =>
      tx.loyaltyProgramVersion.findFirstOrThrow({ select: { id: true } })
    );

    const accountB = await seedGuest('cross-tenant-b', 10, ctxB);
    const programB = await deps.withTenantDb(orgB, (tx) =>
      tx.loyaltyProgramVersion.findFirstOrThrow({ select: { id: true } })
    );

    /** One INSERT as tenant B, on a raw session, so the SQLSTATE and the constraint name
     * that rejected it are the database's own words rather than a driver's paraphrase. */
    async function insertAsTenantB(row: {
      id: string;
      organizationId: string;
      accountId: string;
      programVersionId: string;
      billId: string | null;
      idempotencyKey: string;
    }) {
      const client = new Client({ connectionString: TEST_DATABASE_URL });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [orgB]);
        await client.query(
          `INSERT INTO restaurant_loyalty_points_entries
             (id, "organizationId", "accountId", "programVersionId", kind, points, "billId",
              "actorId", reason, "occurredAt", "idempotencyKey")
           VALUES ($1, $2, $3, $4, 'ADJUSTMENT', 1, $5, 'attacker', 'cross-tenant write',
                   now(), $6)`,
          [
            row.id,
            row.organizationId,
            row.accountId,
            row.programVersionId,
            row.billId,
            row.idempotencyKey,
          ]
        );
        // DEFERRABLE INITIALLY DEFERRED: the composite tenant FKs are only checked here.
        await client.query('COMMIT');
        return null;
      } catch (failure) {
        return failure as Error & { code?: string; constraint?: string };
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        await client.end();
      }
    }

    // 1. Row stamped with A's organization, written from B's session: the INSERT policy's
    //    WITH CHECK rejects it outright. A tenant cannot write INTO another tenant.
    const policy = await insertAsTenantB({
      id: `x_${suffix}_policy`,
      organizationId: orgId,
      accountId: guest.accountId,
      programVersionId: program.id,
      billId: null,
      idempotencyKey: `cross:policy:${suffix}`,
    });
    expect(policy?.code).toBe('42501');
    expect(policy?.message).toMatch(/row-level security policy/i);

    // 2. Row stamped with B's OWN organization but pointing at A's bill. The plain
    //    `billId` foreign key is satisfied — that bill really exists — so the only thing
    //    standing between B and a ledger entry against A's money is the COMPOSITE tenant
    //    key on (organizationId, billId). It is what rejects this, by name, at COMMIT.
    const composite = await insertAsTenantB({
      id: `x_${suffix}_fk`,
      organizationId: orgB,
      accountId: accountB.accountId,
      programVersionId: programB.id,
      billId,
      idempotencyKey: `cross:fk:${suffix}`,
    });
    expect(composite?.code).toBe('23503');
    expect(composite?.constraint).toBe('tenant_loyalty_points_billId_fk');

    // Neither attempt left anything behind, in either tenant.
    const planted =
      (await deps.withTenantDb(orgId, (tx) =>
        tx.loyaltyPointsEntry.count({
          where: { idempotencyKey: { in: [`cross:policy:${suffix}`, `cross:fk:${suffix}`] } },
        })
      )) +
      (await deps.withTenantDb(orgB, (tx) =>
        tx.loyaltyPointsEntry.count({
          where: { idempotencyKey: { in: [`cross:policy:${suffix}`, `cross:fk:${suffix}`] } },
        })
      ));
    expect(planted).toBe(0);
  });
});
