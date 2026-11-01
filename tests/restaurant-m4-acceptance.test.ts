/** WHA-49 M4-L6b: real terminal/KDS route acceptance against PostgreSQL. */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensurePlatformModule, seedDepartments } from '@/lib/test-support/departments';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
process.env.AUTH_SECRET ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const PIN = '424242';
const MANAGER_PIN = '989898';

const ids = {
  orgA: `org_wha49_a_${suffix}`,
  orgB: `org_wha49_b_${suffix}`,
  branchA: `branch_a_${suffix}`,
  branchB: `branch_b_${suffix}`,
  operatorA: `staff_a_${suffix}`,
  operatorAUser: `user_a_${suffix}`,
  managerAUser: `user_manager_a_${suffix}`,
  operatorBUser: `user_b_${suffix}`,
  settleRole: `role_settle_${suffix}`,
  orderRoleB: `role_orders_b_${suffix}`,
  managerA: `manager_a_${suffix}`,
  operatorB: `staff_b_${suffix}`,
  category: `category_${suffix}`,
  product: `product_${suffix}`,
  brand: `brand_${suffix}`,
  menu: `menu_${suffix}`,
  section: `section_${suffix}`,
  menuItem: `menu_item_${suffix}`,
  priceList: `price_list_${suffix}`,
  priceVersion: `price_version_${suffix}`,
  priceEntry: `price_entry_${suffix}`,
  publication: `publication_${suffix}`,
  taxSource: `tax_source_${suffix}`,
  taxProfile: `tax_profile_${suffix}`,
  stationA: `station_a_${suffix}`,
  stationB: `station_b_${suffix}`,
};

type RouteModule = {
  GET?: (request: Request) => Promise<Response>;
  POST?: (request: Request) => Promise<Response>;
};

type Device = { deviceId: string; secret: string; session?: string };

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  enrollDevice: (typeof import('@/lib/restaurant/devices'))['enrollDevice'];
  hashOperatorCredential: (typeof import('@/lib/restaurant/operator-credentials'))['hashOperatorCredential'];
  routes: Record<string, RouteModule>;
};

let deps: Deps;
const composerProofs = new Map<string, string>();
let posA: Device;
let posB: Device;
let kdsA: Device;
let kdsB: Device;
let sessionA: string;
let sessionB: string;
let keySequence = 0;

const key = (label: string) => `wha49-${label}-${suffix}-${++keySequence}`;

