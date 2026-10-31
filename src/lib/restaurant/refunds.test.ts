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
const otherOrgId = `org_wha892_other_${suffix}`;
const ids = {
  branch: `branch_${suffix}`,
  branchTwo: `branch_two_${suffix}`,
  customer: `customer_${suffix}`,
  loyaltyAccount: `loyalty_account_${suffix}`,
  loyaltyProgram: `loyalty_program_${suffix}`,
  operator: `staff_op_${suffix}`,
  manager: `staff_mgr_${suffix}`,
  managerTwo: `staff_mgr_two_${suffix}`,
  category: `cat_${suffix}`,
  product: `prod_${suffix}`,
  brand: `brand_${suffix}`,
  menu: `menu_${suffix}`,
  section: `sec_${suffix}`,
  menuItem: `mitem_${suffix}`,
  priceList: `pl_${suffix}`,
  priceVersion: `plv_${suffix}`,
  publication: `pub_${suffix}`,
  publicationTwo: `pub_two_${suffix}`,
  taxSource: `tax_source_${suffix}`,
  taxProfile: `tax_profile_${suffix}`,
  taxProfileTwo: `tax_profile_two_${suffix}`,
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
let branchTwoDeviceId: string;
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
    organizationId: orgId,
    entitlementLimits: { 'pos.orders.monthly': 1000000 },
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
    branchId: ids.branch,
    split: { kind: 'NONE' },
    actor: actor(),
  });
  return cut.billIds[0]!;
}

async function cardTenderAtBranchTwo(): Promise<{
  billId: string;
  tenderId: string;
  paymentId: string;
}> {
  const billId = await openBillAtBranchTwo();
  const db = deps.createTenantDb(orgId);
  const tender = await deps.tenders.applyTender(db, {
    billId,
    // 12.50 merchandise + 1.25 exclusive tax + 1.25 non-taxable service charge.
    tender: { type: 'CARD', amount: '15.00' },
    actor: actor(branchTwoDeviceId),
    now: AT,
  });
  return { billId, tenderId: tender.tenderId, paymentId: tender.paymentId! };
}

async function openBillAtBranchTwo(): Promise<string> {
  const db = deps.createTenantDb(orgId);
  const opened = await deps.orders.openOrder(db, {
    organizationId: orgId,
    entitlementLimits: { 'pos.orders.monthly': 1000000 },
    branchId: ids.branchTwo,
    channel: 'DINE_IN',
    publicationId: ids.publicationTwo,
    actor: actor(branchTwoDeviceId),
    now: AT,
  });
  await deps.orders.addItem(db, {
    orderId: opened.orderId,
    menuItemId: ids.menuItem,
    actor: actor(branchTwoDeviceId),
  });
  const cut = await deps.bills.cutBills(db, {
    orderId: opened.orderId,
    branchId: ids.branchTwo,
    split: { kind: 'NONE' },
    actor: actor(branchTwoDeviceId),
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
    organizationId: orgId,
    entitlementLimits: { 'pos.concurrentRegisters.max': 1000000 },
    branchId: ids.branch,
    openingFloat: '100.00',
    actor: actor(device),
    now: AT,
  });
}

async function openDrawerAtBranch(device: string, branchId: string): Promise<void> {
  await deps.drawer.openDrawerSession(deps.createTenantDb(orgId), {
    organizationId: orgId,
    entitlementLimits: { 'pos.concurrentRegisters.max': 1000000 },
    branchId,
    openingFloat: '100.00',
    actor: actor(device),
    now: AT,
  });
}

