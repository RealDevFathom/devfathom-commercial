/** WHA-100: independent M8 API, reconciliation, privacy, and loyalty battery. */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '@/server/trpc';

const mocks = vi.hoisted(() => ({
  annotateAudit: vi.fn(),
  can: vi.fn<typeof import('@/lib/abac').can>(),
  grants: new Set<string>(),
  recordTrpcAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/server/audit', async () => {
  const actual = await vi.importActual<typeof import('@/server/audit')>('@/server/audit');
  return {
    ...actual,
    annotateAudit: (...args: Parameters<typeof actual.annotateAudit>) => {
      mocks.annotateAudit(...args);
      actual.annotateAudit(...args);
    },
    isAuditExcludedPath: vi.fn(() => false),
    recordTrpcAudit: async (...args: Parameters<typeof actual.recordTrpcAudit>) => {
      const [entry] = args;
      mocks.recordTrpcAudit({
        ...entry,
        input: entry.ctx.audit?.detail.skipInput ? '[skipped]' : entry.input,
      });
    },
  };
});

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
];
const ids = {
  branch: `branch_${suffix}`,
  branchTwo: `branch_two_${suffix}`,
  category: `category_${suffix}`,
  manager: `manager_${suffix}`,
  menu: `menu_${suffix}`,
  menuItem: `menu_item_${suffix}`,
  operator: `operator_${suffix}`,
  priceList: `price_list_${suffix}`,
  priceVersion: `price_version_${suffix}`,
  product: `product_${suffix}`,
  publication: `publication_${suffix}`,
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
  bills: typeof import('@/lib/restaurant/bills');
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  devices: typeof import('@/lib/restaurant/devices');
  expiry: typeof import('@/lib/restaurant/loyalty-expiry');
  loyalty: typeof import('@/lib/restaurant/loyalty');
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
const actor = (idempotencyKey = key('money')) => ({
  staffProfileId: ids.operator,
  deviceId,
  idempotencyKey,
});
const tenant = <T>(work: (tx: ScopedDb) => Promise<T>, organizationId = orgId) =>
  deps.withTenantDb(organizationId, work);

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
  await deps.orders.addItem(db, {
    orderId: opened.orderId,
    menuItemId: ids.menuItem,
    actor: actor(),
  });
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
  return { billId, orderId: opened.orderId, tenderId: paid.tenderId, paymentId: paid.paymentId };
}

