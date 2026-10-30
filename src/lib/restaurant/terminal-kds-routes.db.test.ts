/**
 * M4-L4 — the route-level named checks that only a database can establish, driving
 * the ACTUAL POS-terminal + KDS route handlers exactly as an HTTP request would:
 *
 *  - a REVOKED device is rejected on EVERY new route (the device is re-read fresh
 *    on every call, so even a still-"valid" session token is refused — C8);
 *  - a device-scoped idempotent replay of `(deviceId, key)` returns the original
 *    result and creates nothing (C7);
 *  - a KDS bump/ack maps only to a LEGAL item-domain transition, is scoped to the
 *    device's own bound station, and carries an idempotency key + operator (C8);
 *  - cross-tenant probes on the order routes are indistinguishable from "not found"
 *    (RLS hides another org's order — C1).
 *
 * Requires TEST_DATABASE_URL (a migrated throwaway DB, never DATABASE_URL); without
 * it the suite reports itself skipped rather than passing vacuously. Every read
 * filters by a per-run-unique id, so it is valid on a superuser URL too.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePlatformModule, seedDepartments } from '@/lib/test-support/departments';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(6).toString('hex');
const BDATE = new Date('2026-08-19T00:00:00.000Z');
const PIN = '424242';

const orgA = `org_wha44_a_${suffix}`;
const orgB = `org_wha44_b_${suffix}`;

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
  branchReplay: `branch_r_${suffix}`,
  branchB: `branch_b_${suffix}`,
  staffA: `staff_a_${suffix}`,
  staffReplay: `staff_replay_${suffix}`,
  staffB: `staff_b_${suffix}`,
  userA: `user_a_${suffix}`,
  userReplay: `user_replay_${suffix}`,
  userB: `user_b_${suffix}`,
  orderRoleA: `role_orders_a_${suffix}`,
  orderRoleB: `role_orders_b_${suffix}`,
  productA: `prod_a_${suffix}`,
  productB: `prod_b_${suffix}`,
  station1A: `stn1_a_${suffix}`,
  station2A: `stn2_a_${suffix}`,
  stationB: `stn_b_${suffix}`,
  posA: { deviceId: '', secret: '' },
  posReplay: { deviceId: '', secret: '' },
  kdsA: { deviceId: '', secret: '', session: '' },
  posB: { deviceId: '', secret: '' },
  kdsB: { deviceId: '', secret: '', session: '' },
};

let orderSeq = 0;
const ticketSeq = new Map<string, number>();

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

async function enroll(orgId: string, branchId: string, name: string) {
  const { device, secret } = await deps.withTenantDb(orgId, (tx) =>
    deps.enrollDevice(tx, { branchId, name })
  );
  return { deviceId: device.id, secret };
}

async function makeKds(orgId: string, branchId: string, stationId: string, name: string) {
  const device = await enroll(orgId, branchId, name);
  await deps.withTenantDb(orgId, (tx) =>
    tx.restaurantRegisteredDevice.update({
      where: { id: device.deviceId },
      data: { kind: 'KDS', stationId },
    })
  );
  return {
    ...device,
    session: await establishUnlock(device.secret, orgId === orgA ? ctx.staffA : ctx.staffB),
  };
}

async function establishUnlock(secret: string, staffProfileId = ctx.staffA): Promise<string> {
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

/** Seed an order + one item in orgA, optionally with a kitchen ticket routed to a
 * station (so a KDS can act on it). Rows are inserted directly — no menu needed. */
async function seedOrder(
  itemStatus: string,
  stationId?: string,
  branchId = ctx.branchA
): Promise<{ orderId: string; itemId: string }> {
  orderSeq += 1;
  const orderNumber = orderSeq;
  return deps.withTenantDb(orgA, async (tx) => {
    const order = await tx.restaurantOrder.create({
      data: {
        branchId,
        orderNumber,
        businessDate: BDATE,
        status: 'IN_PREPARATION',
        channel: 'DINE_IN',
        staffProfileId: ctx.staffA,
        deviceId: branchId === ctx.branchReplay ? ctx.posReplay.deviceId : ctx.posA.deviceId,
      },
      select: { id: true },
    });
    const item = await tx.restaurantOrderItem.create({
      data: {
        orderId: order.id,
        productId: ctx.productA,
        name: 'Widget',
        unitPrice: '5.00',
        quantity: 1,
        status: itemStatus as 'FIRING',
      },
      select: { id: true },
    });
    if (stationId) {
      const next = (ticketSeq.get(stationId) ?? 0) + 1;
      ticketSeq.set(stationId, next);
      const ticket = await tx.restaurantKitchenTicket.create({
        data: { orderId: order.id, stationId, businessDate: BDATE, ticketNumber: next },
        select: { id: true },
      });
      await tx.restaurantKitchenTicketItem.create({
        data: { ticketId: ticket.id, orderItemId: item.id, quantity: 1 },
        select: { id: true },
      });
    }
    return { orderId: order.id, itemId: item.id };
  });
}

