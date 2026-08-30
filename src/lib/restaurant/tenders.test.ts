/**
 * M5-L4 tenders — the named integration checks a real database establishes: cash
 * change + a net CASH_SALE drawer movement (open drawer required), card SALE through
 * the MOCK adapter with a tip, declined-SALE ATOMICITY (no tender/movement/payment/
 * receipt), split-tender exactness (Σ tenders ≡ the settled bill), over-tender
 * rejection, settle-exactly-once under concurrent final tenders (receipt allocated
 * once), and device-scoped idempotent replay.
 *
 * Requires TEST_DATABASE_URL (a migrated, unprivileged throwaway database — never
 * DATABASE_URL); without it the suite reports itself skipped. Money is asserted by
 * exact Decimal STRING equality (C2 — never epsilon/toBeCloseTo).
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { allocateTenderTaxCents, classifyTenderAmount } from './tenders';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

describe('bill-bound tender tax allocation', () => {
  it('reconciles a frozen bucket exactly across multiple original tenders', () => {
    const rows = allocateTenderTaxCents(new Prisma.Decimal('1.01'), [
      { tenderId: 'tender-a', principal: new Prisma.Decimal('1.00') },
      { tenderId: 'tender-b', principal: new Prisma.Decimal('1.00') },
      { tenderId: 'tender-c', principal: new Prisma.Decimal('1.00') },
    ]);

    expect(rows).toEqual([
      { originalTenderId: 'tender-a', cents: 34 },
      { originalTenderId: 'tender-b', cents: 34 },
      { originalTenderId: 'tender-c', cents: 33 },
    ]);
    expect(rows.reduce((total, row) => total + row.cents, 0)).toBe(101);
  });

  it('retains zero-cent facts so every frozen bucket remains bill/tender-bound', () => {
    expect(
      allocateTenderTaxCents(new Prisma.Decimal('0.00'), [
        { tenderId: 'tender-a', principal: new Prisma.Decimal('4.00') },
      ])
    ).toEqual([{ originalTenderId: 'tender-a', cents: 0 }]);
  });
});

const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha58t_${suffix}`;
const ids = {
  branch: `branch_${suffix}`,
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
  taxSource: `tax_source_${suffix}`,
  taxProfile: `tax_profile_${suffix}`,
  taxedProfile: `tax_profile_taxed_${suffix}`,
  taxedSource: `tax_source_taxed_${suffix}`,
};
const AT = new Date('2026-08-19T18:00:00.000Z');

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  enrollDevice: (typeof import('@/lib/restaurant/devices'))['enrollDevice'];
  orders: typeof import('@/lib/restaurant/orders');
  bills: typeof import('./bills');
  drawer: typeof import('./drawer-sessions');
  tenders: typeof import('./tenders');
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

/** Open an order with `count` burger items and cut one NONE bill; return its id +
 * grand total (12.50 per item). */
async function openBill(
  count: number
): Promise<{ orderId: string; billId: string; grandTotal: string }> {
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
    split: { kind: 'NONE' },
    actor: actor(),
  });
  const bill = await read((tx) =>
    tx.restaurantBill.findUnique({ where: { id: cut.billIds[0]! }, select: { grandTotal: true } })
  );
  return {
    orderId: opened.orderId,
    billId: cut.billIds[0]!,
    grandTotal: bill!.grandTotal.toString(),
  };
}

