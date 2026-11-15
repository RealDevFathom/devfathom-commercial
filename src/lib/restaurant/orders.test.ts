/**
 * M4-L2 command layer — the named integration checks that only a real database
 * can establish: transactional number allocation (unique + monotone under
 * concurrency), business-date stamping, C4 snapshot immutability, C2 ledger +
 * outbox appends, C3 state-machine enforcement (illegal transitions, terminal
 * invariants, cancel compensation, remake-blocks-close), hold/fire isolation, KOT
 * generation, C6 post-prep void co-authorization + disposition, and C7 idempotent
 * replay.
 *
 * Requires TEST_DATABASE_URL (a migrated, throwaway database, never DATABASE_URL);
 * without it the suite reports itself skipped rather than passing vacuously. One
 * per-run-unique organization; every read filters by the seeded ids.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { canCloseDeliveredOrder } from '@/components/restaurant/pos/order-ticket-panel';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { ensureRestaurantTaxProfile } from '@/lib/test-support/restaurant-tax-profile';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha42_${suffix}`;
const ids = {
  brand: `brand_${suffix}`,
  branch: `branch_${suffix}`,
  customer: `customer_${suffix}`,
  loyaltyAccount: `loyalty_account_${suffix}`,
  loyaltyProgram: `loyalty_program_${suffix}`,
  operator: `staff_op_${suffix}`,
  manager: `staff_mgr_${suffix}`,
  floor: `floor_${suffix}`,
  tableA: `table_a_${suffix}`,
  tableB: `table_b_${suffix}`,
  tableC: `table_c_${suffix}`,
  category: `cat_${suffix}`,
  product: `prod_${suffix}`,
  modGroup: `mgrp_${suffix}`,
  modOption: `mopt_${suffix}`,
  menu: `menu_${suffix}`,
  section: `msec_${suffix}`,
  menuItem: `mitem_${suffix}`,
  priceList: `pl_${suffix}`,
  priceVersion: `plv_${suffix}`,
  stationGrill: `st_grill_${suffix}`,
  stationBar: `st_bar_${suffix}`,
  publication: `pub_${suffix}`,
};

const AT = new Date('2026-08-19T18:00:00.000Z');

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  enrollDevice: (typeof import('@/lib/restaurant/devices'))['enrollDevice'];
  orders: typeof import('@/lib/restaurant/orders');
  bills: typeof import('@/lib/restaurant/bills');
  close: typeof import('@/lib/restaurant/daily-close');
  stateMachine: typeof import('@/lib/restaurant/order-state-machine');
  coAuth: typeof import('@/lib/restaurant/co-authorization');
  deliveryDispatch: typeof import('@/lib/restaurant/terminal-delivery-dispatch');
  terminalOrders: typeof import('@/lib/restaurant/terminal-orders');
};

let deps: Deps;
let deviceId: string;
let keyCounter = 0;

/** A fresh device-scoped idempotency key per command (unless a test reuses one). */
const key = () => `key_${suffix}_${++keyCounter}`;
const actor = (idempotencyKey = key()) => ({
  staffProfileId: ids.operator,
  deviceId,
  idempotencyKey,
});

function read<T>(fn: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(orgId, fn);
}

/** Open a fresh order and add one menu item (HELD). Returns their ids. */
async function openWithItem(over?: { course?: number; tableIds?: readonly string[] }) {
  const db = deps.createTenantDb(orgId);
  const opened = await deps.orders.openOrder(db, {
    organizationId: orgId,
    entitlementLimits: { 'pos.orders.monthly': 1000000 },
    branchId: ids.branch,
    channel: 'DINE_IN',
    publicationId: ids.publication,
    tableIds: over?.tableIds,
    actor: actor(),
    now: AT,
  });
  const added = await deps.orders.addItem(db, {
    orderId: opened.orderId,
    menuItemId: ids.menuItem,
    course: over?.course ?? 1,
    actor: actor(),
  });
  return { orderId: opened.orderId, itemId: added.itemId, db };
}

/** Cut one bill for the whole order and settle it, so the M5-L2 settlement guard
 * lets the order close. Uses the real bills command layer + the `settleBill` seam
 * L4's tender flow calls; here we settle directly (no tender) to exercise the
 * order-close path without pulling in the not-yet-built tender lane. */