async function call(
  route: RouteModule,
  options: {
    method?: 'GET' | 'POST';
    secret?: string;
    session?: string;
    key?: string;
    body?: unknown;
    query?: Record<string, string>;
  }
): Promise<{ status: number; json: Record<string, unknown> }> {
  const method = options.method ?? 'POST';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.secret) headers.authorization = `Bearer ${options.secret}`;
  if (options.session) headers['x-terminal-session'] = options.session;
  const composerProof = options.session ? composerProofs.get(options.session) : undefined;
  if (composerProof) headers['x-pos-composer-proof'] = composerProof;
  if (options.key) headers['idempotency-key'] = options.key;
  const url = new URL('https://tenant.test/api/restaurant/acceptance');
  for (const [name, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(name, value);
  }
  const response = await (method === 'GET' ? route.GET! : route.POST!)(
    new Request(url, {
      method,
      headers,
      body:
        method === 'GET' || options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  );
  return {
    status: response.status,
    json: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

async function enroll(orgId: string, branchId: string, name: string): Promise<Device> {
  const enrolled = await deps.withTenantDb(orgId, (tx) =>
    deps.enrollDevice(tx, { branchId, name })
  );
  return { deviceId: enrolled.device.id, secret: enrolled.secret };
}

async function makeKds(
  orgId: string,
  branchId: string,
  stationId: string,
  name: string
): Promise<Device> {
  const device = await enroll(orgId, branchId, name);
  await deps.withTenantDb(orgId, (tx) =>
    tx.restaurantRegisteredDevice.update({
      where: { id: device.deviceId },
      data: { kind: 'KDS', stationId },
    })
  );
  return {
    ...device,
    session: await establishUnlock(device, orgId === ids.orgA ? ids.operatorA : ids.operatorB, PIN),
  };
}

async function establishUnlock(
  device: Device,
  staffProfileId: string,
  pin: string
): Promise<string> {
  const established = await call(deps.routes.establish!, { secret: device.secret });
  expect(established.status).toBe(201);
  const token = established.json.sessionToken as string;
  const unlocked = await call(deps.routes.unlock!, {
    secret: device.secret,
    session: token,
    body: { staffProfileId, type: 'PIN', secret: pin },
  });
  expect(unlocked.status).toBe(200);
  expect(unlocked.json.composerProof).toEqual(expect.any(String));
  composerProofs.set(token, unlocked.json.composerProof as string);
  return token;
}

async function postPos(route: string, body: Record<string, unknown>, idempotencyKey = key(route)) {
  return call(deps.routes[route]!, {
    secret: posA.secret,
    session: sessionA,
    key: idempotencyKey,
    body,
  });
}

async function postKds(
  route: string,
  orderItemId: string,
  idempotencyKey = key(route),
  device = kdsA,
  operatorStaffProfileId = ids.operatorA
) {
  return call(deps.routes[route]!, {
    secret: device.secret,
    session: device.session,
    key: idempotencyKey,
    body: { orderItemId, operatorStaffProfileId },
  });
}

async function openWithItem(course = 1) {
  const opened = await postPos('open', {
    channel: 'DINE_IN',
    publicationId: ids.publication,
  });
  expect(opened.status).toBe(201);
  const orderId = opened.json.orderId as string;
  const added = await postPos('addItem', {
    orderId,
    menuItemId: ids.menuItem,
    course,
  });
  expect(added.status).toBe(201);
  return {
    orderId,
    itemId: added.json.itemId as string,
    businessDate: opened.json.businessDate as string,
  };
}

async function orderState(orderId: string) {
  return deps.withTenantDb(ids.orgA, (tx) =>
    tx.restaurantOrder.findUnique({
      where: { id: orderId },
      select: {
        status: true,
        items: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, course: true, status: true },
        },
      },
    })
  );
}

async function expectLedger(orderId: string, eventTypes: string[]) {
  const { events, outboxCount } = await deps.withTenantDb(ids.orgA, async (tx) => ({
    events: await tx.restaurantOrderEvent.findMany({
      where: { orderId },
      orderBy: { sequence: 'asc' },
      select: { eventType: true, sequence: true },
    }),
    outboxCount: await tx.restaurantEventOutbox.count({ where: { aggregateId: orderId } }),
  }));
  expect(events.map((event) => event.eventType)).toEqual(eventTypes);
  expect(events.map((event) => event.sequence)).toEqual(eventTypes.map((_, index) => index + 1));
  expect(outboxCount).toBe(events.length);
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, devices, credentials, ...routeModules] = await Promise.all([
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
    import('@/app/api/restaurant/orders/detail/route'),
    import('@/app/api/restaurant/kds/queue/route'),
    import('@/app/api/restaurant/kds/ack/route'),
    import('@/app/api/restaurant/kds/bump/route'),
    import('@/app/api/restaurant/terminal/establish/route'),
    import('@/app/api/restaurant/terminal/unlock/route'),
    import('@/app/api/restaurant/checkout/bill/route'),
    import('@/app/api/restaurant/checkout/tender/route'),
  ]);
  const [
    open,
    addItem,
    hold,
    fire,
    markServed,
    remake,
    voidItem,
    cancel,
    close,
    detail,
    queue,
    ack,
    bump,
    establish,
    unlock,
    bill,
    tender,
  ] = routeModules as RouteModule[];
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    enrollDevice: devices.enrollDevice,
    hashOperatorCredential: credentials.hashOperatorCredential,
    routes: {
      open,
      addItem,
      hold,
      fire,
      markServed,
      remake,
      voidItem,
      cancel,
      close,
      detail,
      queue,
      ack,
      bump,
      establish,
      unlock,
      bill,
      tender,
    },
  };

  for (const [organizationId, slug] of [
    [ids.orgA, `wha49-a-${suffix}`],
    [ids.orgB, `wha49-b-${suffix}`],
  ] as const) {
    // ACTIVE and entitled to `restaurant-pos`: the terminal transport answers
    // 403 before the handler when the module is disabled (WHA-192).
    await deps.withPlatformDb(async (tx) => {
      await tx.organization.create({
        data: {
          id: organizationId,
          slug,
          legalName: 'WHA-49 Acceptance',
          displayName: 'WHA-49 Acceptance',
          status: 'ACTIVE',
        },
      });
      await seedDepartments(tx, [organizationId], ['LEADERSHIP']);
      const posModule = await ensurePlatformModule(tx, 'restaurant-pos', {
        name: 'POS and Fulfilment',
        category: 'Operations',
      });
      await tx.organizationModule.create({
        data: {
          organizationId,
          moduleId: posModule.id,
          // Backdated: suites that travel to a past business date must stay
          // entitled — the override only applies once `startsAt` has passed.
          startsAt: new Date(0),
        },
      });
      await tx.organizationLimit.create({
        data: { organizationId, key: 'pos.orders.monthly', value: 1_000_000 },
      });
    });
  }

  await deps.withTenantDb(ids.orgA, async (tx) => {
    await tx.restaurantBranch.create({
      data: {
        id: ids.branchA,
        name: 'New York',
        timezone: 'America/New_York',
        businessDayCutoff: '04:00',
      },
    });
    await tx.restaurantTaxOfficialSource.create({
      data: {
        id: ids.taxSource,
        authorityCode: 'SYNTHETIC_TEST_ONLY',
        documentTitle: 'Synthetic zero-rate M4 fixture',
        sourceUrl: 'https://example.invalid/synthetic-tax',
        contentHash: `synthetic-m4-${suffix}`,
        retrievedAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      },
    });
    await tx.restaurantTaxProfileVersion.create({
      data: {
        id: ids.taxProfile,
        branchId: ids.branchA,
        versionNumber: 1,
        status: 'PUBLISHED',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        approvalReference: 'SYNTHETIC_TEST_APPROVAL',
        approvedAt: new Date('2026-01-01T00:00:00.000Z'),
        publishedAt: new Date('2026-01-01T00:00:00.000Z'),
        rules: {
          create: (['CASH', 'CARD', 'OTHER'] as const).map((paymentCategory) => ({
            officialSourceId: ids.taxSource,
            ruleCode: `SYNTHETIC_${paymentCategory}`,
            paymentCategory,
            priceMode: 'EXCLUSIVE',
            rate: '0.000000',
            status: 'PUBLISHED',
            effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
            approvalReference: 'SYNTHETIC_TEST_APPROVAL',
            approvedAt: new Date('2026-01-01T00:00:00.000Z'),
            publishedAt: new Date('2026-01-01T00:00:00.000Z'),
          })),
        },
      },
    });
    // Operator A settles bills through the M5 checkout routes, which gate on
    // `payments:collect`; post-prep void approval also requires `coauth:approve`.
    await tx.organizationRole.create({
      data: {
        id: ids.settleRole,
        key: `wha49_settle_${suffix}`,
        name: 'WHA-49 Settlement',
        permissions: {
          create: [
            { capability: 'payments:collect', effect: 'ALLOW' },
            { capability: 'coauth:approve', effect: 'ALLOW' },
            { capability: 'orders:take', effect: 'ALLOW' },
            { capability: 'kitchen:operate', effect: 'ALLOW' },
          ],
        },
      },
    });
    await tx.user.create({
      data: {
        id: ids.operatorAUser,
        name: 'Operator A',
        email: `operator_a_${suffix}@test.local`,
        department: 'LEADERSHIP',
        title: 'Operator',
        organizationRoleId: ids.settleRole,
      },
    });
    await tx.user.create({
      data: {
        id: ids.managerAUser,
        name: 'Manager A',
        email: `manager_a_${suffix}@test.local`,
        department: 'LEADERSHIP',
        title: 'Manager',
        organizationRoleId: ids.settleRole,
      },
    });
    for (const [id, displayName, pin, userId] of [
      [ids.operatorA, 'Operator A', PIN, ids.operatorAUser],
      [ids.managerA, 'Manager A', MANAGER_PIN, ids.managerAUser],
    ] as const) {
      await tx.restaurantStaffProfile.create({
        data: {
          id,
          displayName,
          primaryBranchId: ids.branchA,
          status: 'ACTIVE',
          ...(userId ? { userId } : {}),
        },
      });
      await tx.restaurantOperatorCredential.create({
        data: {
          staffProfileId: id,
          type: 'PIN',
          credentialHash: await deps.hashOperatorCredential('PIN', pin),
        },
      });
    }
    await tx.restaurantCategory.create({ data: { id: ids.category, name: 'Mains' } });
    await tx.restaurantProduct.create({
      data: { id: ids.product, categoryId: ids.category, name: 'Catalog Burger' },
    });
    await tx.restaurantKitchenStation.create({
      data: { id: ids.stationA, branchId: ids.branchA, name: 'Grill', isDefault: true },
    });
    await tx.restaurantStationRoutingRule.create({
      data: { stationId: ids.stationA, productId: ids.product, priority: 0 },
    });
    await tx.restaurantBrand.create({ data: { id: ids.brand, name: 'WHA-49' } });
    await tx.restaurantMenu.create({
      data: { id: ids.menu, brandId: ids.brand, name: 'Dinner' },
    });
    await tx.restaurantMenuSection.create({
      data: { id: ids.section, menuId: ids.menu, name: 'Mains' },
    });
    await tx.restaurantMenuItem.create({
      data: {
        id: ids.menuItem,
        sectionId: ids.section,
        productId: ids.product,
        displayName: 'House Burger',
      },
    });
    await tx.restaurantPriceList.create({
      data: { id: ids.priceList, name: 'Base', isDefault: true },
    });
    await tx.restaurantPriceListVersion.create({
      data: {
        id: ids.priceVersion,
        priceListId: ids.priceList,
        versionNumber: 1,
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        status: 'ACTIVE',
      },
    });
    await tx.restaurantPriceListEntry.create({
      data: {
        id: ids.priceEntry,
        priceListVersionId: ids.priceVersion,
        productId: ids.product,
        price: '12.50',
      },
    });
    await tx.restaurantBranchMenuPublication.create({
      data: {
        id: ids.publication,
        branchId: ids.branchA,
        menuId: ids.menu,
        priceListId: ids.priceList,
        status: 'PUBLISHED',
        channels: ['DINE_IN', 'TAKEAWAY'],
      },
    });
  });

  await deps.withTenantDb(ids.orgB, async (tx) => {
    await tx.organizationRole.create({
      data: {
        id: ids.orderRoleB,
        key: `wha49_orders_b_${suffix}`,
        name: 'WHA-49 Order Taking',
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
        id: ids.operatorBUser,
        name: 'Operator B',
        email: `operator_b_${suffix}@test.local`,
        department: 'LEADERSHIP',
        title: 'Operator',
        organizationRoleId: ids.orderRoleB,
      },
    });
    await tx.restaurantBranch.create({ data: { id: ids.branchB, name: 'Tenant B' } });
    await tx.restaurantStaffProfile.create({
      data: {
        id: ids.operatorB,
        displayName: 'Operator B',
        primaryBranchId: ids.branchB,
        status: 'ACTIVE',
        userId: ids.operatorBUser,
      },
    });
    await tx.restaurantOperatorCredential.create({
      data: {
        staffProfileId: ids.operatorB,
        type: 'PIN',
        credentialHash: await deps.hashOperatorCredential('PIN', PIN),
      },
    });
    await tx.restaurantKitchenStation.create({
      data: { id: ids.stationB, branchId: ids.branchB, name: 'Tenant B Grill', isDefault: true },
    });
  });

  posA = await enroll(ids.orgA, ids.branchA, 'POS A');
  kdsA = await makeKds(ids.orgA, ids.branchA, ids.stationA, 'KDS A');
  posB = await enroll(ids.orgB, ids.branchB, 'POS B');
  kdsB = await makeKds(ids.orgB, ids.branchB, ids.stationB, 'KDS B');
  sessionA = await establishUnlock(posA, ids.operatorA, PIN);
  sessionB = await establishUnlock(posB, ids.operatorB, PIN);
}, 60_000);

