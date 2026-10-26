/**
 * M5-L3 daily close — the pure aggregation + chain-tip resolution, plus the named
 * integration checks: cross-business-date aggregation (a D1 tender + a D2 refund of
 * it → D2 carries the refund, D1 is unchanged), the cut guards (an open drawer or
 * an unsettled bill blocks a cut), the immutable snapshot + tender-type children,
 * and the correction chain (a new record supersedes the tip under manager co-auth;
 * the original re-reads byte-identical; the chain tip is authoritative).
 *
 * Requires TEST_DATABASE_URL (a migrated, throwaway database); the pure tests run
 * regardless. One per-run-unique organization; each DB test uses its OWN business
 * date so branch × date aggregation is isolated.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { computeCloseAggregate, resolveChainTip } from './daily-close';
import { insightRollupJobKey } from './insight-rollups';

const D = (v: string) => new Prisma.Decimal(v);

// ── Pure aggregation + chain tip (no database) ────────────────────────────────

describe('computeCloseAggregate (pure, exact Decimal)', () => {
  it('aggregates settled/void bills, tenders, refunds and drawers to the cent', () => {
    const aggregate = computeCloseAggregate({
      bills: [
        {
          status: 'SETTLED',
          subtotal: D('100.00'),
          deliveryFeeTotal: D('12.00'),
          taxTotal: D('0'),
          serviceChargeTotal: D('0'),
          compTotal: D('20.00'),
          discountTotal: D('5.00'),
          grandTotal: D('80.00'),
        },
        {
          status: 'VOID',
          subtotal: D('12.50'),
          deliveryFeeTotal: D('4.00'),
          taxTotal: D('0'),
          serviceChargeTotal: D('0'),
          compTotal: D('0'),
          discountTotal: D('0'),
          grandTotal: D('12.50'),
        },
        {
          status: 'OPEN',
          subtotal: D('999.99'),
          deliveryFeeTotal: D('99.00'),
          taxTotal: D('0'),
          serviceChargeTotal: D('0'),
          compTotal: D('0'),
          discountTotal: D('0'),
          grandTotal: D('999.99'),
        },
      ],
      tenders: [
        { type: 'CASH', amount: D('80.00'), tipAmount: D('5.00') },
        { type: 'CARD', amount: D('30.00'), tipAmount: D('10.00') },
        { type: 'CASH', amount: D('20.00'), tipAmount: D('0') },
      ],
      refunds: [
        {
          amount: D('15.00'),
          taxRefundAmount: D('0'),
          serviceChargeRefundAmount: D('0'),
          deliveryFeeRefundAmount: D('3.00'),
        },
      ],
      drawers: [{ status: 'CLOSED', expectedCash: D('180.00'), countedCash: D('178.00') }],
    });
    expect(aggregate.grossSales.toString()).toBe('100'); // OPEN bill excluded
    expect(aggregate.deliveryFeeSales.toString()).toBe('12');
    expect(aggregate.deliveryFeeRefunds.toString()).toBe('3');
    expect(aggregate.compTotal.toString()).toBe('20');
    expect(aggregate.discountTotal.toString()).toBe('5');
    expect(aggregate.netSales.toString()).toBe('63'); // delivery is not sales principal
    expect(aggregate.voidTotal.toString()).toBe('12.5');
    expect(aggregate.tipTotal.toString()).toBe('15');
    expect(aggregate.refundTotal.toString()).toBe('12');
    expect(aggregate.cashExpected.toString()).toBe('180');
    expect(aggregate.cashCounted.toString()).toBe('178');
    expect(aggregate.cashVariance.toString()).toBe('-2');
    expect(aggregate.tenderTotals).toEqual([
      { tenderType: 'CASH', amount: expect.anything(), tipAmount: expect.anything(), count: 2 },
      { tenderType: 'CARD', amount: expect.anything(), tipAmount: expect.anything(), count: 1 },
    ]);
    expect(aggregate.tenderTotals[0].amount.toString()).toBe('100'); // 80 + 20
    expect(aggregate.tenderTotals[0].tipAmount.toString()).toBe('5');
    expect(aggregate.tenderTotals[1].amount.toString()).toBe('30');
  });
});

describe('resolveChainTip (pure)', () => {
  it('reconciles a tax-and-service-inclusive cash refund with the drawer', () => {
    const aggregate = computeCloseAggregate({
      bills: [
        {
          status: 'SETTLED',
          subtotal: D('100.00'),
          deliveryFeeTotal: D('0'),
          taxTotal: D('10.00'),
          serviceChargeTotal: D('10.00'),
          compTotal: D('0'),
          discountTotal: D('0'),
          grandTotal: D('120.00'),
        },
      ],
      tenders: [{ type: 'CASH', amount: D('120.00'), tipAmount: D('0') }],
      refunds: [
        {
          amount: D('60.00'),
          taxRefundAmount: D('5.00'),
          serviceChargeRefundAmount: D('5.00'),
          deliveryFeeRefundAmount: D('0'),
        },
      ],
      drawers: [{ status: 'CLOSED', expectedCash: D('60.00'), countedCash: D('60.00') }],
    });

    expect(aggregate.netSales.toFixed(2)).toBe('50.00');
    expect(aggregate.taxTotal.toFixed(2)).toBe('5.00');
    expect(aggregate.serviceChargeTotal.toFixed(2)).toBe('5.00');
    expect(aggregate.refundTotal.toFixed(2)).toBe('60.00');
    expect(
      aggregate.netSales.plus(aggregate.taxTotal).plus(aggregate.serviceChargeTotal).toFixed(2)
    ).toBe(aggregate.cashExpected.toFixed(2));
  });

  it('reports a delivery-fee-only refund separately without reducing sales or refundTotal', () => {
    const aggregate = computeCloseAggregate({
      bills: [],
      tenders: [],
      refunds: [
        {
          amount: D('12.00'),
          taxRefundAmount: D('0'),
          serviceChargeRefundAmount: D('0'),
          deliveryFeeRefundAmount: D('12.00'),
        },
      ],
      drawers: [],
    });

    expect(aggregate.netSales.toFixed(2)).toBe('0.00');
    expect(aggregate.refundTotal.toFixed(2)).toBe('0.00');
    expect(aggregate.deliveryFeeRefunds.toFixed(2)).toBe('12.00');
  });

  it('deducts a zero-tax refund from netSales and still reports it separately', () => {
    const bill = {
      status: 'SETTLED' as const,
      subtotal: D('14.00'),
      deliveryFeeTotal: D('0'),
      taxTotal: D('0'),
      serviceChargeTotal: D('0'),
      compTotal: D('0'),
      discountTotal: D('0'),
      grandTotal: D('14.00'),
    };
    const aggregate = computeCloseAggregate({
      bills: [bill, bill],
      tenders: [],
      refunds: [
        {
          amount: D('14.00'),
          taxRefundAmount: D('0'),
          serviceChargeRefundAmount: D('0'),
          deliveryFeeRefundAmount: D('0'),
        },
      ],
      drawers: [],
    });
    expect(aggregate.grossSales.toFixed(2)).toBe('28.00');
    expect(aggregate.refundTotal.toFixed(2)).toBe('14.00');
    expect(aggregate.netSales.toFixed(2)).toBe('14.00');
  });

  it('finds the unsuperseded tip of a linear chain', () => {
    const tip = resolveChainTip([
      { id: 'a', supersedesCloseId: null },
      { id: 'b', supersedesCloseId: 'a' },
      { id: 'c', supersedesCloseId: 'b' },
    ]);
    expect(tip?.id).toBe('c');
  });
  it('returns null for an empty chain and the sole node otherwise', () => {
    expect(resolveChainTip([])).toBeNull();
    expect(resolveChainTip([{ id: 'a', supersedesCloseId: null }])?.id).toBe('a');
  });
});

// ── Real-database integration ─────────────────────────────────────────────────

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha56c_${suffix}`;
const ids = {
  branch: `branch_${suffix}`,
  operator: `staff_op_${suffix}`,
  manager: `staff_mgr_${suffix}`,
  seedDevice: '',
};

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
let orderCounter = 0;
const key = () => `k_${suffix}_${++keyCounter}`;
const mActor = (deviceId: string, idempotencyKey = key()) => ({
  staffProfileId: ids.operator,
  deviceId,
  idempotencyKey,
});

const utcDate = (d: string) => new Date(`${d}T00:00:00.000Z`);
const noonOf = (d: string) => new Date(`${d}T12:00:00.000Z`);

function read<T>(fn: (tx: ScopedDb) => Promise<T>): Promise<T> {
  return deps.withTenantDb(orgId, fn);
}

async function newDevice(label: string): Promise<string> {
  return deps.withTenantDb(orgId, async (tx) => {
    const enrolled = await deps.enrollDevice(tx, { branchId: ids.branch, name: label });
    return enrolled.device.id;
  });
}

/** Directly seed an order → bill → tender chain (the L2/L4 rows the aggregation
 * reads), bypassing those lanes' command layers which do not exist in this lane. */
