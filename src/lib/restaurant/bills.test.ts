/**
 * M5-L2 bill command layer.
 *
 * Two layers of checks:
 *   1. PURE split-exactness property tests over `planBills` / `deriveOrderTotal` —
 *      no database. BY_ITEM/BY_SEAT partition completeness; FRACTIONAL Σ(grandTotal)
 *      ≡ order total by Decimal STRING equality on adversarial remainders; identical
 *      input → identical per-bill cents across runs (deterministic remainder, C4).
 *   2. DB-backed integration tests (require TEST_DATABASE_URL — a migrated throwaway
 *      database, never DATABASE_URL): cut/split persistence, comp-at-zero (snapshot
 *      price retained + reason + co-auth), the re-split guard, settleBill + receipt
 *      allocation, the settlement predicate, and money-key idempotency.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { deriveOrderTotal, planBills } from './bills';

// ── Pure fixtures ────────────────────────────────────────────────────────────

const D = (v: string | number) => new Prisma.Decimal(v);

/** Build a minimal LoadedBillOrder-shaped literal for the pure planners. */
function order(
  items: Array<{
    id: string;
    unitPrice: string;
    quantity?: number;
    seatNumber?: number | null;
    status?: string;
    modifiers?: string[];
  }>
) {
  return {
    id: 'o1',
    branchId: 'b1',
    status: 'OPEN',
    businessDate: new Date('2026-08-19T00:00:00.000Z'),
    items: items.map((i) => ({
      id: i.id,
      status: i.status ?? 'SERVED',
      seatNumber: i.seatNumber ?? null,
      name: i.id,
      unitPrice: D(i.unitPrice),
      quantity: i.quantity ?? 1,
      modifiers: (i.modifiers ?? []).map((m) => ({ priceDelta: D(m) })),
    })),
  };
}

describe('deriveOrderTotal (pure, C4)', () => {
  it('sums (unitPrice + Σ modifier deltas) × quantity over non-voided items', () => {
    const o = order([
      { id: 'a', unitPrice: '12.50', quantity: 2, modifiers: ['1.00'] }, // (12.50+1)*2 = 27.00
      { id: 'b', unitPrice: '4.25', quantity: 1 }, // 4.25
      { id: 'c', unitPrice: '9.99', quantity: 1, status: 'VOIDED' }, // excluded
    ]);
    expect(deriveOrderTotal(o.items.filter((i) => i.status !== 'VOIDED')).toString()).toBe('31.25');
  });
});

describe('planBills — NONE / BY_ITEM / BY_SEAT (pure partition, C4)', () => {
  it('NONE places every non-voided item on one bill; subtotal ≡ order total', () => {
    const o = order([
      { id: 'a', unitPrice: '10.00' },
      { id: 'b', unitPrice: '5.00', quantity: 3 },
    ]);
    const [bill, ...rest] = planBills(o, { kind: 'NONE' });
    expect(rest).toHaveLength(0);
    expect(bill!.lines.map((l) => l.orderItemId).sort()).toEqual(['a', 'b']);
    expect(bill!.subtotal.toString()).toBe('25');
    expect(bill!.grandTotal.toString()).toBe('25');
    expect(bill!.roundingAdjustment.toString()).toBe('0');
  });

  it('BY_ITEM asserts a complete partition and rejects gaps/dupes/unknowns', () => {
    const o = order([
      { id: 'a', unitPrice: '10.00' },
      { id: 'b', unitPrice: '6.00' },
      { id: 'c', unitPrice: '4.00' },
    ]);
    const bills = planBills(o, { kind: 'BY_ITEM', groups: [['a', 'b'], ['c']] });
    expect(bills).toHaveLength(2);
    expect(bills[0]!.subtotal.toString()).toBe('16');
    expect(bills[1]!.subtotal.toString()).toBe('4');
    // Every non-voided item is placed on exactly one bill.
    const placed = bills.flatMap((b) => b.lines.map((l) => l.orderItemId)).sort();
    expect(placed).toEqual(['a', 'b', 'c']);

    expect(() => planBills(o, { kind: 'BY_ITEM', groups: [['a', 'b']] })).toThrowError(
      /Every non-voided item/
    );
    expect(() => planBills(o, { kind: 'BY_ITEM', groups: [['a', 'a', 'b', 'c']] })).toThrowError(
      /more than one bill/
    );
    expect(() => planBills(o, { kind: 'BY_ITEM', groups: [['a', 'b', 'c', 'zz']] })).toThrowError(
      /not a billable/
    );
  });

  it('BY_SEAT groups by seatNumber and sends unseated items to one designated bill', () => {
    const o = order([
      { id: 'a', unitPrice: '10.00', seatNumber: 2 },
      { id: 'b', unitPrice: '6.00', seatNumber: 1 },
      { id: 'c', unitPrice: '4.00', seatNumber: 1 },
      { id: 'd', unitPrice: '3.00', seatNumber: null },
    ]);
    const bills = planBills(o, { kind: 'BY_SEAT' });
    // seat 1 (b+c), seat 2 (a), then unseated (d) — ascending seats, unseated last.
    expect(bills).toHaveLength(3);
    expect(bills[0]!.lines.map((l) => l.orderItemId).sort()).toEqual(['b', 'c']);
    expect(bills[1]!.lines.map((l) => l.orderItemId)).toEqual(['a']);
    expect(bills[2]!.lines.map((l) => l.orderItemId)).toEqual(['d']);
    // Full partition and reconciliation.
    const total = deriveOrderTotal(o.items);
    const sum = bills.reduce((acc, b) => acc.plus(b.grandTotal), new Prisma.Decimal(0));
    expect(sum.toString()).toBe(total.toString());
  });
});