afterAll(() => {
  vi.useRealTimers();
});

describeIfDatabase('WHA-49 M4 restaurant acceptance (real DB/routes)', () => {
  it('opens, adds, fires, prepares, serves, closes, and keeps ledger/outbox after each step', async () => {
    const opened = await postPos('open', {
      channel: 'DINE_IN',
      publicationId: ids.publication,
    });
    expect(opened.status).toBe(201);
    const orderId = opened.json.orderId as string;
    await expectLedger(orderId, ['order.opened']);
    expect((await orderState(orderId))?.status).toBe('OPEN');

    const added = await postPos('addItem', { orderId, menuItemId: ids.menuItem });
    expect(added.status).toBe(201);
    const itemId = added.json.itemId as string;
    await expectLedger(orderId, ['order.opened', 'item.added']);

    const fired = await postPos('fire', { orderId });
    expect(fired.status).toBe(200);
    await expectLedger(orderId, ['order.opened', 'item.added', 'order.sent']);
    expect((await orderState(orderId))?.status).toBe('SENT');

    expect((await postKds('ack', itemId)).status).toBe(200);
    await expectLedger(orderId, ['order.opened', 'item.added', 'order.sent', 'item.advanced']);
    expect((await orderState(orderId))?.status).toBe('IN_PREPARATION');

    expect((await postKds('bump', itemId)).status).toBe(200);
    await expectLedger(orderId, [
      'order.opened',
      'item.added',
      'order.sent',
      'item.advanced',
      'item.advanced',
    ]);
    expect((await orderState(orderId))?.status).toBe('READY');

    expect((await postPos('markServed', { orderId, itemId })).status).toBe(200);
    await expectLedger(orderId, [
      'order.opened',
      'item.added',
      'order.sent',
      'item.advanced',
      'item.advanced',
      'item.advanced',
    ]);
    expect((await orderState(orderId))?.status).toBe('SERVED');

    // M5-L2 settlement guard (C12): settle the served order — cut a bill and tender it to
    // full coverage through the real checkout routes — before the terminal close. The
    // money commands append no order events, so the single close below still walks
    // SERVED → PAYMENT_PENDING → CLOSED in one shot, emitting both order events.
    const billed = await postPos('bill', { orderId, split: { kind: 'NONE' } });
    expect(billed.status).toBe(200);
    const settleBillId = (billed.json.billIds as string[])[0];
    const tendered = await postPos('tender', {
      billId: settleBillId,
      tender: { type: 'CARD', amount: '12.50' },
    });
    expect(tendered.status).toBe(200);
    expect(tendered.json.settled).toBe(true);

    expect((await postPos('close', { orderId })).status).toBe(200);
    await expectLedger(orderId, [
      'order.opened',
      'item.added',
      'order.sent',
      'item.advanced',
      'item.advanced',
      'item.advanced',
      'order.payment_pending',
      'order.closed',
    ]);
    expect((await orderState(orderId))?.status).toBe('CLOSED');
  }, 20_000);

  it('rejects closing a terminal order while an active item remains', async () => {
    const { orderId } = await openWithItem();
    expect((await postPos('fire', { orderId })).status).toBe(200);
    const rejected = await postPos('close', { orderId });
    expect(rejected.status).toBe(409);
    expect(rejected.json.error).toEqual(expect.stringContaining('served or voided'));
    expect((await orderState(orderId))?.status).toBe('SENT');
    await expectLedger(orderId, ['order.opened', 'item.added', 'order.sent']);
  });

  it('rejects cancelling a prepared item without co-authorization/compensation', async () => {
    const { orderId, itemId } = await openWithItem();
    expect((await postPos('fire', { orderId })).status).toBe(200);
    expect((await postKds('ack', itemId)).status).toBe(200);
    expect((await postKds('bump', itemId)).status).toBe(200);

    const rejected = await postPos('cancel', { orderId, reason: 'kitchen incident' });
    expect(rejected.status).toBe(400);
    expect(rejected.json.error).toEqual(expect.stringContaining('co-authorizing manager'));
    expect(await orderState(orderId)).toMatchObject({
      status: 'READY',
      items: [{ id: itemId, course: 1, status: 'PREPARED' }],
    });
    await expectLedger(orderId, [
      'order.opened',
      'item.added',
      'order.sent',
      'item.advanced',
      'item.advanced',
    ]);
  });

  it('rejects close while a remake remains unresolved', async () => {
    const { orderId, itemId } = await openWithItem();
    expect((await postPos('fire', { orderId })).status).toBe(200);
    expect((await postKds('ack', itemId)).status).toBe(200);
    expect((await postKds('bump', itemId)).status).toBe(200);
    expect((await postPos('markServed', { orderId, itemId })).status).toBe(200);
    const remake = await postPos('remake', { orderId, itemId, reason: 'guest returned it' });
    expect(remake.status).toBe(201);

    const rejected = await postPos('close', { orderId });
    expect(rejected.status).toBe(409);
    const state = await orderState(orderId);
    expect(state?.status).toBe('IN_PREPARATION');
    expect(state?.items.map((item) => item.status).sort()).toEqual(['HELD', 'REMAKE_REQUESTED']);
  });

  it('rejects a client-authored aggregate status edit', async () => {
    const opened = await postPos('open', { channel: 'TAKEAWAY' });
    expect(opened.status).toBe(201);
    const orderId = opened.json.orderId as string;
    const rejected = await postPos('close', { orderId, status: 'CLOSED' });
    expect(rejected.status).toBe(400);
    expect((await orderState(orderId))?.status).toBe('OPEN');
    await expectLedger(orderId, ['order.opened']);
  });

  it('isolates held courses, then fires each requested course only', async () => {
    const first = await openWithItem(1);
    const second = await postPos('addItem', {
      orderId: first.orderId,
      menuItemId: ids.menuItem,
      course: 2,
    });
    expect(second.status).toBe(201);
    const secondItemId = second.json.itemId as string;

    expect((await postPos('fire', { orderId: first.orderId, course: 1 })).status).toBe(200);
    expect((await postPos('hold', { orderId: first.orderId, course: 1 })).status).toBe(200);
    expect((await postPos('fire', { orderId: first.orderId, course: 2 })).status).toBe(200);
    expect(await orderState(first.orderId)).toMatchObject({
      items: [
        { id: first.itemId, course: 1, status: 'HELD' },
        { id: secondItemId, course: 2, status: 'QUEUED' },
      ],
    });

    expect((await postPos('fire', { orderId: first.orderId, course: 1 })).status).toBe(200);
    expect((await orderState(first.orderId))?.items).toEqual([
      { id: first.itemId, course: 1, status: 'QUEUED' },
      { id: secondItemId, course: 2, status: 'QUEUED' },
    ]);
  });

  it('requires post-prep void approval and preserves co-auth, history, and disposition', async () => {
    const { orderId, itemId } = await openWithItem();
    expect((await postPos('fire', { orderId })).status).toBe(200);
    expect((await postKds('ack', itemId)).status).toBe(200);
    expect((await postKds('bump', itemId)).status).toBe(200);

    expect((await postPos('voidItem', { orderId, itemId, reason: 'burnt' })).status).toBe(400);
    const approved = await postPos('voidItem', {
      orderId,
      itemId,
      reason: 'burnt',
      wastageDisposition: 'WASTE',
      approving: { staffProfileId: ids.managerA, type: 'PIN', secret: MANAGER_PIN },
    });
    expect(approved.status).toBe(200);

    const evidence = await deps.withTenantDb(ids.orgA, async (tx) => {
      const item = await tx.restaurantOrderItem.findUnique({
        where: { id: itemId },
        select: {
          status: true,
          voidedPostPrep: true,
          wastageDisposition: true,
          voidReason: true,
          voidCoAuthorizationId: true,
        },
      });
      const coAuthorization = item?.voidCoAuthorizationId
        ? await tx.restaurantCoAuthorization.findUnique({
            where: { id: item.voidCoAuthorizationId },
            select: {
              actingStaffProfileId: true,
              approvingStaffProfileId: true,
              capability: true,
              targetId: true,
            },
          })
        : null;
      const history = await tx.restaurantOrderEvent.findMany({
        where: { orderId },
        orderBy: { sequence: 'asc' },
        select: { eventType: true, payload: true },
      });
      return { item, coAuthorization, history };
    });
    expect(evidence.item).toMatchObject({
      status: 'VOIDED',
      voidedPostPrep: true,
      wastageDisposition: 'WASTE',
      voidReason: 'burnt',
    });
    expect(evidence.coAuthorization).toEqual({
      actingStaffProfileId: ids.operatorA,
      approvingStaffProfileId: ids.managerA,
      capability: 'orders:void',
      targetId: itemId,
    });
    expect(evidence.history.at(-1)).toMatchObject({
      eventType: 'item.voided',
      payload: expect.objectContaining({
        itemId,
        postPrep: true,
        wastageDisposition: 'WASTE',
        reason: 'burnt',
      }),
    });
    await expectLedger(orderId, [
      'order.opened',
      'item.added',
      'order.sent',
      'item.advanced',
      'item.advanced',
      'item.voided',
    ]);
  }, 20_000);

  it('allocates unique consecutive order numbers under concurrent route opens', async () => {
    const opened = await Promise.all(
      ['a', 'b'].map((label) =>
        postPos('open', { channel: 'TAKEAWAY' }, key(`concurrent-${label}`))
      )
    );
    expect(opened.map((result) => result.status)).toEqual([201, 201]);
    const numbers = opened.map((result) => result.json.orderNumber as number).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(2);
    expect(numbers[1]).toBe(numbers[0]! + 1);
  });

  it('stamps business dates across a DST cutoff from server time in New York', async () => {
    const device = await enroll(ids.orgA, ids.branchA, 'DST POS');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-03-08T07:59:00.000Z'));
      const token = await establishUnlock(device, ids.operatorA, PIN);
      const before = await call(deps.routes.open!, {
        secret: device.secret,
        session: token,
        key: key('dst-before'),
        body: { channel: 'TAKEAWAY' },
      });
      expect(before.status).toBe(201);
      expect(before.json.businessDate).toBe('2026-03-07');

      vi.setSystemTime(new Date('2026-03-08T08:01:00.000Z'));
      const after = await call(deps.routes.open!, {
        secret: device.secret,
        session: token,
        key: key('dst-after'),
        body: { channel: 'TAKEAWAY' },
      });
      expect(after.status).toBe(201);
      expect(after.json.businessDate).toBe('2026-03-08');
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('keeps item snapshots after catalog, menu-name, and price edits', async () => {
    const { orderId, itemId } = await openWithItem();
    try {
      await deps.withTenantDb(ids.orgA, async (tx) => {
        await tx.restaurantProduct.update({
          where: { id: ids.product },
          data: { name: 'Catalog Burger v2' },
        });
        await tx.restaurantMenuItem.update({
          where: { id: ids.menuItem },
          data: { displayName: 'House Burger v2' },
        });
        await tx.restaurantPriceListEntry.update({
          where: { id: ids.priceEntry },
          data: { price: '99.99' },
        });
      });

      const detail = await call(deps.routes.detail!, {
        method: 'GET',
        secret: posA.secret,
        session: sessionA,
        query: { orderId },
      });
      expect(detail.status).toBe(200);
      const item = (detail.json.items as Array<Record<string, unknown>>).find(
        (candidate) => candidate.id === itemId
      );
      expect(item).toMatchObject({ name: 'House Burger', unitPrice: '12.5' });
    } finally {
      await deps.withTenantDb(ids.orgA, async (tx) => {
        await tx.restaurantProduct.update({
          where: { id: ids.product },
          data: { name: 'Catalog Burger' },
        });
        await tx.restaurantMenuItem.update({
          where: { id: ids.menuItem },
          data: { displayName: 'House Burger' },
        });
        await tx.restaurantPriceListEntry.update({
          where: { id: ids.priceEntry },
          data: { price: '12.50' },
        });
      });
    }
  });

  it('hides an order from cross-tenant terminal and KDS route probes', async () => {
    const { orderId, itemId, businessDate } = await openWithItem();
    expect((await postPos('fire', { orderId })).status).toBe(200);

    const foreignDetail = await call(deps.routes.detail!, {
      method: 'GET',
      secret: posB.secret,
      session: sessionB,
      query: { orderId },
    });
    expect(foreignDetail.status).toBe(404);
    const foreignClose = await call(deps.routes.close!, {
      secret: posB.secret,
      session: sessionB,
      key: key('foreign-close'),
      body: { orderId },
    });
    expect(foreignClose.status).toBe(404);
    const foreignAck = await postKds('ack', itemId, key('foreign-ack'), kdsB, ids.operatorB);
    expect(foreignAck.status).toBe(404);
    const foreignQueue = await call(deps.routes.queue!, {
      method: 'GET',
      secret: kdsB.secret,
      session: kdsB.session,
      query: { businessDate },
    });
    expect(foreignQueue.status).toBe(200);
    expect(
      (foreignQueue.json.tickets as Array<{ items: Array<{ orderItemId: string }> }>).some(
        (ticket) => ticket.items.some((item) => item.orderItemId === itemId)
      )
    ).toBe(false);
    expect((await orderState(orderId))?.items[0]?.status).toBe('QUEUED');
  });
});
