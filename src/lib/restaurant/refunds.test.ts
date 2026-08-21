/**
 * M5-L4 refunds (C7) — the named integration checks: partial/full card REFUND with
 * the payment status transition + append-only event; same-day full VOID_REVERSAL via
 * the adapter VOID; cash refunds writing exactly one CASH_REFUND drawer movement
 * (open drawer required); the Σ(refunds) ≤ tender cap; manager co-authorization
 * (reason + distinct approver); the VOID_REVERSAL preconditions; the cross-business-
 * date posting rule (a refund lands on the processing day, never a prior day); and
 * device-scoped idempotent replay.
 *
 * Requires TEST_DATABASE_URL (a migrated, unprivileged throwaway database). Money is
 * asserted by exact Decimal STRING equality (C2).
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha58r_${suffix}`;
const ids = {
  branch: `branch_${suffix}`,
  customer: `customer_${suffix}`,
  loyaltyAccount: `loyalty_account_${suffix}`,
  loyaltyProgram: `loyalty_program_${suffix}`,
  operator: `staff_op_${suffix}`,
  manager: `staff_mgr_${suffix}`,
  category: `cat_${suffix}`,
  product: `prod_${suffix}`,
  brand: `brand_${suffix}`,
  menu: `menu_${suffix}`,
  section: `sec_${suffix}`,
  menuItem: `mitem_${suffix}`,
  priceList: `pl_${suffix}`,
  priceVersion: `plv_${suffix}`,
  publication: `pub_${suffix}`,
};
const AT = new Date('2026-08-19T18:00:00.000Z');
const NEXT_DAY = new Date('2026-08-20T18:00:00.000Z');

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  enrollDevice: (typeof import('@/lib/restaurant/devices'))['enrollDevice'];
  orders: typeof import('@/lib/restaurant/orders');
  bills: typeof import('./bills');
  drawer: typeof import('./drawer-sessions');
  tenders: typeof import('./tenders');
  refunds: typeof import('./refunds');
};

let deps: Deps;
let deviceId: string;
let keyCounter = 0;
const key = () => `key_${suffix}_${++keyCounter}`;
const actor = (device = deviceId, idempotencyKey = key()) => ({
  staffProfileId: ids.operator,
  deviceId: device,
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

async function openBill(count: number): Promise<string> {
  const db = deps.createTenantDb(orgId);
  const opened = await deps.orders.openOrder(db, {
    branchId: ids.branch,
    channel: 'DINE_IN',
    publicationId: ids.publication,
    actor: actor(),
    now: AT,
  });
  for (let i = 0; i < count; i += 1) {
    await deps.orders.addItem(db, {
      orderId: opened.orderId,
      menuItemId: ids.menuItem,
      actor: actor(),
    });
  }
  const cut = await deps.bills.cutBills(db, {
    orderId: opened.orderId,
    split: { kind: 'NONE' },
    actor: actor(),
  });
  return cut.billIds[0]!;
}

/** Settle a single-item (12.50) bill with a card tender and return the tender id. */
async function cardTender(
  tip = '0.00'
): Promise<{ billId: string; tenderId: string; paymentId: string }> {
  const billId = await openBill(1);
  const result = await deps.tenders.applyTender(deps.createTenantDb(orgId), {
    billId,
    tender: { type: 'CARD', amount: '12.50', tipAmount: tip },
    actor: actor(),
    now: AT,
  });
  return { billId, tenderId: result.tenderId, paymentId: result.paymentId! };
}

/** Settle a single-item bill with cash on `device` (which must have an open drawer). */
async function cashTender(device: string): Promise<{ billId: string; tenderId: string }> {
  const billId = await openBill(1);
  const result = await deps.tenders.applyTender(deps.createTenantDb(orgId), {
    billId,
    tender: { type: 'CASH', amount: '12.50', cashReceived: '12.50' },
    actor: actor(device),
    now: AT,
  });
  return { billId, tenderId: result.tenderId };
}

