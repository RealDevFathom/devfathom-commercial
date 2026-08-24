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
 *   - the release and the bill mutation commit or roll back together (injected
 *     failure), and a money-key replay releases nothing a second time.
 *
 * Requires TEST_DATABASE_URL — a migrated throwaway database with an unprivileged
 * (NOSUPERUSER / NOBYPASSRLS) application role, never DATABASE_URL. Every read is
 * filtered by a per-run-unique id.
 */
import { randomBytes } from 'node:crypto';

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

    // A replay of the SAME money key writes nothing and releases nothing twice.
    const afterEntries = await ledger(guest.accountId);
    const replay = await deps.bills.compLine(db, {
      billId,
      billLineId: lines[0]!.id,
      reason: 'kitchen error',
      approvingStaffProfileId: ctx.manager,
      actor: retryActor,
    });
    expect(replay.replayed).toBe(true);
    eqMoney(replay.releasedDiscount, '0.00');
    expect(await ledger(guest.accountId)).toEqual(afterEntries);
    expect(await readBill(billId)).toEqual(after);
  });
});
