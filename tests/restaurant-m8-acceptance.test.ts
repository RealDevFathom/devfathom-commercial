/** WHA-100 — independent M8 API, privacy, and reconciliation acceptance. */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { TRPCContext } from '@/server/trpc';

const mocks = vi.hoisted(() => ({
  can: vi.fn<(subject: unknown, action: string) => Promise<boolean>>(() => Promise.resolve(true)),
  hasModule: vi.fn(() => true),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/lib/entitlements', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements')>('@/lib/entitlements');
  return { ...actual, hasModule: mocks.hasModule };
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha100_${suffix}`;
const otherOrgId = `org_wha100_other_${suffix}`;
const ids = {
  branch: `branch_wha100_${suffix}`,
  otherBranch: `branch_wha100_other_${suffix}`,
  user: `user_wha100_${suffix}`,
  otherUser: `user_wha100_other_${suffix}`,
  staff: `staff_wha100_${suffix}`,
  otherStaff: `staff_wha100_other_${suffix}`,
  product: `product_wha100_${suffix}`,
};
const T0 = new Date('2026-08-20T12:00:00.000Z');
const businessDate = new Date('2026-08-20T00:00:00.000Z');
const D = (value: string | number | Prisma.Decimal) => new Prisma.Decimal(value);
const eqDecimal = (actual: unknown, expected: string | number | Prisma.Decimal) =>
  expect(D(String(actual)).equals(expected)).toBe(true);

type CustomersCaller = ReturnType<
  (typeof import('@/server/routers/restaurant-customers'))['restaurantCustomersRouter']['createCaller']
>;
type LoyaltyCaller = ReturnType<
  (typeof import('@/server/routers/restaurant-loyalty'))['restaurantLoyaltyRouter']['createCaller']
>;
type InsightsCaller = ReturnType<
  (typeof import('@/server/routers/restaurant-insights'))['restaurantInsightsRouter']['createCaller']
>;
type Api = { customers: CustomersCaller; loyalty: LoyaltyCaller; insights: InsightsCaller };

type Deps = {
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  customers: typeof import('@/lib/restaurant/customers');
  loyalty: typeof import('@/lib/restaurant/loyalty');
  loyaltyExpiry: typeof import('@/lib/restaurant/loyalty-expiry');
  insightRollups: typeof import('@/lib/restaurant/insight-rollups');
  scheduler: typeof import('@/lib/restaurant/scheduler');
  audit: typeof import('@/server/audit');
  routers: {
    customers: typeof import('@/server/routers/restaurant-customers');
    loyalty: typeof import('@/server/routers/restaurant-loyalty');
    insights: typeof import('@/server/routers/restaurant-insights');
  };
};

let deps: Deps;
let api: Api;
let otherApi: Api;
let customerId: string;
let loyaltyAccountId: string;

const context = (organizationId: string, userId: string, activeCustomersMax = 10) =>
  ({
    db: deps.createTenantDb(organizationId),
    entitlements: {
      enabledModules: ['restaurant-pos'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
      limits: { 'loyalty.activeCustomers.max': activeCustomersMax },
    },
    session: {
      expires: 'later',
      user: {
        id: userId,
        name: 'WHA-100 operator',
        email: `operator-${suffix}@example.test`,
        role: 'EMPLOYEE',
        department: 'QUALITY',
        status: 'ACTIVE',
        organizationId,
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  }) as unknown as TRPCContext;

const callers = (organizationId: string, userId: string, activeCustomersMax = 10): Api => {
  const ctx = context(organizationId, userId, activeCustomersMax);
  return {
    customers: deps.routers.customers.restaurantCustomersRouter.createCaller(ctx),
    loyalty: deps.routers.loyalty.restaurantLoyaltyRouter.createCaller(ctx),
    insights: deps.routers.insights.restaurantInsightsRouter.createCaller(ctx),
  };
};

const snapshotRows = (db: ScopedDb, id: string) =>
  Promise.all([
    db.customerConsent.findMany({ where: { customerId: id }, orderBy: { id: 'asc' } }),
    db.customerInteraction.findMany({ where: { customerId: id }, orderBy: { id: 'asc' } }),
    db.loyaltyPointsEntry.findMany({
      where: { account: { customerId: id } },
      orderBy: { id: 'asc' },
    }),
    db.restaurantOrder.findMany({ where: { customerId: id }, orderBy: { id: 'asc' } }),
  ]).then((rows) => JSON.stringify(rows));

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, customers, loyalty, loyaltyExpiry, insightRollups, scheduler, audit, customersRouter, loyaltyRouter, insightsRouter] =
    await Promise.all([
      import('@/lib/tenancy/scoped-db'),
      import('@/lib/restaurant/customers'),
      import('@/lib/restaurant/loyalty'),
      import('@/lib/restaurant/loyalty-expiry'),
      import('@/lib/restaurant/insight-rollups'),
      import('@/lib/restaurant/scheduler'),
      import('@/server/audit'),
      import('@/server/routers/restaurant-customers'),
      import('@/server/routers/restaurant-loyalty'),
      import('@/server/routers/restaurant-insights'),
    ]);
  deps = {
    createTenantDb: scopedDb.createTenantDb,
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    customers,
    loyalty,
    loyaltyExpiry,
    insightRollups,
    scheduler,
    audit,
    routers: { customers: customersRouter, loyalty: loyaltyRouter, insights: insightsRouter },
  };

  const roles = await deps.withPlatformDb((tx) =>
    tx.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `
  );
  if (roles[0]?.rolsuper || roles[0]?.rolbypassrls) {
    throw new Error('WHA-100 requires an unprivileged NOBYPASSRLS TEST_DATABASE_URL role.');
  }

  await deps.withPlatformDb((tx) =>
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
  for (const [organizationId, branchId, userId, staffId] of [
    [orgId, ids.branch, ids.user, ids.staff],
    [otherOrgId, ids.otherBranch, ids.otherUser, ids.otherStaff],
  ] as const) {
    await deps.withTenantDb(organizationId, async (tx) => {
      await tx.restaurantBranch.create({
        data: { id: branchId, name: 'New York branch', timezone: 'America/New_York' },
      });
      await tx.user.create({
        data: {
          id: userId,
          name: 'WHA-100 operator',
          email: `${userId}@example.test`,
          department: 'QUALITY',
          title: 'Operator',
          role: 'EMPLOYEE',
          status: 'ACTIVE',
        },
      });
      await tx.restaurantStaffProfile.create({
        data: { id: staffId, userId, displayName: 'WHA-100 operator', primaryBranchId: branchId },
      });
    });
  }
  await deps.withTenantDb(orgId, (tx) =>
    tx.restaurantProduct.create({ data: { id: ids.product, name: 'Acceptance item' } })
  );
  api = callers(orgId, ids.user);
  otherApi = callers(otherOrgId, ids.otherUser);
}, 60_000);

