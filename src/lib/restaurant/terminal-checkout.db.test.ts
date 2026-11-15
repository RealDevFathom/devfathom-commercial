/**
 * M5-L5 — the route-level named checks that only a database can establish, driving the
 * checkout + cash REST handlers exactly as an HTTP request would. The public comp
 * endpoint is denial-only in MVP; retained comp domain checks use a test-only adapter:
 *
 *  - a HAPPY PATH per route: bill cut / split / re-cut, comp, tender, refund, the
 *    settlement summary + settled-bill receipt reads, drawer open / movement / close,
 *    and the day preview / close / correct;
 *  - a REVOKED device is rejected on EVERY money route (the device is re-read fresh on
 *    every call, so even a still-"valid" session token is refused — C12);
 *  - a device-scoped idempotent replay of `(deviceId, key)` returns the original result
 *    and creates NOTHING — bills, tenders, payments, payment events, refunds, drawer
 *    movements and daily closes are all asserted unchanged across the replay (C11);
 *  - a money route is refused (403) when the acting operator lacks its capability, and a
 *    co-authorized action is refused when the approving manager lacks `coauth:approve`
 *    (C11).
 *
 * Requires TEST_DATABASE_URL (a migrated throwaway DB, never DATABASE_URL); without it
 * the suite reports itself skipped rather than passing vacuously. Every read filters by a
 * per-run-unique id, so it is valid on a superuser URL too. Capabilities are resolved
 * from an operator's linked `User` org-role, so a money operator here is a staff profile
 * linked to a user carrying the capability (the contract L7a/L6b seed against).
 */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import { ensureRestaurantTaxProfile } from '@/lib/test-support/restaurant-tax-profile';
import { ensurePlatformModule, seedDepartments } from '@/lib/test-support/departments';
import { clearRateLimit } from '@/lib/rate-limit';

/** Assert a serialised money value by Decimal VALUE, tolerant of trailing-zero format
 * (`.toString()` trims computed Decimals: '10' ≡ '10.00'). Never a float comparison. */
const eqMoney = (actual: unknown, expected: string) =>
  expect(new Prisma.Decimal(String(actual)).equals(expected)).toBe(true);

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
process.env.AUTH_SECRET ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const PIN = '424242';

const orgA = `org_wha59_${suffix}`;
const orgB = `org_wha977_b_${suffix}`;

type RouteModule = {
  GET?: (request: Request) => Promise<Response>;
  POST?: (request: Request) => Promise<Response>;
};

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  enrollDevice: (typeof import('@/lib/restaurant/devices'))['enrollDevice'];
  revokeDevice: (typeof import('@/lib/restaurant/devices'))['revokeDevice'];
  hashOperatorCredential: (typeof import('@/lib/restaurant/operator-credentials'))['hashOperatorCredential'];
  routes: Record<string, RouteModule>;
  terminal: { establish: RouteModule; unlock: RouteModule };
};

let deps: Deps;
const composerProofs = new Map<string, string>();

/** Seeded once per run. */
const ctx = {
  branchA: `branch_a_${suffix}`,
  branchB: `branch_b_${suffix}`,
  orgBBranch: `branch_org_b_${suffix}`,
  branchDay: `branch_d_${suffix}`,
  branchReplay: `branch_r_${suffix}`,
  branchTax: `branch_t_${suffix}`,
  roleFull: `role_full_${suffix}`,
  roleNone: `role_none_${suffix}`,
  userA: `user_a_${suffix}`,
  userMgr: `user_m_${suffix}`,
  userForeignMgr: `user_fm_${suffix}`,
  userNoCap: `user_n_${suffix}`,
  staffA: `staff_a_${suffix}`,
  managerA: `staff_m_${suffix}`,
  managerForeign: `staff_fm_${suffix}`,
  staffNoCap: `staff_n_${suffix}`,
  // QA-145: PIN-only approvers with NO linked user, carrying capabilities only via
  // SOP-1 job roles. `floorApprover` holds a role with coauth:approve; `floorNoCoauth`
  // holds a role without it.
  jobRoleApprover: `jobrole_approver_${suffix}`,
  jobRoleFloor: `jobrole_floor_${suffix}`,
  floorApprover: `staff_floor_approver_${suffix}`,
  floorNoCoauth: `staff_floor_nocoauth_${suffix}`,
  customerA: `customer_a_${suffix}`,
  productA: `prod_a_${suffix}`,
  posA: { deviceId: '', secret: '' },
  posB: { deviceId: '', secret: '' },
  posDay: { deviceId: '', secret: '' },
  posReplay: { deviceId: '', secret: '' },
  posTax: { deviceId: '', secret: '' },
};

let orderSeq = 0;

beforeEach(async () => {
  await Promise.all([
    clearRateLimit('terminal:ip:unknown'),
    ...[ctx.posA, ctx.posB, ctx.posDay, ctx.posReplay, ctx.posTax]
      .filter(({ deviceId }) => deviceId)
      .map(({ deviceId }) => clearRateLimit(`terminal:device:${deviceId}`)),
  ]);
});