describe('planBills — FRACTIONAL split exactness + determinism (C4)', () => {
  // Adversarial remainders: odd cents ÷3 and ÷7.
  const cases: Array<{ total: string; weights: number[] }> = [
    { total: '100.00', weights: [1, 1, 1] },
    { total: '0.01', weights: [1, 1, 1] },
    { total: '10.00', weights: [1, 1, 1, 1, 1, 1, 1] },
    { total: '0.07', weights: [1, 1, 1, 1, 1, 1, 1] },
    { total: '99.99', weights: [2, 1, 1] },
    { total: '33.33', weights: [1, 2, 4] },
    { total: '0.05', weights: [1, 1, 1, 1, 1, 1, 1] },
  ];

  for (const { total, weights } of cases) {
    it(`${total} split ${weights.join('/')} sums exactly and is deterministic`, () => {
      // A single item priced at `total`, quantity 1 — so the derived order total is
      // exactly `total`.
      const o = order([{ id: 'x', unitPrice: total }]);
      const first = planBills(o, { kind: 'FRACTIONAL', weights });
      // Σ grandTotal ≡ order total by Decimal STRING equality (never epsilon).
      const sum = first.reduce((acc, b) => acc.plus(b.grandTotal), new Prisma.Decimal(0));
      expect(sum.toString()).toBe(D(total).toString());
      // Σ (subtotal + roundingAdjustment) ≡ grandTotal per bill; fraction pair set.
      for (const bill of first) {
        expect(bill.subtotal.plus(bill.roundingAdjustment).toString()).toBe(
          bill.grandTotal.toString()
        );
        expect(bill.fractionDenominator).toBe(weights.reduce((a, b) => a + b, 0));
      }
      // Deterministic: a second run yields byte-identical per-bill cents.
      const second = planBills(o, { kind: 'FRACTIONAL', weights });
      expect(second.map((b) => b.grandTotal.toString())).toEqual(
        first.map((b) => b.grandTotal.toString())
      );
    });
  }

  it('rejects non-positive / non-integer weights', () => {
    const o = order([{ id: 'x', unitPrice: '10.00' }]);
    expect(() => planBills(o, { kind: 'FRACTIONAL', weights: [] })).toThrowError(/at least one/);
    expect(() => planBills(o, { kind: 'FRACTIONAL', weights: [1, 0] })).toThrowError(
      /positive integers/
    );
    expect(() => planBills(o, { kind: 'FRACTIONAL', weights: [1, 1.5] })).toThrowError(
      /positive integers/
    );
  });
});