async function splitTaxedTenders(): Promise<{
  billId: string;
  tenders: Array<{ id: string; type: 'CASH' | 'CARD' | 'OTHER' }>;
}> {
  await openDrawerAtBranch(branchTwoDeviceId, ids.branchTwo);
  const db = deps.createTenantDb(orgId);
  const opened = await deps.orders.openOrder(db, {
    organizationId: orgId,
    entitlementLimits: { 'pos.orders.monthly': 1000000 },
    branchId: ids.branchTwo,
    channel: 'DINE_IN',
    publicationId: ids.publicationTwo,
    actor: actor(branchTwoDeviceId),
    now: AT,
  });
  await deps.orders.addItem(db, {
    orderId: opened.orderId,
    menuItemId: ids.menuItem,
    actor: actor(branchTwoDeviceId),
  });
  const cut = await deps.bills.cutBills(db, {
    orderId: opened.orderId,
    branchId: ids.branchTwo,
    split: { kind: 'NONE' },
    actor: actor(branchTwoDeviceId),
  });
  const billId = cut.billIds[0]!;
  const cash = await deps.tenders.applyTender(db, {
    billId,
    tender: { type: 'CASH', amount: '5.00', cashReceived: '5.00' },
    actor: actor(branchTwoDeviceId),
    now: AT,
  });
  const card = await deps.tenders.applyTender(db, {
    billId,
    tender: { type: 'CARD', amount: '5.00' },
    actor: actor(branchTwoDeviceId),
    now: AT,
  });
  const other = await deps.tenders.applyTender(db, {
    billId,
    tender: { type: 'OTHER', amount: '5.00' },
    actor: actor(branchTwoDeviceId),
    now: AT,
  });
  expect(other.settled).toBe(true);
  return {
    billId,
    tenders: [
      { id: cash.tenderId, type: 'CASH' },
      { id: card.tenderId, type: 'CARD' },
      { id: other.tenderId, type: 'OTHER' },
    ],
  };
}

