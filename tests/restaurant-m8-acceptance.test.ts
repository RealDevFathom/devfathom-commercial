/** WHA-100: independent M8 API, reconciliation, privacy, and loyalty battery. */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { Action } from '@/lib/abac';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '@/server/trpc';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn(async () => null) }));

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha100_${suffix}`;
const otherOrgId = `org_wha100_other_${suffix}`;
const M5_AT = new Date('2099-08-21T12:00:00.000Z');
const ROLLUP_AT = new Date('2099-08-22T12:00:00.000Z');
const BUSINESS_DATE = '2099-08-21';
const ROLLUP_DATE = '2099-08-22';
const modules = ['restaurant-customers', 'restaurant-loyalty', 'restaurant-insights'];
const grants = [
  'customers:read',
  'restaurant:configure',
  'loyalty:redeem',
  'reports:operational',
  'reports:financial',
  'workforce:rates',
] as const satisfies readonly Action[];
const ids = {
  branch: `branch_${suffix}`,
  branchTwo: `branch_two_${suffix}`,
  category: `category_${suffix}`,
  manager: `manager_${suffix}`,
  menu: `menu_${suffix}`,
  menuItem: `menu_item_${suffix}`,
  operator: `operator_${suffix}`,
  otherRole: `other_role_${suffix}`,
  otherUser: `other_user_${suffix}`,
  priceList: `price_list_${suffix}`,
  priceVersion: `price_version_${suffix}`,
  product: `product_${suffix}`,
  productStale: `product_stale_${suffix}`,
  publication: `publication_${suffix}`,
  role: `role_${suffix}`,
  section: `section_${suffix}`,
  user: `user_${suffix}`,
};

type CustomersCaller = ReturnType<
  (typeof import('@/server/routers/restaurant-customers'))['restaurantCustomersRouter']['createCaller']
>;
type LoyaltyCaller = ReturnType<
  (typeof import('@/server/routers/restaurant-loyalty'))['restaurantLoyaltyRouter']['createCaller']
>;
type InsightsCaller = ReturnType<
  (typeof import('@/server/routers/restaurant-insights'))['restaurantInsightsRouter']['createCaller']
>;
type Api = {
  restaurantCustomers: CustomersCaller;
  restaurantInsights: InsightsCaller;
  restaurantLoyalty: LoyaltyCaller;
};
type Deps = {
  abac: typeof import('@/lib/abac');
  audit: typeof import('@/server/audit');
  bills: typeof import('@/lib/restaurant/bills');
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  dailyClose: typeof import('@/lib/restaurant/daily-close');
  devices: typeof import('@/lib/restaurant/devices');
  expiry: typeof import('@/lib/restaurant/loyalty-expiry');
  orders: typeof import('@/lib/restaurant/orders');
  refunds: typeof import('@/lib/restaurant/refunds');
  rollups: typeof import('@/lib/restaurant/insight-rollups');
  scheduler: typeof import('@/lib/restaurant/scheduler');
  tenders: typeof import('@/lib/restaurant/tenders');
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
};

let deps: Deps;
let api: Api;
let deviceId = '';
let programId = '';
let sequence = 0;
let makeCaller: (organizationId?: string, enabledModules?: string[], limit?: number) => Api;
const key = (label: string) => `wha100_${suffix}_${label}_${++sequence}`;
const D = (value: string | number | Prisma.Decimal) => new Prisma.Decimal(value);
const sumDecimals = (values: readonly Prisma.Decimal[]) =>
  values.reduce((total, value) => total.plus(value), D(0));
const actor = (idempotencyKey = key('money')) => ({
  staffProfileId: ids.operator,
  deviceId,
  idempotencyKey,
});
const tenant = <T>(work: (tx: ScopedDb) => Promise<T>, organizationId = orgId) =>
  deps.withTenantDb(organizationId, work);

async function setGrants(next: readonly Action[]) {
  await tenant(async (tx) => {
    await tx.organizationRolePermission.deleteMany({ where: { organizationRoleId: ids.role } });
    if (next.length) {
      await tx.organizationRolePermission.createMany({
        data: next.map((capability) => ({
          organizationId: orgId,
          organizationRoleId: ids.role,
          capability,
          effect: 'ALLOW' as const,
        })),
      });
    }
  });
}

async function customer(label: string, organizationId = orgId) {
  return makeCaller(organizationId).restaurantCustomers.create({
    displayName: label,
    identifiers: [{ kind: 'EMAIL', value: `${label}.${suffix}@example.com` }],
  });
}

async function seedBill(input: {
  customerId?: string;
  orderStatus: 'OPEN' | 'CLOSED' | 'CANCELLED';
  billStatus: 'OPEN' | 'SETTLED';
  total: string;
}) {
  return tenant(async (tx) => {
    const order = await tx.restaurantOrder.create({
      data: {
        branchId: ids.branch,
        orderNumber: ++sequence,
        businessDate: new Date(`${BUSINESS_DATE}T00:00:00.000Z`),
        status: input.orderStatus,
        channel: 'DINE_IN',
        coverCount: 1,
        staffProfileId: ids.operator,
        deviceId,
        customerId: input.customerId,
        closedAt: input.orderStatus === 'CLOSED' ? M5_AT : null,
        cancelledAt: input.orderStatus === 'CANCELLED' ? M5_AT : null,
      },
    });
    const bill = await tx.restaurantBill.create({
      data: {
        orderId: order.id,
        branchId: ids.branch,
        businessDate: new Date(`${BUSINESS_DATE}T00:00:00.000Z`),
        status: input.billStatus,
        subtotal: input.total,
        grandTotal: input.total,
        settledAt: input.billStatus === 'SETTLED' ? M5_AT : null,
        openerStaffProfileId: ids.operator,
        deviceId,
      },
    });
    return { order, bill };
  });
}

async function cardBill(customerId: string) {
  const db = deps.createTenantDb(orgId);
  const opened = await deps.orders.openOrder(db, {
    branchId: ids.branch,
    channel: 'DINE_IN',
    publicationId: ids.publication,
    actor: actor(),
    now: M5_AT,
  });
  await tenant((tx) =>
    tx.restaurantOrder.update({ where: { id: opened.orderId }, data: { customerId } })
  );
  const added = await deps.orders.addItem(db, {
    orderId: opened.orderId,
    menuItemId: ids.menuItem,
    actor: actor(),
  });
  await deps.orders.sendOrder(db, { orderId: opened.orderId, actor: actor() });
  for (const toStatus of ['FIRING', 'PREPARED', 'SERVED'] as const) {
    await deps.orders.advanceItem(db, {
      orderId: opened.orderId,
      itemId: added.itemId,
      toStatus,
      actor: actor(),
    });
  }
  await deps.orders.closeOrder(db, { orderId: opened.orderId, actor: actor() });
  const cut = await deps.bills.cutBills(db, {
    orderId: opened.orderId,
    split: { kind: 'NONE' },
    actor: actor(),
  });
  const billId = cut.billIds[0];
  if (!billId) throw new Error('Bill cut returned no bill.');
  const paid = await deps.tenders.applyTender(db, {
    billId,
    tender: { type: 'CARD', amount: '12.50', tipAmount: '0.00' },
    actor: actor(),
    now: M5_AT,
  });
  if (!paid.paymentId) throw new Error('Card tender returned no payment.');
  return {
    billId,
    itemId: added.itemId,
    orderId: opened.orderId,
    tenderId: paid.tenderId,
    paymentId: paid.paymentId,
  };
}

async function seedRollupRaw() {
  const date = new Date(`${ROLLUP_DATE}T00:00:00.000Z`);
  return tenant(async (tx) => {
    const order = await tx.restaurantOrder.create({
      data: {
        branchId: ids.branch,
        orderNumber: ++sequence,
        businessDate: date,
        status: 'CLOSED',
        channel: 'DINE_IN',
        coverCount: 2,
        staffProfileId: ids.operator,
        deviceId,
        closedAt: ROLLUP_AT,
      },
    });
    const item = await tx.restaurantOrderItem.create({
      data: {
        orderId: order.id,
        productId: ids.product,
        name: 'Burger',
        unitPrice: '10.00',
        quantity: 2,
        status: 'SERVED',
      },
    });
    await tx.restaurantOrderItemModifier.create({
      data: { orderItemId: item.id, name: 'Extra', priceDelta: '1.00' },
    });
    const staleItem = await tx.restaurantOrderItem.create({
      data: {
        orderId: order.id,
        productId: ids.productStale,
        name: 'Stale side',
        unitPrice: '5.00',
        quantity: 1,
        status: 'SERVED',
      },
    });
    const bill = await tx.restaurantBill.create({
      data: {
        orderId: order.id,
        branchId: ids.branch,
        businessDate: date,
        status: 'SETTLED',
        subtotal: '27.00',
        taxTotal: '1.00',
        serviceChargeTotal: '2.00',
        compTotal: '2.00',
        discountTotal: '1.00',
        grandTotal: '27.00',
        settledAt: ROLLUP_AT,
        openerStaffProfileId: ids.operator,
        deviceId,
      },
    });
    const line = await tx.restaurantBillLine.create({
      data: {
        billId: bill.id,
        orderItemId: item.id,
        name: 'Burger',
        quantity: 2,
        unitPrice: '10.00',
        lineSubtotal: '22.00',
        compAmount: '2.00',
        lineTotal: '20.00',
      },
    });
    await tx.restaurantBillLine.create({
      data: {
        billId: bill.id,
        orderItemId: staleItem.id,
        name: 'Stale side',
        quantity: 1,
        unitPrice: '5.00',
        lineSubtotal: '5.00',
        lineTotal: '5.00',
      },
    });
    const tender = await tx.restaurantTender.create({
      data: {
        billId: bill.id,
        type: 'CARD',
        amount: '27.00',
        tipAmount: '3.00',
        businessDate: date,
        staffProfileId: ids.operator,
        deviceId,
      },
    });
    const coAuth = await tx.restaurantCoAuthorization.create({
      data: {
        actingStaffProfileId: ids.operator,
        approvingStaffProfileId: ids.manager,
        capability: 'payments:refund',
        reason: 'rollup fixture',
      },
    });
    await tx.restaurantRefund.create({
      data: {
        originalTenderId: tender.id,
        billId: bill.id,
        amount: '4.00',
        kind: 'REFUND',
        businessDate: date,
        reason: 'rollup fixture',
        coAuthorizationId: coAuth.id,
        staffProfileId: ids.operator,
        deviceId,
      },
    });
    const voidOrder = await tx.restaurantOrder.create({
      data: {
        branchId: ids.branch,
        orderNumber: ++sequence,
        businessDate: date,
        status: 'CLOSED',
        channel: 'TAKEAWAY',
        coverCount: 0,
        staffProfileId: ids.operator,
        deviceId,
        closedAt: ROLLUP_AT,
      },
    });
    await tx.restaurantBill.create({
      data: {
        orderId: voidOrder.id,
        branchId: ids.branch,
        businessDate: date,
        status: 'VOID',
        subtotal: '5.00',
        grandTotal: '5.00',
        openerStaffProfileId: ids.operator,
        deviceId,
      },
    });
    const drawer = await tx.restaurantDrawerSession.create({
      data: {
        branchId: ids.branch,
        deviceId,
        staffProfileId: ids.operator,
        businessDate: date,
        status: 'CLOSED',
        openedAt: new Date('2099-08-22T08:00:00.000Z'),
        closedAt: ROLLUP_AT,
        openingFloat: '100.00',
        expectedCash: '120.00',
        countedCash: '119.00',
        variance: '-1.00',
      },
    });
    await tx.restaurantDrawerMovement.createMany({
      data: [
        {
          drawerSessionId: drawer.id,
          kind: 'OPENING_FLOAT',
          amount: '100.00',
          staffProfileId: ids.operator,
          deviceId,
        },
        {
          drawerSessionId: drawer.id,
          kind: 'CASH_SALE',
          amount: '20.00',
          staffProfileId: ids.operator,
          deviceId,
        },
      ],
    });
    return { billId: bill.id, drawerId: drawer.id, lineId: line.id, staleItemId: staleItem.id };
  });
}

async function readRollupOracle() {
  const businessDate = new Date(`${ROLLUP_DATE}T00:00:00.000Z`);
  return tenant(async (tx) => {
    const [closes, bills, tenders, refunds, drawers, orders, ledger] = await Promise.all([
      tx.restaurantDailyClose.findMany({
        where: { branchId: ids.branch, businessDate },
        orderBy: { createdAt: 'asc' },
      }),
      tx.restaurantBill.findMany({ where: { branchId: ids.branch, businessDate } }),
      tx.restaurantTender.findMany({
        where: { businessDate, bill: { branchId: ids.branch } },
      }),
      tx.restaurantRefund.findMany({
        where: { businessDate, bill: { branchId: ids.branch } },
      }),
      tx.restaurantDrawerSession.findMany({
        where: { branchId: ids.branch, businessDate },
        include: { movements: true },
      }),
      tx.restaurantOrder.findMany({
        where: { branchId: ids.branch, businessDate, status: 'CLOSED' },
        include: {
          items: {
            where: { status: { not: 'VOIDED' } },
            include: {
              modifiers: true,
              billLines: { where: { bill: { status: 'SETTLED' } } },
            },
          },
        },
      }),
      tx.loyaltyPointsEntry.findMany({ select: { accountId: true, points: true } }),
    ]);
    const superseded = new Set(
      closes.flatMap((close) => (close.supersedesCloseId ? [close.supersedesCloseId] : []))
    );
    const close = closes.find((candidate) => !superseded.has(candidate.id));
    if (!close) throw new Error('Rollup oracle found no close-chain tip.');
    const program = await tx.loyaltyProgramVersion.findFirst({
      where: { effectiveFrom: { lte: close.createdAt } },
      orderBy: { effectiveFrom: 'desc' },
    });
    const settled = bills.filter((bill) => bill.status === 'SETTLED');
    const grossSales = sumDecimals(settled.map((bill) => bill.subtotal));
    const compTotal = sumDecimals(settled.map((bill) => bill.compTotal));
    const discountTotal = sumDecimals(settled.map((bill) => bill.discountTotal));
    const expectedCash = sumDecimals(
      drawers.flatMap((drawer) =>
        drawer.movements.map((movement) => {
          const sign =
            movement.kind === 'CASH_REFUND' ||
            movement.kind === 'PAID_OUT' ||
            movement.kind === 'DROP'
              ? -1
              : movement.kind === 'CLOSING_COUNT'
                ? 0
                : 1;
          return movement.amount.times(sign);
        })
      )
    );
    const countedCash = sumDecimals(drawers.map((drawer) => drawer.countedCash ?? D(0)));
    const itemMix = new Map<
      string,
      {
        compTotal: Prisma.Decimal;
        grossSales: Prisma.Decimal;
        netSales: Prisma.Decimal;
        quantity: number;
      }
    >();
    for (const order of orders) {
      for (const item of order.items) {
        const gross = item.unitPrice
          .plus(sumDecimals(item.modifiers.map((modifier) => modifier.priceDelta)))
          .times(item.quantity);
        const comp = sumDecimals(item.billLines.map((line) => line.compAmount));
        const prior = itemMix.get(item.productId) ?? {
          compTotal: D(0),
          grossSales: D(0),
          netSales: D(0),
          quantity: 0,
        };
        prior.quantity += item.quantity;
        prior.grossSales = prior.grossSales.plus(gross);
        prior.compTotal = prior.compTotal.plus(comp);
        prior.netSales = prior.netSales.plus(gross.minus(comp));
        itemMix.set(item.productId, prior);
      }
    }
    const balances = new Map<string, number>();
    for (const entry of ledger) {
      balances.set(entry.accountId, (balances.get(entry.accountId) ?? 0) + entry.points);
    }
    const loyaltyLiability = sumDecimals(
      [...balances.values()]
        .filter((balance) => balance > 0)
        .map((balance) => D(balance).times(program?.redemptionValue ?? D(0)))
    ).toDecimalPlaces(2);
    return {
      close,
      compTotal,
      coverCount: orders.reduce((total, order) => total + (order.coverCount ?? 0), 0),
      drawerVariance: countedCash.minus(expectedCash),
      grossSales,
      itemMix: [...itemMix.entries()]
        .map(([productId, values]) => ({ productId, ...values }))
        .sort((left, right) => left.productId.localeCompare(right.productId)),
      loyaltyLiability,
      netSales: grossSales.minus(compTotal).minus(discountTotal),
      orderCount: orders.length,
      refundTotal: sumDecimals(refunds.map((refund) => refund.amount)),
      tipTotal: sumDecimals(tenders.map((tender) => tender.tipAmount)),
      voidTotal: sumDecimals(
        bills.filter((bill) => bill.status === 'VOID').map((bill) => bill.grandTotal)
      ),
    };
  });
}

describeDb('WHA-100 restaurant M8 acceptance', () => {
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ROLLUP_AT);
    const scoped = await import('@/lib/tenancy/scoped-db');
    const [
      abac,
      audit,
      bills,
      dailyClose,
      devices,
      expiry,
      orders,
      refunds,
      rollups,
      scheduler,
      tenders,
    ] = await Promise.all([
      import('@/lib/abac'),
      import('@/server/audit'),
      import('@/lib/restaurant/bills'),
      import('@/lib/restaurant/daily-close'),
      import('@/lib/restaurant/devices'),
      import('@/lib/restaurant/loyalty-expiry'),
      import('@/lib/restaurant/orders'),
      import('@/lib/restaurant/refunds'),
      import('@/lib/restaurant/insight-rollups'),
      import('@/lib/restaurant/scheduler'),
      import('@/lib/restaurant/tenders'),
    ]);
    deps = {
      ...scoped,
      abac,
      audit,
      bills,
      dailyClose,
      devices,
      expiry,
      orders,
      refunds,
      rollups,
      scheduler,
      tenders,
    };
    const role = await scoped.withPlatformDb(
      (tx) => tx.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
      `
    );
    if (role[0]?.rolsuper || role[0]?.rolbypassrls) {
      throw new Error('WHA-100 requires an unprivileged NOBYPASSRLS TEST_DATABASE_URL role.');
    }
    await scoped.withPlatformDb((tx) =>
      tx.organization.createMany({
        data: [
          {
            id: orgId,
            slug: `wha100-${suffix}`,
            legalName: 'WHA-100 Acceptance',
            displayName: 'WHA-100 Acceptance',
            status: 'ACTIVE',
          },
          {
            id: otherOrgId,
            slug: `wha100-other-${suffix}`,
            legalName: 'WHA-100 Other',
            displayName: 'WHA-100 Other',
            status: 'ACTIVE',
          },
        ],
      })
    );
    await tenant(async (tx) => {
      await tx.organizationRole.create({
        data: {
          id: ids.role,
          key: `wha100_${suffix}`,
          name: 'WHA-100 acceptance',
          permissions: {
            create: grants.map((capability) => ({ capability, effect: 'ALLOW' as const })),
          },
        },
      });
      await tx.restaurantBranch.createMany({
        data: [
          { id: ids.branch, name: 'Main', timezone: 'Asia/Karachi', businessDayCutoff: '00:00' },
          { id: ids.branchTwo, name: 'Other', timezone: 'UTC', businessDayCutoff: '00:00' },
        ],
      });
      await tx.user.create({
        data: {
          id: ids.user,
          name: 'WHA Operator',
          email: `wha100-${suffix}@example.test`,
          department: 'QUALITY',
          title: 'Operator',
          role: 'ADMIN',
          status: 'ACTIVE',
          organizationRoleId: ids.role,
        },
      });
      await tx.restaurantStaffProfile.createMany({
        data: [
          {
            id: ids.operator,
            userId: ids.user,
            displayName: 'Operator',
            primaryBranchId: ids.branch,
            status: 'ACTIVE',
          },
          {
            id: ids.manager,
            displayName: 'Manager',
            primaryBranchId: ids.branch,
            status: 'ACTIVE',
          },
        ],
      });
      deviceId = (await devices.enrollDevice(tx, { branchId: ids.branch, name: 'POS-1' })).device
        .id;
      await tx.restaurantCategory.create({ data: { id: ids.category, name: 'Mains' } });
      await tx.restaurantProduct.create({
        data: { id: ids.product, name: 'Burger', categoryId: ids.category },
      });
      await tx.restaurantProduct.create({
        data: { id: ids.productStale, name: 'Stale side', categoryId: ids.category },
      });
      await tx.restaurantKitchenStation.create({
        data: { branchId: ids.branch, name: 'Kitchen', isDefault: true },
      });
      const brand = await tx.restaurantBrand.create({ data: { name: 'WHA Brand' } });
      await tx.restaurantMenu.create({
        data: { id: ids.menu, brandId: brand.id, name: 'All Day' },
      });
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
          effectiveFrom: new Date('2099-01-01T00:00:00.000Z'),
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
      programId = (
        await tx.loyaltyProgramVersion.create({
          data: {
            versionNumber: 1,
            effectiveFrom: new Date('2099-01-01T00:00:00.000Z'),
            earnRate: '1',
            redemptionValue: '0.05',
            expiryDays: 30,
          },
        })
      ).id;
    });
    await tenant(async (tx) => {
      await tx.organizationRole.create({
        data: {
          id: ids.otherRole,
          key: `wha100_other_${suffix}`,
          name: 'WHA-100 other acceptance',
          permissions: { create: [{ capability: 'customers:read', effect: 'ALLOW' }] },
        },
      });
      await tx.user.create({
        data: {
          id: ids.otherUser,
          name: 'Other operator',
          email: `wha100-other-${suffix}@example.test`,
          department: 'QUALITY',
          title: 'Operator',
          role: 'ADMIN',
          status: 'ACTIVE',
          organizationRoleId: ids.otherRole,
        },
      });
    }, otherOrgId);
    const trpc = await import('@/server/trpc');
    const [customers, loyaltyRouter, insights] = await Promise.all([
      import('@/server/routers/restaurant-customers'),
      import('@/server/routers/restaurant-loyalty'),
      import('@/server/routers/restaurant-insights'),
    ]);
    const acceptanceRouter = trpc.router({
      restaurantCustomers: customers.restaurantCustomersRouter,
      restaurantLoyalty: loyaltyRouter.restaurantLoyaltyRouter,
      restaurantInsights: insights.restaurantInsightsRouter,
    });
    makeCaller = (organizationId = orgId, enabledModules = modules, limit = 100) => {
      const userId = organizationId === orgId ? ids.user : ids.otherUser;
      const context: TRPCContext = {
        db: scoped.createTenantDb(organizationId),
        entitlements: {
          organizationId,
          enabledModules,
          activeSeats: 1,
          seatLimit: 50,
          modules: [],
          limits: { 'loyalty.activeCustomers.max': limit },
        },
        session: {
          expires: '2100-01-01T00:00:00.000Z',
          user: {
            id: userId,
            organizationId,
            organizationSlug:
              organizationId === orgId ? `wha100-${suffix}` : `wha100-other-${suffix}`,
            organizationStatus: 'ACTIVE',
            name: 'WHA Operator',
            email: `wha100-${organizationId === orgId ? '' : 'other-'}${suffix}@example.test`,
            role: 'ADMIN',
            department: 'QUALITY',
            title: 'Operator',
            status: 'ACTIVE',
          },
        },
        organization: null,
        support: null,
        requestMeta: { ip: null, userAgent: null },
        audit: { detail: {} },
      };
      return acceptanceRouter.createCaller(context);
    };
    api = makeCaller();
  }, 60_000);

  beforeEach(async () => {
    await setGrants(grants);
    api = makeCaller();
  });

  afterAll(async () => {
    await deps.audit.flushAuditWritesForTest();
    await deps.withPlatformDb((tx) =>
      tx.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } })
    );
    vi.useRealTimers();
  }, 60_000);

  it('scopes normalized identity and preserves latest immutable consent provenance', async () => {
    const email = `Mixed.${suffix}@Example.COM`;
    const first = await api.restaurantCustomers.create({
      displayName: 'First',
      identifiers: [{ kind: 'EMAIL', value: ` ${email} ` }],
    });
    await expect(
      api.restaurantCustomers.create({
        identifiers: [{ kind: 'EMAIL', value: email.toLowerCase() }],
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const cross = await makeCaller(otherOrgId).restaurantCustomers.create({
      identifiers: [{ kind: 'EMAIL', value: email.toLowerCase() }],
    });
    expect(cross.id).not.toBe(first.id);
    expect(first.identifiers[0]?.normalizedValue).toBe(email.toLowerCase());
    expect(first.currentConsent.EMAIL?.granted ?? false).toBe(false);
    const granted = await api.restaurantCustomers.appendConsent({
      customerId: first.id,
      channel: 'EMAIL',
      granted: true,
      source: 'checkout',
      policyVersion: 'v1',
      idempotencyKey: key('consent_grant'),
    });
    const revoked = await api.restaurantCustomers.appendConsent({
      customerId: first.id,
      channel: 'EMAIL',
      granted: false,
      source: 'customer-request',
      policyVersion: 'v2',
      idempotencyKey: key('consent_revoke'),
    });
    const detail = await api.restaurantCustomers.detail({ customerId: first.id });
    expect(detail.currentConsent.EMAIL).toMatchObject({
      id: revoked.id,
      actorId: ids.user,
      source: 'customer-request',
      policyVersion: 'v2',
      granted: false,
    });
    expect(detail.consentEvents.map((event) => event.id)).toEqual([revoked.id, granted.id]);
    await expect(
      tenant((tx) =>
        tx.customerConsent.update({ where: { id: granted.id }, data: { granted: false } })
      )
    ).rejects.toBeDefined();
    await expect(
      tenant((tx) => tx.customerConsent.delete({ where: { id: granted.id } }))
    ).rejects.toBeDefined();
    const phone = '+923001234567';
    const phoneCustomer = await api.restaurantCustomers.create({
      identifiers: [{ kind: 'PHONE', value: phone }],
    });
    expect(phoneCustomer.identifiers[0]?.normalizedValue).toBe(phone);
    await expect(
      api.restaurantCustomers.create({ identifiers: [{ kind: 'PHONE', value: phone }] })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      (
        await makeCaller(otherOrgId).restaurantCustomers.create({
          identifiers: [{ kind: 'PHONE', value: phone }],
        })
      ).identifiers[0]?.normalizedValue
    ).toBe(phone);
    await setGrants(grants.filter((grant) => grant !== 'customers:read'));
    await expect(api.restaurantCustomers.list({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await setGrants(grants);
    await expect(makeCaller(orgId, []).restaurantCustomers.list({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  }, 60_000);

  it('exports one customer safely and anonymizes once without mutating retained history', async () => {
    const targetEmail = `privacy-target.${suffix}@example.com`;
    const otherEmail = `privacy-other.${suffix}@example.com`;
    const target = await api.restaurantCustomers.create({
      displayName: 'Privacy Target',
      givenName: 'Private',
      familyName: 'Person',
      birthDate: new Date('1980-01-02T00:00:00.000Z'),
      notes: 'private profile note',
      identifiers: [{ kind: 'EMAIL', value: targetEmail }],
    });
    const other = await api.restaurantCustomers.create({
      displayName: 'Privacy Other',
      identifiers: [{ kind: 'EMAIL', value: otherEmail }],
    });
    const tag = await api.restaurantCustomers.createTag({ name: `VIP ${suffix}` });
    const assignment = await api.restaurantCustomers.assignTag({
      customerId: target.id,
      tagId: tag.id,
    });
    const consent = await api.restaurantCustomers.appendConsent({
      customerId: target.id,
      channel: 'SMS',
      granted: true,
      source: 'checkout',
      policyVersion: 'v1',
      idempotencyKey: key('privacy_consent'),
    });
    const account = await api.restaurantLoyalty.enrollAccount({ customerId: target.id });
    const ledger = await api.restaurantLoyalty.adjust({
      accountId: account.id,
      points: 15,
      reason: 'fixture',
      idempotencyKey: key('privacy_points'),
    });
    const money = await seedBill({
      customerId: target.id,
      orderStatus: 'CLOSED',
      billStatus: 'SETTLED',
      total: '12.34',
    });
    const interaction = await api.restaurantCustomers.appendInteraction({
      customerId: target.id,
      branchId: ids.branch,
      orderId: money.order.id,
      type: 'ORDER_CLOSED',
      idempotencyKey: key('privacy_interaction'),
    });
    const before = await tenant(async (tx) => ({
      order: await tx.restaurantOrder.findUniqueOrThrow({ where: { id: money.order.id } }),
      bill: await tx.restaurantBill.findUniqueOrThrow({ where: { id: money.bill.id } }),
      consent: await tx.customerConsent.findUniqueOrThrow({ where: { id: consent.id } }),
      interaction: await tx.customerInteraction.findUniqueOrThrow({
        where: { id: interaction.id },
      }),
      ledger: await tx.loyaltyPointsEntry.findUniqueOrThrow({ where: { id: ledger.id } }),
      program: await tx.loyaltyProgramVersion.findUniqueOrThrow({ where: { id: programId } }),
    }));
    const exported = await makeCaller().restaurantCustomers.export({ customerId: target.id });
    await deps.audit.flushAuditWritesForTest();
    expect(exported.profile.id).toBe(target.id);
    expect(exported.identifiers.map((row) => row.id)).toEqual(
      expect.arrayContaining(target.identifiers.map((row) => row.id))
    );
    expect(exported.interactions.map((row) => row.id)).toEqual([interaction.id]);
    expect(exported.tags.map((row) => row.id)).toEqual([tag.id]);
    expect(exported.tagAssignments).toEqual([
      { id: assignment.id, tagId: tag.id, createdAt: assignment.createdAt },
    ]);
    expect(exported.consentEvents.map((row) => row.id)).toEqual([consent.id]);
    expect(exported.loyaltyAccount).toEqual({
      id: account.id,
      active: account.active,
      enrolledAt: account.enrolledAt,
      deactivatedAt: account.deactivatedAt,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    });
    expect(exported.loyaltyProgramVersions.map((row) => row.id)).toEqual([programId]);
    expect(exported.loyaltyLedger).toEqual([
      expect.objectContaining({
        id: ledger.id,
        accountId: account.id,
        programVersionId: programId,
      }),
    ]);
    expect(exported.orders).toEqual([
      {
        id: money.order.id,
        branchId: money.order.branchId,
        orderNumber: money.order.orderNumber,
        businessDate: money.order.businessDate,
        status: money.order.status,
        channel: money.order.channel,
        openedAt: money.order.openedAt,
        closedAt: money.order.closedAt,
        cancelledAt: money.order.cancelledAt,
        createdAt: money.order.createdAt,
      },
    ]);
    expect(exported.bills).toEqual([
      expect.objectContaining({ id: money.bill.id, orderId: money.order.id }),
    ]);
    expect(exported.bills[0]?.grandTotal).toBe('12.34');
    const exportedJson = JSON.stringify(exported);
    expect(exportedJson).not.toContain(other.id);
    expect(exportedJson).not.toContain(otherEmail);
    expect(exportedJson).not.toContain('Privacy Other');
    const exportAudit = await tenant((tx) =>
      tx.auditLog.findFirstOrThrow({
        where: { action: 'restaurantCustomers.export', targetId: target.id },
        orderBy: { createdAt: 'desc' },
        select: { action: true, input: true, metadata: true, targetId: true, targetType: true },
      })
    );
    expect(exportAudit).toMatchObject({
      action: 'restaurantCustomers.export',
      input: '[skipped]',
      targetId: target.id,
      targetType: 'RestaurantCustomer',
    });
    expect(JSON.stringify(exportAudit)).not.toMatch(
      new RegExp(`${targetEmail}|Private|Person|private profile note`, 'i')
    );
    const first = await makeCaller().restaurantCustomers.anonymize({ customerId: target.id });
    const replay = await makeCaller().restaurantCustomers.anonymize({ customerId: target.id });
    expect(replay).toEqual(first);
    await deps.audit.flushAuditWritesForTest();
    const after = await tenant(async (tx) => ({
      customer: await tx.restaurantCustomer.findUniqueOrThrow({ where: { id: target.id } }),
      identifiers: await tx.customerIdentifier.findMany({ where: { customerId: target.id } }),
      tags: await tx.customerTagAssignment.findMany({ where: { customerId: target.id } }),
      account: await tx.loyaltyAccount.findUniqueOrThrow({ where: { id: account.id } }),
      order: await tx.restaurantOrder.findUniqueOrThrow({ where: { id: money.order.id } }),
      bill: await tx.restaurantBill.findUniqueOrThrow({ where: { id: money.bill.id } }),
      consent: await tx.customerConsent.findUniqueOrThrow({ where: { id: consent.id } }),
      interaction: await tx.customerInteraction.findUniqueOrThrow({
        where: { id: interaction.id },
      }),
      ledger: await tx.loyaltyPointsEntry.findUniqueOrThrow({ where: { id: ledger.id } }),
      program: await tx.loyaltyProgramVersion.findUniqueOrThrow({ where: { id: programId } }),
    }));
    expect(after.customer).toMatchObject({
      displayName: null,
      givenName: null,
      familyName: null,
      notes: null,
      anonymizedAt: first.anonymizedAt,
    });
    expect(after.identifiers).toEqual([]);
    expect(after.tags).toEqual([]);
    expect(after.account.active).toBe(false);
    expect(after.order).toEqual(before.order);
    expect(after.bill).toEqual(before.bill);
    expect(after.consent).toEqual(before.consent);
    expect(after.interaction).toEqual(before.interaction);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.program).toEqual(before.program);
    const anonymizeAudits = await tenant((tx) =>
      tx.auditLog.findMany({
        where: { action: 'restaurantCustomers.anonymize', targetId: target.id },
        select: { action: true, input: true, metadata: true, targetId: true, targetType: true },
      })
    );
    expect(anonymizeAudits).toHaveLength(2);
    expect(anonymizeAudits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'restaurantCustomers.anonymize',
          input: '[skipped]',
          targetId: target.id,
          targetType: 'RestaurantCustomer',
        }),
      ])
    );
    expect(JSON.stringify(anonymizeAudits)).not.toMatch(
      new RegExp(`${targetEmail}|Private|Person|private profile note`, 'i')
    );
  }, 60_000);

  it('pins immutable programs, enforces active max, and derives exact signed balance', async () => {
    const configured = await api.restaurantLoyalty.configure({
      effectiveFrom: '2100-01-01T00:00:00.000Z',
      earnRate: '2.5',
      redemptionValue: '0.02',
      expiryDays: 60,
    });
    expect(configured).toMatchObject({
      versionNumber: 2,
      earnRate: '2.5',
      redemptionValue: '0.02',
    });
    const bad = {
      effectiveFrom: '2100-02-01T00:00:00.000Z',
      earnRate: '1',
      redemptionValue: '0.05',
      unknown: true,
    };
    await expect(api.restaurantLoyalty.configure(bad)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    for (const operation of ['update', 'delete']) {
      await expect(
        tenant(async (tx) => {
          const row = await tx.loyaltyProgramVersion.create({
            data: {
              versionNumber: operation === 'update' ? 900 : 901,
              effectiveFrom: new Date('2000-01-01T00:00:00.000Z'),
              earnRate: '1',
              redemptionValue: '0.05',
            },
          });
          return operation === 'update'
            ? tx.loyaltyProgramVersion.update({ where: { id: row.id }, data: { earnRate: '9' } })
            : tx.loyaltyProgramVersion.delete({ where: { id: row.id } });
        })
      ).rejects.toBeDefined();
    }
    const active = await tenant((tx) => tx.loyaltyAccount.count({ where: { active: true } }));
    const first = await customer('limit-first');
    const second = await customer('limit-second');
    const limited = makeCaller(orgId, modules, active + 1);
    const account = await limited.restaurantLoyalty.enrollAccount({ customerId: first.id });
    await expect(
      limited.restaurantLoyalty.enrollAccount({ customerId: second.id })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await api.restaurantLoyalty.adjust({
      accountId: account.id,
      points: 10,
      reason: 'plus',
      idempotencyKey: key('plus'),
    });
    await api.restaurantLoyalty.adjust({
      accountId: account.id,
      points: -3,
      reason: 'minus',
      idempotencyKey: key('minus'),
    });
    expect((await api.restaurantLoyalty.getAccount({ id: account.id })).balance).toBe(7);
  }, 60_000);

  it('earns once, redeems exact value with denials, and expires FIFO once', async () => {
    const guest = await customer('loyalty-flow');
    const account = await api.restaurantLoyalty.enrollAccount({ customerId: guest.id });
    const settled = await cardBill(guest.id);
    const closingActor = actor(key('close_loyalty'));
    await deps.orders.closeOrder(deps.createTenantDb(orgId), {
      orderId: settled.orderId,
      actor: closingActor,
    });
    await expect(
      deps.orders.closeOrder(deps.createTenantDb(orgId), {
        orderId: settled.orderId,
        actor: closingActor,
      })
    ).resolves.toEqual({ orderId: settled.orderId, replayed: true });
    const earnRow = await tenant((tx) =>
      tx.loyaltyPointsEntry.findFirstOrThrow({ where: { billId: settled.billId, kind: 'EARN' } })
    );
    expect(earnRow).toMatchObject({ points: 12, programVersionId: programId });
    expect(
      await tenant((tx) =>
        tx.loyaltyPointsEntry.count({ where: { billId: settled.billId, kind: 'EARN' } })
      )
    ).toBe(1);
    const cancelled = await deps.orders.openOrder(deps.createTenantDb(orgId), {
      branchId: ids.branch,
      channel: 'TAKEAWAY',
      publicationId: ids.publication,
      actor: actor(),
      now: M5_AT,
    });
    await tenant((tx) =>
      tx.restaurantOrder.update({
        where: { id: cancelled.orderId },
        data: { customerId: guest.id },
      })
    );
    await deps.orders.addItem(deps.createTenantDb(orgId), {
      orderId: cancelled.orderId,
      menuItemId: ids.menuItem,
      actor: actor(),
    });
    await deps.orders.cancelOrder(deps.createTenantDb(orgId), {
      orderId: cancelled.orderId,
      reason: 'customer left',
      actor: actor(),
    });
    await expect(
      deps.orders.closeOrder(deps.createTenantDb(orgId), {
        orderId: cancelled.orderId,
        actor: actor(),
      })
    ).rejects.toMatchObject({ reason: 'ORDER_TERMINAL' });
    expect(
      await tenant((tx) =>
        tx.loyaltyPointsEntry.count({
          where: { bill: { orderId: cancelled.orderId }, kind: 'EARN' },
        })
      )
    ).toBe(0);
    await api.restaurantLoyalty.adjust({
      accountId: account.id,
      points: 100,
      reason: 'redeem',
      idempotencyKey: key('redeem_balance'),
    });
    const open = await seedBill({
      customerId: guest.id,
      orderStatus: 'OPEN',
      billStatus: 'OPEN',
      total: '10.00',
    });
    const redeemInput = {
      accountId: account.id,
      billId: open.bill.id,
      points: 20,
      idempotencyKey: key('redeem'),
    };
    const redeemed = await api.restaurantLoyalty.redeem(redeemInput);
    const redeemReplay = await api.restaurantLoyalty.redeem(redeemInput);
    expect(redeemed.value).toBe('1.00');
    expect(redeemReplay).toMatchObject({ entryId: redeemed.entryId, replayed: true });
    const redeemedState = await tenant(async (tx) => ({
      bill: await tx.restaurantBill.findUniqueOrThrow({ where: { id: open.bill.id } }),
      entries: await tx.loyaltyPointsEntry.findMany({
        where: { billId: open.bill.id, kind: 'REDEEM' },
      }),
    }));
    expect(redeemedState.bill.discountTotal.toFixed(2)).toBe('1.00');
    expect(redeemedState.bill.grandTotal.toFixed(2)).toBe('9.00');
    expect(redeemedState.entries).toEqual([
      expect.objectContaining({
        id: redeemed.entryId,
        accountId: account.id,
        billId: open.bill.id,
        points: -20,
      }),
    ]);
    await expect(
      api.restaurantLoyalty.redeem({
        accountId: account.id,
        billId: open.bill.id,
        points: 999999,
        idempotencyKey: key('insufficient'),
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const tiny = await seedBill({
      customerId: guest.id,
      orderStatus: 'OPEN',
      billStatus: 'OPEN',
      total: '0.50',
    });
    await expect(
      api.restaurantLoyalty.redeem({
        accountId: account.id,
        billId: tiny.bill.id,
        points: 20,
        idempotencyKey: key('over_bill'),
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const recovery = await customer('negative-recovery');
    const recoveryAccount = await api.restaurantLoyalty.enrollAccount({ customerId: recovery.id });
    await api.restaurantLoyalty.adjust({
      accountId: recoveryAccount.id,
      points: -5,
      reason: 'negative fixture',
      idempotencyKey: key('negative_fixture'),
    });
    const recoveryBill = await seedBill({
      customerId: recovery.id,
      orderStatus: 'OPEN',
      billStatus: 'OPEN',
      total: '1.00',
    });
    await expect(
      api.restaurantLoyalty.redeem({
        accountId: recoveryAccount.id,
        billId: recoveryBill.bill.id,
        points: 1,
        idempotencyKey: key('negative_deny'),
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await api.restaurantLoyalty.adjust({
      accountId: recoveryAccount.id,
      points: 6,
      reason: 'recover balance',
      idempotencyKey: key('negative_recover'),
    });
    await expect(
      api.restaurantLoyalty.redeem({
        accountId: recoveryAccount.id,
        billId: recoveryBill.bill.id,
        points: 1,
        idempotencyKey: key('recovered_redeem'),
      })
    ).resolves.toMatchObject({ balance: 0, value: '0.05' });
    const expiring = await customer('expiry');
    const expiryAccount = await api.restaurantLoyalty.enrollAccount({ customerId: expiring.id });
    const firstLotBill = await seedBill({
      customerId: expiring.id,
      orderStatus: 'CLOSED',
      billStatus: 'SETTLED',
      total: '5.00',
    });
    const secondLotBill = await seedBill({
      customerId: expiring.id,
      orderStatus: 'CLOSED',
      billStatus: 'SETTLED',
      total: '7.00',
    });
    const fifoRedeemBill = await seedBill({
      customerId: expiring.id,
      orderStatus: 'OPEN',
      billStatus: 'OPEN',
      total: '1.00',
    });
    const lots = await tenant(async (tx) => {
      const first = await tx.loyaltyPointsEntry.create({
        data: {
          accountId: expiryAccount.id,
          programVersionId: programId,
          kind: 'EARN',
          points: 5,
          billId: firstLotBill.bill.id,
          expiresAt: new Date('2099-08-20T00:00:00.000Z'),
          occurredAt: new Date('2099-01-01T00:00:00.000Z'),
          idempotencyKey: key('lot1'),
        },
      });
      const second = await tx.loyaltyPointsEntry.create({
        data: {
          accountId: expiryAccount.id,
          programVersionId: programId,
          kind: 'EARN',
          points: 7,
          billId: secondLotBill.bill.id,
          expiresAt: new Date('2099-08-20T00:00:00.000Z'),
          occurredAt: new Date('2099-02-01T00:00:00.000Z'),
          idempotencyKey: key('lot2'),
        },
      });
      await tx.loyaltyPointsEntry.create({
        data: {
          accountId: expiryAccount.id,
          programVersionId: programId,
          kind: 'REDEEM',
          points: -6,
          billId: fifoRedeemBill.bill.id,
          occurredAt: new Date('2099-03-01T00:00:00.000Z'),
          idempotencyKey: key('lot_redeem'),
        },
      });
      return { first, second };
    });
    await deps.expiry.expireAccountLoyaltyPoints(
      deps.createTenantDb(orgId),
      expiryAccount.id,
      ROLLUP_AT
    );
    const firstExpiries = await tenant((tx) =>
      tx.loyaltyPointsEntry.findMany({
        where: { accountId: expiryAccount.id, kind: 'EXPIRY' },
      })
    );
    await deps.expiry.expireAccountLoyaltyPoints(
      deps.createTenantDb(orgId),
      expiryAccount.id,
      ROLLUP_AT
    );
    const expiries = await tenant((tx) =>
      tx.loyaltyPointsEntry.findMany({ where: { accountId: expiryAccount.id, kind: 'EXPIRY' } })
    );
    expect(expiries).toEqual(firstExpiries);
    expect(expiries).toHaveLength(1);
    expect(expiries[0]).toMatchObject({
      points: -6,
      reversesEntryId: lots.second.id,
      programVersionId: programId,
    });
    expect(lots.first.points + lots.second.points - 6 + expiries[0]!.points).toBe(0);
  }, 60_000);

  it('reverses partial/full M5 refunds atomically, capped, pinned, and idempotent', async () => {
    const guest = await customer('refund-flow');
    const account = await api.restaurantLoyalty.enrollAccount({ customerId: guest.id });
    const payment = await cardBill(guest.id);
    const earn = await tenant((tx) =>
      tx.loyaltyPointsEntry.create({
        data: {
          accountId: account.id,
          programVersionId: programId,
          kind: 'EARN',
          points: 12,
          billId: payment.billId,
          occurredAt: new Date('2099-08-21T10:00:00.000Z'),
          idempotencyKey: key('refund_earn'),
        },
      })
    );
    await api.restaurantLoyalty.adjust({
      accountId: account.id,
      points: -2,
      reason: 'pre-refund debit',
      idempotencyKey: key('refund_debit'),
    });
    await tenant(async (tx) => {
      const latest = await tx.loyaltyProgramVersion.findFirstOrThrow({
        orderBy: { versionNumber: 'desc' },
      });
      await tx.loyaltyProgramVersion.create({
        data: {
          versionNumber: latest.versionNumber + 1,
          effectiveFrom: new Date('2099-08-21T11:00:00.000Z'),
          earnRate: '9',
          redemptionValue: '0.02',
        },
      });
    });
    const partialActor = actor(key('partial'));
    const partial = await deps.refunds.refundTender(deps.createTenantDb(orgId), {
      originalTenderId: payment.tenderId,
      amount: '5.00',
      reason: 'partial',
      approvingStaffProfileId: ids.manager,
      actor: partialActor,
      now: M5_AT,
    });
    expect(partial.amount.toFixed(2)).toBe('5.00');
    expect(partial.paymentStatus).toBe('PARTIALLY_REFUNDED');
    const replay = await deps.refunds.refundTender(deps.createTenantDb(orgId), {
      originalTenderId: payment.tenderId,
      amount: '5.00',
      reason: 'partial',
      approvingStaffProfileId: ids.manager,
      actor: partialActor,
      now: M5_AT,
    });
    expect(replay.refundId).toBe(partial.refundId);
    expect(replay.replayed).toBe(true);
    const afterPartial = await tenant(async (tx) => ({
      refunds: await tx.restaurantRefund.findMany({
        where: { originalTenderId: payment.tenderId },
      }),
      reversals: await tx.loyaltyPointsEntry.findMany({ where: { reversesEntryId: earn.id } }),
    }));
    expect(afterPartial.refunds).toHaveLength(1);
    expect(afterPartial.reversals).toEqual([
      expect.objectContaining({
        billId: payment.billId,
        points: -5,
        programVersionId: programId,
        refundId: partial.refundId,
      }),
    ]);
    const full = await deps.refunds.refundTender(deps.createTenantDb(orgId), {
      originalTenderId: payment.tenderId,
      amount: '7.50',
      reason: 'remainder',
      approvingStaffProfileId: ids.manager,
      actor: actor(),
      now: M5_AT,
    });
    expect(full.paymentStatus).toBe('REFUNDED');
    expect(full.amount.toFixed(2)).toBe('7.50');
    const committed = await tenant(async (tx) => ({
      payment: await tx.restaurantPayment.findUniqueOrThrow({ where: { id: payment.paymentId } }),
      refunds: await tx.restaurantRefund.findMany({
        where: { originalTenderId: payment.tenderId },
        orderBy: { id: 'asc' },
      }),
      reversals: await tx.loyaltyPointsEntry.findMany({
        where: { reversesEntryId: earn.id },
        orderBy: { id: 'asc' },
      }),
    }));
    expect(committed.payment.status).toBe('REFUNDED');
    expect(committed.refunds.map((row) => row.amount.toFixed(2)).sort()).toEqual(['5.00', '7.50']);
    expect(committed.reversals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          points: -5,
          programVersionId: programId,
          refundId: partial.refundId,
        }),
        expect.objectContaining({
          points: -7,
          programVersionId: programId,
          refundId: full.refundId,
        }),
      ])
    );
    await expect(
      deps.refunds.refundTender(deps.createTenantDb(orgId), {
        originalTenderId: payment.tenderId,
        amount: '0.01',
        reason: 'over',
        approvingStaffProfileId: ids.manager,
        actor: actor(),
        now: M5_AT,
      })
    ).rejects.toMatchObject({ reason: 'REFUND_EXCEEDS_TENDER' });
    const afterFailedRefund = await tenant(async (tx) => ({
      payment: await tx.restaurantPayment.findUniqueOrThrow({ where: { id: payment.paymentId } }),
      refunds: await tx.restaurantRefund.findMany({
        where: { originalTenderId: payment.tenderId },
        orderBy: { id: 'asc' },
      }),
      reversals: await tx.loyaltyPointsEntry.findMany({
        where: { reversesEntryId: earn.id },
        orderBy: { id: 'asc' },
      }),
    }));
    expect(afterFailedRefund).toEqual(committed);
    expect((await api.restaurantLoyalty.getAccount({ id: account.id })).balance).toBe(-2);
    const recoveryBill = await seedBill({
      customerId: guest.id,
      orderStatus: 'OPEN',
      billStatus: 'OPEN',
      total: '1.00',
    });
    await expect(
      api.restaurantLoyalty.redeem({
        accountId: account.id,
        billId: recoveryBill.bill.id,
        points: 1,
        idempotencyKey: key('refund_negative_deny'),
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await api.restaurantLoyalty.adjust({
      accountId: account.id,
      points: 3,
      reason: 'refund balance recovery',
      idempotencyKey: key('refund_recovery'),
    });
    await expect(
      api.restaurantLoyalty.redeem({
        accountId: account.id,
        billId: recoveryBill.bill.id,
        points: 1,
        idempotencyKey: key('refund_recovered_redeem'),
      })
    ).resolves.toMatchObject({ balance: 0, value: '0.02' });
  }, 60_000);

  it('runs scheduler rollup/backfill replay and replaces corrected projections exactly', async () => {
    const raw = await seedRollupRaw();
    const cutActor = actor(key('rollup_cut'));
    const cut = await deps.dailyClose.cutClose(deps.createTenantDb(orgId), {
      branchId: ids.branch,
      businessDate: ROLLUP_DATE,
      actor: cutActor,
    });
    await expect(
      deps.dailyClose.cutClose(deps.createTenantDb(orgId), {
        branchId: ids.branch,
        businessDate: ROLLUP_DATE,
        actor: cutActor,
      })
    ).resolves.toMatchObject({ dailyCloseId: cut.dailyCloseId, replayed: true });
    const close = await tenant((tx) =>
      tx.restaurantDailyClose.findUniqueOrThrow({ where: { id: cut.dailyCloseId } })
    );
    const cutJobKey = deps.rollups.insightRollupJobKey({
      branchId: ids.branch,
      businessDate: ROLLUP_DATE,
      sourceDailyCloseId: cut.dailyCloseId,
    });
    expect(
      await tenant((tx) => tx.restaurantJob.count({ where: { idempotencyKey: cutJobKey } }))
    ).toBe(1);
    const claimed = await deps.scheduler.claimNextDue(deps.createTenantDb(orgId), {
      workerId: 'wha100-rollup',
      now: ROLLUP_AT,
    });
    if (!claimed) throw new Error('Rollup job was not claimable.');
    await deps.rollups.rollupDayHandler({ db: deps.createTenantDb(orgId), job: claimed });
    const firstOracle = await readRollupOracle();
    const first = await tenant(async (tx) => ({
      daily: await tx.insightDailyRollup.findFirstOrThrow({
        where: { branchId: ids.branch, businessDate: close.businessDate },
      }),
      items: await tx.insightItemMixRollup.findMany({
        where: { branchId: ids.branch, businessDate: close.businessDate },
        orderBy: { productId: 'asc' },
      }),
    }));
    expect(close.grossSales.toString()).toBe(firstOracle.grossSales.toString());
    expect(close.netSales.toString()).toBe(firstOracle.netSales.toString());
    expect(close.compTotal.toString()).toBe(firstOracle.compTotal.toString());
    expect(close.refundTotal.toString()).toBe(firstOracle.refundTotal.toString());
    expect(close.voidTotal.toString()).toBe(firstOracle.voidTotal.toString());
    expect(close.tipTotal.toString()).toBe(firstOracle.tipTotal.toString());
    expect(close.cashVariance.toString()).toBe(firstOracle.drawerVariance.toString());
    expect(first.daily).toMatchObject({
      orderCount: firstOracle.orderCount,
      coverCount: firstOracle.coverCount,
      sourceDailyCloseId: close.id,
    });
    expect(first.daily.grossSales.toString()).toBe(firstOracle.grossSales.toString());
    expect(first.daily.netSales.toString()).toBe(firstOracle.netSales.toString());
    expect(first.daily.compTotal.toString()).toBe(firstOracle.compTotal.toString());
    expect(first.daily.refundTotal.toString()).toBe(firstOracle.refundTotal.toString());
    expect(first.daily.voidTotal.toString()).toBe(firstOracle.voidTotal.toString());
    expect(first.daily.drawerVariance.toString()).toBe(firstOracle.drawerVariance.toString());
    expect(first.daily.loyaltyLiability.toString()).toBe(firstOracle.loyaltyLiability.toString());
    expect(
      first.items.map((item) => ({
        compTotal: item.compTotal.toString(),
        grossSales: item.grossSales.toString(),
        netSales: item.netSales.toString(),
        productId: item.productId,
        quantity: item.quantity,
        sourceDailyCloseId: item.sourceDailyCloseId,
      }))
    ).toEqual(
      firstOracle.itemMix.map((item) => ({
        compTotal: item.compTotal.toString(),
        grossSales: item.grossSales.toString(),
        netSales: item.netSales.toString(),
        productId: item.productId,
        quantity: item.quantity,
        sourceDailyCloseId: close.id,
      }))
    );
    await deps.rollups.rollupDayHandler({ db: deps.createTenantDb(orgId), job: claimed });
    expect(
      await tenant(async (tx) => ({
        daily: await tx.insightDailyRollup.findFirstOrThrow({
          where: { branchId: ids.branch, businessDate: close.businessDate },
        }),
        items: await tx.insightItemMixRollup.findMany({
          where: { branchId: ids.branch, businessDate: close.businessDate },
          orderBy: { productId: 'asc' },
        }),
      }))
    ).toEqual(first);

    const correctedAt = new Date('2099-08-22T12:01:00.000Z');
    await tenant(async (tx) => {
      await tx.restaurantBill.update({
        where: { id: raw.billId },
        data: { compTotal: '3.00', discountTotal: '2.00', grandTotal: '25.00' },
      });
      await tx.restaurantBillLine.update({
        where: { id: raw.lineId },
        data: { compAmount: '3.00', lineTotal: '19.00' },
      });
      await tx.restaurantOrderItem.update({
        where: { id: raw.staleItemId },
        data: { status: 'VOIDED', voidReason: 'corrected fixture' },
      });
      await tx.restaurantDrawerSession.update({
        where: { id: raw.drawerId },
        data: { countedCash: '118.00', variance: '-2.00' },
      });
    });
    vi.setSystemTime(correctedAt);
    const correctionActor = actor(key('rollup_correction'));
    const corrected = await deps.dailyClose.correctClose(deps.createTenantDb(orgId), {
      branchId: ids.branch,
      businessDate: ROLLUP_DATE,
      supersedesCloseId: close.id,
      reason: 'rebuild corrected facts',
      approvingStaffProfileId: ids.manager,
      actor: correctionActor,
    });
    await expect(
      deps.dailyClose.correctClose(deps.createTenantDb(orgId), {
        branchId: ids.branch,
        businessDate: ROLLUP_DATE,
        supersedesCloseId: close.id,
        reason: 'rebuild corrected facts',
        approvingStaffProfileId: ids.manager,
        actor: correctionActor,
      })
    ).resolves.toMatchObject({ dailyCloseId: corrected.dailyCloseId, replayed: true });
    expect(
      await tenant((tx) =>
        tx.restaurantJob.count({
          where: {
            idempotencyKey: {
              in: [
                cutJobKey,
                deps.rollups.insightRollupJobKey({
                  branchId: ids.branch,
                  businessDate: ROLLUP_DATE,
                  sourceDailyCloseId: corrected.dailyCloseId,
                }),
              ],
            },
          },
        })
      )
    ).toBe(2);
    const correctionJob = await deps.scheduler.claimNextDue(deps.createTenantDb(orgId), {
      workerId: 'wha100-correction',
      now: correctedAt,
    });
    if (!correctionJob) throw new Error('Correction rollup job was not claimable.');
    await deps.rollups.rollupDayHandler({ db: deps.createTenantDb(orgId), job: correctionJob });
    const correctedOracle = await readRollupOracle();
    const correctedProjection = await tenant(async (tx) => ({
      closes: await tx.restaurantDailyClose.findMany({
        where: { branchId: ids.branch, businessDate: close.businessDate },
        orderBy: { createdAt: 'asc' },
      }),
      daily: await tx.insightDailyRollup.findFirstOrThrow({
        where: { branchId: ids.branch, businessDate: close.businessDate },
      }),
      items: await tx.insightItemMixRollup.findMany({
        where: { branchId: ids.branch, businessDate: close.businessDate },
        orderBy: { productId: 'asc' },
      }),
    }));
    expect(correctedProjection.closes[0]).toEqual(close);
    expect(correctedOracle.close.id).toBe(corrected.dailyCloseId);
    expect(correctedOracle.netSales.toString()).not.toBe(firstOracle.netSales.toString());
    expect(correctedOracle.drawerVariance.toString()).not.toBe(
      firstOracle.drawerVariance.toString()
    );
    expect(correctedProjection.daily).toMatchObject({
      orderCount: correctedOracle.orderCount,
      coverCount: correctedOracle.coverCount,
      sourceDailyCloseId: corrected.dailyCloseId,
    });
    expect(correctedProjection.daily.grossSales.toString()).toBe(
      correctedOracle.grossSales.toString()
    );
    expect(correctedProjection.daily.netSales.toString()).toBe(correctedOracle.netSales.toString());
    expect(correctedProjection.daily.compTotal.toString()).toBe(
      correctedOracle.compTotal.toString()
    );
    expect(correctedProjection.daily.refundTotal.toString()).toBe(
      correctedOracle.refundTotal.toString()
    );
    expect(correctedProjection.daily.voidTotal.toString()).toBe(
      correctedOracle.voidTotal.toString()
    );
    expect(correctedProjection.daily.drawerVariance.toString()).toBe(
      correctedOracle.drawerVariance.toString()
    );
    expect(correctedProjection.daily.loyaltyLiability.toString()).toBe(
      correctedOracle.loyaltyLiability.toString()
    );
    expect(correctedProjection.items.map((item) => item.productId)).toEqual([ids.product]);
    expect(correctedProjection.items[0]).toMatchObject({
      quantity: 2,
      sourceDailyCloseId: corrected.dailyCloseId,
    });
    expect(correctedProjection.items[0]?.grossSales.toString()).toBe('22');
    expect(correctedProjection.items[0]?.netSales.toString()).toBe('19');
    await deps.rollups.rollupDayHandler({ db: deps.createTenantDb(orgId), job: correctionJob });
    expect(
      await tenant(async (tx) => ({
        closes: await tx.restaurantDailyClose.findMany({
          where: { branchId: ids.branch, businessDate: close.businessDate },
          orderBy: { createdAt: 'asc' },
        }),
        daily: await tx.insightDailyRollup.findFirstOrThrow({
          where: { branchId: ids.branch, businessDate: close.businessDate },
        }),
        items: await tx.insightItemMixRollup.findMany({
          where: { branchId: ids.branch, businessDate: close.businessDate },
          orderBy: { productId: 'asc' },
        }),
      }))
    ).toEqual(correctedProjection);

    const backfill = await api.restaurantInsights.backfill({
      branchId: ids.branch,
      from: '2099-05-24',
      to: ROLLUP_DATE,
    });
    const backfillReplay = await api.restaurantInsights.backfill({
      branchId: ids.branch,
      from: ROLLUP_DATE,
      to: ROLLUP_DATE,
    });
    expect(backfill).toEqual({
      chunks: [
        { from: '2099-05-24', to: '2099-08-21' },
        { from: ROLLUP_DATE, to: ROLLUP_DATE },
      ],
      deduplicated: 0,
      enqueued: 91,
    });
    expect(backfillReplay).toEqual({
      chunks: [{ from: ROLLUP_DATE, to: ROLLUP_DATE }],
      deduplicated: 1,
      enqueued: 0,
    });
    const backfillJob = await tenant((tx) =>
      tx.restaurantJob.findFirstOrThrow({
        where: {
          idempotencyKey: deps.rollups.insightRollupJobKey({
            branchId: ids.branch,
            businessDate: ROLLUP_DATE,
          }),
        },
      })
    );
    await deps.rollups.rollupDayHandler({
      db: deps.createTenantDb(orgId),
      job: { ...backfillJob, claimedBy: 'wha100-backfill', startedAt: ROLLUP_AT },
    });
    expect(
      await tenant((tx) =>
        tx.insightDailyRollup.findFirstOrThrow({
          where: { branchId: ids.branch, businessDate: close.businessDate },
        })
      )
    ).toEqual(correctedProjection.daily);
    const operational = await api.restaurantInsights.listOperationalReports({
      branchId: ids.branch,
      from: ROLLUP_DATE,
      to: ROLLUP_DATE,
    });
    const financial = await api.restaurantInsights.listFinancialReports({
      branchId: ids.branch,
      from: ROLLUP_DATE,
      to: ROLLUP_DATE,
    });
    const operationalRead = await api.restaurantInsights.readOperationalReport({
      branchId: ids.branch,
      businessDate: ROLLUP_DATE,
    });
    const financialRead = await api.restaurantInsights.readFinancialReport({
      branchId: ids.branch,
      businessDate: ROLLUP_DATE,
    });
    const operationalExport = await api.restaurantInsights.exportOperationalReports({
      branchId: ids.branch,
      from: ROLLUP_DATE,
      to: ROLLUP_DATE,
    });
    const financialExport = await api.restaurantInsights.exportFinancialReports({
      branchId: ids.branch,
      from: ROLLUP_DATE,
      to: ROLLUP_DATE,
    });
    expect(operational[0]).not.toHaveProperty('grossSales');
    expect(operational[0]).not.toHaveProperty('labourCost');
    expect(operational[0]).toMatchObject({
      coverCount: correctedOracle.coverCount,
      orderCount: correctedOracle.orderCount,
    });
    expect(operationalRead).not.toHaveProperty('labourCost');
    expect(financial[0]).not.toHaveProperty('labourCost');
    expect(financialRead).not.toHaveProperty('labourCost');
    expect(financial[0]).toMatchObject({
      compTotal: correctedOracle.compTotal.toString(),
      drawerVariance: correctedOracle.drawerVariance.toString(),
      grossSales: correctedOracle.grossSales.toString(),
      loyaltyLiability: correctedOracle.loyaltyLiability.toString(),
      netSales: correctedOracle.netSales.toString(),
      refundTotal: correctedOracle.refundTotal.toString(),
      voidTotal: correctedOracle.voidTotal.toString(),
    });
    expect(financialRead).toMatchObject({
      grossSales: correctedOracle.grossSales.toString(),
      netSales: correctedOracle.netSales.toString(),
    });
    expect(financial[0]?.freshness.computedAtUtc).toBe(correctedAt.toISOString());
    expect(financial[0]?.freshness.computedAtLocal).toBe('2099-08-22T17:01:00[Asia/Karachi]');
    expect(operationalExport.content).not.toMatch(/grossSales|labour/i);
    expect(financialExport.content).toContain('grossSales');
    expect(financialExport.content).not.toMatch(/labour/i);
  }, 60_000);

  it('requires both labour grants and branch proof while ordinary reports stay closed', async () => {
    const defaultDeny = [
      'customers:read',
      'loyalty:redeem',
      'reports:financial',
      'workforce:rates',
      'restaurant:configure',
    ] as const satisfies readonly Action[];
    await setGrants([]);
    const subject = deps.abac.subjectFromSession({
      id: ids.user,
      role: 'ADMIN',
      department: 'QUALITY',
      status: 'ACTIVE',
    });
    expect(
      await tenant((tx) =>
        Promise.all(
          defaultDeny.map((action) =>
            deps.abac.can(subject, action, undefined, {
              db: tx as never,
              now: ROLLUP_AT,
              source: 'TRPC',
            })
          )
        )
      )
    ).toEqual(defaultDeny.map(() => false));
    await setGrants(grants);
    await expect(
      makeCaller(
        orgId,
        modules.filter((module) => module !== 'restaurant-customers')
      ).restaurantCustomers.list({})
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      makeCaller(
        orgId,
        modules.filter((module) => module !== 'restaurant-loyalty')
      ).restaurantLoyalty.listAccounts({})
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      makeCaller(
        orgId,
        modules.filter((module) => module !== 'restaurant-insights')
      ).restaurantInsights.listFinancialReports({ branchId: ids.branch })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const imported = await api.restaurantInsights.importLabourCost({
      branchId: ids.branch,
      businessDate: ROLLUP_DATE,
      labourHours: '7.25',
      labourCost: '88.45',
      source: 'MANUAL',
      idempotencyKey: key('labour'),
    });
    expect(imported.fact).toMatchObject({ labourHours: '7.25', labourCost: '88.45' });
    await setGrants(grants.filter((grant) => grant !== 'workforce:rates'));
    await expect(
      api.restaurantInsights.listLabourCosts({ branchId: ids.branch })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      api.restaurantInsights.readLabourCost({ id: imported.fact.id })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      api.restaurantInsights.exportLabourCosts({ branchId: ids.branch })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await setGrants(grants.filter((grant) => grant !== 'reports:financial'));
    for (const call of [
      () => api.restaurantInsights.listLabourCosts({ branchId: ids.branch }),
      () => api.restaurantInsights.readLabourCost({ id: imported.fact.id }),
      () => api.restaurantInsights.exportLabourCosts({ branchId: ids.branch }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await setGrants(grants);
    expect(
      (await api.restaurantInsights.listLabourCosts({ branchId: ids.branch }))[0]
    ).toMatchObject({ labourCost: '88.45' });
    expect(await api.restaurantInsights.readLabourCost({ id: imported.fact.id })).toMatchObject({
      labourHours: '7.25',
    });
    expect(
      (await api.restaurantInsights.exportLabourCosts({ branchId: ids.branch })).content
    ).toContain('88.45');
    const other = await tenant((tx) =>
      tx.labourCostFact.create({
        data: {
          branchId: ids.branchTwo,
          businessDate: new Date(`${ROLLUP_DATE}T00:00:00.000Z`),
          labourHours: '1.00',
          labourCost: '10.00',
          source: 'MANUAL',
          idempotencyKey: key('other_labour'),
        },
      })
    );
    await setGrants(grants.filter((grant) => grant !== 'restaurant:configure'));
    await expect(
      api.restaurantInsights.listFinancialReports({ branchId: ids.branch })
    ).resolves.toHaveLength(1);
    await expect(
      api.restaurantInsights.listFinancialReports({ branchId: ids.branchTwo })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.restaurantInsights.listFinancialReports({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(api.restaurantInsights.readLabourCost({ id: other.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await setGrants(grants);
    await expect(
      api.restaurantInsights.listFinancialReports({ branchId: ids.branchTwo })
    ).resolves.toEqual([]);
    await expect(api.restaurantInsights.listFinancialReports({})).resolves.toHaveLength(1);
    expect(await api.restaurantInsights.readLabourCost({ id: other.id })).toMatchObject({
      branchId: ids.branchTwo,
    });

    await setGrants(grants.filter((grant) => grant !== 'restaurant:configure'));
    await tenant((tx) =>
      tx.restaurantStaffProfile.update({
        where: { id: ids.operator },
        data: { status: 'SUSPENDED' },
      })
    );
    await expect(
      api.restaurantInsights.listFinancialReports({ branchId: ids.branch })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await tenant((tx) =>
      tx.restaurantStaffProfile.update({ where: { id: ids.operator }, data: { status: 'ACTIVE' } })
    );
    await setGrants(grants.filter((grant) => grant !== 'reports:operational'));
    await expect(
      api.restaurantInsights.listOperationalReports({ branchId: ids.branch })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await setGrants(grants.filter((grant) => grant !== 'customers:read'));
    await expect(api.restaurantCustomers.list({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await setGrants(grants.filter((grant) => grant !== 'loyalty:redeem'));
    await expect(
      api.restaurantLoyalty.redeem({
        accountId: 'account-denied',
        billId: 'bill-denied',
        points: 1,
        idempotencyKey: key('loyalty_denied'),
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await setGrants(grants);
  }, 60_000);

  it('rejects unknown keys on every M8 router input', async () => {
    const strictCustomer = await customer('strict-matrix');
    const strictAccount = await api.restaurantLoyalty.enrollAccount({
      customerId: strictCustomer.id,
    });
    const strictEntry = await api.restaurantLoyalty.adjust({
      accountId: strictAccount.id,
      points: 10,
      reason: 'strict matrix',
      idempotencyKey: key('strict_adjust'),
    });
    const strictBill = await seedBill({
      customerId: strictCustomer.id,
      orderStatus: 'OPEN',
      billStatus: 'OPEN',
      total: '10.00',
    });
    const strictTag = await api.restaurantCustomers.createTag({ name: `Strict ${suffix}` });
    const strictLabour = await api.restaurantInsights.importLabourCost({
      branchId: ids.branch,
      businessDate: ROLLUP_DATE,
      labourHours: '1.25',
      labourCost: '20.50',
      source: 'MANUAL',
      idempotencyKey: key('strict_labour'),
    });
    const bad = <T extends object>(input: T) => ({ ...input, unknown: true }) as never;
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['customers.list', () => api.restaurantCustomers.list(bad({}))],
      [
        'customers.detail',
        () => api.restaurantCustomers.detail(bad({ customerId: strictCustomer.id })),
      ],
      ['customers.create', () => api.restaurantCustomers.create(bad({ displayName: 'Strict' }))],
      [
        'customers.create.identifier',
        () =>
          api.restaurantCustomers.create({
            identifiers: [bad({ kind: 'EMAIL' as const, value: `strict.${suffix}@example.com` })],
          }),
      ],
      [
        'customers.correct',
        () =>
          api.restaurantCustomers.correct(
            bad({ customerId: strictCustomer.id, displayName: 'Strict corrected' })
          ),
      ],
      [
        'customers.correct.identifier',
        () =>
          api.restaurantCustomers.correct({
            customerId: strictCustomer.id,
            identifiers: [
              bad({ kind: 'EMAIL' as const, value: `corrected.${suffix}@example.com` }),
            ],
          }),
      ],
      [
        'customers.attachToOrder',
        () =>
          api.restaurantCustomers.attachToOrder(
            bad({ customerId: strictCustomer.id, orderId: strictBill.order.id })
          ),
      ],
      [
        'customers.appendInteraction',
        () =>
          api.restaurantCustomers.appendInteraction(
            bad({
              customerId: strictCustomer.id,
              branchId: ids.branch,
              orderId: strictBill.order.id,
              type: 'STRICT',
              idempotencyKey: key('strict_interaction'),
            })
          ),
      ],
      [
        'customers.appendConsent',
        () =>
          api.restaurantCustomers.appendConsent(
            bad({
              customerId: strictCustomer.id,
              channel: 'EMAIL' as const,
              granted: true,
              source: 'strict',
              policyVersion: 'v1',
              idempotencyKey: key('strict_consent'),
            })
          ),
      ],
      [
        'customers.createTag',
        () => api.restaurantCustomers.createTag(bad({ name: 'Strict unknown' })),
      ],
      ['customers.listTags', () => api.restaurantCustomers.listTags(bad({}))],
      [
        'customers.assignTag',
        () =>
          api.restaurantCustomers.assignTag(
            bad({ customerId: strictCustomer.id, tagId: strictTag.id })
          ),
      ],
      [
        'customers.unassignTag',
        () =>
          api.restaurantCustomers.unassignTag(
            bad({ customerId: strictCustomer.id, tagId: strictTag.id })
          ),
      ],
      [
        'customers.export',
        () => api.restaurantCustomers.export(bad({ customerId: strictCustomer.id })),
      ],
      [
        'customers.anonymize',
        () => api.restaurantCustomers.anonymize(bad({ customerId: strictCustomer.id })),
      ],
      ['loyalty.listPrograms', () => api.restaurantLoyalty.listPrograms(bad({ limit: 1 }))],
      ['loyalty.getProgram', () => api.restaurantLoyalty.getProgram(bad({ id: programId }))],
      ['loyalty.listAccounts', () => api.restaurantLoyalty.listAccounts(bad({ limit: 1 }))],
      ['loyalty.getAccount', () => api.restaurantLoyalty.getAccount(bad({ id: strictAccount.id }))],
      [
        'loyalty.enrollAccount',
        () => api.restaurantLoyalty.enrollAccount(bad({ customerId: strictCustomer.id })),
      ],
      [
        'loyalty.listLedger',
        () => api.restaurantLoyalty.listLedger(bad({ accountId: strictAccount.id })),
      ],
      [
        'loyalty.getLedgerEntry',
        () => api.restaurantLoyalty.getLedgerEntry(bad({ id: strictEntry.id })),
      ],
      [
        'loyalty.configure',
        () =>
          api.restaurantLoyalty.configure(
            bad({
              effectiveFrom: '2101-01-01T00:00:00.000Z',
              earnRate: '1',
              redemptionValue: '0.05',
            })
          ),
      ],
      [
        'loyalty.adjust',
        () =>
          api.restaurantLoyalty.adjust(
            bad({
              accountId: strictAccount.id,
              points: 1,
              reason: 'strict',
              idempotencyKey: key('strict_adjust_bad'),
            })
          ),
      ],
      [
        'loyalty.redeem',
        () =>
          api.restaurantLoyalty.redeem(
            bad({
              accountId: strictAccount.id,
              billId: strictBill.bill.id,
              points: 1,
              idempotencyKey: key('strict_redeem'),
            })
          ),
      ],
      [
        'reports.listOperational',
        () => api.restaurantInsights.listOperationalReports(bad({ branchId: ids.branch })),
      ],
      [
        'reports.readOperational',
        () =>
          api.restaurantInsights.readOperationalReport(
            bad({ branchId: ids.branch, businessDate: ROLLUP_DATE })
          ),
      ],
      [
        'reports.exportOperational',
        () => api.restaurantInsights.exportOperationalReports(bad({ branchId: ids.branch })),
      ],
      [
        'reports.listFinancial',
        () => api.restaurantInsights.listFinancialReports(bad({ branchId: ids.branch })),
      ],
      [
        'reports.readFinancial',
        () =>
          api.restaurantInsights.readFinancialReport(
            bad({ branchId: ids.branch, businessDate: ROLLUP_DATE })
          ),
      ],
      [
        'reports.exportFinancial',
        () => api.restaurantInsights.exportFinancialReports(bad({ branchId: ids.branch })),
      ],
      [
        'reports.backfill',
        () =>
          api.restaurantInsights.backfill(
            bad({ branchId: ids.branch, from: ROLLUP_DATE, to: ROLLUP_DATE })
          ),
      ],
      [
        'labour.import',
        () =>
          api.restaurantInsights.importLabourCost(
            bad({
              branchId: ids.branch,
              businessDate: ROLLUP_DATE,
              labourHours: '1.00',
              labourCost: '2.00',
              source: 'MANUAL',
              idempotencyKey: key('strict_labour_bad'),
            })
          ),
      ],
      ['labour.list', () => api.restaurantInsights.listLabourCosts(bad({ branchId: ids.branch }))],
      [
        'labour.read',
        () => api.restaurantInsights.readLabourCost(bad({ id: strictLabour.fact.id })),
      ],
      [
        'labour.export',
        () => api.restaurantInsights.exportLabourCosts(bad({ branchId: ids.branch })),
      ],
    ];
    for (const [name, call] of cases) {
      await expect(call(), name).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
  }, 60_000);
});
