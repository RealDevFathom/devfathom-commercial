/**
 * M5-L5 — the route-level named checks that only a database can establish, driving the
 * ACTUAL checkout + cash REST handlers exactly as an HTTP request would:
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

import { beforeAll, describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import { ensureRestaurantTaxProfile } from '@/lib/test-support/restaurant-tax-profile';
import { ensurePlatformModule, seedDepartments } from '@/lib/test-support/departments';

/** Assert a serialised money value by Decimal VALUE, tolerant of trailing-zero format
 * (`.toString()` trims computed Decimals: '10' ≡ '10.00'). Never a float comparison. */
const eqMoney = (actual: unknown, expected: string) =>
  expect(new Prisma.Decimal(String(actual)).equals(expected)).toBe(true);

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

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

/** Seeded once per run. */
const ctx = {
  branchA: `branch_a_${suffix}`,
  branchB: `branch_b_${suffix}`,
  orgBBranch: `branch_org_b_${suffix}`,
  branchDay: `branch_d_${suffix}`,
  branchReplay: `branch_r_${suffix}`,
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
  productA: `prod_a_${suffix}`,
  posA: { deviceId: '', secret: '' },
  posB: { deviceId: '', secret: '' },
  posDay: { deviceId: '', secret: '' },
  posReplay: { deviceId: '', secret: '' },
};

let orderSeq = 0;

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
      data: { organizationId: orgA, moduleId: posModule.id },
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
    await Promise.all([
      ensureRestaurantTaxProfile(tx, orgA, ctx.branchA),
      ensureRestaurantTaxProfile(tx, orgA, ctx.branchB),
      ensureRestaurantTaxProfile(tx, orgA, ctx.branchDay),
      ensureRestaurantTaxProfile(tx, orgA, ctx.branchReplay),
    ]);
    await tx.restaurantProduct.create({ data: { id: ctx.productA, name: 'Widget' } });

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
        data: [ctx.branchB, ctx.branchDay, ctx.branchReplay].map((branchId) => ({
          branchId,
          userId,
        })),
      });
    }
    await tx.restaurantStaffProfile.update({
      where: { id: ctx.managerForeign },
      data: { primaryBranchId: ctx.branchDay },
    });
  });
  await deps.withTenantDb(orgB, (tx) =>
    tx.restaurantBranch.create({ data: { id: ctx.orgBBranch, name: 'Other tenant' } })
  );

  ctx.posA = await enroll(ctx.branchA, 'posA');
  ctx.posB = await enroll(ctx.branchB, 'posB');
  ctx.posDay = await enroll(ctx.branchDay, 'posDay');
  ctx.posReplay = await enroll(ctx.branchReplay, 'posReplay');
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

    it('comps a bill line with manager co-authorization (payments:collect)', async () => {
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

      const res = await call(deps.routes.comp, {
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
      const sameBranchComp = await call(deps.routes.comp, {
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
      const sameBranchCompReplay = await call(deps.routes.comp, {
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

      const deniedComp = await call(deps.routes.comp, {
        secret: ctx.posA.secret,
        session: tokenA,
        key: uniqueKey('wha977-cross-branch-comp'),
        body: {
          billId: branchBBillId,
          billLineId: branchBLineId,
          reason: 'must not cross branch',
          approving: { staffProfileId: ctx.managerA, type: 'PIN', secret: PIN },
        },
      });
      expect(deniedComp.status).toBe(404);

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
      const deniedCompReplay = await call(deps.routes.comp, {
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
    it('rejects foreign-branch and old-date cash bills with zero tender or drawer writes', async () => {
      const tokenA = await establishUnlock(ctx.posA.secret, ctx.staffA, ctx.branchA);
      const tokenDay = await establishUnlock(ctx.posDay.secret, ctx.staffA, ctx.branchDay);

      const foreignOrder = await seedOrder(ctx.branchDay, ctx.posDay.deviceId, TODAY, ['5.00']);
      const foreignCut = await call(deps.routes.bill, {
        secret: ctx.posDay.secret,
        session: tokenDay,
        key: uniqueKey('foreign-cut'),
        body: { orderId: foreignOrder.orderId, split: { kind: 'NONE' } },
      });
      const foreignBillId = (foreignCut.json.billIds as string[])[0]!;
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
      const beforeOld = await moneyCounts();
      const old = await call(deps.routes.tender, {
        secret: ctx.posA.secret,
        session: tokenA,
        key: uniqueKey('old-tender'),
        body: {
          billId: oldBillId,
          tender: { type: 'CASH', amount: '5.00', cashReceived: '5.00' },
        },
      });
      expect(old.status).toBe(409);
      expect(await moneyCounts()).toEqual(beforeOld);

      await call(deps.routes.drawerClose, {
        secret: ctx.posA.secret,
        session: tokenA,
        key: uniqueKey('date-drawer-close'),
        body: { drawerSessionId: open.json.drawerSessionId, countedCash: '0.00' },
      });
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
          r: 'comp',
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
          r: 'comp',
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
      const res = await call(deps.routes.comp, {
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
});