async function openDrawer(device: string): Promise<void> {
  await deps.drawer.openDrawerSession(deps.createTenantDb(orgId), {
    branchId: ids.branch,
    openingFloat: '100.00',
    actor: actor(device),
    now: AT,
  });
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, devices, orders, bills, drawer, tenders, refunds] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/devices'),
    import('@/lib/restaurant/orders'),
    import('./bills'),
    import('./drawer-sessions'),
    import('./tenders'),
    import('./refunds'),
  ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    createTenantDb: scopedDb.createTenantDb,
    enrollDevice: devices.enrollDevice,
    orders,
    bills,
    drawer,
    tenders,
    refunds,
  };

  await deps.withPlatformDb((tx) =>
    tx.organization.create({
      data: {
        id: orgId,
        slug: `wha58r-${suffix}`,
        legalName: 'Refunds Test Co',
        displayName: 'Refunds Test',
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
    await tx.restaurantCustomer.create({ data: { id: ids.customer, displayName: 'Loyal Guest' } });
    await tx.loyaltyAccount.create({
      data: { id: ids.loyaltyAccount, customerId: ids.customer },
    });
    await tx.loyaltyProgramVersion.create({
      data: {
        id: ids.loyaltyProgram,
        versionNumber: 1,
        effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
        earnRate: '1',
        redemptionValue: '0.01',
      },
    });
    const enrolled = await deps.enrollDevice(tx, { branchId: ids.branch, name: 'POS-1' });
    deviceId = enrolled.device.id;

    await tx.restaurantCategory.create({ data: { id: ids.category, name: 'Mains' } });
    await tx.restaurantProduct.create({
      data: { id: ids.product, name: 'Burger', categoryId: ids.category },
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

describeIfDatabase('card refunds (real DB)', () => {
  it('appends a capped REVERSAL pinned to the original earn program', async () => {
    const { billId, tenderId } = await cardTender();
    await read((tx) =>
      tx.loyaltyPointsEntry.create({
        data: {
          accountId: ids.loyaltyAccount,
          programVersionId: ids.loyaltyProgram,
          kind: 'EARN',
          points: 12,
          billId,
          idempotencyKey: `earn_${billId}`,
        },
      })
    );
    const refund = await deps.refunds.refundTender(deps.createTenantDb(orgId), {
      originalTenderId: tenderId,
      amount: '6.25',
      reason: 'partial return',
      approvingStaffProfileId: ids.manager,
      actor: actor(),
      now: AT,
    });
    const reversal = await read((tx) =>
      tx.loyaltyPointsEntry.findFirst({ where: { refundId: refund.refundId, kind: 'REVERSAL' } })
    );
    expect(reversal?.points).toBe(-6);
    expect(reversal?.programVersionId).toBe(ids.loyaltyProgram);
  });

  it('partial then full REFUND transitions the payment PARTIALLY_REFUNDED → REFUNDED', async () => {
    const { tenderId, paymentId } = await cardTender();

    const partial = await deps.refunds.refundTender(deps.createTenantDb(orgId), {
      originalTenderId: tenderId,
      amount: '5.00',
      reason: 'partial return',
      approvingStaffProfileId: ids.manager,
      actor: actor(),
      now: AT,
    });
    expect(partial.kind).toBe('REFUND');
    expect(partial.paymentStatus).toBe('PARTIALLY_REFUNDED');
    expect(partial.businessDate.toISOString().slice(0, 10)).toBe('2026-08-19');

    const remainder = await deps.refunds.refundTender(deps.createTenantDb(orgId), {
      originalTenderId: tenderId,
      amount: '7.50',
      reason: 'rest returned',
      approvingStaffProfileId: ids.manager,
      actor: actor(),
      now: AT,
    });
    expect(remainder.paymentStatus).toBe('REFUNDED');

    const payment = await read((tx) =>
      tx.restaurantPayment.findUnique({
        where: { id: paymentId },
        select: {
          status: true,
          events: { orderBy: { createdAt: 'asc' }, select: { capability: true, eventType: true } },
        },
      })
    );
    expect(payment?.status).toBe('REFUNDED');
    expect(payment?.events).toEqual([
      { capability: 'SALE', eventType: 'SALE_APPROVED' },
      { capability: 'REFUND', eventType: 'REFUND_APPROVED' },
      { capability: 'REFUND', eventType: 'REFUND_APPROVED' },
    ]);

    // Σ refunds equals the tender exactly; a further refund is capped out.
    const agg = await read((tx) =>
      tx.restaurantRefund.aggregate({
        where: { originalTenderId: tenderId },
        _sum: { amount: true },
      })
    );
    expect(agg._sum.amount?.toString()).toBe('12.5');
    await expect(
      deps.refunds.refundTender(deps.createTenantDb(orgId), {
        originalTenderId: tenderId,
        amount: '0.01',
        reason: 'too much',
        approvingStaffProfileId: ids.manager,
        actor: actor(),
        now: AT,
      })
    ).rejects.toMatchObject({ reason: 'REFUND_EXCEEDS_TENDER' });
  });

  it('a same-day full VOID_REVERSAL voids the payment via the adapter VOID', async () => {
    const { tenderId, paymentId } = await cardTender();
    const reversal = await deps.refunds.refundTender(deps.createTenantDb(orgId), {
      originalTenderId: tenderId,
      amount: '12.50',
      kind: 'VOID_REVERSAL',
      reason: 'wrong card',
      approvingStaffProfileId: ids.manager,
      actor: actor(),
      now: AT,
    });
    expect(reversal.kind).toBe('VOID_REVERSAL');
    expect(reversal.paymentStatus).toBe('VOIDED');

    const payment = await read((tx) =>
      tx.restaurantPayment.findUnique({
        where: { id: paymentId },
        select: { status: true, events: { select: { eventType: true } } },
      })
    );
    expect(payment?.status).toBe('VOIDED');
    expect(payment?.events.map((e) => e.eventType)).toContain('VOID_APPROVED');
  });

  it('rejects a VOID_REVERSAL that is not a same-day full reversal', async () => {
    const { tenderId } = await cardTender();
    // Partial amount → cannot be a VOID_REVERSAL.
    await expect(
      deps.refunds.refundTender(deps.createTenantDb(orgId), {
        originalTenderId: tenderId,
        amount: '5.00',
        kind: 'VOID_REVERSAL',
        reason: 'partial void',
        approvingStaffProfileId: ids.manager,
        actor: actor(),
        now: AT,
      })
    ).rejects.toMatchObject({ reason: 'INVALID_REVERSAL' });
  });

  it('posts a cross-business-date correction to the processing day, not the tender day', async () => {
    const { tenderId } = await cardTender(); // tender businessDate 2026-08-19
    const refund = await deps.refunds.refundTender(deps.createTenantDb(orgId), {
      originalTenderId: tenderId,
      amount: '12.50',
      reason: 'next-day return',
      approvingStaffProfileId: ids.manager,
      actor: actor(),
      now: NEXT_DAY, // processing on 2026-08-20
    });
    expect(refund.businessDate.toISOString().slice(0, 10)).toBe('2026-08-20');
    const tender = await read((tx) =>
      tx.restaurantTender.findUnique({ where: { id: tenderId }, select: { businessDate: true } })
    );
    expect(tender?.businessDate.toISOString().slice(0, 10)).toBe('2026-08-19');
  });
});

describeIfDatabase('cash refunds + co-authorization (real DB)', () => {
  it('writes exactly one CASH_REFUND movement to the open drawer', async () => {
    const device = await newDevice('POS-cashrefund');
    await openDrawer(device);
    const { tenderId } = await cashTender(device);

    const refund = await deps.refunds.refundTender(deps.createTenantDb(orgId), {
      originalTenderId: tenderId,
      amount: '12.50',
      reason: 'cash back',
      approvingStaffProfileId: ids.manager,
      actor: actor(device),
      now: AT,
    });
    expect(refund.drawerSessionId).not.toBeNull();
    expect(refund.paymentStatus).toBeNull();

    const movements = await read((tx) =>
      tx.restaurantDrawerMovement.findMany({
        where: { refundId: refund.refundId, kind: 'CASH_REFUND' },
        select: { amount: true },
      })
    );
    expect(movements).toHaveLength(1);
    expect(movements[0]!.amount.toString()).toBe('12.5');
  });

  it('rejects a cash refund with no open drawer', async () => {
    const device = await newDevice('POS-cashrefund2');
    await openDrawer(device);
    const { tenderId } = await cashTender(device);
    // Close the drawer, then a cash refund cannot post a movement.
    const openSession = await read((tx) =>
      tx.restaurantDrawerSession.findFirst({
        where: { deviceId: device, status: 'OPEN' },
        select: { id: true },
      })
    );
    await deps.drawer.closeDrawerSession(deps.createTenantDb(orgId), {
      drawerSessionId: openSession!.id,
      countedCash: '112.50',
      actor: actor(device),
    });
    await expect(
      deps.refunds.refundTender(deps.createTenantDb(orgId), {
        originalTenderId: tenderId,
        amount: '12.50',
        reason: 'late cash back',
        approvingStaffProfileId: ids.manager,
        actor: actor(device),
        now: AT,
      })
    ).rejects.toMatchObject({ reason: 'DRAWER_NOT_OPEN' });
  });

  it('requires a reason and a distinct co-authorizing manager', async () => {
    const { tenderId } = await cardTender();
    await expect(
      deps.refunds.refundTender(deps.createTenantDb(orgId), {
        originalTenderId: tenderId,
        amount: '5.00',
        reason: '   ',
        approvingStaffProfileId: ids.manager,
        actor: actor(),
        now: AT,
      })
    ).rejects.toMatchObject({ reason: 'REASON_REQUIRED' });

    await expect(
      deps.refunds.refundTender(deps.createTenantDb(orgId), {
        originalTenderId: tenderId,
        amount: '5.00',
        reason: 'self approval',
        approvingStaffProfileId: ids.operator, // same as the actor
        actor: actor(),
        now: AT,
      })
    ).rejects.toThrow(/second identity/);
  });
});

describeIfDatabase('refund idempotency (real DB)', () => {
  it('replays a refund: same device key returns the original and creates nothing', async () => {
    const { tenderId } = await cardTender();
    const reuse = actor();
    const first = await deps.refunds.refundTender(deps.createTenantDb(orgId), {
      originalTenderId: tenderId,
      amount: '5.00',
      reason: 'return',
      approvingStaffProfileId: ids.manager,
      actor: reuse,
      now: AT,
    });
    const replay = await deps.refunds.refundTender(deps.createTenantDb(orgId), {
      originalTenderId: tenderId,
      amount: '5.00',
      reason: 'return',
      approvingStaffProfileId: ids.manager,
      actor: reuse,
      now: AT,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.refundId).toBe(first.refundId);

    const count = await read((tx) =>
      tx.restaurantRefund.count({ where: { originalTenderId: tenderId } })
    );
    expect(count).toBe(1);
  });
});