describeIfDatabase('WHA-100 M8 independent acceptance (real PostgreSQL + API)', () => {
  it('scopes normalized identities and preserves append-only consent provenance', async () => {
    const created = await api.customers.create({
      displayName: 'Primary Person',
      givenName: 'Primary',
      familyName: 'Person',
      notes: 'private-note-wha100',
      identifiers: [{ kind: 'EMAIL', value: '  Primary.Person@Example.TEST  ' }],
    });
    customerId = created.id;
    expect(created.identifiers[0]?.normalizedValue).toBe('primary.person@example.test');

    await expect(
      api.customers.create({ identifiers: [{ kind: 'EMAIL', value: 'PRIMARY.PERSON@example.test' }] })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const crossOrg = await otherApi.customers.create({
      identifiers: [{ kind: 'EMAIL', value: 'primary.person@example.test' }],
    });
    expect(crossOrg.identifiers[0]?.normalizedValue).toBe('primary.person@example.test');

    const granted = await api.customers.appendConsent({
      customerId,
      channel: 'EMAIL',
      granted: true,
      source: 'checkout',
      policyVersion: 'privacy-2026-08',
      idempotencyKey: `consent-grant-${suffix}`,
    });
    const revoked = await api.customers.appendConsent({
      customerId,
      channel: 'EMAIL',
      granted: false,
      source: 'customer-request',
      policyVersion: 'privacy-2026-08',
      idempotencyKey: `consent-revoke-${suffix}`,
    });
    expect(granted.actorId).toBe(ids.user);
    expect(revoked.actorId).toBe(ids.user);
    const events = await deps.withTenantDb(orgId, (tx) =>
      tx.customerConsent.findMany({ where: { customerId, channel: 'EMAIL' }, orderBy: { occurredAt: 'asc' } })
    );
    expect(events.map(({ granted: state, source, actorId, policyVersion }) => ({ state, source, actorId, policyVersion }))).toEqual([
      { state: true, source: 'checkout', actorId: ids.user, policyVersion: 'privacy-2026-08' },
      { state: false, source: 'customer-request', actorId: ids.user, policyVersion: 'privacy-2026-08' },
    ]);
    expect(events.at(-1)?.granted).toBe(false);

    await expect(
      deps.withTenantDb(orgId, (tx) =>
        tx.$executeRaw`UPDATE restaurant_customer_consents SET source = 'tampered' WHERE id = ${revoked.id}`
      )
    ).rejects.toThrow();
    await expect(
      deps.withTenantDb(orgId, (tx) =>
        tx.$executeRaw`DELETE FROM restaurant_customer_consents WHERE id = ${granted.id}`
      )
    ).rejects.toThrow();
  });

  it('exports one customer, audits without copied PII, and anonymizes idempotently', async () => {
    const other = await api.customers.create({
      displayName: 'Excluded Person',
      notes: 'excluded-secret-wha100',
      identifiers: [{ kind: 'EMAIL', value: 'excluded@example.test' }],
    });
    const tag = await api.customers.createTag({ name: `VIP ${suffix}`, color: '#334455' });
    await api.customers.assignTag({ customerId, tagId: tag.id });
    await api.customers.appendInteraction({
      customerId,
      branchId: ids.branch,
      type: 'ACCEPTANCE_NOTE',
      idempotencyKey: `interaction-${suffix}`,
    });
    await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantOrder.create({
        data: {
          id: `order_privacy_${suffix}`,
          branchId: ids.branch,
          orderNumber: 100,
          businessDate,
          status: 'SERVED',
          channel: 'DINE_IN',
          staffProfileId: ids.staff,
          customerId,
        },
      })
    );
    await api.loyalty.configure({
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      earnRate: '1.250000',
      redemptionValue: '0.100000',
      expiryDays: 30,
    });
    const account = await api.loyalty.enrollAccount({ customerId });
    loyaltyAccountId = account.id;
    await api.loyalty.adjust({
      accountId: account.id,
      points: 25,
      reason: 'Acceptance seed',
      idempotencyKey: `privacy-adjust-${suffix}`,
    });

    const exported = await callers(orgId, ids.user).customers.export({ customerId });
    await deps.audit.flushAuditWritesForTest();
    const exportedJson = JSON.stringify(exported);
    expect(exported.profile.id).toBe(customerId);
    expect(exportedJson).toContain('primary.person@example.test');
    expect(exportedJson).not.toContain(other.id);
    expect(exportedJson).not.toContain('excluded@example.test');
    expect(exportedJson).not.toContain('excluded-secret-wha100');
    expect(exported.identifiers.every((identifier) => identifier.customerId === customerId)).toBe(true);
    expect(exported.consentEvents.every((event) => event.customerId === customerId)).toBe(true);
    expect(exported.orders.every((order) => order.customerId === customerId)).toBe(true);

    const before = await deps.withTenantDb(orgId, (tx) => snapshotRows(tx, customerId));
    const first = await callers(orgId, ids.user).customers.anonymize({ customerId });
    await deps.audit.flushAuditWritesForTest();
    const second = await callers(orgId, ids.user).customers.anonymize({ customerId });
    await deps.audit.flushAuditWritesForTest();
    expect(second.anonymizedAt.toISOString()).toBe(first.anonymizedAt.toISOString());
    const after = await deps.withTenantDb(orgId, (tx) => snapshotRows(tx, customerId));
    expect(after).toBe(before);

    const state = await deps.withTenantDb(orgId, async (tx) => ({
      customer: await tx.restaurantCustomer.findUniqueOrThrow({ where: { id: customerId } }),
      identifiers: await tx.customerIdentifier.count({ where: { customerId } }),
      tagAssignments: await tx.customerTagAssignment.count({ where: { customerId } }),
      account: await tx.loyaltyAccount.findUniqueOrThrow({ where: { customerId } }),
      audits: await tx.auditLog.findMany({
        where: {
          targetId: customerId,
          action: { in: ['restaurantCustomers.export', 'restaurantCustomers.anonymize'] },
        },
        orderBy: { createdAt: 'asc' },
      }),
    }));
    expect(state.customer).toMatchObject({
      displayName: null,
      givenName: null,
      familyName: null,
      birthDate: null,
      notes: null,
    });
    expect(state.customer.anonymizedAt).not.toBeNull();
    expect(state.identifiers).toBe(0);
    expect(state.tagAssignments).toBe(0);
    expect(state.account.active).toBe(false);
    expect(state.audits.map((row) => row.action)).toEqual([
      'restaurantCustomers.export',
      'restaurantCustomers.anonymize',
      'restaurantCustomers.anonymize',
    ]);
    for (const row of state.audits) {
      const payload = JSON.stringify([row.input, row.result, row.changes, row.metadata]);
      expect(payload).not.toContain('Primary Person');
      expect(payload).not.toContain('primary.person@example.test');
      expect(payload).not.toContain('private-note-wha100');
    }
  });

  it('pins exact loyalty arithmetic, expiry, and capped refund reversals', async () => {
    const loyaltyCustomer = await api.customers.create({ displayName: 'Loyalty arithmetic' });
    const limitedApi = callers(orgId, ids.user, 1);
    await expect(limitedApi.loyalty.enrollAccount({ customerId: loyaltyCustomer.id })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const program = await api.loyalty.configure({
      effectiveFrom: '2026-08-20T00:00:00.000Z',
      earnRate: '1.500000',
      redemptionValue: '0.250000',
      expiryDays: 1,
    });
    await expect(
      deps.withTenantDb(orgId, (tx) =>
        tx.loyaltyProgramVersion.update({ where: { id: program.id }, data: { earnRate: '99' } })
      )
    ).rejects.toThrow();

    const account = await deps.loyalty.enrollLoyaltyAccount(deps.createTenantDb(orgId), {
      customerId: loyaltyCustomer.id,
      activeCustomersMax: 10,
      at: T0,
    });
    const billId = `bill_loyalty_${suffix}`;
    const cancelledBillId = `bill_cancelled_${suffix}`;
    await deps.withTenantDb(orgId, async (tx) => {
      for (const [orderId, orderNumber, status, id] of [
        [`order_loyalty_${suffix}`, 201, 'CLOSED', billId],
        [`order_cancelled_${suffix}`, 202, 'CANCELLED', cancelledBillId],
      ] as const) {
        await tx.restaurantOrder.create({
          data: {
            id: orderId,
            branchId: ids.branch,
            orderNumber,
            businessDate,
            status,
            channel: 'DINE_IN',
            staffProfileId: ids.staff,
            customerId: loyaltyCustomer.id,
          },
        });
        await tx.restaurantBill.create({
          data: {
            id,
            orderId,
            billNumber: 1,
            status: 'CLOSED',
            subtotal: '10.10',
            discountTotal: '0',
            taxTotal: '0',
            serviceChargeTotal: '0',
            tipTotal: '0',
            total: '10.10',
            closedAt: T0,
          },
        });
      }
    });
    const earned = await deps.loyalty.earnLoyaltyForClosedOrder(deps.createTenantDb(orgId), {
      billId,
      occurredAt: T0,
    });
    expect(earned?.points).toBe(15);
    expect(earned?.programVersionId).toBe(program.id);
    expect(
      await deps.loyalty.earnLoyaltyForClosedOrder(deps.createTenantDb(orgId), {
        billId: cancelledBillId,
        occurredAt: T0,
      })
    ).toBeNull();

    await api.loyalty.configure({
      effectiveFrom: '2026-08-21T00:00:00.000Z',
      earnRate: '9.000000',
      redemptionValue: '0.500000',
      expiryDays: 7,
    });
    const replayedEarn = await deps.loyalty.earnLoyaltyForClosedOrder(
      deps.createTenantDb(orgId),
      { billId, occurredAt: new Date('2026-08-22T00:00:00.000Z') }
    );
    expect(replayedEarn?.id).toBe(earned?.id);
    expect(replayedEarn?.programVersionId).toBe(program.id);

    const redeemed = await api.loyalty.redeem({
      accountId: account.id,
      billId,
      points: 4,
      idempotencyKey: `redeem-${suffix}`,
    });
    expect(redeemed.value).toBe('1.00');
    await api.loyalty.adjust({
      accountId: account.id,
      points: 2,
      reason: 'Exact arithmetic',
      idempotencyKey: `adjust-${suffix}`,
    });
    expect((await api.loyalty.getAccount({ id: account.id })).balance).toBe(13);

    await deps.withTenantDb(orgId, (tx) =>
      tx.loyaltyPointsEntry.createMany({
        data: [
          {
            accountId: account.id,
            programVersionId: program.id,
            kind: 'EARN',
            points: 3,
            expiresAt: new Date('2026-08-19T00:00:00.000Z'),
            occurredAt: new Date('2026-08-17T00:00:00.000Z'),
            idempotencyKey: `oldest-${suffix}`,
          },
          {
            accountId: account.id,
            programVersionId: program.id,
            kind: 'EARN',
            points: 5,
            expiresAt: new Date('2026-08-19T00:00:00.000Z'),
            occurredAt: new Date('2026-08-18T00:00:00.000Z'),
            idempotencyKey: `newer-${suffix}`,
          },
        ],
      })
    );
    const expiry = await deps.loyaltyExpiry.expireAccountLoyaltyPoints(
      deps.createTenantDb(orgId),
      account.id,
      T0
    );
    const expiryReplay = await deps.loyaltyExpiry.expireAccountLoyaltyPoints(
      deps.createTenantDb(orgId),
      account.id,
      T0
    );
    expect(expiryReplay).toEqual(expiry);
    const expiryRows = await deps.withTenantDb(orgId, (tx) =>
      tx.loyaltyPointsEntry.findMany({
        where: { accountId: account.id, kind: 'EXPIRY' },
        orderBy: { occurredAt: 'asc' },
      })
    );
    expect(expiryRows).toHaveLength(2);
    expect(expiryRows.map((row) => row.points)).toEqual([-3, -5]);

    const tenderId = `tender_loyalty_${suffix}`;
    await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantTender.create({
        data: {
          id: tenderId,
          billId,
          type: 'CASH',
          amount: '10.10',
          status: 'CAPTURED',
          idempotencyKey: `tender-${suffix}`,
        },
      })
    );
    const refundIds = [`refund_partial_${suffix}`, `refund_full_${suffix}`] as const;
    await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantRefund.createMany({
        data: [
          {
            id: refundIds[0],
            tenderId,
            amount: '4.04',
            reason: 'Partial acceptance refund',
            status: 'COMPLETED',
            idempotencyKey: `refund-partial-${suffix}`,
          },
          {
            id: refundIds[1],
            tenderId,
            amount: '10.10',
            reason: 'Full acceptance refund',
            status: 'COMPLETED',
            idempotencyKey: `refund-full-${suffix}`,
          },
        ],
      })
    );
    const partial = await deps.loyalty.reverseLoyaltyForRefund(
      deps.createTenantDb(orgId),
      refundIds[0],
      T0
    );
    const partialReplay = await deps.loyalty.reverseLoyaltyForRefund(
      deps.createTenantDb(orgId),
      refundIds[0],
      T0
    );
    expect(partialReplay?.id).toBe(partial?.id);
    await deps.loyalty.reverseLoyaltyForRefund(deps.createTenantDb(orgId), refundIds[1], T0);
    const reversals = await deps.withTenantDb(orgId, (tx) =>
      tx.loyaltyPointsEntry.findMany({ where: { accountId: account.id, kind: 'REVERSAL', billId } })
    );
    expect(reversals.reduce((sum, row) => sum + row.points, 0)).toBe(-15);
    expect(reversals.every((row) => row.reversesEntryId === earned?.id)).toBe(true);
  });

  it('drives reconciled rollup retries and enforces strict report boundaries', async () => {
    const rollupBranch = ids.branch;
    const closeId = `close_wha100_${suffix}`;
    await deps.withTenantDb(orgId, async (tx) => {
      await tx.restaurantDailyClose.create({
        data: {
          id: closeId,
          branchId: rollupBranch,
          businessDate,
          grossSales: '0',
          netSales: '0',
          taxTotal: '0',
          serviceChargeTotal: '0',
          tipTotal: '0',
          compTotal: '0',
          discountTotal: '0',
          refundTotal: '0',
          voidTotal: '0',
          cashExpected: '0',
          cashCounted: '0',
          cashVariance: '0',
          closedByStaffId: ids.staff,
          closedAt: T0,
        },
      });
      await tx.labourCostFact.create({
        data: {
          id: `labour_wha100_${suffix}`,
          branchId: rollupBranch,
          businessDate,
          labourHours: '7.50',
          labourCost: '123.45',
          source: 'acceptance',
          idempotencyKey: `labour-${suffix}`,
          importedAt: T0,
        },
      });
    });

    const enqueued = await deps.insightRollups.enqueueInsightBackfill(
      deps.createTenantDb(orgId),
      { branchId: rollupBranch, from: '2026-08-20', to: '2026-08-20' }
    );
    expect(enqueued).toMatchObject({ enqueued: 1, deduplicated: 0 });
    const duplicate = await deps.insightRollups.enqueueInsightBackfill(
      deps.createTenantDb(orgId),
      { branchId: rollupBranch, from: '2026-08-20', to: '2026-08-20' }
    );
    expect(duplicate).toMatchObject({ enqueued: 0, deduplicated: 1 });

    let failOnce = true;
    const handler = async (job: { payload: unknown }) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('forced rollup retry');
      }
      await deps.insightRollups.rollupDay(
        deps.createTenantDb(orgId),
        job.payload as { branchId: string; businessDate: string }
      );
    };
    const runScoped = <T>(run: (db: ScopedDb) => Promise<T>) => deps.withTenantDb(orgId, run);
    const firstDrain = await deps.scheduler.drainDueJobs({
      runScoped,
      workerId: `wha100-first-${suffix}`,
      handler,
      clock: () => T0,
      maxJobs: 1,
    });
    expect(firstDrain).toMatchObject({ claimed: 1, retried: 1, succeeded: 0 });
    const secondDrain = await deps.scheduler.drainDueJobs({
      runScoped,
      workerId: `wha100-second-${suffix}`,
      handler,
      clock: () => new Date(T0.getTime() + 60 * 60_000),
      maxJobs: 1,
    });
    expect(secondDrain).toMatchObject({ claimed: 1, succeeded: 1 });

    const rollup = await deps.withTenantDb(orgId, (tx) =>
      tx.insightDailyRollup.findUniqueOrThrow({
        where: { branchId_businessDate: { branchId: rollupBranch, businessDate } },
      })
    );
    expect(rollup.sourceDailyCloseId).toBe(closeId);
    for (const amount of [
      rollup.grossSales,
      rollup.netSales,
      rollup.compTotal,
      rollup.refundTotal,
      rollup.voidTotal,
      rollup.drawerVariance,
    ]) {
      eqDecimal(amount, '0');
    }

    const correctedCloseId = `close_wha100_corrected_${suffix}`;
    await deps.withTenantDb(orgId, async (tx) => {
      await tx.restaurantDailyClose.create({
        data: {
          id: correctedCloseId,
          branchId: rollupBranch,
          businessDate,
          supersedesCloseId: closeId,
          grossSales: '0',
          netSales: '0',
          taxTotal: '0',
          serviceChargeTotal: '0',
          tipTotal: '0',
          compTotal: '0',
          discountTotal: '0',
          refundTotal: '0',
          voidTotal: '0',
          cashExpected: '0',
          cashCounted: '0',
          cashVariance: '0',
          closedByStaffId: ids.staff,
          closedAt: new Date(T0.getTime() + 60_000),
        },
      });
      await deps.scheduler.enqueue(
        tx,
        {
          type: 'restaurant.insights.rollup-day',
          payload: { branchId: rollupBranch, businessDate: '2026-08-20' },
          idempotencyKey: `rebuild-${suffix}`,
          scheduledAt: T0,
        },
        T0
      );
    });
    await deps.scheduler.drainDueJobs({
      runScoped,
      workerId: `wha100-rebuild-${suffix}`,
      handler: async (job) =>
        deps.insightRollups.rollupDay(
          deps.createTenantDb(orgId),
          job.payload as { branchId: string; businessDate: string }
        ),
      clock: () => new Date(T0.getTime() + 2 * 60 * 60_000),
      maxJobs: 1,
    });
    const rebuilt = await deps.withTenantDb(orgId, async (tx) => ({
      daily: await tx.insightDailyRollup.findMany({ where: { branchId: rollupBranch, businessDate } }),
      items: await tx.insightItemMixRollup.findMany({ where: { branchId: rollupBranch, businessDate } }),
    }));
    expect(rebuilt.daily).toHaveLength(1);
    expect(rebuilt.daily[0]?.sourceDailyCloseId).toBe(correctedCloseId);
    expect(new Set(rebuilt.items.map((row) => row.productId)).size).toBe(rebuilt.items.length);

    await expect(
      api.customers.list({ limit: 1, unexpected: true } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      api.loyalty.listAccounts({ limit: 1, unexpected: true } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      api.insights.listFinancialReports({ branchId: rollupBranch, unexpected: true } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    mocks.hasModule.mockReturnValueOnce(false);
    await expect(api.customers.list({ limit: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    mocks.can.mockResolvedValueOnce(false);
    await expect(api.loyalty.listPrograms()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    mocks.can.mockImplementation(async (_subject, action) => action === 'reports:operational');
    await expect(
      api.insights.listOperationalReports({ branchId: ids.otherBranch })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    for (const actionSet of [new Set(['reports:financial']), new Set(['workforce:rates'])]) {
      mocks.can.mockImplementation(async (_subject, action) => actionSet.has(action));
      await expect(
        api.insights.listLabourCosts({ branchId: rollupBranch })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        api.insights.readLabourCost({ id: `labour_wha100_${suffix}` })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        api.insights.exportLabourCosts({ branchId: rollupBranch })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }

    mocks.can.mockResolvedValue(true);
    const reports = await api.insights.listFinancialReports({ branchId: rollupBranch });
    expect(reports).toHaveLength(1);
    expect(reports[0]).not.toHaveProperty('labourCost');
    expect(reports[0]).not.toHaveProperty('labourHours');
    for (const key of [
      'grossSales',
      'netSales',
      'compTotal',
      'refundTotal',
      'voidTotal',
      'drawerVariance',
      'loyaltyLiability',
    ] as const) {
      expect(typeof reports[0]?.[key]).toBe('string');
    }
    const labour = await api.insights.listLabourCosts({ branchId: rollupBranch });
    expect(labour[0]).toMatchObject({ labourHours: '7.5', labourCost: '123.45' });
    const programs = await api.loyalty.listPrograms({ limit: 10 });
    expect(programs.every((row) => typeof row.earnRate === 'string')).toBe(true);
    expect(programs.every((row) => typeof row.redemptionValue === 'string')).toBe(true);
    expect(String(reports[0]?.computedAt)).not.toBe(T0.toISOString());
    expect(String(reports[0]?.computedAt)).toMatch(/08:00|8:00/);
  });
});