async function sideEffectTotals(organizationId: string) {
  return deps.withTenantDb(organizationId, async (tx) => ({
    refunds: await tx.restaurantRefund.count(),
    coAuthorizations: await tx.restaurantCoAuthorization.count(),
    paymentEvents: await tx.restaurantPaymentEvent.count(),
    paymentStatuses: await tx.restaurantPayment.findMany({
      orderBy: { id: 'asc' },
      select: { id: true, status: true },
    }),
    drawerMovements: await tx.restaurantDrawerMovement.count(),
    loyaltyReversals: await tx.loyaltyPointsEntry.count({ where: { kind: 'REVERSAL' } }),
    taxAllocations: await tx.restaurantTaxRefundAllocation.count(),
    idempotencyKeys: await tx.restaurantMoneyIdempotencyKey.count(),
  }));
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

  const role = await deps.withPlatformDb(
    (tx) =>
      tx.$queryRaw<Array<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `
  );
  expect(role[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });

  await deps.withPlatformDb(async (tx) => {
    await tx.organization.createMany({
      data: [
        {
          id: orgId,
          slug: `wha58r-${suffix}`,
          legalName: 'Refunds Test Co',
          displayName: 'Refunds Test',
          status: 'ACTIVE',
        },
        {
          id: otherOrgId,
          slug: `wha892-other-${suffix}`,
          legalName: 'Other Refunds Co',
          displayName: 'Other Refunds',
          status: 'ACTIVE',
        },
      ],
    });
  });
  await deps.withTenantDb(otherOrgId, (tx) =>
    tx.restaurantBranch.create({
      data: {
        id: `other_branch_${suffix}`,
        name: 'Other org',
        timezone: 'UTC',
        businessDayCutoff: '00:00',
      },
    })
  );

  await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantBranch.create({
      data: { id: ids.branch, name: 'Main', timezone: 'UTC', businessDayCutoff: '00:00' },
    });
    await tx.restaurantBranch.create({
      data: { id: ids.branchTwo, name: 'Annex', timezone: 'UTC', businessDayCutoff: '00:00' },
    });
    await tx.restaurantTaxOfficialSource.create({
      data: {
        id: ids.taxSource,
        authorityCode: 'SYNTHETIC_TEST_ONLY',
        documentTitle: 'Synthetic zero-rate refund fixture',
        sourceUrl: 'https://example.invalid/synthetic-tax',
        contentHash: `synthetic-${suffix}`,
        retrievedAt: new Date('2026-08-01T00:00:00.000Z'),
        expiresAt: new Date('2027-08-01T00:00:00.000Z'),
      },
    });
    await tx.restaurantTaxProfileVersion.create({
      data: {
        id: ids.taxProfile,
        branchId: ids.branch,
        versionNumber: 1,
        status: 'PUBLISHED',
        effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
        approvalReference: 'SYNTHETIC_TEST_APPROVAL',
        approvedAt: new Date('2026-08-01T00:00:00.000Z'),
        publishedAt: new Date('2026-08-01T00:00:00.000Z'),
        rules: {
          create: (['CASH', 'CARD', 'OTHER'] as const).map((paymentCategory) => ({
            officialSourceId: ids.taxSource,
            ruleCode: `SYNTHETIC_${paymentCategory}`,
            paymentCategory,
            priceMode: 'EXCLUSIVE',
            rate: '0.000000',
            status: 'PUBLISHED',
            effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
            approvalReference: 'SYNTHETIC_TEST_APPROVAL',
            approvedAt: new Date('2026-08-01T00:00:00.000Z'),
            publishedAt: new Date('2026-08-01T00:00:00.000Z'),
          })),
        },
      },
    });
    await tx.restaurantTaxProfileVersion.create({
      data: {
        id: ids.taxProfileTwo,
        branchId: ids.branchTwo,
        versionNumber: 1,
        status: 'PUBLISHED',
        effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-08-20T00:00:00.000Z'),
        approvalReference: 'SYNTHETIC_TEST_APPROVAL',
        approvedAt: new Date('2026-08-01T00:00:00.000Z'),
        publishedAt: new Date('2026-08-01T00:00:00.000Z'),
        rules: {
          create: (['CASH', 'CARD', 'OTHER'] as const).map((paymentCategory) => ({
            officialSourceId: ids.taxSource,
            ruleCode: `SYNTHETIC_TEN_PERCENT_${paymentCategory}`,
            paymentCategory,
            priceMode: 'EXCLUSIVE' as const,
            rate: '0.100000',
            status: 'PUBLISHED' as const,
            effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
            effectiveTo: new Date('2026-08-20T00:00:00.000Z'),
            approvalReference: 'SYNTHETIC_TEST_APPROVAL',
            approvedAt: new Date('2026-08-01T00:00:00.000Z'),
            publishedAt: new Date('2026-08-01T00:00:00.000Z'),
          })),
        },
      },
    });
    await tx.restaurantStaffProfile.create({
      data: { id: ids.operator, displayName: 'Operator', status: 'ACTIVE' },
    });
    await tx.restaurantStaffProfile.create({
      data: { id: ids.manager, displayName: 'Manager', status: 'ACTIVE' },
    });
    await tx.restaurantStaffProfile.create({
      data: { id: ids.managerTwo, displayName: 'Manager Two', status: 'ACTIVE' },
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
    const branchTwoDevice = await deps.enrollDevice(tx, {
      branchId: ids.branchTwo,
      name: 'POS-2',
    });
    branchTwoDeviceId = branchTwoDevice.device.id;

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
    await tx.restaurantBranchMenuPublication.create({
      data: {
        id: ids.publicationTwo,
        branchId: ids.branchTwo,
        menuId: ids.menu,
        priceListId: ids.priceList,
        status: 'PUBLISHED',
        channels: [],
      },
    });
    await tx.restaurantServiceChargePolicyVersion.create({
      data: {
        branchId: ids.branchTwo,
        rate: '0.100000',
        effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
        acknowledgedAt: new Date('2026-08-01T00:00:00.000Z'),
        acknowledgementRef: 'SYNTHETIC_SERVICE_ACK',
        idempotencyKey: `service_${suffix}`,
        payloadHash: `synthetic-service-${suffix}`,
      },
    });
  });
});

describeIfDatabase('card refunds (real DB)', () => {
  it('rejects refunding a partial tender while its bill is still open', async () => {
    const billId = await openBill(1);
    const db = deps.createTenantDb(orgId);
    const partial = await deps.tenders.applyTender(db, {
      billId,
      tender: { type: 'OTHER', amount: '6.00' },
      actor: actor(),
      now: AT,
    });
    const beforeRejectedRefund = await sideEffectTotals(orgId);

    await expect(
      deps.refunds.refundTender(db, {
        originalTenderId: partial.tenderId,
        amount: '6.00',
        reason: 'must not refund before settlement',
        approvingStaffProfileId: ids.manager,
        actor: actor(),
        now: AT,
      })
    ).rejects.toMatchObject({ reason: 'BILL_NOT_SETTLED' });

    expect(await sideEffectTotals(orgId)).toEqual(beforeRejectedRefund);

    const final = await deps.tenders.applyTender(db, {
      billId,
      tender: { type: 'OTHER', amount: '6.50' },
      actor: actor(),
      now: AT,
    });
    expect(final.settled).toBe(true);
    const persisted = await read(async (tx) => ({
      bill: await tx.restaurantBill.findUniqueOrThrow({
        where: { id: billId },
        select: { status: true },
      }),
      refunds: await tx.restaurantRefund.count({
        where: { originalTenderId: partial.tenderId },
      }),
      tenderAmounts: await tx.restaurantTender.findMany({
        where: { billId },
        orderBy: { amount: 'asc' },
        select: { amount: true },
      }),
    }));
    expect(persisted.bill.status).toBe('SETTLED');
    expect(persisted.refunds).toBe(0);
    expect(persisted.tenderAmounts.map(({ amount }) => amount.toFixed(2))).toEqual([
      '6.00',
      '6.50',
    ]);
  });

  it('reloads the complete tender set after concurrent settlement without rounding drift', async () => {
    const billId = await openBillAtBranchTwo();
    const partial = await deps.tenders.applyTender(deps.createTenantDb(orgId), {
      billId,
      tender: { type: 'OTHER', amount: '5.00' },
      actor: actor(branchTwoDeviceId),
      now: AT,
    });

    let signalSettlementReady!: () => void;
    const settlementReady = new Promise<void>((resolve) => {
      signalSettlementReady = resolve;
    });
    let releaseSettlement!: () => void;
    const settlementMayCommit = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    let finalTenderId!: string;
    const concurrentSettlement = read(async (tx) => {
      await tx.$queryRaw`SELECT id FROM restaurant_bills WHERE id = ${billId} FOR UPDATE`;
      const finalTender = await tx.restaurantTender.create({
        data: {
          billId,
          type: 'OTHER',
          amount: '10.00',
          businessDate: new Date('2026-08-19T00:00:00.000Z'),
          staffProfileId: ids.operator,
          deviceId: branchTwoDeviceId,
        },
        select: { id: true },
      });
      finalTenderId = finalTender.id;
      await tx.restaurantBill.update({
        where: { id: billId },
        data: { status: 'SETTLED', settledAt: AT },
      });
      signalSettlementReady();
      await settlementMayCommit;
    });
    await settlementReady;

    const refund = deps.refunds.refundTender(deps.createTenantDb(orgId), {
      originalTenderId: partial.tenderId,
      amount: '5.00',
      reason: 'concurrent settlement allocation',
      branchId: ids.branchTwo,
      approvingStaffProfileId: ids.manager,
      actor: actor(branchTwoDeviceId),
      now: AT,
    });
    let blocked = false;
    try {
      for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
        const [activity] = await deps.withPlatformDb((tx) =>
          tx.$queryRaw<Array<{ count: number }>>`
            SELECT count(*)::int AS count
            FROM pg_stat_activity
            WHERE wait_event_type = 'Lock'
              AND query LIKE '%SELECT status FROM restaurant_bills%FOR UPDATE%'
          `
        );
        blocked = (activity?.count ?? 0) > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      releaseSettlement();
    }
    await concurrentSettlement;

    const result = await refund;
    expect(blocked).toBe(true);
    // The settled bill's 1.25 service charge is shared 5:10, rather than assigning
    // all 1.25 to the only tender visible before the settlement transaction committed.
    expect(result.serviceChargeRefundAmount.toFixed(2)).toBe('0.42');

    const finalTenderRefund = await deps.refunds.refundTender(deps.createTenantDb(orgId), {
      originalTenderId: finalTenderId,
      amount: '10.00',
      reason: 'verify balanced settlement allocation',
      branchId: ids.branchTwo,
      approvingStaffProfileId: ids.manager,
      actor: actor(branchTwoDeviceId),
      now: AT,
    });
    expect(finalTenderRefund.serviceChargeRefundAmount.toFixed(2)).toBe('0.83');

    const persistedServiceRefunds = await read(async (tx) => {
      const refunds = await tx.restaurantRefund.findMany({
        where: { billId },
        orderBy: { serviceChargeRefundAmount: 'asc' },
        select: { serviceChargeRefundAmount: true },
      });
      return refunds.map(({ serviceChargeRefundAmount }) =>
        serviceChargeRefundAmount.toFixed(2)
      );
    });
    expect(persistedServiceRefunds).toEqual(['0.42', '0.83']);
  });

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

  it('conflicts when the same key changes only the selected manager', async () => {
    const { tenderId } = await cardTender();
    const reuse = actor();
    await deps.refunds.refundTender(deps.createTenantDb(orgId), {
      originalTenderId: tenderId,
      amount: '5.00',
      reason: 'manager-bound return',
      approvingStaffProfileId: ids.manager,
      actor: reuse,
      now: AT,
    });
    await expect(
      deps.refunds.refundTender(deps.createTenantDb(orgId), {
        originalTenderId: tenderId,
        amount: '5.00',
        reason: 'manager-bound return',
        approvingStaffProfileId: ids.managerTwo,
        actor: reuse,
        now: AT,
      })
    ).rejects.toMatchObject({ reason: 'TAX_SETTLEMENT_CONFLICT' });
    expect(
      await read((tx) => tx.restaurantRefund.count({ where: { originalTenderId: tenderId } }))
    ).toBe(1);
  });
});

describeIfDatabase('WHA-892 branch and allocation integrity (restricted real DB)', () => {
  it('makes a same-tenant cross-branch tender indistinguishable from missing and writes zero rows', async () => {
    const { tenderId } = await cardTenderAtBranchTwo();
    const before = await read(async (tx) => ({
      refunds: await tx.restaurantRefund.count(),
      coAuthorizations: await tx.restaurantCoAuthorization.count(),
      paymentEvents: await tx.restaurantPaymentEvent.count(),
      drawerMovements: await tx.restaurantDrawerMovement.count(),
      idempotencyKeys: await tx.restaurantMoneyIdempotencyKey.count(),
    }));
    await expect(
      deps.refunds.refundTender(deps.createTenantDb(orgId), {
        originalTenderId: tenderId,
        amount: '1.00',
        reason: 'must not cross branch',
        branchId: ids.branch,
        approvingStaffProfileId: ids.manager,
        actor: actor(deviceId),
        now: AT,
      })
    ).rejects.toMatchObject({ reason: 'TENDER_NOT_FOUND' });
    const after = await read(async (tx) => ({
      refunds: await tx.restaurantRefund.count(),
      coAuthorizations: await tx.restaurantCoAuthorization.count(),
      paymentEvents: await tx.restaurantPaymentEvent.count(),
      drawerMovements: await tx.restaurantDrawerMovement.count(),
      idempotencyKeys: await tx.restaurantMoneyIdempotencyKey.count(),
    }));
    expect(after).toEqual(before);
  });

  it('records and replays actual non-null server-authored service and tax allocations', async () => {
    const { tenderId } = await cardTenderAtBranchTwo();
    const reuse = actor(branchTwoDeviceId);
    const first = await deps.refunds.refundTender(deps.createTenantDb(orgId), {
      originalTenderId: tenderId,
      amount: '5.00',
      reason: 'allocated return',
      branchId: ids.branchTwo,
      approvingStaffProfileId: ids.manager,
      actor: reuse,
      now: AT,
    });
    expect(first.serviceChargeRefundAmount.toNumber()).toBeGreaterThan(0);
    expect(first.taxRefundAmount.toNumber()).toBeGreaterThan(0);
    const persisted = await read((tx) =>
      tx.restaurantRefund.findUniqueOrThrow({ where: { id: first.refundId } })
    );
    expect(first.serviceChargeRefundAmount.toString()).toBe(
      persisted.serviceChargeRefundAmount.toString()
    );
    expect(first.taxRefundAmount.toString()).toBe(persisted.taxRefundAmount.toString());

    const replay = await deps.refunds.refundTender(deps.createTenantDb(orgId), {
      originalTenderId: tenderId,
      amount: '5.0',
      reason: '  allocated return  ',
      branchId: ids.branchTwo,
      approvingStaffProfileId: ids.manager,
      actor: reuse,
      now: NEXT_DAY,
    });
    expect(replay).toMatchObject({ refundId: first.refundId, replayed: true });
    expect(replay.businessDate).toEqual(first.businessDate);
    expect(replay.paymentStatus).toBe(first.paymentStatus);
  });

  it('denies cash when only a wrong-device drawer exists or the business date changed', async () => {
    const refundDevice = await newDevice('POS-refund-drawer-date');
    const otherDevice = await newDevice('POS-other-open-drawer');
    await openDrawer(refundDevice);
    await openDrawer(otherDevice);
    const { tenderId } = await cashTender(refundDevice);
    await expect(
      deps.refunds.refundTender(deps.createTenantDb(orgId), {
        originalTenderId: tenderId,
        amount: '1.00',
        reason: 'next date drawer mismatch',
        branchId: ids.branch,
        approvingStaffProfileId: ids.manager,
        actor: actor(refundDevice),
        now: NEXT_DAY,
      })
    ).rejects.toMatchObject({ reason: 'DRAWER_NOT_OPEN' });
    expect(
      await read((tx) => tx.restaurantRefund.count({ where: { originalTenderId: tenderId } }))
    ).toBe(0);
  });
});

describeIfDatabase('WHA-333 per-original-tender refund evidence (restricted real DB)', () => {
  it('reverses a split-tender bill tender by tender with exact frozen unit-bucket evidence', async () => {
    const { billId, tenders } = await splitTaxedTenders();
    const original = await read((tx) =>
      tx.restaurantTaxTenderAllocationSnapshot.findMany({
        where: { billId },
        orderBy: [{ paymentCategory: 'asc' }, { rateBucketSnapshotId: 'asc' }],
        select: {
          id: true,
          originalTenderId: true,
          paymentCategory: true,
          cents: true,
          rateBucket: { select: { billLineId: true, unitOrdinal: true } },
        },
      })
    );
    expect(new Set(original.map((row) => row.paymentCategory))).toEqual(
      new Set(['CASH', 'CARD', 'OTHER'])
    );
    expect(
      original.some((row) => row.rateBucket.billLineId && row.rateBucket.unitOrdinal === 0)
    ).toBe(true);

    for (const tender of tenders) {
      const result = await deps.refunds.refundTender(deps.createTenantDb(orgId), {
        originalTenderId: tender.id,
        amount: '5.00',
        reason: `full ${tender.type} reversal`,
        branchId: ids.branchTwo,
        approvingStaffProfileId: ids.manager,
        actor: actor(branchTwoDeviceId),
        now: AT,
      });
      expect(result.originalTenderId).toBe(tender.id);
      const expected = original.filter((row) => row.originalTenderId === tender.id);
      const copied = await read((tx) =>
        tx.restaurantTaxRefundAllocation.findMany({
          where: { refundId: result.refundId },
          orderBy: { originalTenderAllocationId: 'asc' },
          select: {
            originalTenderId: true,
            paymentCategory: true,
            originalTenderAllocationId: true,
            cents: true,
            originalAllocation: {
              select: { rateBucket: { select: { billLineId: true, unitOrdinal: true } } },
            },
          },
        })
      );
      expect(copied.map((row) => row.originalTenderAllocationId).sort()).toEqual(
        expected.map((row) => row.id).sort()
      );
      expect(copied.reduce((total, row) => total + row.cents, BigInt(0))).toBe(
        expected.reduce((total, row) => total + row.cents, BigInt(0))
      );
      expect(copied.every((row) => row.originalTenderId === tender.id)).toBe(true);
      expect(copied.every((row) => row.paymentCategory === tender.type)).toBe(true);
      const expectedTuples = expected
        .map(
          (row) =>
            `${row.rateBucket.billLineId ?? 'null'}:${row.rateBucket.unitOrdinal ?? 'null'}:${row.paymentCategory}`
        )
        .sort();
      const copiedTuples = copied
        .map(
          (row) =>
            `${row.originalAllocation.rateBucket.billLineId ?? 'null'}:${row.originalAllocation.rateBucket.unitOrdinal ?? 'null'}:${row.paymentCategory}`
        )
        .sort();
      expect(copiedTuples).toEqual(expectedTuples);
    }

    const beforeDuplicate = await sideEffectTotals(orgId);
    await expect(
      deps.refunds.refundTender(deps.createTenantDb(orgId), {
        originalTenderId: tenders[1]!.id,
        amount: '0.01',
        reason: 'duplicate reversal',
        branchId: ids.branchTwo,
        approvingStaffProfileId: ids.manager,
        actor: actor(branchTwoDeviceId),
        now: AT,
      })
    ).rejects.toMatchObject({ reason: 'REFUND_EXCEEDS_TENDER' });
    expect(await sideEffectTotals(orgId)).toEqual(beforeDuplicate);
  });

  it('allocates a partial tax refund proportionally, then exhausts exact frozen cents', async () => {
    const { billId, tenderId } = await cardTenderAtBranchTwo();
    const original = await read((tx) =>
      tx.restaurantTaxTenderAllocationSnapshot.findMany({
        where: { billId, originalTenderId: tenderId },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          cents: true,
          paymentCategory: true,
          rateBucket: { select: { billLineId: true, unitOrdinal: true } },
        },
      })
    );
    const partial = await deps.refunds.refundTender(deps.createTenantDb(orgId), {
      originalTenderId: tenderId,
      amount: '6.00',
      reason: 'partial taxed return',
      branchId: ids.branchTwo,
      approvingStaffProfileId: ids.manager,
      actor: actor(branchTwoDeviceId),
      now: AT,
    });
    const partialRows = await read((tx) =>
      tx.restaurantTaxRefundAllocation.findMany({
        where: { refundId: partial.refundId },
        select: { originalTenderAllocationId: true, cents: true },
      })
    );
    expect(partial.taxRefundAmount.toString()).toBe('0.5');
    expect(original).toHaveLength(1);
    expect(partialRows).toEqual([
      { originalTenderAllocationId: original[0]!.id, cents: BigInt(50) },
    ]);

    await deps.refunds.refundTender(deps.createTenantDb(orgId), {
      originalTenderId: tenderId,
      amount: '9.00',
      reason: 'remaining taxed return',
      branchId: ids.branchTwo,
      approvingStaffProfileId: ids.manager,
      actor: actor(branchTwoDeviceId),
      now: AT,
    });
    const cumulative = await read((tx) =>
      tx.restaurantTaxRefundAllocation.groupBy({
        by: ['originalTenderAllocationId'],
        where: { originalTenderId: tenderId },
        _sum: { cents: true },
      })
    );
    expect(
      original
        .map((row) => ({
          id: row.id,
          cents: row.cents,
          tuple: `${row.rateBucket.billLineId ?? 'null'}:${row.rateBucket.unitOrdinal ?? 'null'}:${row.paymentCategory}`,
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
    ).toEqual(
      cumulative
        .map((row) => {
          const source = original.find(
            (candidate) => candidate.id === row.originalTenderAllocationId
          )!;
          return {
            id: row.originalTenderAllocationId,
            cents: row._sum.cents,
            tuple: `${source.rateBucket.billLineId ?? 'null'}:${source.rateBucket.unitOrdinal ?? 'null'}:${source.paymentCategory}`,
          };
        })
        .sort((left, right) => left.id.localeCompare(right.id))
    );
  });

  it('uses frozen tax evidence after live tax configuration is unavailable', async () => {
    const { tenderId } = await cardTenderAtBranchTwo();
    expect(
      await read((tx) =>
        tx.restaurantTaxProfileVersion.count({
          where: {
            branchId: ids.branchTwo,
            effectiveFrom: { lte: NEXT_DAY },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: NEXT_DAY } }],
          },
        })
      )
    ).toBe(0);
    const refund = await deps.refunds.refundTender(deps.createTenantDb(orgId), {
      originalTenderId: tenderId,
      amount: '15.00',
      reason: 'refund after config expiry',
      branchId: ids.branchTwo,
      approvingStaffProfileId: ids.manager,
      actor: actor(branchTwoDeviceId),
      now: NEXT_DAY,
    });
    expect(refund.taxRefundAmount.toString()).toBe('1.25');
    const evidence = await read((tx) =>
      tx.restaurantTaxRefundAllocation.findMany({
        where: { refundId: refund.refundId },
        include: { originalAllocation: { include: { rateBucket: true } } },
      })
    );
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.some((row) => row.originalAllocation.rateBucket.billLineId !== null)).toBe(
      true
    );
  });

  it('rejects cross-tenant tender access without appending refund evidence', async () => {
    const { tenderId } = await cardTender();
    const beforeOwner = await sideEffectTotals(orgId);
    const beforeOther = await sideEffectTotals(otherOrgId);
    await expect(
      deps.refunds.refundTender(deps.createTenantDb(otherOrgId), {
        originalTenderId: tenderId,
        amount: '1.00',
        reason: 'cross tenant',
        approvingStaffProfileId: ids.manager,
        actor: actor(),
        now: AT,
      })
    ).rejects.toMatchObject({ reason: 'TENDER_NOT_FOUND' });
    expect(await sideEffectTotals(orgId)).toEqual(beforeOwner);
    expect(await sideEffectTotals(otherOrgId)).toEqual(beforeOther);
  });

  it('serializes cumulative refunds so concurrent commands cannot over-refund', async () => {
    const { tenderId, paymentId } = await cardTenderAtBranchTwo();
    const attempts = await Promise.allSettled(
      ['race one', 'race two'].map((reason) =>
        deps.refunds.refundTender(deps.createTenantDb(orgId), {
          originalTenderId: tenderId,
          amount: '9.00',
          reason,
          branchId: ids.branchTwo,
          approvingStaffProfileId: ids.manager,
          actor: actor(branchTwoDeviceId),
          now: AT,
        })
      )
    );
    const fulfilled = attempts.filter((result) => result.status === 'fulfilled');
    const rejected = attempts.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      reason: 'REFUND_EXCEEDS_TENDER',
    });
    const evidence = await read(async (tx) => ({
      refunds: await tx.restaurantRefund.findMany({ where: { originalTenderId: tenderId } }),
      refundEvents: await tx.restaurantPaymentEvent.count({
        where: { paymentId, capability: 'REFUND' },
      }),
      taxAllocations: await tx.restaurantTaxRefundAllocation.findMany({
        where: { originalTenderId: tenderId },
      }),
    }));
    expect(evidence.refunds).toHaveLength(1);
    expect(evidence.refunds[0]!.amount.toString()).toBe('9');
    expect(evidence.refundEvents).toBe(1);
    expect(evidence.taxAllocations.length).toBeGreaterThan(0);
    expect(
      evidence.taxAllocations.reduce((total, row) => total + row.cents, BigInt(0))
    ).toBeGreaterThan(BigInt(0));
  });
});
