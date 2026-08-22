/**
 * WHA-100: M8 customer, loyalty, privacy, and insight acceptance battery.
 *
 * Uses public tRPC callers for API contracts and real PostgreSQL domain
 * functions only for lifecycle hooks that have no public API.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScopedDb } from "@/lib/tenancy/scoped-db";
import type { TRPCContext } from "@/server/trpc";

const mocks = vi.hoisted(() => ({
  annotateAudit: vi.fn(),
  can: vi.fn(),
  grants: new Set<string>(),
  recordTrpcAudit: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/abac", async () => {
  const actual = await vi.importActual<typeof import("@/lib/abac")>("@/lib/abac");
  return { ...actual, can: mocks.can };
});

vi.mock("@/lib/actor", async () => {
  const actual = await vi.importActual<typeof import("@/lib/actor")>("@/lib/actor");
  return { ...actual, subjectFromSession: vi.fn((session) => session?.user ?? null) };
});

vi.mock("@/lib/entitlements", () => ({
  hasModule: (entitlements: { enabledModules: string[] }, module: string) =>
    entitlements.enabledModules.includes(module),
  resolveOrganizationEntitlements: vi.fn(),
}));

vi.mock("@/server/audit", async () => {
  const actual = await vi.importActual<typeof import("@/server/audit")>("@/server/audit");
  return {
    ...actual,
    annotateAudit: (...args: Parameters<typeof actual.annotateAudit>) => {
      mocks.annotateAudit(...args);
      return actual.annotateAudit(...args);
    },
    isAuditExcludedPath: vi.fn(() => false),
    recordTrpcAudit: vi.fn(async (entry) => {
      mocks.recordTrpcAudit({
        ...entry,
        input: entry.ctx.audit?.detail.skipInput ? "[skipped]" : entry.input,
      });
    }),
  };
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeDb = TEST_DATABASE_URL ? describe : describe.skip;
const MODULES = ["restaurant-customers", "restaurant-loyalty", "restaurant-insights"];
const ALL_GRANTS = [
  "customers:read",
  "restaurant:configure",
  "loyalty:redeem",
  "reports:operational",
  "reports:financial",
  "workforce:rates",
];
const AT = new Date("2099-08-21T12:00:00.000Z");
const BUSINESS_DATE = "2099-08-21";
const ROLLUP_DATE = "2099-08-22";
const runId = randomBytes(5).toString("hex");
const id = (label: string) => `wha100_${runId}_${label}`;

type CustomersCaller = ReturnType<
  (typeof import("@/server/routers/restaurant-customers"))["restaurantCustomersRouter"]["createCaller"]
>;
type LoyaltyCaller = ReturnType<
  (typeof import("@/server/routers/restaurant-loyalty"))["restaurantLoyaltyRouter"]["createCaller"]
>;
type InsightsCaller = ReturnType<
  (typeof import("@/server/routers/restaurant-insights"))["restaurantInsightsRouter"]["createCaller"]
>;
type Api = {
  restaurantCustomers: CustomersCaller;
  restaurantInsights: InsightsCaller;
  restaurantLoyalty: LoyaltyCaller;
};

type Deps = {
  bills: typeof import("@/lib/restaurant/bills");
  createTenantDb: typeof import("@/lib/tenancy/scoped-db")["createTenantDb"];
  devices: typeof import("@/lib/restaurant/devices");
  expiry: typeof import("@/lib/restaurant/loyalty-expiry");
  loyalty: typeof import("@/lib/restaurant/loyalty");
  orders: typeof import("@/lib/restaurant/orders");
  refunds: typeof import("@/lib/restaurant/refunds");
  rollups: typeof import("@/lib/restaurant/insight-rollups");
  tenders: typeof import("@/lib/restaurant/tenders");
  withPlatformDb: typeof import("@/lib/tenancy/scoped-db")["withPlatformDb"];
  withTenantDb: typeof import("@/lib/tenancy/scoped-db")["withTenantDb"];
};

let deps: Deps;
let makeCaller: (
  organizationId?: string,
  enabledModules?: string[],
  activeCustomersMax?: number,
) => Api;
let api: Api;
let sequence = 0;

const ids = {
  branch: id("branch"),
  branchTwo: id("branch_two"),
  device: id("device"),
  manager: id("manager"),
  menu: id("menu"),
  menuItem: id("menu_item"),
  organization: id("org"),
  otherOrganization: id("other_org"),
  priceList: id("price_list"),
  priceVersion: id("price_version"),
  product: id("product"),
  publication: id("publication"),
  section: id("section"),
  staff: id("staff"),
  user: id("user"),
};

let activeProgramId = "";

function actor(key: string) {
  return {
    deviceId: ids.device,
    idempotencyKey: id(`${key}_${++sequence}`),
    staffProfileId: ids.staff,
  };
}

function tenant<T>(work: (tx: ScopedDb) => Promise<T>, organizationId = ids.organization) {
  return deps.withTenantDb(organizationId, work);
}

async function createCustomer(label: string, organizationId = ids.organization) {
  return makeCaller(organizationId).restaurantCustomers.create({
    displayName: `Customer ${label}`,
    email: `${label}.${runId}@example.com`,
    phone: `+1555${String(++sequence).padStart(7, "0")}`,
  });
}

async function enroll(customerId: string) {
  return api.restaurantLoyalty.enrollAccount({ customerId });
}

async function seedOrderBill(input: {
  billStatus: "OPEN" | "SETTLED";
  customerId?: string;
  grandTotal: string;
  orderStatus: "CANCELLED" | "CLOSED" | "OPEN";
}) {
  return tenant(async (tx) => {
    const order = await tx.restaurantOrder.create({
      data: {
        branchId: ids.branch,
        businessDate: BUSINESS_DATE,
        channel: "DINE_IN",
        closedAt: input.orderStatus === "CLOSED" ? AT : null,
        coverCount: 1,
        customerId: input.customerId,
        deviceId: ids.device,
        orderNumber: `WHA-${++sequence}`,
        staffProfileId: ids.staff,
        status: input.orderStatus,
      },
    });
    const bill = await tx.restaurantBill.create({
      data: {
        branchId: ids.branch,
        businessDate: BUSINESS_DATE,
        deviceId: ids.device,
        grandTotal: input.grandTotal,
        openerStaffProfileId: ids.staff,
        orderId: order.id,
        settledAt: input.billStatus === "SETTLED" ? AT : null,
        status: input.billStatus,
        subtotal: input.grandTotal,
      },
    });
    return { bill, order };
  });
}

async function openCardBill(customerId: string) {
  const opened = await deps.orders.openOrder(
    deps.createTenantDb(ids.organization),
    {
      branchId: ids.branch,
      channel: "DINE_IN",
      coverCount: 1,
      tableLabel: "WHA-100",
    },
    actor("open_order"),
    AT,
  );
  await tenant((tx) =>
    tx.restaurantOrder.update({ where: { id: opened.orderId }, data: { customerId } }),
  );
  await deps.orders.addItem(
    deps.createTenantDb(ids.organization),
    { menuItemId: ids.menuItem, orderId: opened.orderId, quantity: 1 },
    actor("add_item"),
    AT,
  );
  const cut = await deps.bills.cutBills(
    deps.createTenantDb(ids.organization),
    { orderId: opened.orderId },
    actor("cut_bill"),
    AT,
  );
  const paid = await deps.tenders.applyTender(
    deps.createTenantDb(ids.organization),
    { amount: "12.50", billId: cut.billIds[0]!, type: "CARD" },
    actor("card_tender"),
    AT,
  );
  return { billId: cut.billIds[0]!, orderId: opened.orderId, tenderId: paid.tenderId };
}

describeDb("WHA-100 restaurant M8 acceptance", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL!;
    process.env.PLATFORM_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AT);

    const scoped = await import("@/lib/tenancy/scoped-db");
    const [bills, devices, expiry, loyalty, orders, refunds, rollups, tenders, trpc, customerRouter, loyaltyRouter, insightsRouter] =
      await Promise.all([
        import("@/lib/restaurant/bills"),
        import("@/lib/restaurant/devices"),
        import("@/lib/restaurant/loyalty-expiry"),
        import("@/lib/restaurant/loyalty"),
        import("@/lib/restaurant/orders"),
        import("@/lib/restaurant/refunds"),
        import("@/lib/restaurant/insight-rollups"),
        import("@/lib/restaurant/tenders"),
        import("@/server/trpc"),
        import("@/server/routers/restaurant-customers"),
        import("@/server/routers/restaurant-loyalty"),
        import("@/server/routers/restaurant-insights"),
      ]);
    deps = {
      bills,
      createTenantDb: scoped.createTenantDb,
      devices,
      expiry,
      loyalty,
      orders,
      refunds,
      rollups,
      tenders,
      withPlatformDb: scoped.withPlatformDb,
      withTenantDb: scoped.withTenantDb,
    };

    await scoped.withPlatformDb(async (tx) => {
      const role = await tx.$queryRaw<Array<{ rolbypassrls: boolean }>>`
        SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user
      `;
      if (role[0]) {
        expect(role[0].rolbypassrls, "WHA-100 requires the test role to be NOBYPASSRLS").toBe(false);
      }
      await tx.organization.createMany({
        data: [
          { id: ids.organization, name: `WHA-100 ${runId}`, slug: `wha-100-${runId}` },
          {
            id: ids.otherOrganization,
            name: `WHA-100 Other ${runId}`,
            slug: `wha-100-other-${runId}`,
          },
        ],
      });
    });

    await tenant(async (tx) => {
      await tx.restaurantBranch.createMany({
        data: [
          {
            id: ids.branch,
            name: "WHA-100 Primary",
            timezone: "Asia/Karachi",
          },
          {
            id: ids.branchTwo,
            name: "WHA-100 Secondary",
            timezone: "UTC",
          },
        ],
      });
      await tx.user.create({
        data: {
          email: `wha100-${runId}@example.com`,
          id: ids.user,
          name: "WHA-100 User",
          organizationId: ids.organization,
          role: "ADMIN",
        },
      });
      await tx.restaurantStaffProfile.createMany({
        data: [
          {
            displayName: "WHA Staff",
            id: ids.staff,
            primaryBranchId: ids.branch,
            userId: ids.user,
          },
          { displayName: "WHA Manager", id: ids.manager, primaryBranchId: ids.branch },
        ],
      });
    });

    const enrolled = await devices.enrollDevice(deps.createTenantDb(ids.organization), {
      branchId: ids.branch,
      deviceId: ids.device,
      label: "WHA-100 terminal",
      platform: "WEB",
    });
    expect(enrolled.device.id).toBe(ids.device);

    await tenant(async (tx) => {
      const category = await tx.productCategory.create({ data: { name: "WHA Category" } });
      const brand = await tx.brand.create({ data: { name: "WHA Brand" } });
      await tx.product.create({
        data: {
          brandId: brand.id,
          categoryId: category.id,
          id: ids.product,
          name: "WHA Meal",
        },
      });
      await tx.restaurantMenu.create({ data: { id: ids.menu, name: "WHA Menu" } });
      await tx.restaurantMenuSection.create({
        data: { id: ids.section, menuId: ids.menu, name: "Main", sortOrder: 1 },
      });
      await tx.restaurantMenuItem.create({
        data: { id: ids.menuItem, menuId: ids.menu, productId: ids.product, sectionId: ids.section },
      });
      await tx.restaurantPriceList.create({ data: { id: ids.priceList, name: "WHA Prices" } });
      await tx.restaurantPriceListVersion.create({
        data: {
          effectiveFrom: new Date("2099-01-01T00:00:00.000Z"),
          id: ids.priceVersion,
          priceListId: ids.priceList,
          versionNumber: 1,
        },
      });
      await tx.restaurantPriceListEntry.create({
        data: { menuItemId: ids.menuItem, price: "12.50", priceListVersionId: ids.priceVersion },
      });
      await tx.restaurantBranchMenuPublication.create({
        data: {
          branchId: ids.branch,
          effectiveFrom: new Date("2099-01-01T00:00:00.000Z"),
          id: ids.publication,
          menuId: ids.menu,
          priceListVersionId: ids.priceVersion,
          status: "PUBLISHED",
        },
      });
      const program = await tx.loyaltyProgramVersion.create({
        data: {
          earnRate: "1",
          effectiveFrom: new Date("2099-01-01T00:00:00.000Z"),
          expiryDays: 30,
          redemptionValue: "0.05",
          versionNumber: 1,
        },
      });
      activeProgramId = program.id;
    });

    const acceptanceRouter = trpc.router({
      restaurantCustomers: customerRouter.restaurantCustomersRouter,
      restaurantInsights: insightsRouter.restaurantInsightsRouter,
      restaurantLoyalty: loyaltyRouter.restaurantLoyaltyRouter,
    });
    makeCaller = (
      organizationId = ids.organization,
      enabledModules = MODULES,
      activeCustomersMax = 100,
    ) =>
      acceptanceRouter.createCaller({
        audit: {},
        db: scoped.createTenantDb(organizationId),
        entitlements: {
          enabledModules,
          limits: { "loyalty.activeCustomers.max": activeCustomersMax },
          modules: [],
          organizationId,
          plan: "PROFESSIONAL",
        },
        headers: new Headers(),
        organization: null,
        requestId: id(`request_${++sequence}`),
        session: {
          expires: "2099-12-31T00:00:00.000Z",
          user: {
            email: `wha100-${runId}@example.com`,
            id: ids.user,
            name: "WHA-100 User",
            organizationId,
            role: "ADMIN",
            status: "ACTIVE",
          },
        },
      } satisfies TRPCContext) as unknown as Api;
    api = makeCaller();
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.grants.clear();
    for (const grant of ALL_GRANTS) mocks.grants.add(grant);
    mocks.can.mockImplementation(async (_subject, action) => mocks.grants.has(String(action)));
    api = makeCaller();
  });

  afterAll(async () => {
    if (!deps) return;
    await deps.withPlatformDb((tx) =>
      tx.organization.deleteMany({
        where: { id: { in: [ids.organization, ids.otherOrganization] } },
      }),
    );
    vi.useRealTimers();
  }, 60_000);

  it("deduplicates normalized identifiers per organization and enforces latest consent plus immutable history", async () => {
    const email = `  Mixed.Case.${runId}@Example.COM `;
    const customer = await api.restaurantCustomers.create({ displayName: "First", email });

    await expect(
      api.restaurantCustomers.create({
        displayName: "Duplicate",
        email: `mixed.case.${runId}@example.com`,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const crossOrg = await makeCaller(ids.otherOrganization).restaurantCustomers.create({
      displayName: "Other organization",
      email: `mixed.case.${runId}@example.com`,
    });
    expect(crossOrg.customer.id).not.toBe(customer.customer.id);

    let detail = await api.restaurantCustomers.detail({ customerId: customer.customer.id });
    expect(detail.currentConsent.EMAIL?.granted ?? false).toBe(false);
    expect(detail.consentHistory).toEqual([]);

    const granted = await api.restaurantCustomers.appendConsent({
      channel: "EMAIL",
      customerId: customer.customer.id,
      granted: true,
      source: "POS",
    });
    const revoked = await api.restaurantCustomers.appendConsent({
      channel: "EMAIL",
      customerId: customer.customer.id,
      granted: false,
      source: "CUSTOMER_REQUEST",
    });
    detail = await api.restaurantCustomers.detail({ customerId: customer.customer.id });
    expect(detail.currentConsent.EMAIL).toMatchObject({
      actorId: ids.user,
      granted: false,
      id: revoked.id,
      source: "CUSTOMER_REQUEST",
    });
    expect(detail.consentHistory.map((row) => row.id)).toEqual([revoked.id, granted.id]);

    await expect(
      tenant((tx) =>
        tx.customerConsent.update({ where: { id: granted.id }, data: { granted: false } }),
      ),
    ).rejects.toBeDefined();
    await expect(
      tenant((tx) => tx.customerConsent.delete({ where: { id: granted.id } })),
    ).rejects.toBeDefined();
    expect(
      await tenant((tx) => tx.customerConsent.findUniqueOrThrow({ where: { id: granted.id } })),
    ).toMatchObject({ actorId: ids.user, granted: true, source: "POS" });

    await expect(
      api.restaurantCustomers.create({ displayName: "Strict", surprise: true } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    mocks.grants.delete("customers:read");
    await expect(api.restaurantCustomers.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    mocks.grants.add("customers:read");
    await expect(makeCaller(ids.organization, []).restaurantCustomers.list({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  }, 60_000);

  it("exports exactly one customer with PII-safe audit and anonymizes idempotently without changing retained rows", async () => {
    const target = await createCustomer("privacy-target");
    const other = await createCustomer("privacy-other");
    const tag = await api.restaurantCustomers.createTag({ name: `VIP ${runId}` });
    await api.restaurantCustomers.assignTag({ customerId: target.customer.id, tagId: tag.id });
    await api.restaurantCustomers.appendConsent({
      channel: "SMS",
      customerId: target.customer.id,
      granted: true,
      source: "POS",
    });
    const account = await enroll(target.customer.id);
    await api.restaurantLoyalty.adjust({ accountId: account.id, points: 15, reason: "privacy fixture" });
    const money = await seedOrderBill({
      billStatus: "SETTLED",
      customerId: target.customer.id,
      grandTotal: "12.34",
      orderStatus: "CLOSED",
    });

    const before = await tenant(async (tx) => ({
      bill: await tx.restaurantBill.findUniqueOrThrow({ where: { id: money.bill.id } }),
      consents: await tx.customerConsent.findMany({
        where: { customerId: target.customer.id },
        orderBy: { id: "asc" },
      }),
      ledger: await tx.loyaltyPointsEntry.findMany({
        where: { accountId: account.id },
        orderBy: { id: "asc" },
      }),
      order: await tx.restaurantOrder.findUniqueOrThrow({ where: { id: money.order.id } }),
      program: await tx.loyaltyProgramVersion.findUniqueOrThrow({ where: { id: activeProgramId } }),
    }));

    mocks.annotateAudit.mockClear();
    mocks.recordTrpcAudit.mockClear();
    const exported = await api.restaurantCustomers.export({ customerId: target.customer.id });
    const serialized = JSON.stringify(exported);
    expect(exported.customer.id).toBe(target.customer.id);
    expect(serialized).not.toContain(other.customer.id);
    expect(exported.financialHistory.bills[0]?.grandTotal).toBe("12.34");
    expect(mocks.annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetId: target.customer.id, targetType: "restaurant_customer" }),
    );
    expect(JSON.stringify(mocks.annotateAudit.mock.calls)).not.toContain(target.customer.email!);
    expect(mocks.recordTrpcAudit).toHaveBeenCalledWith(
      expect.objectContaining({ input: "[skipped]" }),
    );

    const first = await api.restaurantCustomers.anonymize({ customerId: target.customer.id });
    const replay = await api.restaurantCustomers.anonymize({ customerId: target.customer.id });
    expect(replay).toEqual(first);

    const after = await tenant(async (tx) => ({
      account: await tx.loyaltyAccount.findUniqueOrThrow({ where: { id: account.id } }),
      bill: await tx.restaurantBill.findUniqueOrThrow({ where: { id: money.bill.id } }),
      consents: await tx.customerConsent.findMany({
        where: { customerId: target.customer.id },
        orderBy: { id: "asc" },
      }),
      customer: await tx.restaurantCustomer.findUniqueOrThrow({ where: { id: target.customer.id } }),
      identifierCount: await tx.customerIdentifier.count({ where: { customerId: target.customer.id } }),
      ledger: await tx.loyaltyPointsEntry.findMany({
        where: { accountId: account.id },
        orderBy: { id: "asc" },
      }),
      order: await tx.restaurantOrder.findUniqueOrThrow({ where: { id: money.order.id } }),
      program: await tx.loyaltyProgramVersion.findUniqueOrThrow({ where: { id: activeProgramId } }),
      tagCount: await tx.customerTagAssignment.count({ where: { customerId: target.customer.id } }),
    }));
    expect(after.customer).toMatchObject({
      anonymizedAt: first.anonymizedAt,
      displayName: null,
      email: null,
      notes: null,
      phone: null,
    });
    expect(after.identifierCount).toBe(0);
    expect(after.tagCount).toBe(0);
    expect(after.account.active).toBe(false);
    expect(after.bill).toEqual(before.bill);
    expect(after.order).toEqual(before.order);
    expect(after.consents).toEqual(before.consents);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.program).toEqual(before.program);
  }, 60_000);

  it("appends program versions, rejects effective mutations, enforces active-account max, and keeps signed balances exact", async () => {
    const configured = await api.restaurantLoyalty.configure({
      earnRate: "2.5",
      effectiveFrom: "2099-09-01T00:00:00.000Z",
      expiryDays: 60,
      redemptionValue: "0.02",
    });
    expect(configured).toMatchObject({
      earnRate: "2.5",
      redemptionValue: "0.02",
      versionNumber: 2,
    });
    const programs = await api.restaurantLoyalty.listPrograms({});
    expect(programs.map((program) => program.versionNumber)).toEqual([2, 1]);
    expect(programs[0]).toMatchObject({ earnRate: "2.5", redemptionValue: "0.02" });

    await expect(
      api.restaurantLoyalty.configure({
        earnRate: "1",
        effectiveFrom: "2099-10-01T00:00:00.000Z",
        redemptionValue: "0.05",
        surprise: true,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await expect(
      tenant(async (tx) => {
        const row = await tx.loyaltyProgramVersion.create({
          data: {
            earnRate: "1",
            effectiveFrom: new Date("2000-01-01T00:00:00.000Z"),
            redemptionValue: "0.05",
            versionNumber: 900,
          },
        });
        return tx.loyaltyProgramVersion.update({
          where: { id: row.id },
          data: { earnRate: "9" },
        });
      }),
    ).rejects.toBeDefined();
    await expect(
      tenant(async (tx) => {
        const row = await tx.loyaltyProgramVersion.create({
          data: {
            earnRate: "1",
            effectiveFrom: new Date("2000-01-02T00:00:00.000Z"),
            redemptionValue: "0.05",
            versionNumber: 901,
          },
        });
        return tx.loyaltyProgramVersion.delete({ where: { id: row.id } });
      }),
    ).rejects.toBeDefined();

    const activeBefore = await tenant((tx) => tx.loyaltyAccount.count({ where: { active: true } }));
    const first = await createCustomer("limit-first");
    const second = await createCustomer("limit-second");
    const limited = makeCaller(ids.organization, MODULES, activeBefore + 1);
    const account = await limited.restaurantLoyalty.enrollAccount({ customerId: first.customer.id });
    await expect(
      limited.restaurantLoyalty.enrollAccount({ customerId: second.customer.id }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const plus = await api.restaurantLoyalty.adjust({
      accountId: account.id,
      points: 10,
      reason: "exact positive",
    });
    const minus = await api.restaurantLoyalty.adjust({
      accountId: account.id,
      points: -3,
      reason: "exact negative",
    });
    expect([plus.points, minus.points]).toEqual([10, -3]);
    expect((await api.restaurantLoyalty.getAccount({ accountId: account.id })).balance).toBe(7);
  }, 60_000);

  it("earns once only on settled close, redeems exact Decimal value with denials, and expires FIFO idempotently", async () => {
    const customer = await createCustomer("loyalty-flow");
    const account = await enroll(customer.customer.id);
    const closed = await seedOrderBill({
      billStatus: "SETTLED",
      customerId: customer.customer.id,
      grandTotal: "12.34",
      orderStatus: "CLOSED",
    });
    const earned = await deps.loyalty.earnLoyaltyForClosedOrder(
      deps.createTenantDb(ids.organization),
      closed.order.id,
      AT,
    );
    const replay = await deps.loyalty.earnLoyaltyForClosedOrder(
      deps.createTenantDb(ids.organization),
      closed.order.id,
      AT,
    );
    expect(earned).toHaveLength(1);
    expect(earned[0]).toMatchObject({ points: 12, programVersionId: activeProgramId });
    expect(replay).toEqual([]);
    expect(
      await tenant((tx) =>
        tx.loyaltyPointsEntry.count({ where: { billId: closed.bill.id, kind: "EARN" } }),
      ),
    ).toBe(1);

    const cancelled = await seedOrderBill({
      billStatus: "SETTLED",
      customerId: customer.customer.id,
      grandTotal: "50.00",
      orderStatus: "CANCELLED",
    });
    expect(
      await deps.loyalty.earnLoyaltyForClosedOrder(
        deps.createTenantDb(ids.organization),
        cancelled.order.id,
        AT,
      ),
    ).toEqual([]);

    await api.restaurantLoyalty.adjust({ accountId: account.id, points: 100, reason: "redeem fixture" });
    const open = await seedOrderBill({
      billStatus: "OPEN",
      customerId: customer.customer.id,
      grandTotal: "10.00",
      orderStatus: "OPEN",
    });
    const redeemed = await api.restaurantLoyalty.redeem({
      accountId: account.id,
      billId: open.bill.id,
      idempotencyKey: id("redeem_exact"),
      points: 20,
    });
    expect(redeemed).toMatchObject({ points: -20, value: "1.00" });
    expect(
      await tenant((tx) => tx.restaurantBill.findUniqueOrThrow({ where: { id: open.bill.id } })),
    ).toMatchObject({ discountTotal: "1", grandTotal: "9" });
    await expect(
      api.restaurantLoyalty.redeem({
        accountId: account.id,
        billId: open.bill.id,
        idempotencyKey: id("redeem_insufficient"),
        points: 999_999,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const tiny = await seedOrderBill({
      billStatus: "OPEN",
      customerId: customer.customer.id,
      grandTotal: "0.50",
      orderStatus: "OPEN",
    });
    await expect(
      api.restaurantLoyalty.redeem({
        accountId: account.id,
        billId: tiny.bill.id,
        idempotencyKey: id("redeem_over_bill"),
        points: 20,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const expiryCustomer = await createCustomer("expiry-flow");
    const expiryAccount = await enroll(expiryCustomer.customer.id);
    await tenant(async (tx) => {
      await tx.loyaltyPointsEntry.createMany({
        data: [
          {
            accountId: expiryAccount.id,
            expiresAt: new Date("2099-08-20T00:00:00.000Z"),
            idempotencyKey: id("expiry_earn_1"),
            kind: "EARN",
            occurredAt: new Date("2099-01-01T00:00:00.000Z"),
            points: 5,
            programVersionId: activeProgramId,
          },
          {
            accountId: expiryAccount.id,
            expiresAt: new Date("2099-08-20T00:00:00.000Z"),
            idempotencyKey: id("expiry_earn_2"),
            kind: "EARN",
            occurredAt: new Date("2099-02-01T00:00:00.000Z"),
            points: 7,
            programVersionId: activeProgramId,
          },
          {
            accountId: expiryAccount.id,
            idempotencyKey: id("expiry_redeem"),
            kind: "REDEEM",
            occurredAt: new Date("2099-03-01T00:00:00.000Z"),
            points: -6,
            programVersionId: activeProgramId,
          },
        ],
      });
    });
    await deps.expiry.expireLoyaltyPoints(deps.createTenantDb(ids.organization), AT);
    await deps.expiry.expireLoyaltyPoints(deps.createTenantDb(ids.organization), AT);
    const expiries = await tenant((tx) =>
      tx.loyaltyPointsEntry.findMany({
        where: { accountId: expiryAccount.id, kind: "EXPIRY" },
        orderBy: { occurredAt: "asc" },
      }),
    );
    expect(expiries).toHaveLength(1);
    expect(expiries[0]).toMatchObject({ points: -6, programVersionId: activeProgramId });
    expect((await api.restaurantLoyalty.getAccount({ accountId: expiryAccount.id })).balance).toBe(0);
    await expect(
      deps.expiry.loyaltyExpiryHandler({
        db: deps.createTenantDb(ids.organization),
        job: { payload: { at: AT.toISOString(), surprise: true } },
      } as never),
    ).rejects.toBeDefined();
  }, 60_000);

  it("reverses partial then full refunds inside the M5 transaction, capped, pinned, atomic, and idempotent", async () => {
    const customer = await createCustomer("refund-flow");
    const account = await enroll(customer.customer.id);
    const payment = await openCardBill(customer.customer.id);
    const earn = await tenant((tx) =>
      tx.loyaltyPointsEntry.create({
        data: {
          accountId: account.id,
          billId: payment.billId,
          idempotencyKey: id("refund_earn"),
          kind: "EARN",
          occurredAt: new Date("2099-08-21T10:00:00.000Z"),
          points: 12,
          programVersionId: activeProgramId,
        },
      }),
    );
    await tenant(async (tx) => {
      const latest = await tx.loyaltyProgramVersion.findFirstOrThrow({
        orderBy: { versionNumber: "desc" },
      });
      await tx.loyaltyProgramVersion.create({
        data: {
          earnRate: "9",
          effectiveFrom: new Date("2099-08-21T11:00:00.000Z"),
          redemptionValue: "0.02",
          versionNumber: latest.versionNumber + 1,
        },
      });
    });

    const partialActor = actor("partial_refund");
    const partial = await deps.refunds.refundTender(
      deps.createTenantDb(ids.organization),
      {
        amount: "6.25",
        approvingStaffProfileId: ids.manager,
        originalTenderId: payment.tenderId,
        reason: "Partial",
      },
      partialActor,
      AT,
    );
    const partialReplay = await deps.refunds.refundTender(
      deps.createTenantDb(ids.organization),
      {
        amount: "6.25",
        approvingStaffProfileId: ids.manager,
        originalTenderId: payment.tenderId,
        reason: "Partial",
      },
      partialActor,
      AT,
    );
    expect(partialReplay.refundId).toBe(partial.refundId);

    const full = await deps.refunds.refundTender(
      deps.createTenantDb(ids.organization),
      {
        amount: "6.25",
        approvingStaffProfileId: ids.manager,
        originalTenderId: payment.tenderId,
        reason: "Remainder",
      },
      actor("full_refund"),
      AT,
    );
    expect(full.refundId).not.toBe(partial.refundId);
    const committed = await tenant(async (tx) => ({
      bill: await tx.restaurantBill.findUniqueOrThrow({ where: { id: payment.billId } }),
      refunds: await tx.restaurantRefund.findMany({
        where: { originalTenderId: payment.tenderId },
        orderBy: { createdAt: "asc" },
      }),
      reversals: await tx.loyaltyPointsEntry.findMany({
        where: { reversesEntryId: earn.id },
        orderBy: { occurredAt: "asc" },
      }),
    }));
    expect(committed.bill.status).toBe("REFUNDED");
    expect(committed.refunds.map((refund) => refund.amount.toFixed(2))).toEqual(["6.25", "6.25"]);
    expect(committed.reversals.map((entry) => entry.points)).toEqual([-6, -6]);
    expect(committed.reversals.every((entry) => entry.programVersionId === activeProgramId)).toBe(true);
    expect(committed.reversals.reduce((sum, entry) => sum + entry.points, 0)).toBe(-earn.points);

    await expect(
      deps.refunds.refundTender(
        deps.createTenantDb(ids.organization),
        {
          amount: "0.01",
          approvingStaffProfileId: ids.manager,
          originalTenderId: payment.tenderId,
          reason: "Over cap",
        },
        actor("over_refund"),
        AT,
      ),
    ).rejects.toBeDefined();
    expect(
      await tenant((tx) => tx.restaurantRefund.count({ where: { originalTenderId: payment.tenderId } })),
    ).toBe(2);
    expect(
      await tenant((tx) => tx.loyaltyPointsEntry.count({ where: { reversesEntryId: earn.id } })),
    ).toBe(2);
  }, 60_000);

  it("replays rollup/backfill exactly from raw facts and replaces a corrected close without leaking labour", async () => {
    const computedAt = new Date("2099-08-22T12:00:00.000Z");
    const raw = await tenant(async (tx) => {
      const order = await tx.restaurantOrder.create({
        data: {
          branchId: ids.branch,
          businessDate: ROLLUP_DATE,
          channel: "DINE_IN",
          closedAt: computedAt,
          coverCount: 2,
          deviceId: ids.device,
          orderNumber: `ROLLUP-${++sequence}`,
          staffProfileId: ids.staff,
          status: "CLOSED",
        },
      });
      const item = await tx.restaurantOrderItem.create({
        data: {
          name: "WHA Meal",
          orderId: order.id,
          productId: ids.product,
          quantity: 2,
          status: "SERVED",
          unitPrice: "10.00",
        },
      });
      await tx.restaurantOrderItemModifier.create({
        data: { name: "Extra", orderItemId: item.id, priceDelta: "1.00" },
      });
      const bill = await tx.restaurantBill.create({
        data: {
          branchId: ids.branch,
          businessDate: ROLLUP_DATE,
          compTotal: "2.00",
          deviceId: ids.device,
          discountTotal: "1.00",
          grandTotal: "22.00",
          openerStaffProfileId: ids.staff,
          orderId: order.id,
          serviceChargeTotal: "2.00",
          settledAt: computedAt,
          status: "SETTLED",
          subtotal: "22.00",
          taxTotal: "1.00",
        },
      });
      await tx.restaurantBillLine.create({
        data: {
          billId: bill.id,
          compAmount: "2.00",
          lineSubtotal: "22.00",
          lineTotal: "20.00",
          name: "WHA Meal",
          orderItemId: item.id,
          quantity: 2,
          serviceChargeAmount: "0.00",
          taxAmount: "0.00",
          unitPrice: "10.00",
        },
      });
      await tx.restaurantBill.create({
        data: {
          branchId: ids.branch,
          businessDate: ROLLUP_DATE,
          deviceId: ids.device,
          grandTotal: "5.00",
          openerStaffProfileId: ids.staff,
          orderId: order.id,
          status: "VOID",
          subtotal: "5.00",
        },
      });
      const tender = await tx.restaurantTender.create({
        data: {
          amount: "22.00",
          billId: bill.id,
          businessDate: ROLLUP_DATE,
          deviceId: ids.device,
          staffProfileId: ids.staff,
          tipAmount: "3.00",
          type: "CASH",
        },
      });
      const coAuth = await tx.restaurantCoAuth.create({
        data: {
          approvingStaffProfileId: ids.manager,
          deviceId: ids.device,
          operation: "REFUND",
          requestingStaffProfileId: ids.staff,
        },
      });
      await tx.restaurantRefund.create({
        data: {
          amount: "4.00",
          billId: bill.id,
          businessDate: ROLLUP_DATE,
          coAuthId: coAuth.id,
          deviceId: ids.device,
          originalTenderId: tender.id,
          reason: "Rollup fixture",
          staffProfileId: ids.staff,
        },
      });
      const drawer = await tx.restaurantDrawerSession.create({
        data: {
          branchId: ids.branch,
          businessDate: ROLLUP_DATE,
          closedAt: computedAt,
          countedCash: "119.00",
          deviceId: ids.device,
          expectedCash: "120.00",
          openedAt: new Date("2099-08-22T08:00:00.000Z"),
          openingFloat: "100.00",
          staffProfileId: ids.staff,
          status: "CLOSED",
          variance: "-1.00",
        },
      });
      await tx.restaurantDrawerMovement.createMany({
        data: [
          {
            amount: "100.00",
            deviceId: ids.device,
            drawerSessionId: drawer.id,
            kind: "OPENING_FLOAT",
            staffProfileId: ids.staff,
          },
          {
            amount: "20.00",
            deviceId: ids.device,
            drawerSessionId: drawer.id,
            kind: "CASH_SALE",
            staffProfileId: ids.staff,
          },
        ],
      });
      const close = await tx.restaurantDailyClose.create({
        data: {
          branchId: ids.branch,
          businessDate: ROLLUP_DATE,
          cashCounted: "119.00",
          cashExpected: "120.00",
          cashVariance: "-1.00",
          compTotal: "2.00",
          createdAt: computedAt,
          cutByStaffProfileId: ids.staff,
          deviceId: ids.device,
          discountTotal: "1.00",
          grossSales: "22.00",
          netSales: "19.00",
          refundTotal: "4.00",
          serviceChargeTotal: "2.00",
          taxTotal: "1.00",
          tipTotal: "3.00",
          voidTotal: "5.00",
        },
      });
      return { close, item };
    });

    await deps.rollups.rollupDayHandler({
      db: deps.createTenantDb(ids.organization),
      job: { payload: { branchId: ids.branch, businessDate: ROLLUP_DATE } },
    } as never);
    expect(
      await deps.rollups.rollupDay(deps.createTenantDb(ids.organization), {
        branchId: ids.branch,
        businessDate: ROLLUP_DATE,
        computedAt,
      }),
    ).toMatchObject({ replayed: true });

    const projected = await tenant(async (tx) => ({
      daily: await tx.insightDailyRollup.findFirstOrThrow({
        where: { branchId: ids.branch, businessDate: new Date(`${ROLLUP_DATE}T00:00:00.000Z`) },
      }),
      itemMix: await tx.insightItemMixRollup.findMany({
        where: { branchId: ids.branch, businessDate: new Date(`${ROLLUP_DATE}T00:00:00.000Z`) },
      }),
      ledger: await tx.loyaltyPointsEntry.findMany(),
      program: await tx.loyaltyProgramVersion.findFirstOrThrow({
        orderBy: [{ effectiveFrom: "desc" }, { versionNumber: "desc" }],
        where: { effectiveFrom: { lte: computedAt } },
      }),
    }));
    const expectedLiability = deps.rollups.computeLoyaltyLiability(
      projected.ledger,
      projected.program.redemptionValue,
    );
    expect({
      cashCounted: projected.daily.cashCounted.toFixed(2),
      cashExpected: projected.daily.cashExpected.toFixed(2),
      cashVariance: projected.daily.cashVariance.toFixed(2),
      compTotal: projected.daily.compTotal.toFixed(2),
      discountTotal: projected.daily.discountTotal.toFixed(2),
      grossSales: projected.daily.grossSales.toFixed(2),
      loyaltyLiability: projected.daily.loyaltyLiability.toFixed(2),
      netSales: projected.daily.netSales.toFixed(2),
      refundTotal: projected.daily.refundTotal.toFixed(2),
      serviceChargeTotal: projected.daily.serviceChargeTotal.toFixed(2),
      taxTotal: projected.daily.taxTotal.toFixed(2),
      tipTotal: projected.daily.tipTotal.toFixed(2),
      voidTotal: projected.daily.voidTotal.toFixed(2),
    }).toEqual({
      cashCounted: "119.00",
      cashExpected: "120.00",
      cashVariance: "-1.00",
      compTotal: "2.00",
      discountTotal: "1.00",
      grossSales: "22.00",
      loyaltyLiability: expectedLiability.toFixed(2),
      netSales: "19.00",
      refundTotal: "4.00",
      serviceChargeTotal: "2.00",
      taxTotal: "1.00",
      tipTotal: "3.00",
      voidTotal: "5.00",
    });
    expect(projected.daily.orderCount).toBe(1);
    expect(projected.daily.coverCount).toBe(2);
    expect(projected.itemMix).toHaveLength(1);
    expect(projected.itemMix[0]).toMatchObject({ itemId: ids.product, itemName: "WHA Meal" });
    expect(projected.itemMix[0]!.quantity.toString()).toBe("2");
    expect(projected.itemMix[0]!.netSales.toFixed(2)).toBe("20.00");

    const firstBackfill = await deps.rollups.enqueueInsightBackfill(
      deps.createTenantDb(ids.organization),
      { branchId: ids.branch, from: ROLLUP_DATE, to: ROLLUP_DATE },
    );
    const replayBackfill = await deps.rollups.enqueueInsightBackfill(
      deps.createTenantDb(ids.organization),
      { branchId: ids.branch, from: ROLLUP_DATE, to: ROLLUP_DATE },
    );
    expect(firstBackfill).toMatchObject({ enqueued: 1 });
    expect(replayBackfill).toMatchObject({ deduplicated: 1, enqueued: 0 });

    const correction = await tenant((tx) =>
      tx.restaurantDailyClose.create({
        data: {
          branchId: ids.branch,
          businessDate: ROLLUP_DATE,
          cashCounted: "119.00",
          cashExpected: "120.00",
          cashVariance: "-1.00",
          compTotal: "2.00",
          correctionReason: "WHA correction",
          createdAt: new Date("2099-08-22T12:01:00.000Z"),
          cutByStaffProfileId: ids.staff,
          deviceId: ids.device,
          discountTotal: "1.00",
          grossSales: "22.00",
          netSales: "19.00",
          refundTotal: "4.00",
          serviceChargeTotal: "2.00",
          supersedesCloseId: raw.close.id,
          taxTotal: "1.00",
          tipTotal: "3.00",
          voidTotal: "5.00",
        },
      }),
    );
    expect(
      await deps.rollups.rollupDay(deps.createTenantDb(ids.organization), {
        branchId: ids.branch,
        businessDate: ROLLUP_DATE,
        computedAt: new Date("2099-08-22T12:01:00.000Z"),
      }),
    ).toMatchObject({ replayed: false, sourceDailyCloseId: correction.id });
    expect(
      await tenant((tx) =>
        tx.insightDailyRollup.count({
          where: { branchId: ids.branch, businessDate: new Date(`${ROLLUP_DATE}T00:00:00.000Z`) },
        }),
      ),
    ).toBe(1);
    expect(
      await tenant((tx) =>
        tx.insightItemMixRollup.count({
          where: { branchId: ids.branch, businessDate: new Date(`${ROLLUP_DATE}T00:00:00.000Z`) },
        }),
      ),
    ).toBe(1);

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
    const operationalCsv = await api.restaurantInsights.exportOperationalReports({
      branchId: ids.branch,
      from: ROLLUP_DATE,
      to: ROLLUP_DATE,
    });
    const financialCsv = await api.restaurantInsights.exportFinancialReports({
      branchId: ids.branch,
      from: ROLLUP_DATE,
      to: ROLLUP_DATE,
    });
    expect(operational.rows[0]).not.toHaveProperty("grossSales");
    expect(operational.rows[0]).not.toHaveProperty("labourCost");
    expect(operationalRead).not.toHaveProperty("labourCost");
    expect(financial.rows[0]).toMatchObject({
      grossSales: "22.00",
      loyaltyLiability: expectedLiability.toFixed(2),
      netSales: "19.00",
      refundTotal: "4.00",
    });
    expect(financial.rows[0]).not.toHaveProperty("labourCost");
    expect(financialRead).not.toHaveProperty("labourCost");
    expect(financial.rows[0]!.computedAtUtc).toBe("2099-08-22T12:01:00.000Z");
    expect(financial.rows[0]!.computedAtLocal).toContain("17:01");
    expect(operationalCsv.csv).not.toMatch(/grossSales|labour/i);
    expect(financialCsv.csv).toContain("grossSales");
    expect(financialCsv.csv).not.toMatch(/labour/i);
    await expect(
      api.restaurantInsights.listFinancialReports({
        branchId: ids.branch,
        from: ROLLUP_DATE,
        surprise: true,
        to: ROLLUP_DATE,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  }, 60_000);

  it("fails closed on insight capabilities and branches, exposing labour only with both required grants", async () => {
    const imported = await api.restaurantInsights.importLabourCost({
      branchId: ids.branch,
      businessDate: ROLLUP_DATE,
      idempotencyKey: id("labour_import"),
      labourCost: "88.45",
      labourHours: "7.25",
      source: "MANUAL",
    });
    expect(imported).toMatchObject({ labourCost: "88.45", labourHours: "7.25" });

    mocks.grants.delete("workforce:rates");
    await expect(
      api.restaurantInsights.listLabourCosts({
        branchId: ids.branch,
        from: ROLLUP_DATE,
        to: ROLLUP_DATE,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      api.restaurantInsights.readLabourCost({ labourCostFactId: imported.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      api.restaurantInsights.exportLabourCosts({
        branchId: ids.branch,
        from: ROLLUP_DATE,
        to: ROLLUP_DATE,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    mocks.grants.add("workforce:rates");
    mocks.grants.delete("reports:financial");
    await expect(
      api.restaurantInsights.listLabourCosts({
        branchId: ids.branch,
        from: ROLLUP_DATE,
        to: ROLLUP_DATE,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    mocks.grants.add("reports:financial");
    const listed = await api.restaurantInsights.listLabourCosts({
      branchId: ids.branch,
      from: ROLLUP_DATE,
      to: ROLLUP_DATE,
    });
    const read = await api.restaurantInsights.readLabourCost({ labourCostFactId: imported.id });
    const csv = await api.restaurantInsights.exportLabourCosts({
      branchId: ids.branch,
      from: ROLLUP_DATE,
      to: ROLLUP_DATE,
    });
    expect(listed.rows[0]).toMatchObject({ labourCost: "88.45", labourHours: "7.25" });
    expect(read).toMatchObject({ labourCost: "88.45", labourHours: "7.25" });
    expect(csv.csv).toContain("88.45");

    const otherBranchFact = await tenant((tx) =>
      tx.labourCostFact.create({
        data: {
          branchId: ids.branchTwo,
          businessDate: new Date(`${ROLLUP_DATE}T00:00:00.000Z`),
          idempotencyKey: id("other_branch_labour"),
          labourCost: "10.00",
          labourHours: "1.00",
          source: "MANUAL",
        },
      }),
    );
    mocks.grants.delete("restaurant:configure");
    await expect(
      api.restaurantInsights.readLabourCost({ labourCostFactId: otherBranchFact.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    mocks.grants.add("restaurant:configure");
    expect(
      await api.restaurantInsights.readLabourCost({ labourCostFactId: otherBranchFact.id }),
    ).toMatchObject({ branchId: ids.branchTwo });

    mocks.grants.delete("reports:operational");
    await expect(
      api.restaurantInsights.listOperationalReports({
        branchId: ids.branch,
        from: ROLLUP_DATE,
        to: ROLLUP_DATE,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    mocks.grants.add("reports:operational");
    await expect(
      makeCaller(ids.organization, []).restaurantInsights.listOperationalReports({
        branchId: ids.branch,
        from: ROLLUP_DATE,
        to: ROLLUP_DATE,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);
});