// ── DB-backed integration ────────────────────────────────────────────────────

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha55_${suffix}`;
const ids = {
  brand: `brand_${suffix}`,
  branch: `branch_${suffix}`,
  operator: `staff_op_${suffix}`,
  manager: `staff_mgr_${suffix}`,
  category: `cat_${suffix}`,
  product: `prod_${suffix}`,
  modGroup: `mgrp_${suffix}`,
  modOption: `mopt_${suffix}`,
  menu: `menu_${suffix}`,
  section: `msec_${suffix}`,
  menuItem: `mitem_${suffix}`,
  priceList: `pl_${suffix}`,
  priceVersion: `plv_${suffix}`,
  publication: `pub_${suffix}`,
};
const AT = new Date('2026-08-19T18:00:00.000Z');

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  enrollDevice: (typeof import('@/lib/restaurant/devices'))['enrollDevice'];
  orders: typeof import('@/lib/restaurant/orders');
  bills: typeof import('./bills');
};

let deps: Deps;
let deviceId: string;
let keyCounter = 0;
const key = () => `key_${suffix}_${++keyCounter}`;
const actor = (idempotencyKey = key()) => ({
  staffProfileId: ids.operator,
  deviceId,
  idempotencyKey,
});

function read<T>(fn: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(orgId, fn);
}

/** Open a fresh order, add N items (each with a price + optional seat + modifier),
 * and return the order id + item ids. Items are HELD (a billable OPEN order). */
async function openWithItems(
  items: Array<{ seat?: number; modifier?: boolean }>
): Promise<{ orderId: string; itemIds: string[]; db: ScopedDb }> {
  const db = deps.createTenantDb(orgId);
  const opened = await deps.orders.openOrder(db, {
    branchId: ids.branch,
    channel: 'DINE_IN',
    publicationId: ids.publication,
    actor: actor(),
    now: AT,
  });
  const itemIds: string[] = [];
  for (const spec of items) {
    const added = await deps.orders.addItem(db, {
      orderId: opened.orderId,
      menuItemId: ids.menuItem,
      seatNumber: spec.seat,
      modifierOptionIds: spec.modifier ? [ids.modOption] : undefined,
      actor: actor(),
    });
    itemIds.push(added.itemId);
  }
  return { orderId: opened.orderId, itemIds, db };
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, devices, orders, bills] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/devices'),
    import('@/lib/restaurant/orders'),
    import('./bills'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    createTenantDb: scopedDb.createTenantDb,
    enrollDevice: devices.enrollDevice,
    orders,
    bills,
  };

  await deps.withPlatformDb((tx) =>
    tx.organization.create({
      data: {
        id: orgId,
        slug: `wha55-${suffix}`,
        legalName: 'Bills Test Co',
        displayName: 'Bills Test',
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
    const enrolled = await deps.enrollDevice(tx, { branchId: ids.branch, name: 'POS-1' });
    deviceId = enrolled.device.id;

    await tx.restaurantCategory.create({ data: { id: ids.category, name: 'Mains' } });
    await tx.restaurantProduct.create({
      data: { id: ids.product, name: 'Burger', categoryId: ids.category },
    });
    await tx.restaurantModifierGroup.create({ data: { id: ids.modGroup, name: 'Extras' } });
    await tx.restaurantModifierOption.create({
      data: {
        id: ids.modOption,
        modifierGroupId: ids.modGroup,
        name: 'Cheese',
        priceDelta: '1.00',
      },
    });
    await tx.restaurantProductModifierGroup.create({
      data: { productId: ids.product, modifierGroupId: ids.modGroup },
    });

    await tx.restaurantBrand.create({ data: { id: ids.brand, name: 'Acme' } });
    await tx.restaurantMenu.create({ data: { id: ids.menu, brandId: ids.brand, name: 'All Day' } });
    await tx.restaurantMenuSection.create({
      data: { id: ids.section, menuId: ids.menu, name: 'Food' },
    });
    await tx.restaurantMenuItem.create({
      data: {
        id: ids.menuItem,
        sectionId: ids.section,
        productId: ids.product,
        displayName: 'Burger',
      },
    });
    await tx.restaurantPriceList.create({
      data: { id: ids.priceList, name: 'Default', isDefault: true },
    });
    await tx.restaurantPriceListVersion.create({
      data: {
        id: ids.priceVersion,
        priceListId: ids.priceList,
        versionNumber: 1,
        effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
        status: 'ACTIVE',
      },
    });
    await tx.restaurantPriceListEntry.create({
      data: { priceListVersionId: ids.priceVersion, productId: ids.product, price: '12.50' },
    });
    await tx.restaurantBranchMenuPublication.create({
      data: {
        id: ids.publication,
        branchId: ids.branch,
        menuId: ids.menu,
        priceListId: ids.priceList,
        status: 'PUBLISHED',
        channels: [],
      },
    });
  });
});

describeIfDatabase('bills command layer (real DB)', () => {
  it('cuts one NONE bill for the whole order; replay is idempotent', async () => {
    const { orderId, db } = await openWithItems([{}, { modifier: true }]);
    const result = await deps.bills.cutBills(db, {
      orderId,
      split: { kind: 'NONE' },
      actor: actor(),
    });
    expect(result.billIds).toHaveLength(1);

    const bill = await read((tx) =>
      tx.restaurantBill.findUnique({
        where: { id: result.billIds[0]! },
        select: { status: true, splitKind: true, subtotal: true, grandTotal: true, lines: true },
      })
    );
    expect(bill?.status).toBe('OPEN');
    expect(bill?.splitKind).toBe('NONE');
    // 12.50 + (12.50 + 1.00) = 26.00
    expect(bill?.subtotal.toString()).toBe('26');
    expect(bill?.grandTotal.toString()).toBe('26');
    expect(bill?.lines).toHaveLength(2);

    // Idempotency: on a fresh order, replaying the SAME cut (same device key)
    // returns the original bills and creates nothing new (the money replay domain).
    const fresh = await openWithItems([{}]);
    const sameActor = actor();
    const first = await deps.bills.cutBills(fresh.db, {
      orderId: fresh.orderId,
      split: { kind: 'FRACTIONAL', weights: [1, 1] },
      actor: sameActor,
    });
    const replay = await deps.bills.cutBills(fresh.db, {
      orderId: fresh.orderId,
      split: { kind: 'FRACTIONAL', weights: [1, 1] },
      actor: sameActor,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.billIds.sort()).toEqual(first.billIds.sort());
    const billCount = await read((tx) =>
      tx.restaurantBill.count({ where: { orderId: fresh.orderId } })
    );
    expect(billCount).toBe(2); // the replay created no additional bills
  });

  it('BY_SEAT groups items into per-seat bills that reconcile to the order total', async () => {
    const { orderId, db } = await openWithItems([{ seat: 1 }, { seat: 2 }, { seat: 2 }]);
    const result = await deps.bills.cutBills(db, {
      orderId,
      split: { kind: 'BY_SEAT' },
      actor: actor(),
    });
    expect(result.billIds).toHaveLength(2);

    const settlement = await read((tx) => deps.bills.evaluateOrderSettlement(tx, orderId));
    expect(settlement.accountedTotal.toString()).toBe(settlement.derivedOrderTotal.toString());
    expect(settlement.unbilledItemIds).toEqual([]);
    expect(settlement.blocker).toBe('BILLS_OPEN'); // bills exist, not yet settled
  });

  it('comps a line to zero: retains snapshot price, records reason + co-auth, updates totals', async () => {
    const { orderId, db } = await openWithItems([{}, {}]);
    const { billIds } = await deps.bills.cutBills(db, {
      orderId,
      split: { kind: 'NONE' },
      actor: actor(),
    });
    const line = await read((tx) =>
      tx.restaurantBillLine.findFirst({
        where: { billId: billIds[0]! },
        select: { id: true, unitPrice: true, lineSubtotal: true },
      })
    );
    await deps.bills.compLine(db, {
      billId: billIds[0]!,
      billLineId: line!.id,
      reason: 'guest complaint',
      approvingStaffProfileId: ids.manager,
      actor: actor(),
    });

    const after = await read((tx) =>
      tx.restaurantBillLine.findUnique({
        where: { id: line!.id },
        select: {
          unitPrice: true,
          lineSubtotal: true,
          compAmount: true,
          lineTotal: true,
          compReason: true,
          compCoAuthorization: { select: { approvingStaffProfileId: true, reason: true } },
        },
      })
    );
    // Original snapshot price + subtotal retained; comp nets the line to zero.
    expect(after?.unitPrice.toString()).toBe(line!.unitPrice.toString());
    expect(after?.lineSubtotal.toString()).toBe(line!.lineSubtotal.toString());
    expect(after?.compAmount.toString()).toBe(line!.lineSubtotal.toString());
    expect(after?.lineTotal.toString()).toBe('0');
    expect(after?.compReason).toBe('guest complaint');
    expect(after?.compCoAuthorization?.approvingStaffProfileId).toBe(ids.manager);

    // Bill totals: compTotal picks up the comp; grandTotal drops by it; the
    // settlement identity Σ(grandTotal + compTotal) ≡ order total still holds.
    const settlement = await read((tx) => deps.bills.evaluateOrderSettlement(tx, orderId));
    expect(settlement.accountedTotal.toString()).toBe(settlement.derivedOrderTotal.toString());

    // A second comp of the same line is rejected.
    await expect(
      deps.bills.compLine(db, {
        billId: billIds[0]!,
        billLineId: line!.id,
        reason: 'again',
        approvingStaffProfileId: ids.manager,
        actor: actor(),
      })
    ).rejects.toMatchObject({ reason: 'ALREADY_COMPED' });
  });

  it('re-split guard: blocks without recut, voids-and-recuts with co-auth, locks after tender/settle', async () => {
    const { orderId, db } = await openWithItems([{}, {}]);
    const firstCut = await deps.bills.cutBills(db, {
      orderId,
      split: { kind: 'NONE' },
      actor: actor(),
    });

    // Re-cut without a recut reason is refused.
    await expect(
      deps.bills.cutBills(db, {
        orderId,
        split: { kind: 'FRACTIONAL', weights: [1, 1] },
        actor: actor(),
      })
    ).rejects.toMatchObject({ reason: 'RESPLIT_LOCKED' });

    // With recut (reason + co-auth) the old bills go VOID and a new set is created.
    const recut = await deps.bills.cutBills(db, {
      orderId,
      split: { kind: 'FRACTIONAL', weights: [1, 1] },
      recut: { reason: 'guest wants separate checks', approvingStaffProfileId: ids.manager },
      actor: actor(),
    });
    expect(recut.billIds).toHaveLength(2);
    const oldBill = await read((tx) =>
      tx.restaurantBill.findUnique({
        where: { id: firstCut.billIds[0]! },
        select: { status: true, voidReason: true, voidCoAuthorizationId: true },
      })
    );
    expect(oldBill?.status).toBe('VOID');
    expect(oldBill?.voidReason).toBe('guest wants separate checks');
    expect(oldBill?.voidCoAuthorizationId).not.toBeNull();

    // Settle one of the new bills, then a further re-split is locked.
    await deps.withTenantDb(orgId, (tx) =>
      deps.bills.settleBill(tx, {
        billId: recut.billIds[0]!,
        staffProfileId: ids.operator,
        deviceId,
        at: AT,
      })
    );
    await expect(
      deps.bills.cutBills(db, {
        orderId,
        split: { kind: 'NONE' },
        recut: { reason: 'too late', approvingStaffProfileId: ids.manager },
        actor: actor(),
      })
    ).rejects.toMatchObject({ reason: 'RESPLIT_LOCKED' });
  });

  it('settleBill flips OPEN→SETTLED once and allocates a monotonic receipt number', async () => {
    const a = await openWithItems([{}]);
    const b = await openWithItems([{}]);
    const cutA = await deps.bills.cutBills(a.db, {
      orderId: a.orderId,
      split: { kind: 'NONE' },
      actor: actor(),
    });
    const cutB = await deps.bills.cutBills(b.db, {
      orderId: b.orderId,
      split: { kind: 'NONE' },
      actor: actor(),
    });

    const settleA = await deps.withTenantDb(orgId, (tx) =>
      deps.bills.settleBill(tx, {
        billId: cutA.billIds[0]!,
        staffProfileId: ids.operator,
        deviceId,
        at: AT,
      })
    );
    const settleB = await deps.withTenantDb(orgId, (tx) =>
      deps.bills.settleBill(tx, {
        billId: cutB.billIds[0]!,
        staffProfileId: ids.operator,
        deviceId,
        at: AT,
      })
    );
    expect(settleA.alreadySettled).toBe(false);
    expect(settleB.receiptNumber).toBe(settleA.receiptNumber + 1); // monotonic, same branch/date

    // Re-settle is a no-op that returns the same receipt (exactly-once allocation).
    const again = await deps.withTenantDb(orgId, (tx) =>
      deps.bills.settleBill(tx, {
        billId: cutA.billIds[0]!,
        staffProfileId: ids.operator,
        deviceId,
        at: AT,
      })
    );
    expect(again.alreadySettled).toBe(true);
    expect(again.receiptNumber).toBe(settleA.receiptNumber);
  });

  it('settlement predicate: NO_BILLS → BILLS_OPEN → settled once every bill is settled', async () => {
    const { orderId, db } = await openWithItems([{}, {}]);
    const before = await read((tx) => deps.bills.evaluateOrderSettlement(tx, orderId));
    expect(before.settled).toBe(false);
    expect(before.blocker).toBe('NO_BILLS');

    const cut = await deps.bills.cutBills(db, {
      orderId,
      split: { kind: 'FRACTIONAL', weights: [1, 1, 1] },
      actor: actor(),
    });
    const open = await read((tx) => deps.bills.evaluateOrderSettlement(tx, orderId));
    expect(open.blocker).toBe('BILLS_OPEN');
    expect(open.accountedTotal.toString()).toBe(open.derivedOrderTotal.toString());

    for (const billId of cut.billIds) {
      await deps.withTenantDb(orgId, (tx) =>
        deps.bills.settleBill(tx, { billId, staffProfileId: ids.operator, deviceId, at: AT })
      );
    }
    const settled = await read((tx) => deps.bills.evaluateOrderSettlement(tx, orderId));
    expect(settled.settled).toBe(true);
    expect(settled.blocker).toBeNull();
  });
});