async function call(
  route: RouteModule,
  opts: {
    method?: 'GET' | 'POST';
    secret?: string;
    session?: string;
    key?: string;
    body?: unknown;
    query?: Record<string, string>;
  }
): Promise<{ status: number; json: Record<string, unknown> }> {
  const method = opts.method ?? 'POST';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.secret) headers.authorization = `Bearer ${opts.secret}`;
  if (opts.session) headers['x-terminal-session'] = opts.session;
  const composerProof = opts.session ? composerProofs.get(opts.session) : undefined;
  if (composerProof) headers['x-pos-composer-proof'] = composerProof;
  if (opts.key) headers['idempotency-key'] = opts.key;
  const url = new URL('https://tenant.test/api/restaurant/probe');
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const request = new Request(url, {
    method,
    headers,
    body: method === 'GET' || opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const handler = method === 'GET' ? route.GET! : route.POST!;
  const res = await handler(request);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function enroll(branchId: string, name: string) {
  const { device, secret } = await deps.withTenantDb(orgA, (tx) =>
    deps.enrollDevice(tx, { branchId, name })
  );
  return { deviceId: device.id, secret };
}

async function establishUnlock(
  secret: string,
  staffProfileId = ctx.staffA,
  branchId = ctx.branchA
): Promise<string> {
  await deps.withTenantDb(orgA, (tx) =>
    tx.restaurantStaffProfile.updateMany({
      where: { id: { in: [staffProfileId, ctx.managerA] } },
      data: { primaryBranchId: branchId },
    })
  );
  const established = await call(deps.terminal.establish, { secret });
  expect(established.status).toBe(201);
  const token = established.json.sessionToken as string;
  const unlocked = await call(deps.terminal.unlock, {
    secret,
    session: token,
    body: { staffProfileId, type: 'PIN', secret: PIN },
  });
  expect(unlocked.status).toBe(200);
  expect(unlocked.json.composerProof).toEqual(expect.any(String));
  composerProofs.set(token, unlocked.json.composerProof as string);
  return token;
}

/** Seed a billable order (status SERVED) in a branch with one item per price. */
async function seedOrder(
  branchId: string,
  deviceId: string,
  businessDate: string,
  prices: string[],
  channel: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY' = 'DINE_IN'
): Promise<{ orderId: string; itemIds: string[] }> {
  orderSeq += 1;
  const orderNumber = orderSeq;
  const bdate = new Date(`${businessDate}T00:00:00.000Z`);
  return deps.withTenantDb(orgA, async (tx) => {
    const order = await tx.restaurantOrder.create({
      data: {
        branchId,
        orderNumber,
        businessDate: bdate,
        status: 'SERVED',
        channel,
        staffProfileId: ctx.staffA,
        deviceId,
        customerId: channel === 'DELIVERY' ? ctx.customerA : null,
      },
      select: { id: true },
    });
    const itemIds: string[] = [];
    for (const price of prices) {
      const item = await tx.restaurantOrderItem.create({
        data: {
          orderId: order.id,
          productId: ctx.productA,
          name: 'Widget',
          unitPrice: price,
          quantity: 1,
          status: 'SERVED',
        },
        select: { id: true },
      });
      itemIds.push(item.id);
    }
    if (channel === 'DELIVERY') {
      await tx.restaurantDeliveryFulfillment.create({
        data: {
          organizationId: orgA,
          branchId,
          customerId: ctx.customerA,
          orderId: order.id,
          paymentMode: null,
          status: 'PENDING',
          recipientNameSnapshot: 'Delivery Guest',
          normalizedPhoneSnapshot: '+923001234567',
          addressLine1Snapshot: '1 Test Street',
          localitySnapshot: 'Karachi',
          countryCodeSnapshot: 'PK',
          deliveryFeeSnapshot: 0,
          deliveryTaxSnapshot: 0,
          promisedMinutesSnapshot: 30,
          promisedAt: new Date(Date.now() + 30 * 60_000),
        },
      });
    }
    return { orderId: order.id, itemIds };
  });
}

/** Global money-row counts (tenant-scoped to orgA) — used to prove a replay writes nothing. */
async function moneyCounts() {
  return deps.withTenantDb(orgA, async (tx) => ({
    bills: await tx.restaurantBill.count(),
    tenders: await tx.restaurantTender.count(),
    payments: await tx.restaurantPayment.count(),
    events: await tx.restaurantPaymentEvent.count(),
    refunds: await tx.restaurantRefund.count(),
    movements: await tx.restaurantDrawerMovement.count(),
    closes: await tx.restaurantDailyClose.count(),
    orderEvents: await tx.restaurantOrderEvent.count(),
    outbox: await tx.restaurantEventOutbox.count(),
    loyaltyEntries: await tx.loyaltyPointsEntry.count(),
    coAuthorizations: await tx.restaurantCoAuthorization.count(),
    idempotencyKeys: await tx.restaurantMoneyIdempotencyKey.count(),
  }));
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, devices, credentials, ...routeMods] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/devices'),
    import('@/lib/restaurant/operator-credentials'),
    import('@/app/api/restaurant/checkout/bill/route'),
    import('@/app/api/restaurant/checkout/comp/route'),
    import('@/app/api/restaurant/checkout/tender/route'),
    import('@/app/api/restaurant/checkout/refund/route'),
    import('@/app/api/restaurant/checkout/summary/route'),
    import('@/app/api/restaurant/checkout/receipt/route'),
    import('@/app/api/restaurant/cash/drawer/open/route'),
    import('@/app/api/restaurant/cash/drawer/current/route'),
    import('@/app/api/restaurant/cash/drawer/movement/route'),
    import('@/app/api/restaurant/cash/drawer/close/route'),
    import('@/app/api/restaurant/cash/day/preview/route'),
    import('@/app/api/restaurant/cash/day/current/route'),
    import('@/app/api/restaurant/cash/day/close/route'),
    import('@/app/api/restaurant/cash/day/correct/route'),
    import('@/app/api/restaurant/terminal/establish/route'),
    import('@/app/api/restaurant/terminal/unlock/route'),
    import('@/app/api/restaurant/orders/close/route'),
    import('@/lib/test-support/retained-comp-route'),
  ]);

  const [
    bill,
    comp,
    tender,
    refund,
    summary,
    receipt,
    drawerOpen,
    drawerCurrent,
    drawerMovement,
    drawerClose,
    dayPreview,
    dayCurrent,
    dayClose,
    dayCorrect,
    establish,
    unlock,
    orderClose,
    retainedComp,
  ] = routeMods as RouteModule[];

  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    enrollDevice: devices.enrollDevice,
    revokeDevice: devices.revokeDevice,
    hashOperatorCredential: credentials.hashOperatorCredential,
    routes: {
      bill,
      comp,
      retainedComp,
      tender,
      refund,
      summary,
      receipt,
      drawerOpen,
      drawerCurrent,
      drawerMovement,
      drawerClose,
      dayPreview,
      dayCurrent,
      dayClose,
      dayCorrect,
      orderClose,
    },
    terminal: { establish, unlock },
  };

  await deps.withPlatformDb(async (tx) => {
    await tx.organization.create({
      data: {
        id: orgA,
        slug: `wha59-${suffix}`,
        legalName: 'M5L5 Test Co',
        displayName: 'M5L5 Test',
        status: 'ACTIVE',
      },
    });
    await tx.organization.create({
      data: {
        id: orgB,
        slug: `wha977-b-${suffix}`,
        legalName: 'WHA-977 Isolation Co',
        displayName: 'WHA-977 Isolation',
        status: 'ACTIVE',
      },
    });
    await seedDepartments(tx, [orgA], ['LEADERSHIP']);
    const posModule = await ensurePlatformModule(tx, 'restaurant-pos', {
      name: 'POS',
      category: 'Operations',
    });
    await tx.organizationModule.create({
      data: {
        organizationId: orgA,
        moduleId: posModule.id,
        // Daily-close tests rewind to noon. Keep the entitlement effective
        // throughout that business day, regardless of the real CI start time.
        startsAt: new Date(`${TODAY}T00:00:00.000Z`),
      },
    });
    await tx.organizationLimit.create({
      data: {
        organizationId: orgA,
        key: 'pos.concurrentRegisters.max',
        value: 4,
        source: 'WHA-977_TEST',
      },
    });
  });

  await deps.withTenantDb(orgA, async (tx) => {
    await tx.restaurantBranch.create({ data: { id: ctx.branchA, name: 'A' } });
    await tx.restaurantBranch.create({ data: { id: ctx.branchB, name: 'B' } });
    await tx.restaurantBranch.create({ data: { id: ctx.branchDay, name: 'Day' } });
    await tx.restaurantBranch.create({ data: { id: ctx.branchReplay, name: 'Replay' } });
    await tx.restaurantBranch.create({ data: { id: ctx.branchTax, name: 'Tax' } });
    await Promise.all([
      ensureRestaurantTaxProfile(tx, orgA, ctx.branchA),
      ensureRestaurantTaxProfile(tx, orgA, ctx.branchB),
      ensureRestaurantTaxProfile(tx, orgA, ctx.branchDay),
      ensureRestaurantTaxProfile(tx, orgA, ctx.branchReplay),
    ]);
    // Match the issue's customer-supplied profile without mutating published evidence.
    const source = await tx.restaurantTaxOfficialSource.findFirstOrThrow({
      where: { organizationId: orgA },
    });
    const effectiveFrom = new Date('2026-08-01T00:00:00.000Z');
    await tx.restaurantTaxProfileVersion.create({
      data: {
        branchId: ctx.branchTax,
        versionNumber: 1,
        status: 'PUBLISHED',
        effectiveFrom,
        approvalReference: 'QA-143 customer-supplied fixture',
        approvedAt: effectiveFrom,
        publishedAt: effectiveFrom,
        rules: {
          create: (['CASH', 'CARD', 'OTHER'] as const).map((paymentCategory) => ({
            paymentCategory,
            rate: '0.15',
            priceMode: 'EXCLUSIVE',
            ruleCode: `QA143_${paymentCategory}`,
            officialSourceId: source.id,
            status: 'PUBLISHED',
            effectiveFrom,
            approvedAt: effectiveFrom,
            approvalReference: 'QA-143 customer-supplied fixture',
            publishedAt: effectiveFrom,
          })),
        },
      },
    });
    await tx.restaurantProduct.create({ data: { id: ctx.productA, name: 'Widget' } });
    await tx.restaurantCustomer.create({
      data: { id: ctx.customerA, displayName: 'Delivery Guest' },
    });

    // A role granting every capability (money routes + coauth:approve via `*`) and a role
    // with a non-money capability only (proves denial is capability-specific, not "no role").
    await tx.organizationRole.create({
      data: {
        id: ctx.roleFull,
        key: `full_${suffix}`,
        name: 'Money Full',
        permissions: { create: [{ capability: '*', effect: 'ALLOW' }] },
      },
    });
    await tx.organizationRole.create({
      data: {
        id: ctx.roleNone,
        key: `none_${suffix}`,
        name: 'No Money',
        permissions: { create: [{ capability: 'menu:read', effect: 'ALLOW' }] },
      },
    });

    // Users carry capabilities via their org role; staff profiles link to them (C11 gate).
    for (const [id, roleId, tag] of [
      [ctx.userA, ctx.roleFull, 'a'],
      [ctx.userMgr, ctx.roleFull, 'm'],
      [ctx.userForeignMgr, ctx.roleFull, 'fm'],
      [ctx.userNoCap, ctx.roleNone, 'n'],
    ] as const) {
      await tx.user.create({
        data: {
          id,
          name: `User ${tag}`,
          email: `${tag}_${suffix}@test.local`,
          department: 'LEADERSHIP',
          title: 'Operator',
          organizationRoleId: roleId,
        },
      });
    }
    for (const [id, userId, name] of [
      [ctx.staffA, ctx.userA, 'Operator A'],
      [ctx.managerA, ctx.userMgr, 'Manager A'],
      [ctx.managerForeign, ctx.userForeignMgr, 'Manager Foreign'],
      [ctx.staffNoCap, ctx.userNoCap, 'No-cap Op'],
    ] as const) {
      await tx.restaurantStaffProfile.create({
        data: { id, displayName: name, primaryBranchId: ctx.branchA, status: 'ACTIVE', userId },
      });
      await tx.restaurantOperatorCredential.create({
        data: {
          staffProfileId: id,
          type: 'PIN',
          credentialHash: await deps.hashOperatorCredential('PIN', PIN),
        },
      });
      await tx.restaurantBranchAssignment.createMany({
        data: [ctx.branchB, ctx.branchDay, ctx.branchReplay, ctx.branchTax].map((branchId) => ({
          branchId,
          userId,
        })),
      });
    }
    await tx.restaurantStaffProfile.update({
      where: { id: ctx.managerForeign },
      data: { primaryBranchId: ctx.branchDay },
    });

    // QA-145: SOP-1 job roles carry capabilities independently of any linked `User`.
    await tx.restaurantJobRole.create({
      data: {
        id: ctx.jobRoleApprover,
        key: `owner_${suffix}`,
        name: 'Owner',
        capabilities: { create: [{ capability: 'coauth:approve' }] },
      },
    });
    await tx.restaurantJobRole.create({
      data: {
        id: ctx.jobRoleFloor,
        key: `floor_${suffix}`,
        name: 'Floor',
        capabilities: { create: [{ capability: 'orders:take' }] },
      },
    });
    // Two PIN-only approvers: NO linked user, so the pre-fix linked-user-only gate would
    // refuse both. The job role is what makes `floorApprover` eligible to co-authorize.
    for (const [id, jobRoleId, name] of [
      [ctx.floorApprover, ctx.jobRoleApprover, 'Floor Owner'],
      [ctx.floorNoCoauth, ctx.jobRoleFloor, 'Floor Server'],
    ] as const) {
      await tx.restaurantStaffProfile.create({
        data: { id, displayName: name, primaryBranchId: ctx.branchA, status: 'ACTIVE' },
      });
      await tx.restaurantOperatorCredential.create({
        data: {
          staffProfileId: id,
          type: 'PIN',
          credentialHash: await deps.hashOperatorCredential('PIN', PIN),
        },
      });
      await tx.restaurantStaffJobRole.create({
        data: { staffProfileId: id, jobRoleId, branchId: ctx.branchA },
      });
    }
  });
  await deps.withTenantDb(orgB, (tx) =>
    tx.restaurantBranch.create({ data: { id: ctx.orgBBranch, name: 'Other tenant' } })
  );

  ctx.posA = await enroll(ctx.branchA, 'posA');
  ctx.posB = await enroll(ctx.branchB, 'posB');
  ctx.posDay = await enroll(ctx.branchDay, 'posDay');
  ctx.posReplay = await enroll(ctx.branchReplay, 'posReplay');
  ctx.posTax = await enroll(ctx.branchTax, 'posTax');
});

