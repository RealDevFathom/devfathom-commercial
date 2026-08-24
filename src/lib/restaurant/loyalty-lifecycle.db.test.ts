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
 *   - the guard migration FAILS the deployment on a database that already holds a
 *     negative grand total, whether or not row-level security lets its precondition
 *     see the row, and leaks no bill or tenant identifier while doing so;
 *   - the release and the bill mutation commit or roll back together (injected
 *     failure), and a money-key replay releases nothing a second time while still
 *     REPORTING what the call it replays released.
 *
 * Requires TEST_DATABASE_URL — a migrated throwaway database with an unprivileged
 * (NOSUPERUSER / NOBYPASSRLS) application role, never DATABASE_URL. Every read is
 * filtered by a per-run-unique id.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

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
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
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

const ctx = {
  branch: `branch_${suffix}`,
  product: `product_${suffix}`,
  operator: `staff_op_${suffix}`,
  manager: `staff_mgr_${suffix}`,
  deviceId: '',
};

/** One loyalty customer + funded account per scenario, so every count is absolute. */
async function seedGuest(label: string, points: number) {
  const customerId = `cust_${label}_${suffix}`;
  await deps.withTenantDb(orgId, (tx) =>
    tx.restaurantCustomer.create({ data: { id: customerId, displayName: label } })
  );
  const enrolled = await deps.loyalty.enrollLoyaltyAccount(db, {
    customerId,
    activeCustomersMax: 50,
  });
  if (points !== 0) {
    await deps.loyalty.adjustLoyaltyPoints(db, {
      accountId: enrolled.id,
      points,
      actorId: ctx.operator,
      reason: 'opening balance for the lifecycle battery',
      idempotencyKey: `seed:${label}:${suffix}`,
    });
  }
  return { customerId, accountId: enrolled.id };
}

let orderSeq = 0;

async function seedOrder(customerId: string | null, prices: string[]) {
  orderSeq += 1;
  const orderNumber = orderSeq;
  return deps.withTenantDb(orgId, async (tx) => {
    const order = await tx.restaurantOrder.create({
      data: {
        branchId: ctx.branch,
        orderNumber,
        businessDate,
        status: 'SERVED',
        channel: 'DINE_IN',
        staffProfileId: ctx.operator,
        deviceId: ctx.deviceId,
        customerId,
      },
      select: { id: true },
    });
    const itemIds: string[] = [];
    for (const unitPrice of prices) {
      const item = await tx.restaurantOrderItem.create({
        data: {
          orderId: order.id,
          productId: ctx.product,
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

const actor = (label: string) => ({
  staffProfileId: ctx.operator,
  deviceId: ctx.deviceId,
  idempotencyKey: `${label}-${suffix}-${randomBytes(3).toString('hex')}`,
});

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

function readBill(billId: string) {
  return deps.withTenantDb(orgId, (tx) =>
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

function ledger(accountId: string) {
  return deps.withTenantDb(orgId, (tx) =>
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

function billLines(billId: string) {
  return deps.withTenantDb(orgId, (tx) =>
    tx.restaurantBillLine.findMany({
      where: { billId },
      orderBy: { id: 'asc' },
      select: { id: true, lineSubtotal: true },
    })
  );
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
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
    withPlatformDb: scopedDb.withPlatformDb,
    enrollDevice: devices.enrollDevice,
    bills,
    loyalty,
    tenders,
    refunds,
    drawers,
    orders,
  };

  await deps.withPlatformDb((tx) =>
    tx.organization.create({
      data: {
        id: orgId,
        slug: `wha132-${suffix}`,
        legalName: 'WHA132 Test Co',
        displayName: 'WHA132 Test',
        status: 'ACTIVE',
      },
    })
  );

  await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantBranch.create({ data: { id: ctx.branch, name: 'Lifecycle' } });
    await tx.restaurantProduct.create({ data: { id: ctx.product, name: 'Plate' } });
    await tx.restaurantStaffProfile.create({
      data: { id: ctx.operator, displayName: 'Operator', status: 'ACTIVE' },
    });
    await tx.restaurantStaffProfile.create({
      data: { id: ctx.manager, displayName: 'Manager', status: 'ACTIVE' },
    });
  });

  const enrolled = await deps.withTenantDb(orgId, (tx) =>
    deps.enrollDevice(tx, { branchId: ctx.branch, name: 'POS' })
  );
  ctx.deviceId = enrolled.device.id;
  db = deps.createTenantDb(orgId);

  // 1 point per currency unit earned; 1 point redeems 0.05.
  await deps.loyalty.configureLoyaltyProgram(db, {
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    earnRate: '1.000000',
    redemptionValue: '0.050000',
    expiryDays: null,
  });
  // Cash tenders and cash refunds both require this register to have an OPEN drawer.
  await deps.drawers.openDrawerSession(db, {
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

    const fresh = await Promise.all(recut.billIds.map(readBill));
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

    // Refunded BEFORE the close: the order is still PAYMENT_PENDING, so no EARN
    // exists to reverse — the close must not earn on this money.
    await deps.refunds.refundTender(db, {
      originalTenderId: tender.tenderId,
      amount: '4.00',
      reason: 'wrong dish',
      approvingStaffProfileId: ctx.manager,
      actor: actor('refund-pre'),
    });
    expect(await ledger(guest.accountId)).toHaveLength(0);

    await deps.orders.closeOrder(db, { orderId, actor: actor('close') });
    let entries = await ledger(guest.accountId);
    expect(entries.map((e) => [e.kind, e.points])).toEqual([['EARN', 6]]);
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
      ['EARN', 6],
      ['REVERSAL', -2],
    ]);
    expect(entries[1]!.refundId).toBeTruthy();
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

    // The close won the lock, so its full earn was committed and visible by the time
    // the refund ran: the refund reverses exactly the 4 points the refunded 4.00 bought.
    expect(closeFirst.entries).toEqual([
      ['EARN', 10],
      ['REVERSAL', -4],
    ]);
    // The refund won, so there was no earn to reverse — and the close, released from
    // the same lock, read the committed refund and earned on the net 6.00.
    expect(refundFirst.entries).toEqual([['EARN', 6]]);

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
    const client = new Client({ connectionString: TEST_DATABASE_URL });
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
    const failing = new Proxy(db, {
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
    const failedActor = actor('comp-rollback');
    await expect(
      deps.bills.compLine(failing, {
        billId,
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
      split: { kind: 'NONE' },
      actor: actor('cut-plain'),
    });
    const billId = cut.billIds[0]!;
    const lines = await billLines(billId);
    const plainActor = actor('comp-plain');
    const args = {
      billId,
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