async function openDrawer(device = deviceId): Promise<string> {
  const opened = await deps.drawer.openDrawerSession(deps.createTenantDb(orgId), {
    organizationId: orgId,
    entitlementLimits: { 'pos.concurrentRegisters.max': 1000000 },
    branchId: ids.branch,
    openingFloat: '100.00',
    actor: actor(device),
    now: AT,
  });
  return opened.drawerSessionId;
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, devices, orders, bills, drawer, tenders] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/devices'),
    import('@/lib/restaurant/orders'),
    import('./bills'),
    import('./drawer-sessions'),
    import('./tenders'),
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
  };

  const runtimeRole = await deps.withPlatformDb(
    (tx) =>
      tx.$queryRaw<Array<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolcanlogin, rolsuper, rolbypassrls
      FROM pg_roles
      WHERE rolname = current_user
    `
  );
  expect(runtimeRole).toEqual([{ rolcanlogin: true, rolsuper: false, rolbypassrls: false }]);

  await deps.withPlatformDb((tx) =>
    tx.organization.create({
      data: {
        id: orgId,
        slug: `wha58t-${suffix}`,
        legalName: 'Tenders Test Co',
        displayName: 'Tenders Test',
        status: 'ACTIVE',
      },
    })
  );

  await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantBranch.create({
      data: { id: ids.branch, name: 'Main', timezone: 'UTC', businessDayCutoff: '00:00' },
    });
    await tx.restaurantTaxOfficialSource.create({
      data: {
        id: ids.taxSource,
        authorityCode: 'SYNTHETIC_TEST_ONLY',
        documentTitle: 'Synthetic zero-rate tender fixture',
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

describeIfDatabase('cash tenders (real DB)', () => {
  it('settles a bill with cash: change, a net CASH_SALE movement, and a receipt', async () => {
    const { billId, grandTotal } = await openBill(1); // 12.50
    const drawerId = await openDrawer();
    const db = deps.createTenantDb(orgId);
    const result = await deps.tenders.applyTender(db, {
      billId,
      tender: { type: 'CASH', amount: grandTotal, cashReceived: '20.00' },
      actor: actor(),
      now: AT,
    });
    expect(result.settled).toBe(true);
    expect(result.changeGiven?.toString()).toBe('7.5'); // 20.00 − 12.50
    expect(result.remainingDue.toString()).toBe('0');
    expect(result.receiptNumber).toBeGreaterThan(0);

    const tender = await read((tx) =>
      tx.restaurantTender.findUnique({
        where: { id: result.tenderId },
        select: {
          type: true,
          amount: true,
          cashReceived: true,
          changeGiven: true,
          drawerSessionId: true,
        },
      })
    );
    expect(tender).toMatchObject({ type: 'CASH', drawerSessionId: drawerId });
    expect(tender?.amount.toString()).toBe('12.5');
    expect(tender?.cashReceived?.toString()).toBe('20');

    // Exactly one CASH_SALE movement, linked to the tender, for the net amount.
    const movements = await read((tx) =>
      tx.restaurantDrawerMovement.findMany({
        where: { tenderId: result.tenderId, kind: 'CASH_SALE' },
        select: { amount: true },
      })
    );
    expect(movements).toHaveLength(1);
    expect(movements[0]!.amount.toString()).toBe('12.5');

    const bill = await read((tx) =>
      tx.restaurantBill.findUnique({
        where: { id: billId },
        select: { status: true, receiptNumber: true },
      })
    );
    expect(bill?.status).toBe('SETTLED');
    expect(bill?.receiptNumber).toBe(result.receiptNumber);
  });

  it('rejects a cash tender when the register has no open drawer', async () => {
    const { billId, grandTotal } = await openBill(1);
    const freshDevice = await newDevice('POS-nodrawer');
    await expect(
      deps.tenders.applyTender(deps.createTenantDb(orgId), {
        billId,
        tender: { type: 'CASH', amount: grandTotal, cashReceived: '20.00' },
        actor: actor(freshDevice),
        now: AT,
      })
    ).rejects.toMatchObject({ reason: 'DRAWER_NOT_OPEN' });
  });

  it('rejects insufficient cash', async () => {
    const { billId, grandTotal } = await openBill(1);
    const device = await newDevice('POS-shortcash');
    await openDrawer(device);
    await expect(
      deps.tenders.applyTender(deps.createTenantDb(orgId), {
        billId,
        tender: { type: 'CASH', amount: grandTotal, cashReceived: '10.00' },
        actor: actor(device),
        now: AT,
      })
    ).rejects.toMatchObject({ reason: 'INSUFFICIENT_CASH' });
  });
});

describeIfDatabase('card tenders + tips (real DB)', () => {
  it('settles with a card SALE through the MOCK adapter and records a tip', async () => {
    const { billId, grandTotal } = await openBill(1); // 12.50
    const db = deps.createTenantDb(orgId);
    const result = await deps.tenders.applyTender(db, {
      billId,
      tender: { type: 'CARD', amount: grandTotal, tipAmount: '2.00' },
      actor: actor(),
      now: AT,
    });
    expect(result.settled).toBe(true);
    expect(result.tipAmount.toString()).toBe('2');
    expect(result.paymentId).not.toBeNull();

    const payment = await read((tx) =>
      tx.restaurantPayment.findUnique({
        where: { id: result.paymentId! },
        select: {
          provider: true,
          capability: true,
          status: true,
          amount: true,
          tipAmount: true,
          providerRef: true,
          events: { select: { capability: true, eventType: true } },
        },
      })
    );
    expect(payment).toMatchObject({ provider: 'MOCK', capability: 'SALE', status: 'CAPTURED' });
    expect(payment?.amount.toString()).toBe('12.5');
    expect(payment?.tipAmount.toString()).toBe('2');
    expect(payment?.providerRef).toMatch(/^mock_sale_/);
    expect(payment?.events).toEqual([{ capability: 'SALE', eventType: 'SALE_APPROVED' }]);

    const tender = await read((tx) =>
      tx.restaurantTender.findUnique({
        where: { id: result.tenderId },
        select: { type: true, tipAmount: true, paymentId: true },
      })
    );
    expect(tender).toMatchObject({ type: 'CARD', paymentId: result.paymentId });
    expect(tender?.tipAmount.toString()).toBe('2');
  });

  it('a declined SALE leaves NO tender, movement, payment or receipt (atomicity)', async () => {
    const { billId } = await openBill(2); // 25.00
    await expect(
      deps.tenders.applyTender(deps.createTenantDb(orgId), {
        // .13 cents is a designated MOCK decline amount (< the 25.00 balance).
        billId,
        tender: { type: 'CARD', amount: '10.13' },
        actor: actor(),
        now: AT,
      })
    ).rejects.toMatchObject({ reason: 'CARD_DECLINED' });

    const counts = await read(async (tx) => ({
      tenders: await tx.restaurantTender.count({ where: { billId } }),
      payments: await tx.restaurantPayment.count({ where: { billId } }),
      events: await tx.restaurantPaymentEvent.count({ where: { payment: { billId } } }),
    }));
    expect(counts).toEqual({ tenders: 0, payments: 0, events: 0 });

    const bill = await read((tx) =>
      tx.restaurantBill.findUnique({
        where: { id: billId },
        select: { status: true, receiptNumber: true },
      })
    );
    expect(bill?.status).toBe('OPEN');
    expect(bill?.receiptNumber).toBeNull();
  });

  it('rejects an over-tender beyond the bill balance', async () => {
    const { billId } = await openBill(1); // 12.50
    await expect(
      deps.tenders.applyTender(deps.createTenantDb(orgId), {
        billId,
        tender: { type: 'CARD', amount: '20.00' },
        actor: actor(),
        now: AT,
      })
    ).rejects.toMatchObject({ reason: 'OVER_TENDER' });
  });
});

describeIfDatabase('split tenders + settlement exactness (real DB)', () => {
  it('accepts partial tenders and settles once Σ tenders ≡ the grand total', async () => {
    const { billId, grandTotal } = await openBill(2); // 25.00
    const drawerId = await openDrawer(await newDevice('POS-split'));
    const splitDevice = await read((tx) =>
      tx.restaurantDrawerSession.findUnique({ where: { id: drawerId }, select: { deviceId: true } })
    ).then((s) => s!.deviceId);

    const db = deps.createTenantDb(orgId);
    const partial = await deps.tenders.applyTender(db, {
      billId,
      tender: { type: 'CARD', amount: '10.00' },
      actor: actor(),
      now: AT,
    });
    expect(partial.settled).toBe(false);
    expect(partial.remainingDue.toString()).toBe('15');
    expect(
      await read((tx) => tx.restaurantTaxTransactionSnapshot.count({ where: { billId } }))
    ).toBe(0);

    const final = await deps.tenders.applyTender(db, {
      billId,
      tender: { type: 'CASH', amount: '15.00', cashReceived: '20.00' },
      actor: actor(splitDevice),
      now: AT,
    });
    expect(final.settled).toBe(true);
    expect(final.changeGiven?.toString()).toBe('5');
    expect(final.receiptNumber).toBeGreaterThan(0);

    // Σ applied tenders ≡ the settled bill's grand total, by exact string equality.
    const agg = await read((tx) =>
      tx.restaurantTender.aggregate({ where: { billId }, _sum: { amount: true } })
    );
    expect(agg._sum.amount?.toString()).toBe(grandTotal); // 25

    const frozen = await read(async (tx) => ({
      snapshots: await tx.restaurantTaxTransactionSnapshot.count({ where: { billId } }),
      allocations: await tx.restaurantTaxTenderAllocationSnapshot.findMany({
        where: { billId },
        select: { originalTenderId: true, paymentCategory: true, cents: true },
      }),
    }));
    expect(frozen.snapshots).toBe(1);
    expect(new Set(frozen.allocations.map((row) => row.originalTenderId))).toEqual(
      new Set([partial.tenderId, final.tenderId])
    );
    expect(
      frozen.allocations.every((row) =>
        row.originalTenderId === partial.tenderId
          ? row.paymentCategory === 'CARD'
          : row.paymentCategory === 'CASH'
      )
    ).toBe(true);
    expect(frozen.allocations.reduce((total, row) => total + row.cents, BigInt(0))).toBe(BigInt(0));
  });

  it('settles exactly once under concurrent final tenders (receipt allocated once)', async () => {
    const { billId } = await openBill(1); // 12.50 — both racers pay it in full
    const results = await Promise.allSettled([
      deps.tenders.applyTender(deps.createTenantDb(orgId), {
        billId,
        tender: { type: 'CARD', amount: '12.50' },
        actor: actor(deviceId, key()),
        now: AT,
      }),
      deps.tenders.applyTender(deps.createTenantDb(orgId), {
        billId,
        tender: { type: 'CARD', amount: '12.50' },
        actor: actor(deviceId, key()),
        now: AT,
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      reason: 'BILL_NOT_OPEN',
    });

    // Exactly one tender and one receipt survived.
    const tenderCount = await read((tx) => tx.restaurantTender.count({ where: { billId } }));
    expect(tenderCount).toBe(1);
    const bill = await read((tx) =>
      tx.restaurantBill.findUnique({
        where: { id: billId },
        select: { status: true, receiptNumber: true },
      })
    );
    expect(bill?.status).toBe('SETTLED');
    expect(bill?.receiptNumber).toBeGreaterThan(0);
  });

  it('reconciles non-zero mixed partial/final tax cents by original tender and category', async () => {
    await read(async (tx) => {
      await tx.restaurantTaxOfficialSource.create({
        data: {
          id: ids.taxedSource,
          authorityCode: 'SYNTHETIC_TAXED_TEST_ONLY',
          documentTitle: 'Synthetic taxed tender fixture',
          sourceUrl: 'https://example.invalid/synthetic-taxed',
          contentHash: `synthetic-taxed-${suffix}`,
          retrievedAt: new Date('2026-07-01T00:00:00.000Z'),
          expiresAt: new Date('2027-07-01T00:00:00.000Z'),
        },
      });
      await tx.restaurantTaxProfileVersion.create({
        data: {
          id: ids.taxedProfile,
          branchId: ids.branch,
          versionNumber: 2,
          status: 'PUBLISHED',
          effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
          effectiveTo: new Date('2026-08-01T00:00:00.000Z'),
          approvalReference: 'SYNTHETIC_TAXED_APPROVAL',
          approvedAt: new Date('2026-07-01T00:00:00.000Z'),
          publishedAt: new Date('2026-07-01T00:00:00.000Z'),
          rules: {
            create: (['CASH', 'CARD', 'OTHER'] as const).map((paymentCategory) => ({
              officialSourceId: ids.taxedSource,
              ruleCode: `SYNTHETIC_TAXED_${paymentCategory}`,
              paymentCategory,
              priceMode: 'EXCLUSIVE',
              rate: '0.100000',
              status: 'PUBLISHED',
              effectiveFrom: new Date('2026-07-01T00:00:00.000Z'),
              effectiveTo: new Date('2026-08-01T00:00:00.000Z'),
              approvalReference: 'SYNTHETIC_TAXED_APPROVAL',
              approvedAt: new Date('2026-07-01T00:00:00.000Z'),
              publishedAt: new Date('2026-07-01T00:00:00.000Z'),
            })),
          },
        },
      });
    });

    const { billId } = await openBill(1);
    const db = deps.createTenantDb(orgId);
    const at = new Date('2026-07-15T18:00:00.000Z');
    const partial = await deps.tenders.applyTender(db, {
      billId,
      tender: { type: 'CARD', amount: '5.00' },
      actor: actor(),
      now: at,
    });
    const final = await deps.tenders.applyTender(db, {
      billId,
      tender: { type: 'OTHER', amount: '8.75' },
      actor: actor(),
      now: at,
    });
    expect(partial).toMatchObject({ settled: false });
    expect(final).toMatchObject({ settled: true });

    const evidence = await read(async (tx) => ({
      snapshot: await tx.restaurantTaxTransactionSnapshot.findFirstOrThrow({
        where: { billId },
        select: { id: true, taxTotal: true },
      }),
      bucket: await tx.restaurantTaxRateBucketSnapshot.findFirstOrThrow({
        where: { snapshot: { billId } },
        select: { id: true },
      }),
      allocations: await tx.restaurantTaxTenderAllocationSnapshot.findMany({
        where: { billId },
        orderBy: { paymentCategory: 'asc' },
        select: { originalTenderId: true, paymentCategory: true, cents: true },
      }),
    }));
    expect(evidence.snapshot.taxTotal.toString()).toBe('1.25');
    expect(evidence.allocations).toEqual([
      { originalTenderId: partial.tenderId, paymentCategory: 'CARD', cents: BigInt(50) },
      { originalTenderId: final.tenderId, paymentCategory: 'OTHER', cents: BigInt(75) },
    ]);

    const wrongBill = await openBill(1);
    const wrongBillTender = await read((tx) =>
      tx.restaurantTender.create({
        data: {
          billId: wrongBill.billId,
          type: 'CARD',
          amount: '1.00',
          businessDate: AT,
          staffProfileId: ids.operator,
          deviceId,
        },
        select: { id: true },
      })
    );
    const base = {
      snapshotId: evidence.snapshot.id,
      rateBucketSnapshotId: evidence.bucket.id,
      originalTenderId: wrongBillTender.id,
      paymentCategory: 'CARD' as const,
      cents: BigInt(0),
    };
    await expect(
      read((tx) =>
        tx.restaurantTaxTenderAllocationSnapshot.create({
          data: { ...base, id: `wrong_bill_app_${suffix}`, billId: wrongBill.billId },
        })
      )
    ).rejects.toThrow();
    await expect(
      read((tx) =>
        tx.restaurantTaxTenderAllocationSnapshot.create({
          data: {
            ...base,
            id: `cross_tenant_app_${suffix}`,
            organizationId: `org_foreign_${suffix}`,
            billId,
          },
        })
      )
    ).rejects.toThrow();
    await expect(
      read(
        (tx) =>
          tx.$executeRaw`INSERT INTO restaurant_tax_tender_allocation_snapshots
          (id, "organizationId", "snapshotId", "billId", "rateBucketSnapshotId",
           "originalTenderId", "paymentCategory", cents)
          VALUES (${`wrong_bill_db_${suffix}`}, ${orgId}, ${evidence.snapshot.id},
            ${wrongBill.billId}, ${evidence.bucket.id}, ${wrongBillTender.id}, 'CARD', 0)`
      )
    ).rejects.toThrow();
    await expect(
      read(
        (tx) =>
          tx.$executeRaw`INSERT INTO restaurant_tax_tender_allocation_snapshots
          (id, "organizationId", "snapshotId", "billId", "rateBucketSnapshotId",
           "originalTenderId", "paymentCategory", cents)
          VALUES (${`cross_tenant_db_${suffix}`}, ${`org_foreign_${suffix}`},
            ${evidence.snapshot.id}, ${billId}, ${evidence.bucket.id},
            ${partial.tenderId}, 'CARD', 0)`
      )
    ).rejects.toThrow();
  });

  it('fails closed before writing a new tender when no tax profile is configured', async () => {
    const { billId } = await openBill(1);
    await expect(
      deps.tenders.applyTender(deps.createTenantDb(orgId), {
        billId,
        tender: { type: 'CARD', amount: '12.50' },
        actor: actor(),
        now: new Date('2025-01-01T00:00:00.000Z'),
      })
    ).rejects.toMatchObject({ reason: 'MISSING' });
    expect(await read((tx) => tx.restaurantTender.count({ where: { billId } }))).toBe(0);
  });
});

describeIfDatabase('idempotency (real DB)', () => {
  it('replays a tender: the same device key returns the original and creates nothing', async () => {
    const { billId } = await openBill(1);
    const db = deps.createTenantDb(orgId);
    const reuse = actor();
    const first = await deps.tenders.applyTender(db, {
      billId,
      tender: { type: 'CARD', amount: '12.50' },
      actor: reuse,
      now: AT,
    });
    const replay = await deps.tenders.applyTender(db, {
      billId,
      tender: { type: 'CARD', amount: '12.50' },
      actor: reuse,
      // The source fixture has expired by then. Replay must return frozen payload
      // before any current profile/source lookup.
      now: new Date('2030-08-19T18:00:00.000Z'),
    });
    expect(replay.replayed).toBe(true);
    expect(replay.tenderId).toBe(first.tenderId);
    expect(replay.settled).toBe(true);

    const tenderCount = await read((tx) => tx.restaurantTender.count({ where: { billId } }));
    expect(tenderCount).toBe(1);
  });

  it('fails closed when the same key is reused with a conflicting payload', async () => {
    const { billId } = await openBill(1);
    const db = deps.createTenantDb(orgId);
    const reuse = actor();
    await deps.tenders.applyTender(db, {
      billId,
      tender: { type: 'CARD', amount: '5.00' },
      actor: reuse,
      now: AT,
    });

    await expect(
      deps.tenders.applyTender(db, {
        billId,
        tender: { type: 'CARD', amount: '4.00' },
        actor: reuse,
        now: AT,
      })
    ).rejects.toMatchObject({ reason: 'TAX_SETTLEMENT_CONFLICT' });
    expect(await read((tx) => tx.restaurantTender.count({ where: { billId } }))).toBe(1);
  });

  it('uses legacy replay fallback without a live profile or tax-source lookup', async () => {
    const { billId } = await openBill(1);
    const firstRun = actor();
    const first = await deps.tenders.applyTender(deps.createTenantDb(orgId), {
      billId,
      tender: { type: 'CARD', amount: '12.50' },
      actor: firstRun,
      now: AT,
    });
    const reuse = actor();
    await read((tx) =>
      tx.restaurantMoneyIdempotencyKey.create({
        data: {
          deviceId: reuse.deviceId,
          key: reuse.idempotencyKey,
          commandType: 'tender.card',
          resultRef: first.tenderId,
        },
      })
    );

    const replay = await deps.tenders.applyTender(deps.createTenantDb(orgId), {
      billId,
      tender: { type: 'CARD', amount: '12.50' },
      actor: reuse,
      now: new Date('2030-08-19T18:00:00.000Z'),
    });
    expect(replay).toMatchObject({
      tenderId: first.tenderId,
      billId,
      type: 'CARD',
      settled: true,
      receiptNumber: first.receiptNumber,
      replayed: true,
    });
    expect(replay.amount.toString()).toBe('12.5');
    expect(replay.remainingDue.toString()).toBe('0');
  });

  it('rejects a cross-command legacy key before replay or live bill/configuration writes', async () => {
    const { billId } = await openBill(1);
    const firstRun = actor();
    const first = await deps.tenders.applyTender(deps.createTenantDb(orgId), {
      billId,
      tender: { type: 'CARD', amount: '12.50' },
      actor: firstRun,
      now: AT,
    });
    const reuse = actor();
    await read((tx) =>
      tx.restaurantMoneyIdempotencyKey.create({
        data: {
          deviceId: reuse.deviceId,
          key: reuse.idempotencyKey,
          commandType: 'cash.day_close',
          resultRef: first.tenderId,
        },
      })
    );
    const before = await read(async (tx) => ({
      tenders: await tx.restaurantTender.count(),
      idempotencyKeys: await tx.restaurantMoneyIdempotencyKey.count(),
    }));

    await expect(
      deps.tenders.applyTender(deps.createTenantDb(orgId), {
        billId: `missing_${suffix}`,
        tender: { type: 'CARD', amount: '12.50' },
        actor: reuse,
        now: new Date('2030-08-19T18:00:00.000Z'),
      })
    ).rejects.toMatchObject({ reason: 'TAX_SETTLEMENT_CONFLICT' });
    expect(
      await read(async (tx) => ({
        tenders: await tx.restaurantTender.count(),
        idempotencyKeys: await tx.restaurantMoneyIdempotencyKey.count(),
      }))
    ).toEqual(before);
  });
});

const d = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

// A pure, DB-free classification of a tender's applied amount against the bill's
// outstanding balance — the guard that lets a ZERO amount settle an already
// fully-covered (e.g. fully comped, zero grand-total) bill while still rejecting a
// zero amount on any bill that still owes a balance. No TEST_DATABASE_URL needed.
describe('classifyTenderAmount (M5-L2 — zero tender settles a fully-covered bill)', () => {
  it('accepts a zero amount when the bill is already fully covered (outstanding 0) — the comp-settlement path', () => {
    expect(classifyTenderAmount(d('0'), d('0'))).toBe('OK');
    expect(classifyTenderAmount(d('0.00'), d('0.00'))).toBe('OK');
  });

  it('rejects a zero amount when the bill still owes a balance', () => {
    expect(classifyTenderAmount(d('0'), d('5.00'))).toBe('INVALID_AMOUNT');
    expect(classifyTenderAmount(d('0.00'), d('0.01'))).toBe('INVALID_AMOUNT');
  });

  it('rejects a negative amount regardless of outstanding', () => {
    expect(classifyTenderAmount(d('-0.01'), d('5.00'))).toBe('INVALID_AMOUNT');
    expect(classifyTenderAmount(d('-5.00'), d('0'))).toBe('INVALID_AMOUNT');
  });

  it('accepts a positive amount that is less than the outstanding balance', () => {
    expect(classifyTenderAmount(d('2.50'), d('5.00'))).toBe('OK');
  });

  it('accepts a positive amount that exactly equals the outstanding balance (final tender)', () => {
    expect(classifyTenderAmount(d('5.00'), d('5.00'))).toBe('OK');
  });

  it('flags a positive amount greater than the outstanding balance as OVER_TENDER', () => {
    expect(classifyTenderAmount(d('5.01'), d('5.00'))).toBe('OVER_TENDER');
    expect(classifyTenderAmount(d('0.01'), d('0'))).toBe('OVER_TENDER');
  });
});
