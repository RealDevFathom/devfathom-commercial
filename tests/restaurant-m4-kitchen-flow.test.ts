/** WHA-49 M4-L6b: durable KDS flow through real route handlers and PostgreSQL. */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';
import { ensurePlatformModule, seedDepartments } from '@/lib/test-support/departments';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
process.env.AUTH_SECRET ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const PIN = '525252';

const ids = {
  org: `org_wha49_kds_${suffix}`,
  branch: `branch_${suffix}`,
  operator: `staff_${suffix}`,
  operatorUser: `user_${suffix}`,
  orderRole: `role_orders_${suffix}`,
  category: `category_${suffix}`,
  productDefault: `product_default_${suffix}`,
  productBar: `product_bar_${suffix}`,
  productGap: `product_gap_${suffix}`,
  brand: `brand_${suffix}`,
  menu: `menu_${suffix}`,
  section: `section_${suffix}`,
  itemDefault: `item_default_${suffix}`,
  itemBar: `item_bar_${suffix}`,
  itemGap: `item_gap_${suffix}`,
  priceList: `price_list_${suffix}`,
  priceVersion: `price_version_${suffix}`,
  publication: `publication_${suffix}`,
  stationGrill: `station_grill_${suffix}`,
  stationBar: `station_bar_${suffix}`,
  stationGap: `station_gap_${suffix}`,
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
  revokeDevice: (typeof import('@/lib/restaurant/devices'))['revokeDevice'];
  hashOperatorCredential: (typeof import('@/lib/restaurant/operator-credentials'))['hashOperatorCredential'];
  routes: Record<string, RouteModule>;
};

let deps: Deps;
const composerProofs = new Map<string, string>();
let pos: Device;
let kdsGrill: Device;
let kdsBar: Device;
let kdsGap: Device;
let session: string;
let keySequence = 0;

const key = (label: string) => `wha49-kds-${label}-${suffix}-${++keySequence}`;

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
  const url = new URL('https://tenant.test/api/restaurant/kitchen-flow');
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

async function enroll(name: string): Promise<Device> {
  const enrolled = await deps.withTenantDb(ids.org, (tx) =>
    deps.enrollDevice(tx, { branchId: ids.branch, name })
  );
  return { deviceId: enrolled.device.id, secret: enrolled.secret };
}

async function makeKds(stationId: string, name: string): Promise<Device> {
  const device = await enroll(name);
  await deps.withTenantDb(ids.org, (tx) =>
    tx.restaurantRegisteredDevice.update({
      where: { id: device.deviceId },
      data: { kind: 'KDS', stationId },
    })
  );
  return { ...device, session: await establishUnlock(device) };
}

async function establishUnlock(device: Device): Promise<string> {
  const established = await call(deps.routes.establish!, { secret: device.secret });
  expect(established.status).toBe(201);
  const token = established.json.sessionToken as string;
  const unlocked = await call(deps.routes.unlock!, {
    secret: device.secret,
    session: token,
    body: { staffProfileId: ids.operator, type: 'PIN', secret: PIN },
  });
  expect(unlocked.status).toBe(200);
  expect(unlocked.json.composerProof).toEqual(expect.any(String));
  composerProofs.set(token, unlocked.json.composerProof as string);
  return token;
}

function postPos(route: string, body: Record<string, unknown>, idempotencyKey = key(route)) {
  return call(deps.routes[route]!, {
    secret: pos.secret,
    session,
    key: idempotencyKey,
    body,
  });
}

function postKds(route: string, device: Device, orderItemId: string, idempotencyKey = key(route)) {
  return call(deps.routes[route]!, {
    secret: device.secret,
    session: device.session,
    key: idempotencyKey,
    body: { orderItemId, operatorStaffProfileId: ids.operator },
  });
}

function readQueue(device: Device, businessDate: string, query: Record<string, string> = {}) {
  return call(deps.routes.queue!, {
    method: 'GET',
    secret: device.secret,
    session: device.session,
    query: { businessDate, ...query },
  });
}