async function seedBillWithTender(input: {
  businessDate: string;
  status: 'OPEN' | 'SETTLED' | 'VOID';
  subtotal: string;
  deliveryFeeTotal?: string;
  compTotal?: string;
  discountTotal?: string;
  grandTotal: string;
  tender?: { type: 'CASH' | 'CARD' | 'OTHER'; amount: string; tip?: string };
}): Promise<{ orderId: string; billId: string; tenderId: string | null }> {
  const businessDate = utcDate(input.businessDate);
  return deps.withTenantDb(orgId, async (tx) => {
    const order = await tx.restaurantOrder.create({
      data: {
        branchId: ids.branch,
        orderNumber: ++orderCounter,
        businessDate,
        status: 'CLOSED',
        channel: 'DINE_IN',
        staffProfileId: ids.operator,
        deviceId: ids.seedDevice,
      },
      select: { id: true },
    });
    const bill = await tx.restaurantBill.create({
      data: {
        orderId: order.id,
        branchId: ids.branch,
        businessDate,
        status: input.status,
        subtotal: input.subtotal,
        deliveryFeeTotal: input.deliveryFeeTotal ?? '0',
        compTotal: input.compTotal ?? '0',
        discountTotal: input.discountTotal ?? '0',
        grandTotal: input.grandTotal,
        openerStaffProfileId: ids.operator,
        deviceId: ids.seedDevice,
      },
      select: { id: true },
    });
    let tenderId: string | null = null;
    if (input.tender) {
      const tender = await tx.restaurantTender.create({
        data: {
          billId: bill.id,
          type: input.tender.type,
          amount: input.tender.amount,
          tipAmount: input.tender.tip ?? '0',
          businessDate,
          staffProfileId: ids.operator,
          deviceId: ids.seedDevice,
        },
        select: { id: true },
      });
      tenderId = tender.id;
    }
    return { orderId: order.id, billId: bill.id, tenderId };
  });
}