// Today's UTC business date (branches default to UTC + a 00:00 cutoff).
const TODAY = new Date().toISOString().slice(0, 10);
const uniqueKey = (label: string) => `${label}-${suffix}-${randomBytes(3).toString('hex')}`;

describeIfDatabase('M5-L5 checkout + cash route transport (real DB)', () => {
  // ── Happy path per route (a real service flow on branch A) ──────────────────
  describe('happy paths', () => {
    let token = '';
    let drawerSessionId = '';
    let order1Bill = '';
    let order1Tender = '';

    beforeAll(async () => {
      token = await establishUnlock(ctx.posA.secret);
    });

    it('opens a drawer (cash:open)', async () => {
      const res = await call(deps.routes.drawerOpen, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('open'),
        body: { openingFloat: '100.00' },
      });
      expect(res.status).toBe(200);
      eqMoney(res.json.openingFloat, '100.00');
      expect(res.json.replayed).toBe(false);
      drawerSessionId = res.json.drawerSessionId as string;
      expect(drawerSessionId).toBeTruthy();
    });

    it('reads the authenticated device drawer and its persisted business date directly', async () => {
      const drawer = await call(deps.routes.drawerCurrent, {
        method: 'GET',
        secret: ctx.posA.secret,
        session: token,
      });
      expect(drawer.status).toBe(200);
      expect(drawer.json.drawerSessionId).toBe(drawerSessionId);
      expect(drawer.json.businessDate).toBe(TODAY);

      const day = await call(deps.routes.dayCurrent, {
        method: 'GET',
        secret: ctx.posA.secret,
        session: token,
      });
      expect(day.status).toBe(200);
      expect(day.json.businessDate).toBe(TODAY);
    });

    it('cuts a bill, tenders it to settlement, and reads the summary + receipt', async () => {
      const { orderId } = await seedOrder(ctx.branchA, ctx.posA.deviceId, TODAY, ['10.00']);

      const cut = await call(deps.routes.bill, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('cut'),
        body: { orderId, split: { kind: 'NONE' } },
      });
      expect(cut.status).toBe(200);
      expect((cut.json.billIds as string[]).length).toBe(1);
      order1Bill = (cut.json.billIds as string[])[0]!;

      const tender = await call(deps.routes.tender, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('tender'),
        body: {
          billId: order1Bill,
          tender: { type: 'CASH', amount: '10.00', cashReceived: '10.00' },
        },
      });
      expect(tender.status, JSON.stringify(tender.json)).toBe(200);
      expect(tender.json.settled).toBe(true);
      eqMoney(tender.json.changeGiven, '0.00');
      eqMoney(tender.json.remainingDue, '0.00');
      expect(typeof tender.json.receiptNumber).toBe('number');
      order1Tender = tender.json.tenderId as string;

      const summary = await call(deps.routes.summary, {
        method: 'GET',
        secret: ctx.posA.secret,
        session: token,
        query: { orderId },
      });
      expect(summary.status).toBe(200);
      expect(summary.json.settled).toBe(true);
      eqMoney(summary.json.derivedOrderTotal, '10.00');

      const receipt = await call(deps.routes.receipt, {
        method: 'GET',
        secret: ctx.posA.secret,
        session: token,
        query: { billId: order1Bill },
      });
      expect(receipt.status).toBe(200);
      expect(receipt.json.receiptNumber).toBe(tender.json.receiptNumber);
      eqMoney((receipt.json.totals as Record<string, string>).grandTotal, '10.00');
      eqMoney((receipt.json.totals as Record<string, string>).deliveryFeeTotal, '0.00');
      expect((receipt.json.tenders as unknown[]).length).toBe(1);
    });

    it.each([
      ['TAKEAWAY', 'CASH', '1.31'],
      ['DELIVERY', 'CARD', '0.74'],
    ] as const)(
      'settles a %s order through the API with Pakistan inclusive odd-cent tax',
      async (channel, tenderType, expectedTax) => {
        const { orderId } = await seedOrder(
          ctx.branchA,
          ctx.posA.deviceId,
          TODAY,
          ['10.01'],
          channel
        );
        const cut = await call(deps.routes.bill, {
          secret: ctx.posA.secret,
          session: token,
          key: uniqueKey(`channel-${channel}-cut`),
          body: { orderId, split: { kind: 'NONE' } },
        });
        expect(cut.status).toBe(200);
        const billId = (cut.json.billIds as string[])[0]!;
        const tender = await call(deps.routes.tender, {
          secret: ctx.posA.secret,
          session: token,
          key: uniqueKey(`channel-${channel}-tender`),
          body: {
            billId,
            tender: {
              type: tenderType,
              amount: '10.01',
              ...(tenderType === 'CASH' ? { cashReceived: '10.01' } : {}),
            },
          },
        });
        expect(tender.status, JSON.stringify(tender.json)).toBe(200);
        expect(tender.json.settled).toBe(true);

        const receipt = await call(deps.routes.receipt, {
          method: 'GET',
          secret: ctx.posA.secret,
          session: token,
          query: { billId },
        });
        expect(receipt.status).toBe(200);
        const totals = receipt.json.totals as Record<string, string>;
        eqMoney(totals.grandTotal, '10.01');
        const snapshot = await deps.withTenantDb(orgA, (tx) =>
          tx.restaurantTaxTransactionSnapshot.findFirstOrThrow({ where: { billId } })
        );
        eqMoney(snapshot.taxTotal, expectedTax);
      }
    );

    it('refunds a tender with manager co-authorization (payments:refund)', async () => {
      const res = await call(deps.routes.refund, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('refund'),
        body: {
          originalTenderId: order1Tender,
          amount: '10.00',
          reason: 'guest complaint',
          approving: { staffProfileId: ctx.managerA, type: 'PIN', secret: PIN },
        },
      });
      expect(res.status).toBe(200);
      eqMoney(res.json.amount, '10.00');
      eqMoney(res.json.deliveryFeeRefundAmount, '0.00');
      expect(res.json.kind).toBe('REFUND');
    });

    it('rejects a foreign-branch manager before a refund writes anything', async () => {
      const before = {
        ...(await moneyCounts()),
        ...(await deps.withTenantDb(orgA, async (tx) => ({
          coAuthorizations: await tx.restaurantCoAuthorization.count(),
          idempotencyKeys: await tx.restaurantMoneyIdempotencyKey.count(),
        }))),
      };
      const res = await call(deps.routes.refund, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('foreign-manager-refund'),
        body: {
          originalTenderId: order1Tender,
          amount: '1.00',
          reason: 'must not cross branch',
          approving: { staffProfileId: ctx.managerForeign, type: 'PIN', secret: PIN },
        },
      });
      expect(res.status).toBe(401);
      const after = {
        ...(await moneyCounts()),
        ...(await deps.withTenantDb(orgA, async (tx) => ({
          coAuthorizations: await tx.restaurantCoAuthorization.count(),
          idempotencyKeys: await tx.restaurantMoneyIdempotencyKey.count(),
        }))),
      };
      expect(after).toEqual(before);
    });

    it.each(['manager', 'job-role approver', 'invalid PIN'])(
      'denies the public MVP comp endpoint with a %s and leaves persistence unchanged',
      async (approval) => {
        const { orderId } = await seedOrder(ctx.branchA, ctx.posA.deviceId, TODAY, ['8.00']);
        const cut = await call(deps.routes.bill, {
          secret: ctx.posA.secret,
          session: token,
          key: uniqueKey('mvp-comp-cut'),
          body: { orderId, split: { kind: 'NONE' } },
        });
        expect(cut.status).toBe(200);
        const billId = (cut.json.billIds as string[])[0]!;
        const snapshot = async () => ({
          counts: await moneyCounts(),
          ...(await deps.withTenantDb(orgA, async (tx) => ({
            bill: await tx.restaurantBill.findUniqueOrThrow({ where: { id: billId } }),
            lines: await tx.restaurantBillLine.findMany({
              where: { billId },
              orderBy: { id: 'asc' },
            }),
            device: await tx.restaurantRegisteredDevice.findUniqueOrThrow({
              where: { id: ctx.posA.deviceId },
            }),
            credentials: await tx.restaurantOperatorCredential.findMany({ orderBy: { id: 'asc' } }),
          }))),
        });
        const before = await snapshot();
        const key = uniqueKey('mvp-comp');
        const body = {
          billId,
          billLineId: before.lines[0]!.id,
          reason: 'kitchen error',
          approving: {
            staffProfileId: approval === 'job-role approver' ? ctx.floorApprover : ctx.managerA,
            type: 'PIN',
            secret: approval === 'invalid PIN' ? '000000' : PIN,
          },
        };

        // A retry with the same key must also deny without consuming it or authenticating.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const denied = await call(deps.routes.comp, {
            secret: ctx.posA.secret,
            session: token,
            key,
            body,
          });
          expect(denied).toEqual({
            status: 403,
            json: { error: 'Complimentary items are not available in this version.' },
          });
          expect(await snapshot()).toEqual(before);
        }
      }
    );

    it('retains domain comp and manager co-authorization coverage through the test adapter', async () => {
      const { orderId } = await seedOrder(ctx.branchA, ctx.posA.deviceId, TODAY, ['8.00']);
      const cut = await call(deps.routes.bill, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('cut2'),
        body: { orderId, split: { kind: 'NONE' } },
      });
      const billId = (cut.json.billIds as string[])[0]!;
      const line = await deps.withTenantDb(orgA, (tx) =>
        tx.restaurantBillLine.findFirst({ where: { billId }, select: { id: true } })
      );

      const res = await call(deps.routes.retainedComp, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('comp'),
        body: {
          billId,
          billLineId: line!.id,
          reason: 'kitchen error',
          approving: { staffProfileId: ctx.managerA, type: 'PIN', secret: PIN },
        },
      });
      expect(res.status).toBe(200);
      expect(res.json.billId).toBe(billId);

      const evidence = await deps.withTenantDb(orgA, (tx) =>
        tx.restaurantCoAuthorization.findFirst({
          where: { targetType: 'RestaurantBillLine', targetId: line!.id },
          select: {
            terminalSessionId: true,
            terminalSession: { select: { deviceId: true, endedAt: true } },
          },
        })
      );
      expect(evidence).toMatchObject({
        terminalSessionId: expect.any(String),
        terminalSession: { deviceId: ctx.posA.deviceId, endedAt: null },
      });
    });

    it('re-cuts an order by item with manager co-authorization (split)', async () => {
      const { orderId, itemIds } = await seedOrder(ctx.branchA, ctx.posA.deviceId, TODAY, [
        '5.00',
        '7.00',
      ]);
      const first = await call(deps.routes.bill, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('cut3'),
        body: { orderId, split: { kind: 'NONE' } },
      });
      expect((first.json.billIds as string[]).length).toBe(1);

      const recut = await call(deps.routes.bill, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('recut'),
        body: {
          orderId,
          split: { kind: 'BY_ITEM', groups: [[itemIds[0]], [itemIds[1]]] },
          recut: {
            reason: 'guests splitting the check',
            approving: { staffProfileId: ctx.managerA, type: 'PIN', secret: PIN },
          },
        },
      });
      expect(recut.status).toBe(200);
      expect((recut.json.billIds as string[]).length).toBe(2);
    });

    it('records a paid-in movement (cash:adjust)', async () => {
      const res = await call(deps.routes.drawerMovement, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('movement'),
        body: { drawerSessionId, kind: 'PAID_IN', amount: '20.00', reason: 'change fund top-up' },
      });
      expect(res.status).toBe(200);
      expect(res.json.movementId).toBeTruthy();
      expect(res.json.replayed).toBe(false);
    });

    it('closes the drawer (cash:close)', async () => {
      // Expected = float 100 + cash sales 20.01 − cash refund 10 + paid-in 20 = 130.01.
      const res = await call(deps.routes.drawerClose, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('close'),
        body: { drawerSessionId, countedCash: '130.01' },
      });
      expect(res.status).toBe(200);
      eqMoney(res.json.expectedCash, '130.01');
      eqMoney(res.json.variance, '0.00');
    });
  });

  // QA-143 — on an EXCLUSIVE-tax bill the register summary must disclose tax and a
  // remaining due that settles the bill, both before any tender and after a partial
  // one. Before the fix the summary reported the stored pre-tax total with no tax, so
  // the displayed due undercharged and a later summary read 0.00 due on an OPEN bill.
  describe('QA-143 open-bill tax disclosure (EXCLUSIVE)', () => {
    it('discloses tax up front, keeps the true remainder after a partial tender, and settles', async () => {
      const token = await establishUnlock(ctx.posTax.secret, ctx.staffA, ctx.branchTax);

      const drawer = await call(deps.routes.drawerOpen, {
        secret: ctx.posTax.secret,
        session: token,
        key: uniqueKey('qa143-open'),
        body: { openingFloat: '0.00' },
      });
      expect(drawer.status).toBe(200);

      const { orderId } = await seedOrder(ctx.branchTax, ctx.posTax.deviceId, TODAY, ['970.00']);
      const cut = await call(deps.routes.bill, {
        secret: ctx.posTax.secret,
        session: token,
        key: uniqueKey('qa143-cut'),
        body: { orderId, split: { kind: 'NONE' } },
      });
      expect(cut.status).toBe(200);
      const billId = (cut.json.billIds as string[])[0]!;

      // Before any tender: tax (15% of 970) is disclosed and the due is the tax-inclusive
      // total — not the bare 970.00 menu price the bill stores.
      const readSummary = async () => {
        const res = await call(deps.routes.summary, {
          method: 'GET',
          secret: ctx.posTax.secret,
          session: token,
          query: { orderId },
        });
        expect(res.status, JSON.stringify(res.json)).toBe(200);
        return res.json;
      };
      const before = await readSummary();
      const billBefore = (before.bills as Record<string, unknown>[])[0]!;
      eqMoney(billBefore.grandTotal, '1115.50');
      eqMoney(billBefore.taxTotal, '145.50');
      eqMoney(billBefore.remainingDue, '1115.50');
      expect(before.settled).toBe(false);

      // Partial cash tender of the menu price (970) leaves the 145.50 tax remainder.
      const partial = await call(deps.routes.tender, {
        secret: ctx.posTax.secret,
        session: token,
        key: uniqueKey('qa143-partial'),
        body: {
          billId,
          tender: { type: 'CASH', amount: '970.00', cashReceived: '5000.00' },
        },
      });
      expect(partial.status, JSON.stringify(partial.json)).toBe(200);
      expect(partial.json.settled).toBe(false);
      eqMoney(partial.json.changeGiven, '4030.00');
      eqMoney(partial.json.remainingDue, '145.50');

      // The summary after the partial must show the true 145.50 remainder on the still
      // OPEN bill — never 0.00 due with a BILLS_OPEN blocker (the reported defect).
      const after = await readSummary();
      const billAfter = (after.bills as Record<string, unknown>[])[0]!;
      expect(billAfter.status).toBe('OPEN');
      eqMoney(billAfter.taxTotal, '145.50');
      eqMoney(billAfter.remainingDue, '145.50');
      expect(after.settled).toBe(false);
      expect(after.blocker).toBe('BILLS_OPEN');

      // Tendering exactly the displayed remainder settles the bill and issues a receipt.
      const settle = await call(deps.routes.tender, {
        secret: ctx.posTax.secret,
        session: token,
        key: uniqueKey('qa143-settle'),
        body: {
          billId,
          tender: { type: 'CASH', amount: '145.50', cashReceived: '200.00' },
        },
      });
      expect(settle.status, JSON.stringify(settle.json)).toBe(200);
      expect(settle.json.settled).toBe(true);
      expect(typeof settle.json.receiptNumber).toBe('number');
      eqMoney(settle.json.remainingDue, '0.00');
      const settled = await readSummary();
      expect(settled.settled).toBe(true);
      expect((settled.bills as Record<string, unknown>[])[0]).toMatchObject({
        status: 'SETTLED',
        taxTotal: '145.50',
        grandTotal: '1115.50',
        remainingDue: '0.00',
      });

      const cardOrder = await seedOrder(
        ctx.branchTax,
        ctx.posTax.deviceId,
        TODAY,
        ['120.00'],
        'TAKEAWAY'
      );
      const cardBill = await call(deps.routes.bill, {
        secret: ctx.posTax.secret,
        session: token,
        key: uniqueKey('qa143-card-cut'),
        body: { orderId: cardOrder.orderId, split: { kind: 'NONE' } },
      });
      expect(cardBill.status).toBe(200);
      const cardSummary = await call(deps.routes.summary, {
        method: 'GET',
        secret: ctx.posTax.secret,
        session: token,
        query: { orderId: cardOrder.orderId },
      });
      expect(cardSummary.status).toBe(200);
      const quotedCardBill = (cardSummary.json.bills as Record<string, unknown>[])[0]!;
      eqMoney(quotedCardBill.taxTotal, '18.00');
      eqMoney(quotedCardBill.remainingDue, '138.00');
      const cardTender = await call(deps.routes.tender, {
        secret: ctx.posTax.secret,
        session: token,
        key: uniqueKey('qa143-card'),
        body: {
          billId: (cardBill.json.billIds as string[])[0],
          tender: { type: 'CARD', amount: quotedCardBill.remainingDue, tipAmount: '20.00' },
        },
      });
      expect(cardTender.status, JSON.stringify(cardTender.json)).toBe(200);
      expect(cardTender.json.settled).toBe(true);
      eqMoney(cardTender.json.remainingDue, '0.00');
      const cardSettled = await call(deps.routes.summary, {
        method: 'GET',
        secret: ctx.posTax.secret,
        session: token,
        query: { orderId: cardOrder.orderId },
      });
      expect(cardSettled.status, JSON.stringify(cardSettled.json)).toBe(200);
      expect(cardSettled.json.settled).toBe(true);
      expect(cardSettled.json.blocker).toBeNull();
      expect((cardSettled.json.bills as Record<string, unknown>[])[0]).toMatchObject({
        status: 'SETTLED',
        taxTotal: '18.00',
        grandTotal: '138.00',
        remainingDue: '0.00',
      });
    });

    it('leaves the bill open and refuses order close when only the pre-tax amount is paid', async () => {
      const token = await establishUnlock(ctx.posTax.secret, ctx.staffA, ctx.branchTax);
      const drawer = await call(deps.routes.drawerOpen, {
        secret: ctx.posTax.secret,
        session: token,
        key: uniqueKey('qa143-underpay-open'),
        body: { openingFloat: '0.00' },
      });
      if (drawer.status !== 200) {
        expect(JSON.stringify(drawer.json)).toMatch(/already has an open drawer/);
      }

      const { orderId } = await seedOrder(ctx.branchTax, ctx.posTax.deviceId, TODAY, ['970.00']);
      const cut = await call(deps.routes.bill, {
        secret: ctx.posTax.secret,
        session: token,
        key: uniqueKey('qa143-underpay-cut'),
        body: { orderId, split: { kind: 'NONE' } },
      });
      expect(cut.status, JSON.stringify(cut.json)).toBe(200);
      const billId = (cut.json.billIds as string[])[0]!;

      const partial = await call(deps.routes.tender, {
        secret: ctx.posTax.secret,
        session: token,
        key: uniqueKey('qa143-underpay'),
        body: {
          billId,
          tender: { type: 'CASH', amount: '970.00', cashReceived: '1000.00' },
        },
      });
      expect(partial.status, JSON.stringify(partial.json)).toBe(200);
      expect(partial.json.settled).toBe(false);
      eqMoney(partial.json.remainingDue, '145.50');

      const summary = await call(deps.routes.summary, {
        method: 'GET',
        secret: ctx.posTax.secret,
        session: token,
        query: { orderId },
      });
      expect(summary.status, JSON.stringify(summary.json)).toBe(200);
      expect(summary.json.settled).toBe(false);
      expect(summary.json.blocker).toBe('BILLS_OPEN');
      const bill = (summary.json.bills as Record<string, unknown>[])[0]!;
      expect(bill.status).toBe('OPEN');
      eqMoney(bill.remainingDue, '145.50');

      // SERVED → PAYMENT_PENDING parks an unsettled order. Closing that pending
      // order is the refusal: the bill is still short the exclusive tax.
      const parked = await call(deps.routes.orderClose, {
        secret: ctx.posTax.secret,
        session: token,
        key: uniqueKey('qa143-underpay-park'),
        body: { orderId },
      });
      expect(parked.status, JSON.stringify(parked.json)).toBe(200);
      const pending = await deps.withTenantDb(orgA, (tx) =>
        tx.restaurantOrder.findUnique({ where: { id: orderId }, select: { status: true } })
      );
      expect(pending?.status).toBe('PAYMENT_PENDING');

      const refused = await call(deps.routes.orderClose, {
        secret: ctx.posTax.secret,
        session: token,
        key: uniqueKey('qa143-underpay-close'),
        body: { orderId },
      });
      expect(refused.status, JSON.stringify(refused.json)).toBe(400);
      expect(refused.json.error).toBe(
        'The order cannot close until it is fully settled (BILLS_OPEN).'
      );
      const stillOpen = await deps.withTenantDb(orgA, (tx) =>
        tx.restaurantOrder.findUnique({ where: { id: orderId }, select: { status: true } })
      );
      expect(stillOpen?.status).toBe('PAYMENT_PENDING');
      const afterRefusal = await call(deps.routes.summary, {
        method: 'GET',
        secret: ctx.posTax.secret,
        session: token,
        query: { orderId },
      });
      expect(afterRefusal.status).toBe(200);
      expect((afterRefusal.json.bills as Record<string, unknown>[])[0]?.status).toBe('OPEN');
    });
  });

  describe('WHA-977 terminal bill branch boundary', () => {
    it('runs as a restricted PostgreSQL role with two tenant and two-branch fixtures', async () => {
      const role = await deps.withTenantDb(
        orgA,
        (tx) =>
          tx.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
          SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
        `
      );
      expect(role).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      expect(
        await deps.withTenantDb(orgA, (tx) => tx.restaurantBranch.count())
      ).toBeGreaterThanOrEqual(2);
      expect(
        await deps.withTenantDb(orgA, (tx) =>
          tx.restaurantBranch.count({ where: { id: ctx.orgBBranch } })
        )
      ).toBe(0);
      expect(
        await deps.withTenantDb(orgB, (tx) =>
          tx.restaurantBranch.count({ where: { id: ctx.orgBBranch } })
        )
      ).toBe(1);
    });

    it('allows same-branch cut and comp, but denies cross-branch cut, recut, and comp with zero side effects', async () => {
      const tokenB = await establishUnlock(ctx.posB.secret, ctx.staffA, ctx.branchB);
      const branchBOrder = await seedOrder(ctx.branchB, ctx.posB.deviceId, TODAY, ['6.00']);
      const branchBCutKey = uniqueKey('wha977-same-branch-cut');
      const branchBCut = await call(deps.routes.bill, {
        secret: ctx.posB.secret,
        session: tokenB,
        key: branchBCutKey,
        body: { orderId: branchBOrder.orderId, split: { kind: 'NONE' } },
      });
      expect(branchBCut.status, JSON.stringify(branchBCut.json)).toBe(200);
      const branchBBillId = (branchBCut.json.billIds as string[])[0]!;
      const branchBLineId = await deps.withTenantDb(
        orgA,
        async (tx) =>
          (
            await tx.restaurantBillLine.findFirstOrThrow({
              where: { billId: branchBBillId },
              select: { id: true },
            })
          ).id
      );

      const branchBCompKey = uniqueKey('wha977-same-branch-comp');
      const branchBCompBody = {
        billId: branchBBillId,
        billLineId: branchBLineId,
        reason: 'same branch regression',
        approving: { staffProfileId: ctx.managerA, type: 'PIN' as const, secret: PIN },
      };
      const sameBranchComp = await call(deps.routes.retainedComp, {
        secret: ctx.posB.secret,
        session: tokenB,
        key: branchBCompKey,
        body: branchBCompBody,
      });
      expect(sameBranchComp.status, JSON.stringify(sameBranchComp.json)).toBe(200);

      const sameBranchCutReplay = await call(deps.routes.bill, {
        secret: ctx.posB.secret,
        session: tokenB,
        key: branchBCutKey,
        body: { orderId: branchBOrder.orderId, split: { kind: 'NONE' } },
      });
      expect(sameBranchCutReplay.json).toEqual({ ...branchBCut.json, replayed: true });
      const sameBranchCompReplay = await call(deps.routes.retainedComp, {
        secret: ctx.posB.secret,
        session: tokenB,
        key: branchBCompKey,
        body: branchBCompBody,
      });
      expect(sameBranchCompReplay.json).toEqual({ ...sameBranchComp.json, replayed: true });

      const recutOrder = await seedOrder(ctx.branchB, ctx.posB.deviceId, TODAY, ['4.00']);
      const initialCut = await call(deps.routes.bill, {
        secret: ctx.posB.secret,
        session: tokenB,
        key: uniqueKey('wha977-recut-fixture'),
        body: { orderId: recutOrder.orderId, split: { kind: 'NONE' } },
      });
      expect(initialCut.status, JSON.stringify(initialCut.json)).toBe(200);

      const uncutOrder = await seedOrder(ctx.branchB, ctx.posB.deviceId, TODAY, ['3.00']);
      const tokenA = await establishUnlock(ctx.posA.secret, ctx.staffA, ctx.branchA);
      const before = await moneyCounts();

      const deniedCut = await call(deps.routes.bill, {
        secret: ctx.posA.secret,
        session: tokenA,
        key: uniqueKey('wha977-cross-branch-cut'),
        body: { orderId: uncutOrder.orderId, split: { kind: 'NONE' } },
      });
      expect(deniedCut.status).toBe(404);

      const deniedRecut = await call(deps.routes.bill, {
        secret: ctx.posA.secret,
        session: tokenA,
        key: uniqueKey('wha977-cross-branch-recut'),
        body: {
          orderId: recutOrder.orderId,
          split: { kind: 'NONE' },
          recut: {
            reason: 'must not cross branch',
            approving: { staffProfileId: ctx.managerA, type: 'PIN', secret: PIN },
          },
        },
      });
      expect(deniedRecut.status).toBe(404);

      const pinState = () =>
        deps.withTenantDb(orgA, (tx) =>
          tx.restaurantOperatorCredential.findFirstOrThrow({
            where: { staffProfileId: ctx.managerA, type: 'PIN' },
            select: { failedAttempts: true, lockedUntil: true },
          })
        );
      const beforePin = await pinState();
      for (const billId of [branchBBillId, `missing_bill_${suffix}`]) {
        const deniedComp = await call(deps.routes.retainedComp, {
          secret: ctx.posA.secret,
          session: tokenA,
          key: uniqueKey('wha977-cross-branch-comp'),
          body: {
            billId,
            billLineId: branchBLineId,
            reason: 'must not cross branch',
            approving: { staffProfileId: ctx.managerA, type: 'PIN', secret: '000000' },
          },
        });
        expect(deniedComp.status).toBe(404);
        expect(await pinState()).toEqual(beforePin);
      }

      await deps.withTenantDb(orgA, (tx) =>
        tx.restaurantRegisteredDevice.update({
          where: { id: ctx.posB.deviceId },
          data: { branchId: ctx.branchA },
        })
      );
      const beforeReassignedReplays = await moneyCounts();
      const deniedCutReplay = await call(deps.routes.bill, {
        secret: ctx.posB.secret,
        session: tokenB,
        key: branchBCutKey,
        body: { orderId: branchBOrder.orderId, split: { kind: 'NONE' } },
      });
      expect(deniedCutReplay).toEqual({
        status: 404,
        json: { error: 'The order does not exist.' },
      });
      const deniedCompReplay = await call(deps.routes.retainedComp, {
        secret: ctx.posB.secret,
        session: tokenB,
        key: branchBCompKey,
        body: branchBCompBody,
      });
      expect(deniedCompReplay).toEqual({
        status: 404,
        json: { error: 'The bill does not exist.' },
      });
      expect(await moneyCounts()).toEqual(beforeReassignedReplays);
      expect(await moneyCounts()).toEqual(before);
    });
  });

  describe('terminal tender branch and business-date boundary', () => {
    it('rejects foreign-branch cash bills, but collects open prior-day bills in the current drawer', async () => {
      const tokenDay = await establishUnlock(ctx.posDay.secret, ctx.staffA, ctx.branchDay);

      const foreignOrder = await seedOrder(ctx.branchDay, ctx.posDay.deviceId, TODAY, ['5.00']);
      const foreignCut = await call(deps.routes.bill, {
        secret: ctx.posDay.secret,
        session: tokenDay,
        key: uniqueKey('foreign-cut'),
        body: { orderId: foreignOrder.orderId, split: { kind: 'NONE' } },
      });
      const foreignBillId = (foreignCut.json.billIds as string[])[0]!;
      const tokenA = await establishUnlock(ctx.posA.secret, ctx.staffA, ctx.branchA);
      const beforeForeign = await moneyCounts();
      const foreign = await call(deps.routes.tender, {
        secret: ctx.posA.secret,
        session: tokenA,
        key: uniqueKey('foreign-tender'),
        body: {
          billId: foreignBillId,
          tender: { type: 'CASH', amount: '5.00', cashReceived: '5.00' },
        },
      });
      expect(foreign.status).toBe(404);
      expect(await moneyCounts()).toEqual(beforeForeign);

      const open = await call(deps.routes.drawerOpen, {
        secret: ctx.posA.secret,
        session: tokenA,
        key: uniqueKey('date-drawer'),
        body: { openingFloat: '0.00' },
      });
      expect(open.status).toBe(200);
      const oldDate = '2026-08-18';
      const oldOrder = await seedOrder(ctx.branchA, ctx.posA.deviceId, oldDate, ['5.00']);
      const oldCut = await call(deps.routes.bill, {
        secret: ctx.posA.secret,
        session: tokenA,
        key: uniqueKey('old-cut'),
        body: { orderId: oldOrder.orderId, split: { kind: 'NONE' } },
      });
      const oldBillId = (oldCut.json.billIds as string[])[0]!;
      const old = await call(deps.routes.tender, {
        secret: ctx.posA.secret,
        session: tokenA,
        key: uniqueKey('old-tender'),
        body: {
          billId: oldBillId,
          tender: { type: 'CASH', amount: '5.00', cashReceived: '5.00' },
        },
      });
      expect(old.status, JSON.stringify(old.json)).toBe(200);
      expect(old.json.settled).toBe(true);
      expect(old.json.drawerSessionId).toBe(open.json.drawerSessionId);
      eqMoney(old.json.remainingDue, '0.00');
      const collected = await deps.withTenantDb(orgA, async (tx) => ({
        bill: await tx.restaurantBill.findUniqueOrThrow({ where: { id: oldBillId } }),
        tenders: await tx.restaurantTender.findMany({ where: { billId: oldBillId } }),
        movements: await tx.restaurantDrawerMovement.findMany({
          where: { drawerSessionId: open.json.drawerSessionId as string, kind: 'CASH_SALE' },
        }),
      }));
      expect(collected.bill.status).toBe('SETTLED');
      expect(collected.bill.businessDate.toISOString().slice(0, 10)).toBe(oldDate);
      expect(collected.tenders).toHaveLength(1);
      const tender = collected.tenders[0]!;
      expect(tender.id).toBe(old.json.tenderId);
      expect(tender.businessDate.toISOString().slice(0, 10)).toBe(open.json.businessDate);
      expect(open.json.businessDate).not.toBe(oldDate);
      expect(tender.drawerSessionId).toBe(open.json.drawerSessionId);
      eqMoney(tender.amount, '5.00');
      eqMoney(tender.cashReceived!.minus(tender.changeGiven!), '5.00');
      expect(tender.amount.equals(collected.bill.grandTotal)).toBe(true);
      expect(collected.movements).toHaveLength(1);
      expect(collected.movements[0]!.tenderId).toBe(tender.id);
      eqMoney(collected.movements[0]!.amount, '5.00');

      const close = await call(deps.routes.drawerClose, {
        secret: ctx.posA.secret,
        session: tokenA,
        key: uniqueKey('date-drawer-close'),
        body: { drawerSessionId: open.json.drawerSessionId, countedCash: '5.00' },
      });
      expect(close.status, JSON.stringify(close.json)).toBe(200);
      eqMoney(close.json.expectedCash, '5.00');
      eqMoney(close.json.variance, '0.00');
    });

    it('rejects a cash tender on an actually closed bill day with zero tender or drawer writes', async () => {
      const token = await establishUnlock(ctx.posA.secret, ctx.staffA, ctx.branchA);
      const closedDate = '2026-08-17';
      const order = await seedOrder(ctx.branchA, ctx.posA.deviceId, closedDate, ['5.00']);
      const cut = await call(deps.routes.bill, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('closed-day-cut'),
        body: { orderId: order.orderId, split: { kind: 'NONE' } },
      });
      expect(cut.status, JSON.stringify(cut.json)).toBe(200);
      const billId = (cut.json.billIds as string[])[0]!;
      // Persist a closed-day fixture with an outstanding bill (e.g. imported
      // history). A different date alone must never stand in for a close record.
      await deps.withTenantDb(orgA, (tx) =>
        tx.restaurantDailyClose.create({
          data: {
            branchId: ctx.branchA,
            businessDate: new Date(`${closedDate}T00:00:00.000Z`),
            cutByStaffProfileId: ctx.staffA,
            deviceId: ctx.posA.deviceId,
          },
        })
      );
      const open = await call(deps.routes.drawerOpen, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('closed-day-drawer'),
        body: { openingFloat: '0.00' },
      });
      expect(open.status).toBe(200);
      expect(open.json.businessDate).not.toBe(closedDate);
      const drawerSessionId = open.json.drawerSessionId as string;
      const before = await moneyCounts();
      const drawerBefore = await deps.withTenantDb(orgA, (tx) =>
        tx.restaurantDrawerSession.findUniqueOrThrow({ where: { id: drawerSessionId } })
      );
      const denied = await call(deps.routes.tender, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('closed-day-tender'),
        body: { billId, tender: { type: 'CASH', amount: '5.00', cashReceived: '5.00' } },
      });
      expect(denied.status, JSON.stringify(denied.json)).toBe(409);
      expect(denied.json.error).toBe('This business day is closed; no money can be posted.');
      expect(await moneyCounts()).toEqual(before);
      expect(
        await deps.withTenantDb(orgA, (tx) =>
          tx.restaurantDrawerSession.findUniqueOrThrow({ where: { id: drawerSessionId } })
        )
      ).toEqual(drawerBefore);
      const close = await call(deps.routes.drawerClose, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('closed-day-drawer-close'),
        body: { drawerSessionId, countedCash: '0.00' },
      });
      expect(close.status).toBe(200);
      eqMoney(close.json.expectedCash, '0.00');
      eqMoney(close.json.variance, '0.00');
    });
  });

  // ── Day close flow (its own branch, so bills/drawers are fully resolved) ─────
  describe('daily close', () => {
    let token = '';
    let dayDate = '';
    let closeId = '';
    let correctionId = '';
    const closeKey = uniqueKey('dayclose');
    const correctionKey = uniqueKey('daycorrect');

    beforeAll(async () => {
      // Keep both cutoff settings on opposite sides of now, including at UTC midnight.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
      token = await establishUnlock(ctx.posDay.secret, ctx.staffA, ctx.branchDay);
      await deps.withTenantDb(orgA, (tx) =>
        tx.restaurantBranch.update({
          where: { id: ctx.branchDay },
          data: { timezone: 'UTC', businessDayCutoff: '23:59' },
        })
      );
      const open = await call(deps.routes.drawerOpen, {
        secret: ctx.posDay.secret,
        session: token,
        key: uniqueKey('dopen'),
        body: { openingFloat: '50.00' },
      });
      expect(open.status).toBe(200);
      dayDate = open.json.businessDate as string;
      const drawerSessionId = open.json.drawerSessionId as string;

      const { orderId } = await seedOrder(ctx.branchDay, ctx.posDay.deviceId, dayDate, ['10.00']);
      const cut = await call(deps.routes.bill, {
        secret: ctx.posDay.secret,
        session: token,
        key: uniqueKey('dcut'),
        body: { orderId, split: { kind: 'NONE' } },
      });
      const billId = (cut.json.billIds as string[])[0]!;
      const tender = await call(deps.routes.tender, {
        secret: ctx.posDay.secret,
        session: token,
        key: uniqueKey('dtender'),
        body: { billId, tender: { type: 'CASH', amount: '10.00', cashReceived: '10.00' } },
      });
      expect(tender.json.settled).toBe(true);
      // Day close refuses active orders, so finish the paid order the way the
      // terminal does before the drawer and day are closed.
      const orderClosed = await call(deps.routes.orderClose, {
        secret: ctx.posDay.secret,
        session: token,
        key: uniqueKey('dorderclose'),
        body: { orderId },
      });
      expect(orderClosed.status, JSON.stringify(orderClosed.json)).toBe(200);
      const close = await call(deps.routes.drawerClose, {
        secret: ctx.posDay.secret,
        session: token,
        key: uniqueKey('dclose'),
        body: { drawerSessionId, countedCash: '60.00' },
      });
      expect(close.status).toBe(200);
      await deps.withTenantDb(orgA, (tx) =>
        tx.restaurantBranch.update({
          where: { id: ctx.branchDay },
          data: { businessDayCutoff: '00:00' },
        })
      );
    });

    afterAll(() => vi.useRealTimers());

    it('recovers the pending drawer date after the cutoff advances', async () => {
      const res = await call(deps.routes.dayCurrent, {
        method: 'GET',
        secret: ctx.posDay.secret,
        session: token,
      });
      expect(res.status).toBe(200);
      expect(res.json.businessDate).toBe(dayDate);
      expect(dayDate).not.toBe(TODAY);
    });

    it('previews the day (cash:close read): ready to close, no existing close', async () => {
      const res = await call(deps.routes.dayPreview, {
        method: 'GET',
        secret: ctx.posDay.secret,
        session: token,
        query: { businessDate: dayDate },
      });
      expect(res.status).toBe(200);
      const readiness = res.json.readiness as Record<string, unknown>;
      expect(readiness.allBillsResolved).toBe(true);
      expect(readiness.allDrawersClosed).toBe(true);
      expect(res.json.existingCloseId).toBeNull();
      eqMoney((res.json.totals as Record<string, string>).grossSales, '8.70');
    });

    it('cuts the daily close (cash:close)', async () => {
      const res = await call(deps.routes.dayClose, {
        secret: ctx.posDay.secret,
        session: token,
        key: closeKey,
        body: { businessDate: dayDate },
      });
      expect(res.status).toBe(200);
      expect(res.json.replayed).toBe(false);
      closeId = res.json.dailyCloseId as string;
      expect(closeId).toBeTruthy();
      const cash = (res.json.tenderTotals as { tenderType: string; amount: string }[]).find(
        (t) => t.tenderType === 'CASH'
      );
      eqMoney(cash?.amount, '10.00');
    });

    it('a replayed day close returns the original close and writes no new close row (C11)', async () => {
      const before = await moneyCounts();
      const res = await call(deps.routes.dayClose, {
        secret: ctx.posDay.secret,
        session: token,
        key: closeKey,
        body: { businessDate: dayDate },
      });
      const after = await moneyCounts();
      expect(res.status).toBe(200);
      expect(res.json.replayed).toBe(true);
      expect(res.json.dailyCloseId).toBe(closeId);
      expect(after.closes).toBe(before.closes);
    });

    it('rejects a day-close key reused with a changed business date with zero writes', async () => {
      const before = await moneyCounts();
      const res = await call(deps.routes.dayClose, {
        secret: ctx.posDay.secret,
        session: token,
        key: closeKey,
        body: { businessDate: '2026-08-18' },
      });
      expect(res.status).toBe(409);
      expect(await moneyCounts()).toEqual(before);
    });

    it('corrects the close, superseding the chain tip (cash:close + co-auth)', async () => {
      const res = await call(deps.routes.dayCorrect, {
        secret: ctx.posDay.secret,
        session: token,
        key: correctionKey,
        body: {
          businessDate: dayDate,
          supersedesCloseId: closeId,
          reason: 'recount adjustment',
          approving: { staffProfileId: ctx.managerA, type: 'PIN', secret: PIN },
        },
      });
      expect(res.status).toBe(200);
      expect(res.json.supersedesCloseId).toBe(closeId);
      expect(res.json.dailyCloseId).not.toBe(closeId);
      correctionId = res.json.dailyCloseId as string;
    });

    it('replays one frozen correction and conflicts on changed reason or approver evidence', async () => {
      const body = {
        businessDate: dayDate,
        supersedesCloseId: closeId,
        reason: 'recount adjustment',
        approving: { staffProfileId: ctx.managerA, type: 'PIN', secret: PIN },
      };
      const before = await moneyCounts();
      const replay = await call(deps.routes.dayCorrect, {
        secret: ctx.posDay.secret,
        session: token,
        key: correctionKey,
        body,
      });
      expect(replay.status).toBe(200);
      expect(replay.json.dailyCloseId).toBe(correctionId);
      expect(replay.json.supersedesCloseId).toBe(closeId);
      expect(replay.json.replayed).toBe(true);
      expect(await moneyCounts()).toEqual(before);

      for (const changed of [
        { ...body, reason: 'different reason' },
        { ...body, supersedesCloseId: correctionId },
        {
          ...body,
          approving: { staffProfileId: ctx.staffA, type: 'PIN', secret: PIN },
        },
      ]) {
        const conflict = await call(deps.routes.dayCorrect, {
          secret: ctx.posDay.secret,
          session: token,
          key: correctionKey,
          body: changed,
        });
        expect(conflict.status).toBe(409);
      }
      expect(await moneyCounts()).toEqual(before);
    });
  });

  // ── Idempotent replay writes nothing (all money tables asserted) ────────────
  describe('idempotent replay', () => {
    it('a replayed card tender returns the original result and creates nothing (C11)', async () => {
      const token = await establishUnlock(ctx.posReplay.secret, ctx.staffA, ctx.branchReplay);
      const { orderId } = await seedOrder(ctx.branchReplay, ctx.posReplay.deviceId, TODAY, [
        '12.00',
      ]);
      const cut = await call(deps.routes.bill, {
        secret: ctx.posReplay.secret,
        session: token,
        key: uniqueKey('rcut'),
        body: { orderId, split: { kind: 'NONE' } },
      });
      const billId = (cut.json.billIds as string[])[0]!;

      const key = uniqueKey('rtender');
      const first = await call(deps.routes.tender, {
        secret: ctx.posReplay.secret,
        session: token,
        key,
        body: { billId, tender: { type: 'CARD', amount: '12.00', tipAmount: '2.00' } },
      });
      expect(first.status).toBe(200);
      expect(first.json.settled).toBe(true);
      expect(first.json.paymentId).toBeTruthy();

      const before = await moneyCounts();
      const replay = await call(deps.routes.tender, {
        secret: ctx.posReplay.secret,
        session: token,
        key,
        body: { billId, tender: { type: 'CARD', amount: '12.00', tipAmount: '2.00' } },
      });
      const after = await moneyCounts();

      expect(replay.status).toBe(200);
      // Original result verbatim, except the replay flag flips false → true.
      expect(replay.json).toEqual({ ...first.json, replayed: true });
      // Nothing was written on the replay — every money table is unchanged.
      expect(after).toEqual(before);
    });
  });

  // ── Revoked device is rejected on every money route (C12) ────────────────────
  describe('revoked device', () => {
    const moneyProbes = (session: string) =>
      [
        { r: 'bill', body: { orderId: 'o', split: { kind: 'NONE' } } },
        {
          r: 'retainedComp',
          body: {
            billId: 'b',
            billLineId: 'l',
            reason: 'x',
            approving: { staffProfileId: ctx.managerA, type: 'PIN', secret: PIN },
          },
        },
        {
          r: 'tender',
          body: { billId: 'b', tender: { type: 'CASH', amount: '1.00', cashReceived: '1.00' } },
        },
        {
          r: 'refund',
          body: {
            originalTenderId: 't',
            amount: '1.00',
            reason: 'x',
            approving: { staffProfileId: ctx.managerA, type: 'PIN', secret: PIN },
          },
        },
        { r: 'drawerOpen', body: { openingFloat: '1.00' } },
        {
          r: 'drawerMovement',
          body: { drawerSessionId: 'd', kind: 'PAID_IN', amount: '1.00', reason: 'x' },
        },
        { r: 'drawerClose', body: { drawerSessionId: 'd', countedCash: '1.00' } },
        { r: 'dayClose', body: { businessDate: TODAY } },
        {
          r: 'dayCorrect',
          body: {
            businessDate: TODAY,
            supersedesCloseId: 'c',
            reason: 'x',
            approving: { staffProfileId: ctx.managerA, type: 'PIN', secret: PIN },
          },
        },
      ].map((p) => ({ ...p, session })) as { r: string; body: unknown; session: string }[];

    const readProbes = (session: string) =>
      (
        [
          { r: 'summary', query: { orderId: 'o' } },
          { r: 'receipt', query: { billId: 'b' } },
          { r: 'dayPreview', query: { businessDate: TODAY } },
        ] as { r: string; query: Record<string, string> }[]
      ).map((p) => ({ ...p, session }));

    it('rejects a REVOKED device on every checkout + cash route, even with a valid session', async () => {
      const device = await enroll(ctx.branchA, 'revoke-pos');
      const token = await establishUnlock(device.secret);
      await deps.withTenantDb(orgA, (tx) => deps.revokeDevice(tx, device.deviceId, new Date()));

      for (const probe of moneyProbes(token)) {
        const res = await call(deps.routes[probe.r], {
          secret: device.secret,
          session: probe.session,
          key: uniqueKey('rev'),
          body: probe.body,
        });
        expect(res.status, `mutation ${probe.r}`).toBe(403);
      }
      for (const probe of readProbes(token)) {
        const res = await call(deps.routes[probe.r], {
          method: 'GET',
          secret: device.secret,
          session: probe.session,
          query: probe.query,
        });
        expect(res.status, `read ${probe.r}`).toBe(403);
      }
    });
  });

  // ── Capability denial per route (C11) ────────────────────────────────────────
  describe('capability denial', () => {
    it('refuses every money route when the acting operator lacks the capability', async () => {
      const token = await establishUnlock(ctx.posA.secret, ctx.staffNoCap);

      const mutations: { r: string; body: unknown }[] = [
        { r: 'bill', body: { orderId: 'o', split: { kind: 'NONE' } } },
        {
          r: 'retainedComp',
          body: {
            billId: 'b',
            billLineId: 'l',
            reason: 'x',
            approving: { staffProfileId: ctx.managerA, type: 'PIN', secret: PIN },
          },
        },
        {
          r: 'tender',
          body: { billId: 'b', tender: { type: 'CASH', amount: '1.00', cashReceived: '1.00' } },
        },
        {
          r: 'refund',
          body: {
            originalTenderId: 't',
            amount: '1.00',
            reason: 'x',
            approving: { staffProfileId: ctx.managerA, type: 'PIN', secret: PIN },
          },
        },
        { r: 'drawerOpen', body: { openingFloat: '1.00' } },
        {
          r: 'drawerMovement',
          body: { drawerSessionId: 'd', kind: 'PAID_IN', amount: '1.00', reason: 'x' },
        },
        { r: 'drawerClose', body: { drawerSessionId: 'd', countedCash: '1.00' } },
        { r: 'dayClose', body: { businessDate: TODAY } },
      ];
      for (const m of mutations) {
        const res = await call(deps.routes[m.r], {
          secret: ctx.posA.secret,
          session: token,
          key: uniqueKey('deny'),
          body: m.body,
        });
        expect(res.status, `mutation ${m.r}`).toBe(403);
      }

      for (const [r, query] of [
        ['summary', { orderId: 'o' }],
        ['receipt', { billId: 'b' }],
        ['dayPreview', { businessDate: TODAY }],
      ] as const) {
        const res = await call(deps.routes[r], {
          method: 'GET',
          secret: ctx.posA.secret,
          session: token,
          query,
        });
        expect(res.status, `read ${r}`).toBe(403);
      }
    });

    it('refuses a co-authorized action when the approving manager lacks coauth:approve', async () => {
      const token = await establishUnlock(ctx.posA.secret);
      const { orderId } = await seedOrder(ctx.branchA, ctx.posA.deviceId, TODAY, ['9.00']);
      const cut = await call(deps.routes.bill, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('cutco'),
        body: { orderId, split: { kind: 'NONE' } },
      });
      const billId = (cut.json.billIds as string[])[0]!;
      const line = await deps.withTenantDb(orgA, (tx) =>
        tx.restaurantBillLine.findFirst({ where: { billId }, select: { id: true } })
      );

      // staffNoCap holds a valid credential but only `menu:read` — not `coauth:approve`.
      const res = await call(deps.routes.retainedComp, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('compco'),
        body: {
          billId,
          billLineId: line!.id,
          reason: 'kitchen error',
          approving: { staffProfileId: ctx.staffNoCap, type: 'PIN', secret: PIN },
        },
      });
      expect(res.status).toBe(403);
    });
  });

  // QA-145 (SEV1): co-authorization must honour SOP-1 job-role capabilities, not only the
  // linked `User` org-role permissions. A PIN-only floor manager holding the Owner job
  // role (which carries `coauth:approve`) must be able to approve a refund and a comp;
  // one whose job role lacks it stays denied and writes nothing.
  describe('QA-145 job-role co-authorization', () => {
    it('lets a PIN-only approver with the coauth:approve job role authorize a refund', async () => {
      const token = await establishUnlock(ctx.posA.secret);
      const { orderId } = await seedOrder(ctx.branchA, ctx.posA.deviceId, TODAY, ['12.00']);
      const cut = await call(deps.routes.bill, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('qa145-cut'),
        body: { orderId, split: { kind: 'NONE' } },
      });
      const billId = (cut.json.billIds as string[])[0]!;
      const tender = await call(deps.routes.tender, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('qa145-tender'),
        body: { billId, tender: { type: 'CARD', amount: '12.00' } },
      });
      expect(tender.status, JSON.stringify(tender.json)).toBe(200);

      const res = await call(deps.routes.refund, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('qa145-refund'),
        body: {
          originalTenderId: tender.json.tenderId as string,
          amount: '12.00',
          reason: 'guest complaint',
          approving: { staffProfileId: ctx.floorApprover, type: 'PIN', secret: PIN },
        },
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      eqMoney(res.json.amount, '12.00');
      const coAuth = await deps.withTenantDb(orgA, (tx) =>
        tx.restaurantCoAuthorization.findFirst({
          where: { approvingStaffProfileId: ctx.floorApprover, capability: 'payments:refund' },
          select: { actingStaffProfileId: true },
        })
      );
      expect(coAuth?.actingStaffProfileId).toBe(ctx.staffA);
    });

    it('lets the same PIN-only approver authorize a retained domain comp through the test adapter', async () => {
      const token = await establishUnlock(ctx.posA.secret);
      const { orderId } = await seedOrder(ctx.branchA, ctx.posA.deviceId, TODAY, ['8.00']);
      const cut = await call(deps.routes.bill, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('qa145-comp-cut'),
        body: { orderId, split: { kind: 'NONE' } },
      });
      const billId = (cut.json.billIds as string[])[0]!;
      const line = await deps.withTenantDb(orgA, (tx) =>
        tx.restaurantBillLine.findFirst({ where: { billId }, select: { id: true } })
      );

      const res = await call(deps.routes.retainedComp, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('qa145-comp'),
        body: {
          billId,
          billLineId: line!.id,
          reason: 'kitchen error',
          approving: { staffProfileId: ctx.floorApprover, type: 'PIN', secret: PIN },
        },
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(res.json.billId).toBe(billId);
    });

    it('still denies a PIN-only approver whose job role lacks coauth:approve, writing nothing', async () => {
      const token = await establishUnlock(ctx.posA.secret);
      const { orderId } = await seedOrder(ctx.branchA, ctx.posA.deviceId, TODAY, ['6.00']);
      const cut = await call(deps.routes.bill, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('qa145-deny-cut'),
        body: { orderId, split: { kind: 'NONE' } },
      });
      const billId = (cut.json.billIds as string[])[0]!;
      const tender = await call(deps.routes.tender, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('qa145-deny-tender'),
        body: { billId, tender: { type: 'CARD', amount: '6.00' } },
      });
      expect(tender.status).toBe(200);

      const before = await deps.withTenantDb(orgA, (tx) => tx.restaurantRefund.count());
      const res = await call(deps.routes.refund, {
        secret: ctx.posA.secret,
        session: token,
        key: uniqueKey('qa145-deny-refund'),
        body: {
          originalTenderId: tender.json.tenderId as string,
          amount: '6.00',
          reason: 'no capability',
          approving: { staffProfileId: ctx.floorNoCoauth, type: 'PIN', secret: PIN },
        },
      });
      expect(res.status).toBe(403);
      expect(res.json.error).toContain('coauth:approve');
      const after = await deps.withTenantDb(orgA, (tx) => tx.restaurantRefund.count());
      expect(after).toBe(before);
    });
  });
});