async function openAdd(menuItemId: string) {
  const opened = await postPos('open', {
    channel: 'DINE_IN',
    publicationId: ids.publication,
  });
  expect(opened.status).toBe(201);
  const orderId = opened.json.orderId as string;
  const added = await postPos('addItem', { orderId, menuItemId });
  expect(added.status).toBe(201);
  return {
    orderId,
    itemId: added.json.itemId as string,
    businessDate: opened.json.businessDate as string,
  };
}

function queueItems(json: Record<string, unknown>) {
  return (json.tickets as Array<{ items: Array<Record<string, unknown>> }>).flatMap(
    (ticket) => ticket.items
  );
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, devices, credentials, ...routeModules] = await Promise.all([
    import('@/lib/tenancy/scoped-db'),
    import('@/lib/restaurant/devices'),
    import('@/lib/restaurant/operator-credentials'),
    import('@/app/api/restaurant/orders/open/route'),
    import('@/app/api/restaurant/orders/add-item/route'),
    import('@/app/api/restaurant/orders/fire/route'),
    import('@/app/api/restaurant/kds/queue/route'),
    import('@/app/api/restaurant/kds/ack/route'),
    import('@/app/api/restaurant/kds/bump/route'),
    import('@/app/api/restaurant/kds/recall/route'),
    import('@/app/api/restaurant/terminal/establish/route'),
    import('@/app/api/restaurant/terminal/unlock/route'),
  ]);
  const [open, addItem, fire, queue, ack, bump, recall, establish, unlock] =
    routeModules as RouteModule[];
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    enrollDevice: devices.enrollDevice,
    revokeDevice: devices.revokeDevice,
    hashOperatorCredential: credentials.hashOperatorCredential,
    routes: { open, addItem, fire, queue, ack, bump, recall, establish, unlock },
  };

  // ACTIVE and entitled to `restaurant-pos`: the terminal transport answers 403
  // before the handler when the module is disabled (WHA-192).
  await deps.withPlatformDb(async (tx) => {
    await tx.organization.create({
      data: {
        id: ids.org,
        slug: `wha49-kds-${suffix}`,
        legalName: 'WHA-49 Kitchen',
        displayName: 'WHA-49 Kitchen',
        status: 'ACTIVE',
      },
    });
    await seedDepartments(tx, [ids.org], ['LEADERSHIP']);
    const posModule = await ensurePlatformModule(tx, 'restaurant-pos', {
      name: 'POS and Fulfilment',
      category: 'Operations',
    });
    await tx.organizationModule.create({
      data: {
        organizationId: ids.org,
        moduleId: posModule.id,
        // Backdated: suites that travel to a past business date must stay
        // entitled — the override only applies once `startsAt` has passed.
        startsAt: new Date(0),
      },
    });
    await tx.organizationLimit.create({
      data: { organizationId: ids.org, key: 'pos.orders.monthly', value: 1_000_000 },
    });
  });
  await deps.withTenantDb(ids.org, async (tx) => {
    await tx.organizationRole.create({
      data: {
        id: ids.orderRole,
        key: `wha49_kds_orders_${suffix}`,
        name: 'WHA-49 Kitchen Order Taking',
        permissions: { create: [{ capability: 'orders:take', effect: 'ALLOW' }] },
      },
    });
    await tx.user.create({
      data: {
        id: ids.operatorUser,
        name: 'Kitchen Operator',
        email: `kitchen_operator_${suffix}@test.local`,
        department: 'LEADERSHIP',
        title: 'Operator',
        organizationRoleId: ids.orderRole,
      },
    });
    await tx.restaurantBranch.create({
      data: { id: ids.branch, name: 'Kitchen', timezone: 'UTC', businessDayCutoff: '00:00' },
    });
    await tx.restaurantStaffProfile.create({
      data: {
        id: ids.operator,
        displayName: 'Kitchen Operator',
        primaryBranchId: ids.branch,
        status: 'ACTIVE',
        userId: ids.operatorUser,
      },
    });
    await tx.restaurantOperatorCredential.create({
      data: {
        staffProfileId: ids.operator,
        type: 'PIN',
        credentialHash: await deps.hashOperatorCredential('PIN', PIN),
      },
    });
    await tx.restaurantCategory.create({ data: { id: ids.category, name: 'Kitchen' } });
    for (const [id, name] of [
      [ids.productDefault, 'Default Soup'],
      [ids.productBar, 'Bar Drink'],
      [ids.productGap, 'Gap Plate'],
    ] as const) {
      await tx.restaurantProduct.create({
        data: { id, name, categoryId: ids.category },
      });
    }
    await tx.restaurantKitchenStation.create({
      data: {
        id: ids.stationGrill,
        branchId: ids.branch,
        name: 'Grill',
        isDefault: true,
      },
    });
    await tx.restaurantKitchenStation.create({
      data: { id: ids.stationBar, branchId: ids.branch, name: 'Bar' },
    });
    await tx.restaurantKitchenStation.create({
      data: { id: ids.stationGap, branchId: ids.branch, name: 'Gap' },
    });
    await tx.restaurantStationRoutingRule.create({
      data: { stationId: ids.stationBar, productId: ids.productBar, priority: 0 },
    });
    await tx.restaurantStationRoutingRule.create({
      data: { stationId: ids.stationGap, productId: ids.productGap, priority: 0 },
    });
    await tx.restaurantBrand.create({ data: { id: ids.brand, name: 'WHA-49' } });
    await tx.restaurantMenu.create({
      data: { id: ids.menu, brandId: ids.brand, name: 'Kitchen Menu' },
    });
    await tx.restaurantMenuSection.create({
      data: { id: ids.section, menuId: ids.menu, name: 'All' },
    });
    for (const [id, productId, displayName] of [
      [ids.itemDefault, ids.productDefault, 'Default Soup'],
      [ids.itemBar, ids.productBar, 'Bar Drink'],
      [ids.itemGap, ids.productGap, 'Gap Plate'],
    ] as const) {
      await tx.restaurantMenuItem.create({
        data: { id, sectionId: ids.section, productId, displayName },
      });
    }
    await tx.restaurantPriceList.create({
      data: { id: ids.priceList, name: 'Kitchen Base', isDefault: true },
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
    for (const productId of [ids.productDefault, ids.productBar, ids.productGap]) {
      await tx.restaurantPriceListEntry.create({
        data: { priceListVersionId: ids.priceVersion, productId, price: '8.00' },
      });
    }
    await tx.restaurantBranchMenuPublication.create({
      data: {
        id: ids.publication,
        branchId: ids.branch,
        menuId: ids.menu,
        priceListId: ids.priceList,
        status: 'PUBLISHED',
        channels: ['DINE_IN'],
      },
    });
  });

  pos = await enroll('POS');
  kdsGrill = await makeKds(ids.stationGrill, 'KDS Grill');
  kdsBar = await makeKds(ids.stationBar, 'KDS Bar');
  kdsGap = await makeKds(ids.stationGap, 'KDS Gap');
  session = await establishUnlock(pos);
}, 60_000);