/** Directly seed an append-only refund (with its required co-authorization),
 * posted to its processing business date (C7). */
async function seedRefund(input: {
  billId: string;
  originalTenderId: string;
  businessDate: string;
  amount: string;
  taxRefundAmount?: string;
  serviceChargeRefundAmount?: string;
  deliveryFeeRefundAmount?: string;
}): Promise<string> {
  return deps.withTenantDb(orgId, async (tx) => {
    const coAuth = await tx.restaurantCoAuthorization.create({
      data: {
        actingStaffProfileId: ids.operator,
        approvingStaffProfileId: ids.manager,
        capability: 'payments:refund',
        reason: 'seed refund',
      },
      select: { id: true },
    });
    const refund = await tx.restaurantRefund.create({
      data: {
        originalTenderId: input.originalTenderId,
        billId: input.billId,
        amount: input.amount,
        taxRefundAmount: input.taxRefundAmount ?? '0',
        serviceChargeRefundAmount: input.serviceChargeRefundAmount ?? '0',
        deliveryFeeRefundAmount: input.deliveryFeeRefundAmount ?? '0',
        kind: 'REFUND',
        businessDate: utcDate(input.businessDate),
        reason: 'seed refund',
        coAuthorizationId: coAuth.id,
        staffProfileId: ids.operator,
        deviceId: ids.seedDevice,
      },
      select: { id: true },
    });
    return refund.id;
  });
}