async function settleOrderFully(db: ScopedDb, orderId: string): Promise<void> {
  const cut = await deps.bills.cutBills(db, {
    orderId,
    branchId: ids.branch,
    split: { kind: 'NONE' },
    actor: actor(),
  });
  await deps.withTenantDb(orgId, (tx) =>
    deps.bills.settleBill(tx, {
      billId: cut.billIds[0]!,
      staffProfileId: ids.operator,
      deviceId,
      at: AT,
    })
  );
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [
    scopedDb,
    devices,
    orders,
    bills,
    close,
    stateMachine,
    coAuth,
    deliveryDispatch,
    terminalOrders,
  ] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/devices'),
    import('@/lib/restaurant/orders'),
    import('@/lib/restaurant/bills'),
    import('@/lib/restaurant/daily-close'),
    import('@/lib/restaurant/order-state-machine'),
    import('@/lib/restaurant/co-authorization'),
    import('@/lib/restaurant/terminal-delivery-dispatch'),
    import('@/lib/restaurant/terminal-orders'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    createTenantDb: scopedDb.createTenantDb,
    enrollDevice: devices.enrollDevice,
    orders,
    bills,
    close,
    stateMachine,
    coAuth,
    deliveryDispatch,
    terminalOrders,
  };

  const [runtimeRole] = await deps.withPlatformDb(
    (tx) =>
      tx.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `
  );
  expect(runtimeRole).toEqual({ rolsuper: false, rolbypassrls: false });

  await deps.withPlatformDb((tx) =>
    tx.organization.create({
      data: {
        id: orgId,
        slug: `wha42-${suffix}`,
        legalName: 'Orders Test Co',
        displayName: 'Orders Test',
        status: 'ACTIVE',
      },
    })
  );

  await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantBranch.create({
      data: { id: ids.branch, name: 'Main', timezone: 'UTC', businessDayCutoff: '00:00' },
    });
    await ensureRestaurantTaxProfile(tx, orgId, ids.branch);
    await tx.restaurantStaffProfile.create({
      data: { id: ids.operator, displayName: 'Operator', status: 'ACTIVE' },
    });
    await tx.restaurantStaffProfile.create({
      data: { id: ids.manager, displayName: 'Manager', status: 'ACTIVE' },
    });
    await tx.restaurantCustomer.create({ data: { id: ids.customer, displayName: 'Loyal Guest' } });
    await tx.loyaltyAccount.create({
      data: { id: ids.loyaltyAccount, customerId: ids.customer },
    });
    await tx.loyaltyProgramVersion.create({
      data: {
        id: ids.loyaltyProgram,
        versionNumber: 1,
        effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
        earnRate: '1.2',
        redemptionValue: '0.01',
        expiryDays: 30,
      },
    });
    const enrolled = await deps.enrollDevice(tx, { branchId: ids.branch, name: 'POS-1' });
    deviceId = enrolled.device.id;

    await tx.restaurantFloor.create({
      data: { id: ids.floor, branchId: ids.branch, name: 'Main' },
    });
    await tx.restaurantTable.create({
      data: { id: ids.tableA, floorId: ids.floor, code: 'A1', capacity: 4 },
    });
    await tx.restaurantTable.create({
      data: { id: ids.tableB, floorId: ids.floor, code: 'A2', capacity: 2 },
    });
    await tx.restaurantTable.create({
      data: { id: ids.tableC, floorId: ids.floor, code: 'A3', capacity: 2 },
    });

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

    // Stations: grill (default) + bar; the product routes to bar.
    await tx.restaurantKitchenStation.create({
      data: { id: ids.stationGrill, branchId: ids.branch, name: 'Grill', isDefault: true },
    });
    await tx.restaurantKitchenStation.create({
      data: { id: ids.stationBar, branchId: ids.branch, name: 'Bar', isDefault: false },
    });
    await tx.restaurantStationRoutingRule.create({
      data: { stationId: ids.stationBar, productId: ids.product, priority: 0 },
    });
    await tx.restaurantPrintRoute.create({
      data: {
        branchId: ids.branch,
        stationId: ids.stationBar,
        documentType: 'BAR_TICKET',
        printerId: 'tcp://127.0.0.1:9100',
      },
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
        displayName: 'House Burger',
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

async function readyDeliveryOrder() {
  const db = deps.createTenantDb(orgId);
  const opened = await deps.orders.openOrder(db, {
    organizationId: orgId,
    entitlementLimits: { 'pos.orders.monthly': 1000000 },
    branchId: ids.branch,
    channel: 'TAKEAWAY',
    publicationId: ids.publication,
    actor: actor(),
    now: AT,
  });
  const added = await deps.orders.addItem(db, {
    orderId: opened.orderId,
    menuItemId: ids.menuItem,
    actor: actor(),
  });
  await read(async (tx) => {
    await tx.restaurantOrder.update({
      where: { id: opened.orderId },
      data: { channel: 'DELIVERY', customerId: ids.customer },
    });
    await tx.restaurantOrderItem.update({
      where: { id: added.itemId },
      data: { status: 'PREPARED' },
    });
    await tx.restaurantBill.create({
      data: {
        orderId: opened.orderId,
        branchId: ids.branch,
        businessDate: AT,
        subtotal: '12.50',
        taxTotal: '0',
        serviceChargeTotal: '0',
        discountTotal: '0',
        grandTotal: '12.50',
        openerStaffProfileId: ids.operator,
        deviceId,
      },
    });
    await tx.restaurantDeliveryFulfillment.create({
      data: {
        branchId: ids.branch,
        customerId: ids.customer,
        orderId: opened.orderId,
        recipientNameSnapshot: 'Delivery Guest',
        normalizedPhoneSnapshot: '+923001234567',
        addressLine1Snapshot: '1 Test Street',
        localitySnapshot: 'Karachi',
        countryCodeSnapshot: 'PK',
        deliveryFeeSnapshot: '0',
        promisedMinutesSnapshot: 30,
        promisedAt: new Date(AT.getTime() + 30 * 60_000),
      },
    });
  });
  const fulfillment = await read((tx) =>
    tx.restaurantDeliveryFulfillment.findFirstOrThrow({ where: { orderId: opened.orderId } })
  );
  return { db, orderId: opened.orderId, fulfillmentId: fulfillment.id };
}

/** A real delivery order, built through the command layer: one live item cooked to
 * PREPARED, one voided before the kitchen, one bill cut for the live item. A PREPAID
 * order is paid in full before dispatch; a COD order keeps its bill open. */
async function preparedDeliveryOrder(paymentMode: 'PREPAID' | 'COD') {
  const db = deps.createTenantDb(orgId);
  const opened = await deps.orders.openOrder(db, {
    organizationId: orgId,
    entitlementLimits: { 'pos.orders.monthly': 1000000 },
    branchId: ids.branch,
    channel: 'TAKEAWAY',
    publicationId: ids.publication,
    actor: actor(),
    now: AT,
  });
  const live = await deps.orders.addItem(db, {
    orderId: opened.orderId,
    menuItemId: ids.menuItem,
    actor: actor(),
  });
  const voided = await deps.orders.addItem(db, {
    orderId: opened.orderId,
    menuItemId: ids.menuItem,
    actor: actor(),
  });
  await read(async (tx) => {
    await tx.restaurantOrder.update({
      where: { id: opened.orderId },
      data: { channel: 'DELIVERY', customerId: ids.customer },
    });
    await tx.restaurantDeliveryFulfillment.create({
      data: {
        branchId: ids.branch,
        customerId: ids.customer,
        orderId: opened.orderId,
        recipientNameSnapshot: 'Delivery Guest',
        normalizedPhoneSnapshot: '+923001234567',
        addressLine1Snapshot: '1 Test Street',
        localitySnapshot: 'Karachi',
        countryCodeSnapshot: 'PK',
        deliveryFeeSnapshot: '0',
        promisedMinutesSnapshot: 30,
        promisedAt: new Date(AT.getTime() + 30 * 60_000),
      },
    });
  });
  await deps.orders.voidItem(db, {
    orderId: opened.orderId,
    itemId: voided.itemId,
    reason: 'guest changed their mind',
    actor: actor(),
  });
  await deps.orders.sendOrder(db, { orderId: opened.orderId, actor: actor() });
  for (const toStatus of ['FIRING', 'PREPARED'] as const) {
    await deps.orders.advanceItem(db, {
      orderId: opened.orderId,
      itemId: live.itemId,
      toStatus,
      actor: actor(),
    });
  }
  const cut = await deps.bills.cutBills(db, {
    orderId: opened.orderId,
    branchId: ids.branch,
    split: { kind: 'NONE' },
    actor: actor(),
  });
  const billId = cut.billIds[0]!;
  const fulfillment = await read((tx) =>
    tx.restaurantDeliveryFulfillment.findFirstOrThrow({ where: { orderId: opened.orderId } })
  );
  const pay = () =>
    read(async (tx) => {
      const bill = await tx.restaurantBill.findUniqueOrThrow({ where: { id: billId } });
      await tx.restaurantTender.create({
        data: {
          billId,
          type: 'CASH',
          amount: bill.grandTotal,
          businessDate: bill.businessDate,
          staffProfileId: ids.operator,
          deviceId,
        },
      });
      await deps.bills.settleBill(tx, {
        billId,
        staffProfileId: ids.operator,
        deviceId,
        at: AT,
      });
    });
  if (paymentMode === 'PREPAID') await pay();
  return {
    db,
    orderId: opened.orderId,
    liveItemId: live.itemId,
    voidedItemId: voided.itemId,
    billId,
    fulfillmentId: fulfillment.id,
    pay,
  };
}

function kdsTransition(
  delivery: { db: ScopedDb; fulfillmentId: string },
  status: 'DISPATCHED' | 'DELIVERED'
) {
  return deps.deliveryDispatch.transitionDeliveryFromKds(delivery.db, {
    organizationId: orgId,
    branchId: ids.branch,
    deviceId,
    idempotencyKey: key(),
    fulfillmentId: delivery.fulfillmentId,
    status,
    staffProfileId: ids.operator,
  });
}

/** The POS Close-order rule evaluated on the server's own order read model. */
async function posCanClose(orderId: string): Promise<boolean> {
  const detail = await deps.terminalOrders.getOrderForBranch(
    deps.createTenantDb(orgId),
    orderId,
    ids.branch
  );
  if (!detail) throw new Error('order not readable');
  return canCloseDeliveredOrder(detail);
}

async function closeBookkeeping(orderId: string, billId: string) {
  return read(async (tx) => ({
    closedEvents: await tx.restaurantOrderEvent.count({
      where: { orderId, eventType: 'order.closed' },
    }),
    deliveryServes: (
      await tx.restaurantOrderEvent.findMany({
        where: { orderId, eventType: 'item.advanced' },
        select: { payload: true },
      })
    ).filter((event) => (event.payload as { via?: string }).via === 'delivery.delivered').length,
    loyaltyEntries: await tx.loyaltyPointsEntry.count({ where: { billId } }),
  }));
}

describeIfDatabase('delivered delivery orders close (DEV-159)', () => {
  it.each(['COD', 'PREPAID'] as const)(
    'serves a %s order on delivery and closes it once it is paid',
    async (paymentMode) => {
      const delivery = await preparedDeliveryOrder(paymentMode);
      await expect(kdsTransition(delivery, 'DISPATCHED')).resolves.toMatchObject({
        status: 'DISPATCHED',
        paymentMode,
      });
      await expect(kdsTransition(delivery, 'DELIVERED')).resolves.toMatchObject({
        status: 'DELIVERED',
        paymentMode,
      });

      const afterDelivery = await read((tx) =>
        tx.restaurantOrder.findUniqueOrThrow({
          where: { id: delivery.orderId },
          select: { status: true, items: { select: { id: true, status: true } } },
        })
      );
      expect(afterDelivery.status).toBe('SERVED');
      expect(new Map(afterDelivery.items.map((item) => [item.id, item.status]))).toEqual(
        new Map([
          [delivery.liveItemId, 'SERVED'],
          [delivery.voidedItemId, 'VOIDED'],
        ])
      );

      if (paymentMode === 'COD') await delivery.pay();
      expect(await posCanClose(delivery.orderId)).toBe(true);
      await expect(
        deps.orders.closeOrder(delivery.db, { orderId: delivery.orderId, actor: actor() })
      ).resolves.toMatchObject({ replayed: false });

      const closed = await read((tx) =>
        tx.restaurantOrder.findUniqueOrThrow({
          where: { id: delivery.orderId },
          select: { status: true, closedAt: true },
        })
      );
      expect(closed.status).toBe('CLOSED');
      expect(closed.closedAt).not.toBeNull();
      const once = await closeBookkeeping(delivery.orderId, delivery.billId);
      expect(once.closedEvents).toBe(1);
      expect(once.deliveryServes).toBe(1);

      // A repeated close or a repeated DELIVERED hand-off books nothing again.
      await expect(
        deps.orders.closeOrder(delivery.db, { orderId: delivery.orderId, actor: actor() })
      ).rejects.toMatchObject({ reason: 'NOT_CLOSABLE' });
      await expect(kdsTransition(delivery, 'DELIVERED')).resolves.toMatchObject({
        status: 'DELIVERED',
      });
      expect(await closeBookkeeping(delivery.orderId, delivery.billId)).toEqual(once);
    }
  );

  it('keeps the POS Close-order rule and closeOrder in agreement at every step', async () => {
    const delivery = await preparedDeliveryOrder('COD');
    // Each step asks the server to close exactly as the POS would. Before delivery it
    // refuses; delivered but unpaid it at most parks the order awaiting tender; only a
    // delivered, paid order reaches CLOSED, and that is the one step the POS offers.
    const serverCloses = async () => {
      await deps.orders
        .closeOrder(delivery.db, { orderId: delivery.orderId, actor: actor() })
        .catch((error: unknown) => {
          expect(error).toMatchObject({ reason: 'NOT_CLOSABLE' });
        });
      const order = await read((tx) =>
        tx.restaurantOrder.findUniqueOrThrow({
          where: { id: delivery.orderId },
          select: { status: true },
        })
      );
      return order.status === 'CLOSED';
    };

    // Prepared, not yet dispatched.
    expect(await posCanClose(delivery.orderId)).toBe(false);
    expect(await serverCloses()).toBe(false);

    await kdsTransition(delivery, 'DISPATCHED');
    expect(await posCanClose(delivery.orderId)).toBe(false);
    expect(await serverCloses()).toBe(false);

    // Delivered, cash still to collect.
    await kdsTransition(delivery, 'DELIVERED');
    expect(await posCanClose(delivery.orderId)).toBe(false);
    expect(await serverCloses()).toBe(false);

    // Delivered and paid: both sides say close.
    await delivery.pay();
    expect(await posCanClose(delivery.orderId)).toBe(true);
    expect(await serverCloses()).toBe(true);
  });

  it('allows the delivered hand-off while a live item is back in the kitchen', async () => {
    const delivery = await preparedDeliveryOrder('PREPAID');
    await kdsTransition(delivery, 'DISPATCHED');
    await deps.orders.advanceItem(delivery.db, {
      orderId: delivery.orderId,
      itemId: delivery.liveItemId,
      toStatus: 'FIRING',
      actor: actor(),
    });
    await expect(kdsTransition(delivery, 'DELIVERED')).resolves.toMatchObject({
      status: 'DELIVERED',
    });
    const state = await read(async (tx) => ({
      delivery: await tx.restaurantDeliveryFulfillment.findUniqueOrThrow({
        where: { id: delivery.fulfillmentId },
        select: { status: true },
      }),
      item: await tx.restaurantOrderItem.findUniqueOrThrow({
        where: { id: delivery.liveItemId },
        select: { status: true },
      }),
    }));
    expect(state).toEqual({ delivery: { status: 'DELIVERED' }, item: { status: 'SERVED' } });
  });
});

describeIfDatabase('orders command layer (real DB)', () => {
  it('opens an order: stamps business date, allocates a number, appends event + outbox', async () => {
    const db = deps.createTenantDb(orgId);
    const opened = await deps.orders.openOrder(db, {
      organizationId: orgId,
      entitlementLimits: { 'pos.orders.monthly': 1000000 },
      branchId: ids.branch,
      channel: 'DINE_IN',
      publicationId: ids.publication,
      tableIds: [ids.tableA],
      coverCount: 2,
      actor: actor(),
      now: AT,
    });
    expect(opened.orderNumber).toBeGreaterThanOrEqual(1);
    expect(opened.businessDate.toISOString().slice(0, 10)).toBe('2026-08-19');

    const order = await read((tx) =>
      tx.restaurantOrder.findUnique({
        where: { id: opened.orderId },
        select: {
          status: true,
          priceListVersionId: true,
          events: { select: { eventType: true, sequence: true } },
          orderTables: { select: { tableId: true, active: true } },
        },
      })
    );
    expect(order?.status).toBe('OPEN');
    expect(order?.priceListVersionId).toBe(ids.priceVersion);
    expect(order?.events).toEqual([{ eventType: 'order.opened', sequence: 1 }]);
    expect(order?.orderTables).toEqual([{ tableId: ids.tableA, active: true }]);

    const outbox = await read((tx) =>
      tx.restaurantEventOutbox.count({ where: { aggregateId: opened.orderId, status: 'PENDING' } })
    );
    expect(outbox).toBe(1);
  });

  it('allocates unique numbers under concurrent opens on one (branch, businessDate)', async () => {
    const db = deps.createTenantDb(orgId);
    const opens = await Promise.all(
      Array.from({ length: 5 }, () =>
        deps.orders.openOrder(db, {
          organizationId: orgId,
          entitlementLimits: { 'pos.orders.monthly': 1000000 },
          branchId: ids.branch,
          channel: 'TAKEAWAY',
          actor: actor(),
          now: AT,
        })
      )
    );
    const numbers = opens.map((o) => o.orderNumber);
    expect(new Set(numbers).size).toBe(5); // unique
    expect(numbers.every((n) => Number.isInteger(n) && n >= 1)).toBe(true); // monotone ints
  });

  it('rejects opening an order after its business day has closed', async () => {
    const now = new Date('2026-08-30T18:00:00.000Z');
    const db = deps.createTenantDb(orgId);
    await deps.close.cutClose(db, {
      branchId: ids.branch,
      businessDate: '2026-08-30',
      actor: actor(),
    });

    await expect(
      deps.orders.openOrder(db, {
        organizationId: orgId,
        entitlementLimits: { 'pos.orders.monthly': 1000000 },
        branchId: ids.branch,
        channel: 'TAKEAWAY',
        actor: actor(),
        now,
      })
    ).rejects.toMatchObject({ reason: 'DAY_CLOSED' });
  });

  it('serializes a concurrent order open against daily close', async () => {
    const now = new Date('2026-08-31T18:00:00.000Z');
    const db = deps.createTenantDb(orgId);
    const outcomes = await Promise.allSettled([
      deps.close.cutClose(db, {
        branchId: ids.branch,
        businessDate: '2026-08-31',
        actor: actor(),
      }),
      deps.orders.openOrder(db, {
        organizationId: orgId,
        entitlementLimits: { 'pos.orders.monthly': 1000000 },
        branchId: ids.branch,
        channel: 'TAKEAWAY',
        actor: actor(),
        now,
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({
        reason: expect.stringMatching(/DAY_CLOSED|ACTIVE_ORDERS/),
      }),
    });
  });

  it('snapshots name + price at add time and never rewrites them on later catalog edits (C4)', async () => {
    const { itemId } = await openWithItem();
    const before = await read((tx) =>
      tx.restaurantOrderItem.findUnique({
        where: { id: itemId },
        select: { name: true, unitPrice: true, status: true },
      })
    );
    expect(before?.name).toBe('House Burger');
    expect(before?.unitPrice.toString()).toBe('12.5');
    expect(before?.status).toBe('HELD');

    // Edit the catalog price + product name AFTER the item was snapshotted.
    await deps.withTenantDb(orgId, async (tx) => {
      await tx.restaurantPriceListEntry.updateMany({
        where: { priceListVersionId: ids.priceVersion, productId: ids.product },
        data: { price: '99.99' },
      });
      await tx.restaurantProduct.update({ where: { id: ids.product }, data: { name: 'Deluxe' } });
    });

    const after = await read((tx) =>
      tx.restaurantOrderItem.findUnique({
        where: { id: itemId },
        select: { name: true, unitPrice: true },
      })
    );
    expect(after?.name).toBe('House Burger');
    expect(after?.unitPrice.toString()).toBe('12.5');

    // Restore the price so other tests keep the original snapshot value.
    await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantPriceListEntry.updateMany({
        where: { priceListVersionId: ids.priceVersion, productId: ids.product },
        data: { price: '12.50' },
      })
    );
  });

  it('sends the order: HELD→QUEUED, order→SENT, and generates KOTs (C2)', async () => {
    const { orderId, db } = await openWithItem();
    const sendActor = actor();
    const result = await deps.orders.sendOrder(db, { orderId, actor: sendActor });
    expect(result.tickets.length).toBeGreaterThanOrEqual(1);
    await expect(deps.orders.sendOrder(db, { orderId, actor: sendActor })).resolves.toMatchObject({
      replayed: true,
    });

    const order = await read((tx) =>
      tx.restaurantOrder.findUnique({
        where: { id: orderId },
        select: {
          status: true,
          items: { select: { status: true } },
          kitchenTickets: { select: { stationId: true, items: { select: { orderItemId: true } } } },
        },
      })
    );
    expect(order?.status).toBe('SENT');
    expect(order?.items.every((i) => i.status === 'QUEUED')).toBe(true);
    expect(order?.kitchenTickets[0]?.stationId).toBe(ids.stationBar); // product routes to bar
    expect(order?.kitchenTickets[0]?.items).toHaveLength(1);
    const printJobs = await read((tx) =>
      tx.restaurantPrintJob.findMany({
        where: { idempotencyKey: `kitchen-ticket:${result.tickets[0]!.ticketId}:v1` },
      })
    );
    expect(printJobs).toHaveLength(1);
    expect(printJobs[0]).toMatchObject({
      status: 'PENDING',
      printerId: 'tcp://127.0.0.1:9100',
      documentType: 'BAR_TICKET',
    });

    const reprintActor = actor();
    await expect(
      deps.orders.reprintKitchenTicket(db, {
        orderId,
        ticketId: result.tickets[0]!.ticketId,
        actor: reprintActor,
      })
    ).resolves.toMatchObject({ ticketId: result.tickets[0]!.ticketId, replayed: false });
    await expect(
      deps.orders.reprintKitchenTicket(db, {
        orderId,
        ticketId: result.tickets[0]!.ticketId,
        actor: reprintActor,
      })
    ).resolves.toMatchObject({ ticketId: result.tickets[0]!.ticketId, replayed: true });
    await expect(
      read((tx) =>
        tx.restaurantPrintJob.count({
          where: { idempotencyKey: { startsWith: 'kitchen-ticket:reprint-' } },
        })
      )
    ).resolves.toBe(1);
  });

  it('fires one course without touching another (hold/fire isolation)', async () => {
    const db = deps.createTenantDb(orgId);
    const opened = await deps.orders.openOrder(db, {
      organizationId: orgId,
      entitlementLimits: { 'pos.orders.monthly': 1000000 },
      branchId: ids.branch,
      channel: 'DINE_IN',
      publicationId: ids.publication,
      actor: actor(),
      now: AT,
    });
    await deps.orders.addItem(db, {
      orderId: opened.orderId,
      menuItemId: ids.menuItem,
      course: 1,
      actor: actor(),
    });
    const second = await deps.orders.addItem(db, {
      orderId: opened.orderId,
      menuItemId: ids.menuItem,
      course: 2,
      actor: actor(),
    });

    await deps.orders.fireCourse(db, { orderId: opened.orderId, course: 1, actor: actor() });

    const items = await read((tx) =>
      tx.restaurantOrderItem.findMany({
        where: { orderId: opened.orderId },
        select: { id: true, course: true, status: true },
      })
    );
    const course2 = items.find((i) => i.id === second.itemId);
    expect(course2?.status).toBe('HELD'); // untouched
    expect(items.find((i) => i.course === 1)?.status).toBe('QUEUED');
  });

  it('rejects an illegal item transition at the command level', async () => {
    const { orderId, itemId, db } = await openWithItem();
    await expect(
      deps.orders.advanceItem(db, { orderId, itemId, toStatus: 'SERVED', actor: actor() })
    ).rejects.toBeInstanceOf(deps.stateMachine.OrderTransitionError);
  });

  it('walks the full lifecycle to CLOSED and blocks an early close (terminal invariant)', async () => {
    const { orderId, itemId, db } = await openWithItem({ tableIds: [ids.tableA] });
    await deps.orders.sendOrder(db, { orderId, actor: actor() });

    // Not every item is served yet — close must be refused.
    await expect(deps.orders.closeOrder(db, { orderId, actor: actor() })).rejects.toMatchObject({
      reason: 'NOT_CLOSABLE',
    });

    await deps.orders.advanceItem(db, { orderId, itemId, toStatus: 'FIRING', actor: actor() });
    await deps.orders.advanceItem(db, { orderId, itemId, toStatus: 'PREPARED', actor: actor() });
    await deps.orders.advanceItem(db, { orderId, itemId, toStatus: 'SERVED', actor: actor() });

    // M5-L2: a served order's first close parks it at PAYMENT_PENDING awaiting
    // tender; it does not close until its bills are settled (settlement guard, C12).
    await deps.orders.closeOrder(db, { orderId, actor: actor() });
    const parked = await read((tx) =>
      tx.restaurantOrder.findUnique({
        where: { id: orderId },
        select: {
          status: true,
          orderTables: {
            where: { tableId: ids.tableA },
            select: { active: true, unlinkedAt: true },
          },
        },
      })
    );
    expect(parked?.status).toBe('PAYMENT_PENDING');
    expect(parked?.orderTables).toEqual([{ active: true, unlinkedAt: null }]);

    await settleOrderFully(db, orderId);
    await deps.orders.closeOrder(db, { orderId, actor: actor() });

    const order = await read((tx) =>
      tx.restaurantOrder.findUnique({
        where: { id: orderId },
        select: {
          status: true,
          closedAt: true,
          events: { select: { eventType: true } },
          orderTables: {
            where: { tableId: ids.tableA },
            select: { active: true, unlinkedAt: true },
          },
        },
      })
    );
    expect(order?.status).toBe('CLOSED');
    expect(order?.closedAt).not.toBeNull();
    expect(order?.orderTables).toEqual([{ active: false, unlinkedAt: order?.closedAt }]);
    expect(order?.events.map((e) => e.eventType)).toContain('order.closed');
  });

  it('earns whole points exactly once for a customer-linked settled bill', async () => {
    const { orderId, itemId, db } = await openWithItem();
    await read((tx) =>
      tx.restaurantOrder.update({ where: { id: orderId }, data: { customerId: ids.customer } })
    );
    await deps.orders.sendOrder(db, { orderId, actor: actor() });
    await deps.orders.advanceItem(db, { orderId, itemId, toStatus: 'FIRING', actor: actor() });
    await deps.orders.advanceItem(db, { orderId, itemId, toStatus: 'PREPARED', actor: actor() });
    await deps.orders.advanceItem(db, { orderId, itemId, toStatus: 'SERVED', actor: actor() });
    await deps.orders.closeOrder(db, { orderId, actor: actor() });
    await settleOrderFully(db, orderId);
    const closingActor = actor();
    await deps.orders.closeOrder(db, { orderId, actor: closingActor });
    await expect(deps.orders.closeOrder(db, { orderId, actor: closingActor })).resolves.toEqual({
      orderId,
      replayed: true,
    });

    const entries = await read((tx) =>
      tx.loyaltyPointsEntry.findMany({ where: { bill: { orderId }, kind: 'EARN' } })
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.points).toBe(15);
    expect(entries[0]?.programVersionId).toBe(ids.loyaltyProgram);
  });

  it('blocks close while a remake is unresolved, then closes once it is (remake-blocks-close)', async () => {
    const { orderId, itemId, db } = await openWithItem();
    await deps.orders.sendOrder(db, { orderId, actor: actor() });
    await deps.orders.advanceItem(db, { orderId, itemId, toStatus: 'FIRING', actor: actor() });
    await deps.orders.advanceItem(db, { orderId, itemId, toStatus: 'PREPARED', actor: actor() });
    await deps.orders.advanceItem(db, { orderId, itemId, toStatus: 'SERVED', actor: actor() });

    const remake = await deps.orders.requestRemake(db, {
      orderId,
      itemId,
      reason: 'sent back',
      actor: actor(),
    });
    const original = await read((tx) =>
      tx.restaurantOrderItem.findUnique({ where: { id: itemId }, select: { status: true } })
    );
    expect(original?.status).toBe('REMAKE_REQUESTED');

    await expect(deps.orders.closeOrder(db, { orderId, actor: actor() })).rejects.toBeDefined();

    // Resolve: cook + serve the remake, accept the original back as served.
    await deps.orders.fireCourse(db, { orderId, course: 1, actor: actor() });
    await deps.orders.advanceItem(db, {
      orderId,
      itemId: remake.remakeItemId,
      toStatus: 'FIRING',
      actor: actor(),
    });
    await deps.orders.advanceItem(db, {
      orderId,
      itemId: remake.remakeItemId,
      toStatus: 'PREPARED',
      actor: actor(),
    });
    await deps.orders.advanceItem(db, {
      orderId,
      itemId: remake.remakeItemId,
      toStatus: 'SERVED',
      actor: actor(),
    });
    await deps.orders.advanceItem(db, { orderId, itemId, toStatus: 'SERVED', actor: actor() });
    await deps.orders.closeOrder(db, { orderId, actor: actor() }); // parks at PAYMENT_PENDING
    await settleOrderFully(db, orderId);
    await deps.orders.closeOrder(db, { orderId, actor: actor() }); // finalizes

    const order = await read((tx) =>
      tx.restaurantOrder.findUnique({ where: { id: orderId }, select: { status: true } })
    );
    expect(order?.status).toBe('CLOSED');
  });

  it('requires co-authorization + disposition for a post-preparation void and preserves history (C6)', async () => {
    const { orderId, itemId, db } = await openWithItem();
    await deps.orders.sendOrder(db, { orderId, actor: actor() });
    await deps.orders.advanceItem(db, { orderId, itemId, toStatus: 'FIRING', actor: actor() });

    // Missing co-auth.
    await expect(
      deps.orders.voidItem(db, { orderId, itemId, reason: 'burnt', actor: actor() })
    ).rejects.toMatchObject({ reason: 'CO_AUTH_REQUIRED' });

    // Missing disposition.
    await expect(
      deps.orders.voidItem(db, {
        orderId,
        itemId,
        reason: 'burnt',
        approvingStaffProfileId: ids.manager,
        actor: actor(),
      })
    ).rejects.toMatchObject({ reason: 'DISPOSITION_REQUIRED' });

    // Self-approval is not a co-authorization.
    await expect(
      deps.orders.voidItem(db, {
        orderId,
        itemId,
        reason: 'burnt',
        wastageDisposition: 'WASTE',
        approvingStaffProfileId: ids.operator,
        actor: actor(),
      })
    ).rejects.toBeInstanceOf(deps.coAuth.CoAuthorizationError);

    // Valid post-prep void.
    await deps.orders.voidItem(db, {
      orderId,
      itemId,
      reason: 'burnt',
      wastageDisposition: 'WASTE',
      approvingStaffProfileId: ids.manager,
      actor: actor(),
    });

    const item = await read((tx) =>
      tx.restaurantOrderItem.findUnique({
        where: { id: itemId },
        select: {
          status: true,
          voidedPostPrep: true,
          wastageDisposition: true,
          voidReason: true,
          voidCoAuthorizationId: true,
        },
      })
    );
    expect(item).toMatchObject({
      status: 'VOIDED',
      voidedPostPrep: true,
      wastageDisposition: 'WASTE',
      voidReason: 'burnt',
    });
    expect(item?.voidCoAuthorizationId).not.toBeNull();

    const events = await read((tx) =>
      tx.restaurantOrderEvent.findMany({
        where: { orderId },
        select: { eventType: true },
        orderBy: { sequence: 'asc' },
      })
    );
    // The full history is preserved (open→add→sent→fired→advanced→voided).
    expect(events.map((e) => e.eventType)).toContain('item.voided');
    expect(events.length).toBeGreaterThanOrEqual(5);
  });

  it('blocks an item void after bill cut so its line and service stay consistent', async () => {
    const { orderId, itemId, db } = await openWithItem();
    const second = await deps.orders.addItem(db, {
      orderId,
      menuItemId: ids.menuItem,
      actor: actor(),
    });
    const policy = await read((tx) =>
      tx.restaurantServiceChargePolicyVersion.create({
        data: {
          branchId: ids.branch,
          rate: '0.100000',
          effectiveFrom: new Date('2026-08-18T00:00:00.000Z'),
          effectiveTo: AT,
          acknowledgedAt: AT,
          acknowledgementRef: 'issue-366',
          idempotencyKey: `bill_void_service_${suffix}`,
          payloadHash: `bill-void-service-${suffix}`,
        },
      })
    );
    await read(async (tx) => {
      await tx.restaurantOrderItem.update({
        where: { id: itemId },
        data: { unitPrice: '40.00' },
      });
      await tx.restaurantOrderItem.update({
        where: { id: second.itemId },
        data: { unitPrice: '60.00' },
      });
      await tx.restaurantOrder.update({
        where: { id: orderId },
        data: { serviceChargePolicyVersionId: policy.id },
      });
    });
    const cut = await deps.bills.cutBills(db, {
      orderId,
      branchId: ids.branch,
      split: { kind: 'NONE' },
      actor: actor(),
    });

    await expect(
      deps.orders.voidItem(db, {
        orderId,
        itemId,
        reason: 'guest changed their mind',
        actor: actor(),
      })
    ).rejects.toMatchObject({ reason: 'BILL_ALREADY_CUT' });

    const snapshot = await read(async (tx) => ({
      item: await tx.restaurantOrderItem.findUniqueOrThrow({
        where: { id: itemId },
        select: { status: true },
      }),
      bill: await tx.restaurantBill.findUniqueOrThrow({
        where: { id: cut.billIds[0]! },
        select: {
          status: true,
          subtotal: true,
          serviceChargeTotal: true,
          grandTotal: true,
          lines: { orderBy: { lineSubtotal: 'asc' } },
        },
      }),
    }));
    expect(snapshot.item.status).not.toBe('VOIDED');
    expect(snapshot.bill).toMatchObject({ status: 'OPEN' });
    expect(snapshot.bill.lines).toHaveLength(2);
    expect(snapshot.bill.lines.map((line) => line.lineSubtotal.toFixed(2))).toEqual([
      '40.00',
      '60.00',
    ]);
    expect(snapshot.bill.subtotal.toFixed(2)).toBe('100.00');
    expect(snapshot.bill.serviceChargeTotal.toFixed(2)).toBe('10.00');
    expect(snapshot.bill.grandTotal.toFixed(2)).toBe('110.00');
  });

  it('cancels an order with a compensating void of every in-flight item (cancel-compensation)', async () => {
    const { orderId, db } = await openWithItem({ tableIds: [ids.tableA] });
    await deps.orders.sendOrder(db, { orderId, actor: actor() }); // item QUEUED (pre-prep)
    await deps.orders.cancelOrder(db, { orderId, reason: 'walkout', actor: actor() });

    const order = await read((tx) =>
      tx.restaurantOrder.findUnique({
        where: { id: orderId },
        select: {
          status: true,
          cancelledAt: true,
          items: { select: { status: true } },
          orderTables: {
            where: { tableId: ids.tableA },
            select: { active: true, unlinkedAt: true },
          },
        },
      })
    );
    expect(order?.status).toBe('CANCELLED');
    expect(order?.cancelledAt).not.toBeNull();
    expect(order?.orderTables).toEqual([{ active: false, unlinkedAt: order?.cancelledAt }]);
    // No item may remain QUEUED/FIRING/PREPARED on a cancelled order.
    expect(order?.items.every((i) => i.status === 'VOIDED')).toBe(true);
  });

  it('serializes concurrent moves so one source link cannot produce two active destinations', async () => {
    const { orderId, db } = await openWithItem({ tableIds: [ids.tableA] });

    const results = await Promise.allSettled([
      deps.orders.moveTable(db, {
        orderId,
        fromTableId: ids.tableA,
        toTableId: ids.tableB,
        actor: actor(),
      }),
      deps.orders.moveTable(db, {
        orderId,
        fromTableId: ids.tableA,
        toTableId: ids.tableC,
        actor: actor(),
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: { reason: 'TABLE_LINK_NOT_FOUND' },
    });

    const activeLinks = await read((tx) =>
      tx.restaurantOrderTable.findMany({
        where: { orderId, active: true },
        select: { tableId: true, linkReason: true },
      })
    );
    expect(activeLinks).toHaveLength(1);
    expect(activeLinks[0]).toMatchObject({ linkReason: 'MOVE' });
    expect([ids.tableB, ids.tableC]).toContain(activeLinks[0]?.tableId);
  });

  it('requires co-authorization to cancel an order with prepared items', async () => {
    const { orderId, itemId, db } = await openWithItem();
    await deps.orders.sendOrder(db, { orderId, actor: actor() });
    await deps.orders.advanceItem(db, { orderId, itemId, toStatus: 'FIRING', actor: actor() });
    await deps.orders.advanceItem(db, { orderId, itemId, toStatus: 'PREPARED', actor: actor() });

    await expect(
      deps.orders.cancelOrder(db, { orderId, reason: 'kitchen fire', actor: actor() })
    ).rejects.toMatchObject({ reason: 'CO_AUTH_REQUIRED' });

    await deps.orders.cancelOrder(db, {
      orderId,
      reason: 'kitchen fire',
      wastageDisposition: 'WASTE',
      approvingStaffProfileId: ids.manager,
      actor: actor(),
    });
    const order = await read((tx) =>
      tx.restaurantOrder.findUnique({ where: { id: orderId }, select: { status: true } })
    );
    expect(order?.status).toBe('CANCELLED');
  });

  it('replays an idempotent command and creates nothing (C7)', async () => {
    const db = deps.createTenantDb(orgId);
    const opened = await deps.orders.openOrder(db, {
      organizationId: orgId,
      entitlementLimits: { 'pos.orders.monthly': 1000000 },
      branchId: ids.branch,
      channel: 'DINE_IN',
      publicationId: ids.publication,
      actor: actor(),
      now: AT,
    });
    const addKey = key();
    const first = await deps.orders.addItem(db, {
      orderId: opened.orderId,
      menuItemId: ids.menuItem,
      actor: actor(addKey),
    });
    const replay = await deps.orders.addItem(db, {
      orderId: opened.orderId,
      menuItemId: ids.menuItem,
      actor: actor(addKey),
    });
    expect(replay.replayed).toBe(true);
    expect(replay.itemId).toBe(first.itemId);

    const count = await read((tx) =>
      tx.restaurantOrderItem.count({ where: { orderId: opened.orderId } })
    );
    expect(count).toBe(1); // the replay created nothing
  });

  it('keeps the ledger + outbox in lock-step, one monotonic sequence per order (C2)', async () => {
    const { orderId, itemId, db } = await openWithItem();
    await deps.orders.sendOrder(db, { orderId, actor: actor() });
    await deps.orders.advanceItem(db, { orderId, itemId, toStatus: 'FIRING', actor: actor() });

    const events = await read((tx) =>
      tx.restaurantOrderEvent.findMany({
        where: { orderId },
        select: { sequence: true },
        orderBy: { sequence: 'asc' },
      })
    );
    const outboxCount = await read((tx) =>
      tx.restaurantEventOutbox.count({ where: { aggregateId: orderId } })
    );
    const sequences = events.map((e) => e.sequence);
    expect(sequences).toEqual(sequences.map((_, i) => i + 1)); // 1..N, gap-free per order
    expect(outboxCount).toBe(events.length); // one outbox row per event
  });

  it('dispatches one concurrent duplicate and replays the immutable device-scoped result', async () => {
    const delivery = await readyDeliveryOrder();
    const idempotencyKey = key();
    const command = () =>
      deps.deliveryDispatch.transitionDeliveryFromKds(delivery.db, {
        organizationId: orgId,
        branchId: ids.branch,
        deviceId,
        idempotencyKey,
        fulfillmentId: delivery.fulfillmentId,
        status: 'DISPATCHED',
      });

    const [first, duplicate] = await Promise.all([command(), command()]);
    expect(duplicate).toEqual(first);
    expect(first).toMatchObject({ status: 'DISPATCHED', paymentMode: 'COD' });
    expect(
      await read((tx) =>
        tx.restaurantOrderIdempotencyKey.count({ where: { deviceId, key: idempotencyKey } })
      )
    ).toBe(1);
    await expect(
      deps.deliveryDispatch.transitionDeliveryFromKds(delivery.db, {
        organizationId: orgId,
        branchId: ids.branch,
        deviceId,
        idempotencyKey,
        fulfillmentId: delivery.fulfillmentId,
        status: 'DELIVERED',
      })
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSITION' });
  });

  it('rejects an all-VOIDED delivery in the dispatch command', async () => {
    const delivery = await readyDeliveryOrder();
    await read((tx) =>
      tx.restaurantOrderItem.updateMany({
        where: { orderId: delivery.orderId },
        data: { status: 'VOIDED' },
      })
    );
    await expect(
      deps.deliveryDispatch.transitionDeliveryFromKds(delivery.db, {
        organizationId: orgId,
        branchId: ids.branch,
        deviceId,
        idempotencyKey: key(),
        fulfillmentId: delivery.fulfillmentId,
        status: 'DISPATCHED',
      })
    ).rejects.toMatchObject({ reason: 'INVALID_TRANSITION' });
  });

  it('serializes dispatch against HELD insertion and rejects every post-dispatch add', async () => {
    const delivery = await readyDeliveryOrder();
    let releaseParentLock!: () => void;
    const holdParentLock = new Promise<void>((resolve) => {
      releaseParentLock = resolve;
    });
    let parentLocked!: () => void;
    const parentIsLocked = new Promise<void>((resolve) => {
      parentLocked = resolve;
    });
    const blocker = read(async (tx) => {
      await deps.orders.lockRestaurantOrder(tx, delivery.orderId);
      parentLocked();
      await holdParentLock;
    });
    await parentIsLocked;

    const dispatch = deps.deliveryDispatch.transitionDeliveryFromKds(delivery.db, {
      organizationId: orgId,
      branchId: ids.branch,
      deviceId,
      idempotencyKey: key(),
      fulfillmentId: delivery.fulfillmentId,
      status: 'DISPATCHED',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const concurrentAdd = deps.orders.addItem(delivery.db, {
      orderId: delivery.orderId,
      menuItemId: ids.menuItem,
      actor: actor(),
    });
    releaseParentLock();
    await blocker;

    await expect(dispatch).resolves.toMatchObject({ status: 'DISPATCHED' });
    await expect(concurrentAdd).rejects.toMatchObject({ reason: 'ITEM_STATE' });
    await expect(
      deps.orders.addItem(delivery.db, {
        orderId: delivery.orderId,
        menuItemId: ids.menuItem,
        actor: actor(),
      })
    ).rejects.toMatchObject({ reason: 'ITEM_STATE' });
    expect(
      await read((tx) => tx.restaurantOrderItem.count({ where: { orderId: delivery.orderId } }))
    ).toBe(1);
  });
});