describeIfDatabase('WHA-49 M4 kitchen flow (real DB/routes)', () => {
  it('replays open/add/fire/bump without creating duplicate rows, events, or tickets', async () => {
    const openKey = key('idem-open');
    const firstOpen = await postPos(
      'open',
      { channel: 'DINE_IN', publicationId: ids.publication },
      openKey
    );
    const replayOpen = await postPos(
      'open',
      { channel: 'DINE_IN', publicationId: ids.publication },
      openKey
    );
    expect(firstOpen.status).toBe(201);
    expect(replayOpen.status).toBe(201);
    expect(replayOpen.json).toMatchObject({
      orderId: firstOpen.json.orderId,
      replayed: true,
    });
    const orderId = firstOpen.json.orderId as string;

    const addKey = key('idem-add');
    const firstAdd = await postPos('addItem', { orderId, menuItemId: ids.itemBar }, addKey);
    const replayAdd = await postPos('addItem', { orderId, menuItemId: ids.itemBar }, addKey);
    expect(firstAdd.status).toBe(201);
    expect(replayAdd.status).toBe(201);
    expect(replayAdd.json).toMatchObject({ itemId: firstAdd.json.itemId, replayed: true });
    const itemId = firstAdd.json.itemId as string;

    const fireKey = key('idem-fire');
    const firstFire = await postPos('fire', { orderId }, fireKey);
    const replayFire = await postPos('fire', { orderId }, fireKey);
    expect(firstFire.status).toBe(200);
    expect(replayFire.status).toBe(200);
    expect(replayFire.json.replayed).toBe(true);

    expect((await postKds('ack', kdsBar, itemId)).status).toBe(200);
    const bumpKey = key('idem-bump');
    const firstBump = await postKds('bump', kdsBar, itemId, bumpKey);
    const replayBump = await postKds('bump', kdsBar, itemId, bumpKey);
    expect(firstBump.status).toBe(200);
    expect(replayBump.status).toBe(200);
    expect(replayBump.json.replayed).toBe(true);

    const evidence = await deps.withTenantDb(ids.org, async (tx) => ({
      orderCount: await tx.restaurantOrder.count({ where: { id: orderId } }),
      itemCount: await tx.restaurantOrderItem.count({ where: { orderId } }),
      ticketCount: await tx.restaurantKitchenTicket.count({ where: { orderId } }),
      eventTypes: (
        await tx.restaurantOrderEvent.findMany({
          where: { orderId },
          orderBy: { sequence: 'asc' },
          select: { eventType: true },
        })
      ).map((event) => event.eventType),
      outboxCount: await tx.restaurantEventOutbox.count({ where: { aggregateId: orderId } }),
      replayKeyCount: await tx.restaurantOrderIdempotencyKey.count({
        where: {
          OR: [
            { deviceId: pos.deviceId, key: openKey },
            { deviceId: pos.deviceId, key: addKey },
            { deviceId: pos.deviceId, key: fireKey },
            { deviceId: kdsBar.deviceId, key: bumpKey },
          ],
        },
      }),
      item: await tx.restaurantOrderItem.findUnique({
        where: { id: itemId },
        select: { status: true },
      }),
    }));
    expect(evidence).toMatchObject({
      orderCount: 1,
      itemCount: 1,
      ticketCount: 1,
      eventTypes: ['order.opened', 'item.added', 'order.sent', 'item.advanced', 'item.advanced'],
      outboxCount: 5,
      replayKeyCount: 4,
      item: { status: 'PREPARED' },
    });
  }, 20_000);

  it('routes exact items to bound stations and returns the fixed KDS state mapping', async () => {
    const opened = await postPos('open', {
      channel: 'DINE_IN',
      publicationId: ids.publication,
    });
    expect(opened.status).toBe(201);
    const orderId = opened.json.orderId as string;
    const businessDate = opened.json.businessDate as string;
    const bar = await postPos('addItem', { orderId, menuItemId: ids.itemBar });
    const grill = await postPos('addItem', { orderId, menuItemId: ids.itemDefault });
    expect([bar.status, grill.status]).toEqual([201, 201]);
    const barItemId = bar.json.itemId as string;
    const grillItemId = grill.json.itemId as string;

    const fired = await postPos('fire', { orderId });
    expect(fired.status).toBe(200);
    const tickets = fired.json.tickets as Array<{
      stationId: string;
      matchedBy: string;
      items: Array<{ orderItemId: string }>;
    }>;
    expect(tickets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stationId: ids.stationBar,
          matchedBy: 'product',
          items: [{ orderItemId: barItemId, quantity: 1 }],
        }),
        expect.objectContaining({
          stationId: ids.stationGrill,
          matchedBy: 'default',
          items: [{ orderItemId: grillItemId, quantity: 1 }],
        }),
      ])
    );

    const barQueue = await readQueue(kdsBar, businessDate);
    const grillQueue = await readQueue(kdsGrill, businessDate);
    expect([barQueue.status, grillQueue.status]).toEqual([200, 200]);
    expect(queueItems(barQueue.json)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ orderItemId: barItemId, displayStatus: 'NEW' }),
      ])
    );
    expect(queueItems(barQueue.json).some((item) => item.orderItemId === grillItemId)).toBe(false);
    expect(queueItems(grillQueue.json)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ orderItemId: grillItemId, displayStatus: 'NEW' }),
      ])
    );
    expect(queueItems(grillQueue.json).some((item) => item.orderItemId === barItemId)).toBe(false);
    expect(barQueue.json.displayMapping).toEqual({
      HELD: 'HELD',
      QUEUED: 'NEW',
      FIRING: 'COOKING',
      PREPARED: 'READY',
      SERVED: 'SERVED',
      REMAKE_REQUESTED: 'RECALLED',
      VOIDED: 'VOIDED',
    });

    expect((await postKds('ack', kdsBar, barItemId)).status).toBe(200);
    expect(
      queueItems((await readQueue(kdsBar, businessDate)).json).find(
        (item) => item.orderItemId === barItemId
      )
    ).toMatchObject({ itemStatus: 'FIRING', displayStatus: 'COOKING' });
    expect((await postKds('bump', kdsBar, barItemId)).status).toBe(200);
    expect(
      queueItems((await readQueue(kdsBar, businessDate)).json).find(
        (item) => item.orderItemId === barItemId
      )
    ).toMatchObject({ itemStatus: 'PREPARED', displayStatus: 'READY' });
    expect((await postKds('recall', kdsBar, barItemId)).status).toBe(200);
    expect(
      queueItems((await readQueue(kdsBar, businessDate)).json).find(
        (item) => item.orderItemId === barItemId
      )
    ).toMatchObject({ itemStatus: 'FIRING', displayStatus: 'COOKING' });
  }, 20_000);

  it('signals stale-cursor and overflow gaps while returning authoritative resync state', async () => {
    const first = await openAdd(ids.itemGap);
    const second = await openAdd(ids.itemGap);
    expect((await postPos('fire', { orderId: first.orderId })).status).toBe(200);
    expect((await postPos('fire', { orderId: second.orderId })).status).toBe(200);

    const stale = await readQueue(kdsGap, first.businessDate, { sinceCursor: '999999' });
    expect(stale.status).toBe(200);
    expect(stale.json).toMatchObject({ gap: true, hasMore: false, cursor: 2 });
    expect(new Set(queueItems(stale.json).map((item) => item.orderItemId))).toEqual(
      new Set([first.itemId, second.itemId])
    );

    const overflow = await readQueue(kdsGap, first.businessDate, {
      sinceCursor: '0',
      limit: '1',
    });
    expect(overflow.status).toBe(200);
    expect(overflow.json).toMatchObject({ gap: true, hasMore: true, cursor: 2 });
    expect(overflow.json.tickets as unknown[]).toHaveLength(1);
  });

  it('rejects a KDS device immediately when revoked mid-flow', async () => {
    const device = await makeKds(ids.stationBar, 'Revoked Mid-flow KDS');
    const seeded = await openAdd(ids.itemBar);
    expect((await postPos('fire', { orderId: seeded.orderId })).status).toBe(200);
    expect((await readQueue(device, seeded.businessDate)).status).toBe(200);

    await deps.withTenantDb(ids.org, (tx) => deps.revokeDevice(tx, device.deviceId, new Date()));
    expect((await postKds('ack', device, seeded.itemId)).status).toBe(403);
    expect((await readQueue(device, seeded.businessDate)).status).toBe(403);
    const item = await deps.withTenantDb(ids.org, (tx) =>
      tx.restaurantOrderItem.findUnique({
        where: { id: seeded.itemId },
        select: { status: true },
      })
    );
    expect(item?.status).toBe('QUEUED');
  });
});