/** Open then close a drawer on a fresh register for a business date, optionally
 * appending a cash sale first, so the date has a CLOSED drawer to reconcile. */
async function seedClosedDrawer(input: {
  businessDate: string;
  openingFloat: string;
  cashSale?: string;
  countedCash: string;
}): Promise<void> {
  const deviceId = await newDevice(`POS-${input.businessDate}`);
  const db = deps.createTenantDb(orgId);
  const opened = await deps.drawer.openDrawerSession(db, {
    organizationId: orgId,
    entitlementLimits: { 'pos.concurrentRegisters.max': 1000000 },
    branchId: ids.branch,
    openingFloat: input.openingFloat,
    actor: mActor(deviceId),
    now: noonOf(input.businessDate),
  });
  if (input.cashSale) {
    await deps.withTenantDb(orgId, (tx) =>
      deps.drawer.appendMovement(tx, {
        drawerSessionId: opened.drawerSessionId,
        kind: 'CASH_SALE',
        amount: input.cashSale!,
        staffProfileId: ids.operator,
        deviceId,
      })
    );
  }
  await deps.drawer.closeDrawerSession(db, {
    drawerSessionId: opened.drawerSessionId,
    countedCash: input.countedCash,
    actor: mActor(deviceId),
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
        slug: `wha56c-${suffix}`,
        legalName: 'Close Test Co',
        displayName: 'Close Test',
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
    const enrolled = await deps.enrollDevice(tx, { branchId: ids.branch, name: 'SEED' });
    ids.seedDevice = enrolled.device.id;
  });
});