async function itemStatus(orderId: string, itemId: string): Promise<string> {
  const item = await deps.withTenantDb(orgA, (tx) =>
    tx.restaurantOrderItem.findFirst({ where: { id: itemId, orderId }, select: { status: true } })
  );
  return item!.status;
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, devices, credentials, ...routeMods] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/devices'),
    import('@/lib/restaurant/operator-credentials'),
    import('@/app/api/restaurant/orders/open/route'),
    import('@/app/api/restaurant/orders/add-item/route'),
    import('@/app/api/restaurant/orders/hold/route'),
    import('@/app/api/restaurant/orders/fire/route'),
    import('@/app/api/restaurant/orders/mark-served/route'),
    import('@/app/api/restaurant/orders/remake/route'),
    import('@/app/api/restaurant/orders/void/route'),
    import('@/app/api/restaurant/orders/cancel/route'),
    import('@/app/api/restaurant/orders/close/route'),
    import('@/app/api/restaurant/orders/move-table/route'),
    import('@/app/api/restaurant/orders/merge-tables/route'),
    import('@/app/api/restaurant/orders/open-orders/route'),
    import('@/app/api/restaurant/orders/detail/route'),
    import('@/app/api/restaurant/orders/effective-menu/route'),
    import('@/app/api/restaurant/kds/queue/route'),
    import('@/app/api/restaurant/kds/ack/route'),
    import('@/app/api/restaurant/kds/bump/route'),
    import('@/app/api/restaurant/kds/recall/route'),
    import('@/app/api/restaurant/terminal/establish/route'),
    import('@/app/api/restaurant/terminal/unlock/route'),
  ]);

  const [
    open,
    addItem,
    hold,
    fire,
    markServed,
    remake,
    voidR,
    cancel,
    close,
    moveTable,
    mergeTables,
    openOrders,
    detail,
    effectiveMenu,
    queue,
    ack,
    bump,
    recall,
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
      open,
      addItem,
      hold,
      fire,
      markServed,
      remake,
      voidR,
      cancel,
      close,
      moveTable,
      mergeTables,
      openOrders,
      detail,
      effectiveMenu,
      queue,
      ack,
      bump,
      recall,
    },
    terminal: { establish, unlock },
  };

  for (const [orgId, slug] of [
    [orgA, `wha44-a-${suffix}`],
    [orgB, `wha44-b-${suffix}`],
  ] as const) {
    await deps.withPlatformDb(async (tx) => {
      await tx.organization.create({
        data: {
          id: orgId,
          slug,
          legalName: 'M4L4 Test Co',
          displayName: 'M4L4 Test',
          status: 'ACTIVE',
        },
      });
      await seedDepartments(tx, [orgId], ['LEADERSHIP']);
      const posModule = await ensurePlatformModule(tx, 'restaurant-pos', {
        name: 'POS',
        category: 'Operations',
      });
      await tx.organizationModule.create({
        data: { organizationId: orgId, moduleId: posModule.id },
      });
      await tx.organizationLimit.create({
        data: { organizationId: orgId, key: 'pos.orders.monthly', value: 1_000_000 },
      });
    });
  }

  await deps.withTenantDb(orgA, async (tx) => {
    await tx.organizationRole.create({
      data: {
        id: ctx.orderRoleA,
        key: `wha44_orders_a_${suffix}`,
        name: 'WHA-44 Order Taking A',
        permissions: {
          create: [
            { capability: 'orders:take', effect: 'ALLOW' },
            { capability: 'kitchen:operate', effect: 'ALLOW' },
          ],
        },
      },
    });
    for (const [id, name, email] of [
      [ctx.userA, 'Operator A', `operator_a_${suffix}@test.local`],
      [ctx.userReplay, 'Replay Operator', `replay_operator_${suffix}@test.local`],
    ] as const) {
      await tx.user.create({
        data: {
          id,
          name,
          email,
          department: 'LEADERSHIP',
          title: 'Operator',
          organizationRoleId: ctx.orderRoleA,
        },
      });
    }
    await tx.restaurantBranch.create({ data: { id: ctx.branchA, name: 'A' } });
    await tx.restaurantBranch.create({ data: { id: ctx.branchReplay, name: 'Replay' } });
    await tx.restaurantStaffProfile.create({
      data: {
        id: ctx.staffA,
        displayName: 'Operator A',
        primaryBranchId: ctx.branchA,
        status: 'ACTIVE',
        userId: ctx.userA,
      },
    });
    await tx.restaurantOperatorCredential.create({
      data: {
        staffProfileId: ctx.staffA,
        type: 'PIN',
        credentialHash: await deps.hashOperatorCredential('PIN', PIN),
      },
    });
    await tx.restaurantStaffProfile.create({
      data: {
        id: ctx.staffReplay,
        displayName: 'Replay Operator',
        primaryBranchId: ctx.branchReplay,
        status: 'ACTIVE',
        userId: ctx.userReplay,
      },
    });
    await tx.restaurantOperatorCredential.create({
      data: {
        staffProfileId: ctx.staffReplay,
        type: 'PIN',
        credentialHash: await deps.hashOperatorCredential('PIN', PIN),
      },
    });
    await tx.restaurantProduct.create({ data: { id: ctx.productA, name: 'Widget' } });
    await tx.restaurantKitchenStation.create({
      data: { id: ctx.station1A, branchId: ctx.branchA, name: 'Grill', isDefault: true },
    });
    await tx.restaurantKitchenStation.create({
      data: { id: ctx.station2A, branchId: ctx.branchA, name: 'Fry' },
    });
  });

  await deps.withTenantDb(orgB, async (tx) => {
    await tx.organizationRole.create({
      data: {
        id: ctx.orderRoleB,
        key: `wha44_orders_b_${suffix}`,
        name: 'WHA-44 Order Taking B',
        permissions: {
          create: [
            { capability: 'orders:take', effect: 'ALLOW' },
            { capability: 'kitchen:operate', effect: 'ALLOW' },
          ],
        },
      },
    });
    await tx.user.create({
      data: {
        id: ctx.userB,
        name: 'Operator B',
        email: `operator_b_${suffix}@test.local`,
        department: 'LEADERSHIP',
        title: 'Operator',
        organizationRoleId: ctx.orderRoleB,
      },
    });
    await tx.restaurantBranch.create({ data: { id: ctx.branchB, name: 'B' } });
    await tx.restaurantStaffProfile.create({
      data: {
        id: ctx.staffB,
        displayName: 'Operator B',
        primaryBranchId: ctx.branchB,
        status: 'ACTIVE',
        userId: ctx.userB,
      },
    });
    await tx.restaurantOperatorCredential.create({
      data: {
        staffProfileId: ctx.staffB,
        type: 'PIN',
        credentialHash: await deps.hashOperatorCredential('PIN', PIN),
      },
    });
    await tx.restaurantProduct.create({ data: { id: ctx.productB, name: 'Gadget' } });
    await tx.restaurantKitchenStation.create({
      data: { id: ctx.stationB, branchId: ctx.branchB, name: 'Pass', isDefault: true },
    });
  });

  ctx.posA = await enroll(orgA, ctx.branchA, 'posA');
  ctx.posReplay = await enroll(orgA, ctx.branchReplay, 'posReplay');
  ctx.kdsA = await makeKds(orgA, ctx.branchA, ctx.station1A, 'kdsA');
  ctx.posB = await enroll(orgB, ctx.branchB, 'posB');
  ctx.kdsB = await makeKds(orgB, ctx.branchB, ctx.stationB, 'kdsB');
});