async function seedRollupRaw() {
  const date = new Date(`${ROLLUP_DATE}T00:00:00.000Z`);
  await tenant(async (tx) => {
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
    const bill = await tx.restaurantBill.create({
      data: {
        orderId: order.id,
        branchId: ids.branch,
        businessDate: date,
        status: 'SETTLED',
        subtotal: '22.00',
        taxTotal: '1.00',
        serviceChargeTotal: '2.00',
        compTotal: '2.00',
        discountTotal: '1.00',
        grandTotal: '22.00',
        settledAt: ROLLUP_AT,
        openerStaffProfileId: ids.operator,
        deviceId,
      },
    });
    await tx.restaurantBillLine.create({
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
    const tender = await tx.restaurantTender.create({
      data: {
        billId: bill.id,
        type: 'CARD',
        amount: '22.00',
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
    return tx.restaurantDailyClose.create({
      data: {
        branchId: ids.branch,
        businessDate: date,
        cutByStaffProfileId: ids.operator,
        deviceId,
        grossSales: '22.00',
        netSales: '19.00',
        taxTotal: '1.00',
        serviceChargeTotal: '2.00',
        tipTotal: '3.00',
        compTotal: '2.00',
        discountTotal: '1.00',
        refundTotal: '4.00',
        voidTotal: '5.00',
        cashExpected: '120.00',
        cashCounted: '119.00',
        cashVariance: '-1.00',
        createdAt: ROLLUP_AT,
      },
    });
  });
}

describeDb('WHA-100 restaurant M8 acceptance', () => {
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ROLLUP_AT);
    const scoped = await import('@/lib/tenancy/scoped-db');
    const [bills, devices, expiry, loyalty, orders, refunds, rollups, scheduler, tenders] =
      await Promise.all([
        import('@/lib/restaurant/bills'),
        import('@/lib/restaurant/devices'),
        import('@/lib/restaurant/loyalty-expiry'),
        import('@/lib/restaurant/loyalty'),
        import('@/lib/restaurant/orders'),
        import('@/lib/restaurant/refunds'),
        import('@/lib/restaurant/insight-rollups'),
        import('@/lib/restaurant/scheduler'),
        import('@/lib/restaurant/tenders'),
      ]);
    deps = {
      ...scoped,
      bills,
      devices,
      expiry,
      loyalty,
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
            id: ids.user,
            organizationId,
            organizationSlug:
              organizationId === orgId ? `wha100-${suffix}` : `wha100-other-${suffix}`,
            organizationStatus: 'ACTIVE',
            name: 'WHA Operator',
            email: `wha100-${suffix}@example.test`,
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

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.grants.clear();
    for (const grant of grants) mocks.grants.add(grant);
    mocks.can.mockImplementation(async (_subject, action) => mocks.grants.has(String(action)));
    api = makeCaller();
  });

  afterAll(async () => {
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
    const bad = { displayName: 'Strict', unknown: true };
    await expect(api.restaurantCustomers.create(bad)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    mocks.grants.delete('customers:read');
    await expect(api.restaurantCustomers.list({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    mocks.grants.add('customers:read');
    await expect(makeCaller(orgId, []).restaurantCustomers.list({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  }, 60_000);

  it('exports one customer safely and anonymizes once without mutating retained history', async () => {
    const target = await customer('privacy-target');
    const other = await customer('privacy-other');
    const tag = await api.restaurantCustomers.createTag({ name: `VIP ${suffix}` });
    await api.restaurantCustomers.assignTag({ customerId: target.id, tagId: tag.id });
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
    mocks.annotateAudit.mockClear();
    mocks.recordTrpcAudit.mockClear();
    const exported = await api.restaurantCustomers.export({ customerId: target.id });
    expect(exported.profile.id).toBe(target.id);
    expect(JSON.stringify(exported)).not.toContain(other.id);
    expect(exported.bills[0]?.grandTotal).toBe('12.34');
    expect(mocks.recordTrpcAudit).toHaveBeenCalledWith(
      expect.objectContaining({ input: '[skipped]' })
    );
    expect(JSON.stringify(mocks.annotateAudit.mock.calls)).not.toContain(
      `privacy-target.${suffix}@example.com`
    );
    const first = await api.restaurantCustomers.anonymize({ customerId: target.id });
    expect(await api.restaurantCustomers.anonymize({ customerId: target.id })).toEqual(first);
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
    const closed = await seedBill({
      customerId: guest.id,
      orderStatus: 'CLOSED',
      billStatus: 'SETTLED',
      total: '12.34',
    });
    const earned = await deps.loyalty.earnLoyaltyForClosedOrder(
      deps.createTenantDb(orgId),
      closed.order.id,
      M5_AT
    );
    const replay = await deps.loyalty.earnLoyaltyForClosedOrder(
      deps.createTenantDb(orgId),
      closed.order.id,
      M5_AT
    );
    expect(replay).toEqual(earned);
    const earnRow = await tenant((tx) =>
      tx.loyaltyPointsEntry.findFirstOrThrow({ where: { billId: closed.bill.id, kind: 'EARN' } })
    );
    expect(earnRow).toMatchObject({ points: 12, programVersionId: programId });
    expect(
      await tenant((tx) =>
        tx.loyaltyPointsEntry.count({ where: { billId: closed.bill.id, kind: 'EARN' } })
      )
    ).toBe(1);
    const cancelled = await seedBill({
      customerId: guest.id,
      orderStatus: 'CANCELLED',
      billStatus: 'SETTLED',
      total: '50.00',
    });
    expect(
      await deps.loyalty.earnLoyaltyForClosedOrder(
        deps.createTenantDb(orgId),
        cancelled.order.id,
        M5_AT
      )
    ).toEqual([]);
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
    const redeemed = await api.restaurantLoyalty.redeem({
      accountId: account.id,
      billId: open.bill.id,
      points: 20,
      idempotencyKey: key('redeem'),
    });
    expect(redeemed.value).toBe('1.00');
    expect(
      (
        await tenant((tx) => tx.restaurantBill.findUniqueOrThrow({ where: { id: open.bill.id } }))
      ).grandTotal.toString()
    ).toBe('9');
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
    const expiring = await customer('expiry');
    const expiryAccount = await api.restaurantLoyalty.enrollAccount({ customerId: expiring.id });
    const lots = await tenant(async (tx) => {
      const first = await tx.loyaltyPointsEntry.create({
        data: {
          accountId: expiryAccount.id,
          programVersionId: programId,
          kind: 'EARN',
          points: 5,
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
    await deps.expiry.expireAccountLoyaltyPoints(
      deps.createTenantDb(orgId),
      expiryAccount.id,
      ROLLUP_AT
    );
    const expiries = await tenant((tx) =>
      tx.loyaltyPointsEntry.findMany({ where: { accountId: expiryAccount.id, kind: 'EXPIRY' } })
    );
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
    const replay = await deps.refunds.refundTender(deps.createTenantDb(orgId), {
      originalTenderId: payment.tenderId,
      amount: '5.00',
      reason: 'partial',
      approvingStaffProfileId: ids.manager,
      actor: partialActor,
      now: M5_AT,
    });
    expect(replay.refundId).toBe(partial.refundId);
    const full = await deps.refunds.refundTender(deps.createTenantDb(orgId), {
      originalTenderId: payment.tenderId,
      amount: '7.50',
      reason: 'remainder',
      approvingStaffProfileId: ids.manager,
      actor: actor(),
      now: M5_AT,
    });
    expect(full.paymentStatus).toBe('REFUNDED');
    const committed = await tenant(async (tx) => ({
      payment: await tx.restaurantPayment.findUniqueOrThrow({ where: { id: payment.paymentId } }),
      refunds: await tx.restaurantRefund.findMany({
        where: { originalTenderId: payment.tenderId },
      }),
      reversals: await tx.loyaltyPointsEntry.findMany({ where: { reversesEntryId: earn.id } }),
    }));
    expect(committed.payment.status).toBe('REFUNDED');
    expect(committed.refunds.map((row) => row.amount.toString()).sort()).toEqual(['5', '7.5']);
    expect(committed.reversals.reduce((sum, row) => sum + row.points, 0)).toBe(-12);
    expect(committed.reversals.every((row) => row.programVersionId === programId)).toBe(true);
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
    expect(
      await tenant((tx) =>
        tx.restaurantRefund.count({ where: { originalTenderId: payment.tenderId } })
      )
    ).toBe(2);
    expect(
      await tenant((tx) => tx.loyaltyPointsEntry.count({ where: { reversesEntryId: earn.id } }))
    ).toBe(2);
  }, 60_000);

  it('runs scheduler rollup/backfill replay and replaces corrected projections exactly', async () => {
    await seedRollupRaw();
    const close = await tenant((tx) =>
      tx.restaurantDailyClose.findFirstOrThrow({
        where: { branchId: ids.branch, businessDate: new Date(`${ROLLUP_DATE}T00:00:00.000Z`) },
      })
    );
    await deps.rollups.enqueueInsightRollup(deps.createTenantDb(orgId), {
      branchId: ids.branch,
      businessDate: ROLLUP_DATE,
      sourceDailyCloseId: close.id,
    });
    const claimed = await deps.scheduler.claimNextDue(deps.createTenantDb(orgId), {
      workerId: 'wha100-rollup',
      now: ROLLUP_AT,
    });
    if (!claimed) throw new Error('Rollup job was not claimable.');
    await deps.rollups.rollupDayHandler({ db: deps.createTenantDb(orgId), job: claimed });
    expect(
      await deps.rollups.rollupDay(deps.createTenantDb(orgId), {
        branchId: ids.branch,
        businessDate: ROLLUP_DATE,
        computedAt: ROLLUP_AT,
      })
    ).toMatchObject({ replayed: true, sourceDailyCloseId: close.id });
    const first = await tenant(async (tx) => ({
      daily: await tx.insightDailyRollup.findFirstOrThrow({
        where: { branchId: ids.branch, businessDate: close.businessDate },
      }),
      item: await tx.insightItemMixRollup.findFirstOrThrow({
        where: { branchId: ids.branch, businessDate: close.businessDate, productId: ids.product },
      }),
      orders: await tx.restaurantOrder.findMany({
        where: { branchId: ids.branch, businessDate: close.businessDate, status: 'CLOSED' },
      }),
      ledger: await tx.loyaltyPointsEntry.findMany({ select: { accountId: true, points: true } }),
      program: await tx.loyaltyProgramVersion.findFirstOrThrow({
        where: { effectiveFrom: { lte: close.createdAt } },
        orderBy: { effectiveFrom: 'desc' },
      }),
    }));
    expect(first.daily).toMatchObject({
      orderCount: first.orders.length,
      coverCount: 2,
      sourceDailyCloseId: close.id,
    });
    expect(first.daily.grossSales.toString()).toBe(close.grossSales.toString());
    expect(first.daily.netSales.toString()).toBe(close.netSales.toString());
    expect(first.daily.refundTotal.toString()).toBe(close.refundTotal.toString());
    expect(first.daily.drawerVariance.toString()).toBe(close.cashVariance.toString());
    expect(first.daily.loyaltyLiability.toString()).toBe(
      deps.rollups.computeLoyaltyLiability(first.ledger, first.program.redemptionValue).toString()
    );
    expect(first.item).toMatchObject({ quantity: 2, sourceDailyCloseId: close.id });
    expect(first.item.grossSales.toString()).toBe('22');
    expect(first.item.netSales.toString()).toBe('20');
    const correctedAt = new Date('2099-08-22T12:01:00.000Z');
    const corrected = await tenant((tx) =>
      tx.restaurantDailyClose.create({
        data: {
          branchId: ids.branch,
          businessDate: close.businessDate,
          supersedesCloseId: close.id,
          correctionReason: 'rebuild',
          cutByStaffProfileId: ids.operator,
          deviceId,
          grossSales: close.grossSales,
          netSales: close.netSales,
          taxTotal: close.taxTotal,
          serviceChargeTotal: close.serviceChargeTotal,
          tipTotal: close.tipTotal,
          compTotal: close.compTotal,
          discountTotal: close.discountTotal,
          refundTotal: close.refundTotal,
          voidTotal: close.voidTotal,
          cashExpected: close.cashExpected,
          cashCounted: close.cashCounted,
          cashVariance: close.cashVariance,
          createdAt: correctedAt,
        },
      })
    );
    await deps.rollups.enqueueInsightRollup(deps.createTenantDb(orgId), {
      branchId: ids.branch,
      businessDate: ROLLUP_DATE,
      sourceDailyCloseId: corrected.id,
    });
    vi.setSystemTime(correctedAt);
    const correctionJob = await deps.scheduler.claimNextDue(deps.createTenantDb(orgId), {
      workerId: 'wha100-correction',
      now: correctedAt,
    });
    if (!correctionJob) throw new Error('Correction rollup job was not claimable.');
    await deps.rollups.rollupDayHandler({ db: deps.createTenantDb(orgId), job: correctionJob });
    expect(
      await tenant((tx) =>
        tx.insightDailyRollup.count({
          where: { branchId: ids.branch, businessDate: close.businessDate },
        })
      )
    ).toBe(1);
    expect(
      await tenant((tx) =>
        tx.insightItemMixRollup.count({
          where: { branchId: ids.branch, businessDate: close.businessDate },
        })
      )
    ).toBe(1);
    expect(
      (
        await tenant((tx) =>
          tx.insightDailyRollup.findFirstOrThrow({
            where: { branchId: ids.branch, businessDate: close.businessDate },
          })
        )
      ).sourceDailyCloseId
    ).toBe(corrected.id);
    const backfill = await api.restaurantInsights.backfill({
      branchId: ids.branch,
      from: ROLLUP_DATE,
      to: ROLLUP_DATE,
    });
    const backfillReplay = await api.restaurantInsights.backfill({
      branchId: ids.branch,
      from: ROLLUP_DATE,
      to: ROLLUP_DATE,
    });
    expect(backfill).toMatchObject({ enqueued: 1 });
    expect(backfillReplay).toMatchObject({ enqueued: 0, deduplicated: 1 });
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
    expect(operationalRead).not.toHaveProperty('labourCost');
    expect(financial[0]).not.toHaveProperty('labourCost');
    expect(financialRead).not.toHaveProperty('labourCost');
    expect(typeof financial[0]?.grossSales).toBe('string');
    expect(financial[0]?.freshness.computedAtUtc).toBe(correctedAt.toISOString());
    expect(financial[0]?.freshness.computedAtLocal).toContain('17:01:00[Asia/Karachi]');
    expect(operationalExport.content).not.toMatch(/grossSales|labour/i);
    expect(financialExport.content).toContain('grossSales');
    expect(financialExport.content).not.toMatch(/labour/i);
    const bad = { branchId: ids.branch, from: ROLLUP_DATE, to: ROLLUP_DATE, unknown: true };
    await expect(api.restaurantInsights.listFinancialReports(bad)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  }, 60_000);

  it('requires both labour grants and branch proof while ordinary reports stay closed', async () => {
    const imported = await api.restaurantInsights.importLabourCost({
      branchId: ids.branch,
      businessDate: ROLLUP_DATE,
      labourHours: '7.25',
      labourCost: '88.45',
      source: 'MANUAL',
      idempotencyKey: key('labour'),
    });
    expect(imported.fact).toMatchObject({ labourHours: '7.25', labourCost: '88.45' });
    mocks.grants.delete('workforce:rates');
    await expect(
      api.restaurantInsights.listLabourCosts({ branchId: ids.branch })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      api.restaurantInsights.readLabourCost({ id: imported.fact.id })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      api.restaurantInsights.exportLabourCosts({ branchId: ids.branch })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    mocks.grants.add('workforce:rates');
    mocks.grants.delete('reports:financial');
    await expect(
      api.restaurantInsights.listLabourCosts({ branchId: ids.branch })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    mocks.grants.add('reports:financial');
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
    mocks.grants.delete('restaurant:configure');
    await expect(api.restaurantInsights.readLabourCost({ id: other.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    mocks.grants.add('restaurant:configure');
    expect(await api.restaurantInsights.readLabourCost({ id: other.id })).toMatchObject({
      branchId: ids.branchTwo,
    });
    mocks.grants.delete('reports:operational');
    await expect(
      api.restaurantInsights.listOperationalReports({ branchId: ids.branch })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  }, 60_000);
});