describeIfDatabase('daily close (real DB)', () => {
  it('honors the branch timezone and cutoff when rejecting future dates', async () => {
    const currentBusinessDate = '2026-01-14';
    const nextLocalDate = '2026-01-15';
    const db = deps.createTenantDb(orgId);

    await read((tx) =>
      tx.restaurantBranch.update({
        where: { id: ids.branch },
        data: { timezone: 'America/Los_Angeles', businessDayCutoff: '04:00' },
      })
    );

    const beforeCutoff = new Date('2026-01-15T11:59:59.000Z'); // 03:59:59 in Los Angeles
    await expect(
      deps.close.cutClose(
        db,
        {
          branchId: ids.branch,
          businessDate: currentBusinessDate,
          actor: mActor(ids.seedDevice),
        },
        beforeCutoff
      )
    ).resolves.toMatchObject({ replayed: false });

    await expect(
      deps.close.cutClose(
        db,
        {
          branchId: ids.branch,
          businessDate: nextLocalDate,
          actor: mActor(ids.seedDevice),
        },
        beforeCutoff
      )
    ).rejects.toMatchObject({ reason: 'INVALID' });

    const closeCountBeforeCutoff = await read((tx) =>
      tx.restaurantDailyClose.count({
        where: { branchId: ids.branch, businessDate: utcDate(nextLocalDate) },
      })
    );
    expect(closeCountBeforeCutoff).toBe(0);

    await expect(
      deps.close.cutClose(
        db,
        {
          branchId: ids.branch,
          businessDate: nextLocalDate,
          actor: mActor(ids.seedDevice),
        },
        new Date('2026-01-15T12:00:00.000Z') // 04:00:00 in Los Angeles
      )
    ).resolves.toMatchObject({ replayed: false });
  });

  it('cross-business-date: a D2 refund of a D1 tender lands on D2, leaving D1 unchanged', async () => {
    const D1 = '2026-09-01';
    const D2 = '2026-09-02';
    const seeded = await seedBillWithTender({
      businessDate: D1,
      status: 'SETTLED',
      subtotal: '40.00',
      grandTotal: '40.00',
      tender: { type: 'CASH', amount: '40.00', tip: '6.00' },
    });

    const db = deps.createTenantDb(orgId);
    const d1Before = await deps.close.closePreview(db, { branchId: ids.branch, businessDate: D1 });
    expect(d1Before.grossSales.toString()).toBe('40');
    expect(d1Before.tipTotal.toString()).toBe('6');
    expect(d1Before.refundTotal.toString()).toBe('0');
    expect(d1Before.tenderTotals[0]).toMatchObject({ tenderType: 'CASH', count: 1 });

    await seedRefund({
      billId: seeded.billId,
      originalTenderId: seeded.tenderId!,
      businessDate: D2,
      amount: '15.00',
    });

    const d2 = await deps.close.closePreview(db, { branchId: ids.branch, businessDate: D2 });
    expect(d2.refundTotal.toString()).toBe('15');
    expect(d2.tipTotal.toString()).toBe('0');
    expect(d2.grossSales.toString()).toBe('0');
    expect(d2.tenderTotals).toHaveLength(0);

    const d1After = await deps.close.closePreview(db, { branchId: ids.branch, businessDate: D1 });
    expect(d1After.refundTotal.toString()).toBe('0'); // D2 refund does not leak into D1
    expect(d1After.tipTotal.toString()).toBe('6');
    expect(d1After.grossSales.toString()).toBe('40');
  });

  it('blocks a cut while a drawer is OPEN', async () => {
    const date = '2026-09-03';
    const deviceId = await newDevice('POS-openblock');
    const db = deps.createTenantDb(orgId);
    const opened = await deps.drawer.openDrawerSession(db, {
      organizationId: orgId,
      entitlementLimits: { 'pos.concurrentRegisters.max': 1000000 },
      branchId: ids.branch,
      openingFloat: '25.00',
      actor: mActor(deviceId),
      now: noonOf(date),
    });
    await expect(
      deps.close.cutClose(db, { branchId: ids.branch, businessDate: date, actor: mActor(deviceId) })
    ).rejects.toMatchObject({ reason: 'OPEN_DRAWER' });
    // Close it so the date is left clean.
    await deps.drawer.closeDrawerSession(db, {
      drawerSessionId: opened.drawerSessionId,
      countedCash: '25.00',
      actor: mActor(deviceId),
    });
  });

  it('blocks a cut while a bill is unsettled', async () => {
    const date = '2026-09-04';
    await seedBillWithTender({
      businessDate: date,
      status: 'OPEN',
      subtotal: '10.00',
      grandTotal: '10.00',
    });
    const db = deps.createTenantDb(orgId);
    await expect(
      deps.close.cutClose(db, {
        branchId: ids.branch,
        businessDate: date,
        actor: mActor(ids.seedDevice),
      })
    ).rejects.toMatchObject({ reason: 'UNSETTLED_BILL' });
  });

  it('cuts an immutable close: snapshot totals + tender-type children in one txn', async () => {
    const date = '2026-09-05';
    const settled = await seedBillWithTender({
      businessDate: date,
      status: 'SETTLED',
      subtotal: '100.00',
      deliveryFeeTotal: '5.00',
      compTotal: '20.00',
      grandTotal: '85.00',
      tender: { type: 'CASH', amount: '80.00', tip: '5.00' },
    });
    // A second (card) tender + a void bill on the same date.
    await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantTender.create({
        data: {
          billId: settled.billId,
          type: 'CARD',
          amount: '30.00',
          tipAmount: '10.00',
          businessDate: utcDate(date),
          staffProfileId: ids.operator,
          deviceId: ids.seedDevice,
        },
        select: { id: true },
      })
    );
    await seedBillWithTender({
      businessDate: date,
      status: 'VOID',
      subtotal: '12.50',
      grandTotal: '12.50',
    });
    await seedClosedDrawer({
      businessDate: date,
      openingFloat: '100.00',
      cashSale: '80.00',
      countedCash: '180.00',
    });

    const db = deps.createTenantDb(orgId);
    const cut = await deps.close.cutClose(db, {
      branchId: ids.branch,
      businessDate: date,
      actor: mActor(ids.seedDevice, cutKeyFor(date)),
    });
    expect(cut.totals.grossSales.toString()).toBe('100');
    expect(cut.totals.netSales.toString()).toBe('80');
    expect(cut.totals.deliveryFeeSales.toString()).toBe('5');
    expect(cut.totals.compTotal.toString()).toBe('20');
    expect(cut.totals.voidTotal.toString()).toBe('12.5');
    expect(cut.totals.tipTotal.toString()).toBe('15');
    expect(cut.totals.cashExpected.toString()).toBe('180');
    expect(cut.totals.cashVariance.toString()).toBe('0');

    const persisted = await read((tx) =>
      tx.restaurantDailyClose.findUnique({
        where: { id: cut.dailyCloseId },
        select: {
          grossSales: true,
          deliveryFeeSales: true,
          voidTotal: true,
          tenderTotals: {
            orderBy: { tenderType: 'asc' },
            select: { tenderType: true, amount: true, count: true },
          },
        },
      })
    );
    expect(persisted?.grossSales.toString()).toBe('100');
    expect(persisted?.deliveryFeeSales.toString()).toBe('5');
    // Postgres orders the tenderType enum by DEFINITION order (CASH, CARD, OTHER).
    expect(persisted?.tenderTotals).toEqual([
      { tenderType: 'CASH', amount: expect.anything(), count: 1 },
      { tenderType: 'CARD', amount: expect.anything(), count: 1 },
    ]);
    expect(persisted?.tenderTotals[0].amount.toString()).toBe('80');
    expect(persisted?.tenderTotals[1].amount.toString()).toBe('30');

    // A second cut for the same date is rejected (a correction supersedes instead).
    await expect(
      deps.close.cutClose(db, {
        branchId: ids.branch,
        businessDate: date,
        actor: mActor(ids.seedDevice),
      })
    ).rejects.toMatchObject({ reason: 'CLOSE_EXISTS' });

    // Idempotent replay of the ORIGINAL cut (same key) returns it, creating nothing.
    const replay = await deps.close.cutClose(db, {
      branchId: ids.branch,
      businessDate: date,
      actor: mActor(ids.seedDevice, cutKeyFor(date)),
    });
    expect(replay.replayed).toBe(true);
    expect(replay.dailyCloseId).toBe(cut.dailyCloseId);
    const closeCount = await read((tx) =>
      tx.restaurantDailyClose.count({
        where: { branchId: ids.branch, businessDate: utcDate(date) },
      })
    );
    expect(closeCount).toBe(1);
    const rollupJobCount = await read((tx) =>
      tx.restaurantJob.count({
        where: {
          idempotencyKey: insightRollupJobKey({
            branchId: ids.branch,
            businessDate: date,
            sourceDailyCloseId: cut.dailyCloseId,
          }),
        },
      })
    );
    expect(rollupJobCount).toBe(1);
  });

  it('corrects a close: new record supersedes the tip; the original is byte-identical', async () => {
    const date = '2026-09-06';
    const settled = await seedBillWithTender({
      businessDate: date,
      status: 'SETTLED',
      subtotal: '50.00',
      grandTotal: '50.00',
      tender: { type: 'CASH', amount: '50.00' },
    });
    void settled;
    await seedClosedDrawer({ businessDate: date, openingFloat: '50.00', countedCash: '50.00' });

    const db = deps.createTenantDb(orgId);
    const cut = await deps.close.cutClose(db, {
      branchId: ids.branch,
      businessDate: date,
      actor: mActor(ids.seedDevice),
    });
    const before = await read((tx) =>
      tx.restaurantDailyClose.findUnique({
        where: { id: cut.dailyCloseId },
        select: { grossSales: true, netSales: true, createdAt: true, supersedesCloseId: true },
      })
    );

    const correction = await deps.close.correctClose(db, {
      branchId: ids.branch,
      businessDate: date,
      supersedesCloseId: cut.dailyCloseId,
      reason: 'recount after audit',
      approvingStaffProfileId: ids.manager,
      actor: mActor(ids.seedDevice),
    });
    expect(correction.supersedesCloseId).toBe(cut.dailyCloseId);

    // The chain now tips at the correction; the original is unchanged.
    const chain = await read((tx) =>
      tx.restaurantDailyClose.findMany({
        where: { branchId: ids.branch, businessDate: utcDate(date) },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          supersedesCloseId: true,
          correctionReason: true,
          coAuthorizationId: true,
        },
      })
    );
    expect(resolveChainTip(chain)?.id).toBe(correction.dailyCloseId);
    const corrRow = chain.find((c) => c.id === correction.dailyCloseId);
    expect(corrRow?.correctionReason).toBe('recount after audit');
    expect(corrRow?.coAuthorizationId).not.toBeNull();
    const rollupJobs = await read((tx) =>
      tx.restaurantJob.findMany({
        where: {
          idempotencyKey: {
            in: [
              insightRollupJobKey({
                branchId: ids.branch,
                businessDate: date,
                sourceDailyCloseId: cut.dailyCloseId,
              }),
              insightRollupJobKey({
                branchId: ids.branch,
                businessDate: date,
                sourceDailyCloseId: correction.dailyCloseId,
              }),
            ],
          },
        },
        select: { id: true },
      })
    );
    expect(rollupJobs).toHaveLength(2);

    const after = await read((tx) =>
      tx.restaurantDailyClose.findUnique({
        where: { id: cut.dailyCloseId },
        select: { grossSales: true, netSales: true, createdAt: true, supersedesCloseId: true },
      })
    );
    expect(after).toEqual(before); // append-only: the original never changed

    // Superseding a stale (non-tip) close is rejected.
    await expect(
      deps.close.correctClose(db, {
        branchId: ids.branch,
        businessDate: date,
        supersedesCloseId: cut.dailyCloseId,
        reason: 'again',
        approvingStaffProfileId: ids.manager,
        actor: mActor(ids.seedDevice),
      })
    ).rejects.toMatchObject({ reason: 'NOT_TIP' });

    // A self-approved correction is not a co-authorization (rejected by the co-auth
    // primitive: the approving manager must differ from the acting operator).
    await expect(
      deps.close.correctClose(db, {
        branchId: ids.branch,
        businessDate: date,
        supersedesCloseId: correction.dailyCloseId,
        reason: 'self',
        approvingStaffProfileId: ids.operator,
        actor: mActor(ids.seedDevice),
      })
    ).rejects.toThrow(/differ/);
  });

  it('cross-business-date cut: D2 close carries the refund; the D1 close re-reads byte-identical', async () => {
    const D1 = '2026-09-07';
    const D2 = '2026-09-08';
    const seeded = await seedBillWithTender({
      businessDate: D1,
      status: 'SETTLED',
      subtotal: '40.00',
      grandTotal: '40.00',
      tender: { type: 'CASH', amount: '40.00' },
    });
    await seedClosedDrawer({
      businessDate: D1,
      openingFloat: '0.00',
      cashSale: '40.00',
      countedCash: '40.00',
    });

    const db = deps.createTenantDb(orgId);
    const cutD1 = await deps.close.cutClose(db, {
      branchId: ids.branch,
      businessDate: D1,
      actor: mActor(ids.seedDevice),
    });
    const d1Before = await read((tx) =>
      tx.restaurantDailyClose.findUnique({
        where: { id: cutD1.dailyCloseId },
        select: { grossSales: true, refundTotal: true, cashExpected: true, createdAt: true },
      })
    );
    expect(d1Before?.refundTotal.toString()).toBe('0');

    // The D1 tender is refunded on D2 (processing date).
    await seedRefund({
      billId: seeded.billId,
      originalTenderId: seeded.tenderId!,
      businessDate: D2,
      amount: '15.00',
      deliveryFeeRefundAmount: '3.00',
    });

    const cutD2 = await deps.close.cutClose(db, {
      branchId: ids.branch,
      businessDate: D2,
      actor: mActor(ids.seedDevice),
    });
    const d2 = await read((tx) =>
      tx.restaurantDailyClose.findUnique({
        where: { id: cutD2.dailyCloseId },
        select: { refundTotal: true, deliveryFeeRefunds: true, grossSales: true },
      })
    );
    expect(d2?.refundTotal.toString()).toBe('12');
    expect(d2?.deliveryFeeRefunds.toString()).toBe('3');
    expect(d2?.grossSales.toString()).toBe('0');

    const d1After = await read((tx) =>
      tx.restaurantDailyClose.findUnique({
        where: { id: cutD1.dailyCloseId },
        select: { grossSales: true, refundTotal: true, cashExpected: true, createdAt: true },
      })
    );
    expect(d1After).toEqual(d1Before); // the prior day's close is immutable
  });
});

/** A stable idempotency key for a date's cut, so a replay reuses it. */
function cutKeyFor(date: string): string {
  return `cut_${suffix}_${date}`;
}