// The POS routes that reference an existing order (so a revoked device / a foreign
// order id can be probed through each) + the pure reads.
const posRouteProbes = (orderId: string, itemId: string) =>
  [
    { name: 'add-item', key: 'addItem', body: { orderId, menuItemId: 'x' } },
    { name: 'hold', key: 'hold', body: { orderId, course: 1 } },
    { name: 'fire', key: 'fire', body: { orderId } },
    { name: 'mark-served', key: 'markServed', body: { orderId, itemId } },
    { name: 'remake', key: 'remake', body: { orderId, itemId, reason: 'r' } },
    { name: 'void', key: 'voidR', body: { orderId, itemId, reason: 'r' } },
    { name: 'cancel', key: 'cancel', body: { orderId, reason: 'r' } },
    { name: 'close', key: 'close', body: { orderId } },
    {
      name: 'move-table',
      key: 'moveTable',
      body: { orderId, fromTableId: 'a', toTableId: 'b' },
    },
    { name: 'merge-tables', key: 'mergeTables', body: { orderId, tableIds: ['a'] } },
  ] as const;

describeIfDatabase('M4-L4 terminal + KDS route transport (real DB)', () => {
  it('rejects a REVOKED device on every POS route, even with a still-valid session token (C8)', async () => {
    const device = await enroll(orgA, ctx.branchA, 'revoke-pos');
    const token = await establishUnlock(device.secret);
    await deps.withTenantDb(orgA, (tx) => deps.revokeDevice(tx, device.deviceId, new Date()));

    const posPost = [
      { r: deps.routes.open, body: { channel: 'TAKEAWAY' } },
      ...posRouteProbes('o', 'i').map((p) => ({ r: deps.routes[p.key], body: p.body })),
    ];
    for (const { r, body } of posPost) {
      const res = await call(r, {
        secret: device.secret,
        session: token,
        key: `rev-${suffix}`,
        body,
      });
      expect(res.status).toBe(403);
    }
    for (const [route, query] of [
      [deps.routes.openOrders, undefined],
      [deps.routes.detail, { orderId: 'o' }],
      [deps.routes.effectiveMenu, { channel: 'DINE_IN' }],
    ] as const) {
      const res = await call(route, {
        method: 'GET',
        secret: device.secret,
        session: token,
        query,
      });
      expect(res.status).toBe(403);
    }
  });

  it('rejects a REVOKED KDS device on every KDS route (C8)', async () => {
    const device = await makeKds(orgA, ctx.branchA, ctx.station1A, 'revoke-kds');
    await deps.withTenantDb(orgA, (tx) => deps.revokeDevice(tx, device.deviceId, new Date()));

    const q = await call(deps.routes.queue, {
      method: 'GET',
      secret: device.secret,
      session: device.session,
    });
    expect(q.status).toBe(403);
    for (const route of [deps.routes.ack, deps.routes.bump, deps.routes.recall]) {
      const res = await call(route, {
        secret: device.secret,
        session: device.session,
        key: `rev-kds-${suffix}`,
        body: { orderItemId: 'x', operatorStaffProfileId: ctx.staffA },
      });
      expect(res.status).toBe(403);
    }
  });

  it('replays a device-scoped idempotent open and creates nothing on the second call (C7)', async () => {
    const token = await establishUnlock(ctx.posReplay.secret, ctx.staffReplay);
    const key = `open-${suffix}`;
    const first = await call(deps.routes.open, {
      secret: ctx.posReplay.secret,
      session: token,
      key,
      body: { channel: 'TAKEAWAY' },
    });
    expect(first.status).toBe(201);
    expect(first.json.replayed).toBe(false);

    const second = await call(deps.routes.open, {
      secret: ctx.posReplay.secret,
      session: token,
      key,
      body: { channel: 'TAKEAWAY' },
    });
    expect(second.status).toBe(201);
    expect(second.json.replayed).toBe(true);
    expect(second.json.orderId).toBe(first.json.orderId);

    const count = await deps.withTenantDb(orgA, (tx) =>
      tx.restaurantOrder.count({ where: { branchId: ctx.branchReplay } })
    );
    expect(count).toBe(1);
  });

  it('rejects a mutating terminal command with no Idempotency-Key (C7)', async () => {
    const token = await establishUnlock(ctx.posA.secret);
    const res = await call(deps.routes.open, {
      secret: ctx.posA.secret,
      session: token,
      body: { channel: 'TAKEAWAY' },
    });
    expect(res.status).toBe(400);
  });

  it('rejects an order command from a LOCKED terminal (no acting operator, C6)', async () => {
    const device = await enroll(orgA, ctx.branchA, 'locked');
    const established = await call(deps.terminal.establish, { secret: device.secret });
    const token = established.json.sessionToken as string;
    const res = await call(deps.routes.open, {
      secret: device.secret,
      session: token,
      key: `locked-${suffix}`,
      body: { channel: 'TAKEAWAY' },
    });
    expect(res.status).toBe(409);
  });

  it('bumps only along legal item transitions, scoped to the KDS device station (C8)', async () => {
    // A FIRING line on this station bumps to PREPARED; a second bump is illegal.
    const fired = await seedOrder('FIRING', ctx.station1A);
    const bumped = await call(deps.routes.bump, {
      secret: ctx.kdsA.secret,
      session: ctx.kdsA.session,
      key: `bump1-${suffix}`,
      body: { orderItemId: fired.itemId, operatorStaffProfileId: ctx.staffA },
    });
    expect(bumped.status).toBe(200);
    expect(await itemStatus(fired.orderId, fired.itemId)).toBe('PREPARED');

    const bumpedAgain = await call(deps.routes.bump, {
      secret: ctx.kdsA.secret,
      session: ctx.kdsA.session,
      key: `bump2-${suffix}`,
      body: { orderItemId: fired.itemId, operatorStaffProfileId: ctx.staffA },
    });
    expect(bumpedAgain.status).toBe(409); // PREPARED→PREPARED is not a legal edge

    // A QUEUED line: bump (QUEUED→PREPARED) is illegal; ack (QUEUED→FIRING) is legal.
    const queued = await seedOrder('QUEUED', ctx.station1A);
    const illegalBump = await call(deps.routes.bump, {
      secret: ctx.kdsA.secret,
      session: ctx.kdsA.session,
      key: `bump3-${suffix}`,
      body: { orderItemId: queued.itemId, operatorStaffProfileId: ctx.staffA },
    });
    expect(illegalBump.status).toBe(409);
    const acked = await call(deps.routes.ack, {
      secret: ctx.kdsA.secret,
      session: ctx.kdsA.session,
      key: `ack1-${suffix}`,
      body: { orderItemId: queued.itemId, operatorStaffProfileId: ctx.staffA },
    });
    expect(acked.status).toBe(200);
    expect(await itemStatus(queued.orderId, queued.itemId)).toBe('FIRING');

    // A line on a DIFFERENT station is not on this device's queue → 404.
    const other = await seedOrder('FIRING', ctx.station2A);
    const crossStation = await call(deps.routes.bump, {
      secret: ctx.kdsA.secret,
      session: ctx.kdsA.session,
      key: `bump4-${suffix}`,
      body: { orderItemId: other.itemId, operatorStaffProfileId: ctx.staffA },
    });
    expect(crossStation.status).toBe(404);
  });

  it('rejects a KDS action with a missing key or mismatched session operator', async () => {
    const seeded = await seedOrder('FIRING', ctx.station1A);
    const noKey = await call(deps.routes.bump, {
      secret: ctx.kdsA.secret,
      session: ctx.kdsA.session,
      body: { orderItemId: seeded.itemId, operatorStaffProfileId: ctx.staffA },
    });
    expect(noKey.status).toBe(400);
    const badOperator = await call(deps.routes.bump, {
      secret: ctx.kdsA.secret,
      session: ctx.kdsA.session,
      key: `badop-${suffix}`,
      body: { orderItemId: seeded.itemId, operatorStaffProfileId: 'ghost' },
    });
    expect(badOperator.status).toBe(403);
  });

  it('reads the station queue with the fixed display mapping (C10 for L5c)', async () => {
    const seeded = await seedOrder('QUEUED', ctx.station1A);
    const res = await call(deps.routes.queue, {
      method: 'GET',
      secret: ctx.kdsA.secret,
      session: ctx.kdsA.session,
      query: { businessDate: '2026-08-19' },
    });
    expect(res.status).toBe(200);
    const tickets = res.json.tickets as Array<{
      items: Array<{ orderItemId: string; displayStatus: string }>;
    }>;
    const line = tickets.flatMap((t) => t.items).find((i) => i.orderItemId === seeded.itemId);
    expect(line?.displayStatus).toBe('NEW'); // QUEUED → NEW
    expect(res.json.displayMapping).toMatchObject({ QUEUED: 'NEW', FIRING: 'COOKING' });
  });

  it('serves the terminal open-orders + detail reads for its branch (C10 for L5b)', async () => {
    const seeded = await seedOrder('FIRING', ctx.station1A);
    const token = await establishUnlock(ctx.posA.secret);

    const list = await call(deps.routes.openOrders, {
      method: 'GET',
      secret: ctx.posA.secret,
      session: token,
    });
    expect(list.status).toBe(200);
    const orders = list.json.orders as Array<{ id: string }>;
    expect(orders.some((o) => o.id === seeded.orderId)).toBe(true);

    const detail = await call(deps.routes.detail, {
      method: 'GET',
      secret: ctx.posA.secret,
      session: token,
      query: { orderId: seeded.orderId },
    });
    expect(detail.status).toBe(200);
    expect(detail.json.id).toBe(seeded.orderId);
  });

  it('allows representative generic and longhand mutations within the device branch', async () => {
    const token = await establishUnlock(ctx.posA.secret);
    const generic = await seedOrder('PREPARED');
    const served = await call(deps.routes.markServed, {
      secret: ctx.posA.secret,
      session: token,
      key: `same-generic-${suffix}`,
      body: { orderId: generic.orderId, itemId: generic.itemId },
    });
    expect(served.status).toBe(200);
    expect(await itemStatus(generic.orderId, generic.itemId)).toBe('SERVED');

    const longhand = await seedOrder('HELD');
    const voided = await call(deps.routes.voidR, {
      secret: ctx.posA.secret,
      session: token,
      key: `same-longhand-${suffix}`,
      body: { orderId: longhand.orderId, itemId: longhand.itemId, reason: 'Guest changed mind' },
    });
    expect(voided.status).toBe(200);
    expect(await itemStatus(longhand.orderId, longhand.itemId)).toBe('VOIDED');
  });

  it('denies every same-organization cross-branch mutation before any side effect', async () => {
    const victim = await seedOrder('PREPARED', undefined, ctx.branchReplay);
    const token = await establishUnlock(ctx.posA.secret);
    const effects = () =>
      deps.withTenantDb(orgA, async (tx) => ({
        order: await tx.restaurantOrder.findUniqueOrThrow({
          where: { id: victim.orderId },
          select: { status: true, customerId: true },
        }),
        item: await tx.restaurantOrderItem.findUniqueOrThrow({
          where: { id: victim.itemId },
          select: { status: true },
        }),
        events: await tx.restaurantOrderEvent.count({ where: { orderId: victim.orderId } }),
        outbox: await tx.restaurantEventOutbox.count({ where: { aggregateId: victim.orderId } }),
        keys: await tx.restaurantOrderIdempotencyKey.count({
          where: { deviceId: ctx.posA.deviceId, key: { startsWith: `cross-branch-` } },
        }),
        tenders: await tx.restaurantTender.count({ where: { bill: { orderId: victim.orderId } } }),
        inventory: await tx.restaurantStockMovement.count({ where: { orderId: victim.orderId } }),
        loyalty: await tx.loyaltyPointsEntry.count({
          where: { bill: { orderId: victim.orderId } },
        }),
      }));
    const before = await effects();

    for (const probe of posRouteProbes(victim.orderId, victim.itemId)) {
      const denied = await call(deps.routes[probe.key], {
        secret: ctx.posA.secret,
        session: token,
        key: `cross-branch-${probe.name}-${suffix}`,
        body: probe.body,
      });
      expect(denied.status, `${probe.name} should be 404 across branches`).toBe(404);
      expect(denied.json).toEqual({ error: 'The order does not exist.' });
    }

    expect(await effects()).toEqual(before);
  });

  it('isolates another org: a cross-tenant order id is "not found" on every order route (C1)', async () => {
    const victim = await seedOrder('FIRING', ctx.station1A); // belongs to orgA
    const token = await establishUnlock(ctx.posB.secret, ctx.staffB); // authed as orgB

    // The branch-scoped read cannot see it.
    const detail = await call(deps.routes.detail, {
      method: 'GET',
      secret: ctx.posB.secret,
      session: token,
      query: { orderId: victim.orderId },
    });
    expect(detail.status).toBe(404);

    // Every mutating route that references the order 404s (RLS hides it).
    for (const probe of posRouteProbes(victim.orderId, victim.itemId)) {
      const res = await call(deps.routes[probe.key], {
        secret: ctx.posB.secret,
        session: token,
        key: `xt-${probe.name}-${suffix}`,
        body: probe.body,
      });
      expect(res.status, `${probe.name} should be 404 across tenants`).toBe(404);
    }

    // A KDS in orgB cannot bump an orgA line either.
    const kdsCross = await call(deps.routes.bump, {
      secret: ctx.kdsB.secret,
      session: ctx.kdsB.session,
      key: `xt-kds-${suffix}`,
      body: { orderItemId: victim.itemId, operatorStaffProfileId: ctx.staffB },
    });
    expect(kdsCross.status).toBe(404);
  });
});
