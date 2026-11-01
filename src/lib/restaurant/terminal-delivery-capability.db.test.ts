/**
 * WHA-1047 — real-route proof that DELIVERY capability denial precedes every
 * order-side write and does not consume the idempotency key.
 */
import { randomBytes } from 'node:crypto';

import { Client } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';

import { assertRlsEnforcingRole } from '@/lib/testing/rls-role-guard';
import { ensurePlatformModule, seedDepartments } from '@/lib/test-support/departments';
import { RESTAURANT_ROLE_TEMPLATES } from '@/lib/vertical-catalog';

const RUNTIME_DATABASE_URL =
  process.env.M8_TEST_RUNTIME_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const OWNER_DATABASE_URL = process.env.M8_TEST_OWNER_DATABASE_URL;
if (RUNTIME_DATABASE_URL) process.env.DATABASE_URL = RUNTIME_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
process.env.AUTH_SECRET ??= randomBytes(32).toString('base64');

const describeIfDatabase = RUNTIME_DATABASE_URL && OWNER_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha1047_${suffix}`;
const branchId = `branch_wha1047_${suffix}`;
const denied = { id: `staff_denied_${suffix}`, pin: '104701' };
const cashier = { id: `staff_cashier_${suffix}`, pin: '104702' };
const customerId = `customer_wha1047_${suffix}`;

type RouteModule = { POST: (request: Request) => Promise<Response> };
type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  enrollDevice: (typeof import('./devices'))['enrollDevice'];
  hashOperatorCredential: (typeof import('./operator-credentials'))['hashOperatorCredential'];
  routes: {
    establish: RouteModule;
    unlock: RouteModule;
    switchOperator: RouteModule;
    open: RouteModule;
  };
};

let deps: Deps;
let deviceId = '';
let deviceSecret = '';
let sessionToken = '';
let composerProof = '';

async function call(route: RouteModule, body?: unknown, idempotencyKey?: string) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${deviceSecret}`,
    'content-type': 'application/json',
  };
  if (sessionToken) headers['x-terminal-session'] = sessionToken;
  if (composerProof) headers['x-pos-composer-proof'] = composerProof;
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const response = await route.POST(
    new Request('https://tenant.test/api/restaurant/orders/open', {
      method: 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  if (!RUNTIME_DATABASE_URL || !OWNER_DATABASE_URL) return;
  expect(OWNER_DATABASE_URL).not.toBe(RUNTIME_DATABASE_URL);

  const owner = new Client({ connectionString: OWNER_DATABASE_URL });
  await owner.connect();
  try {
    await owner.query('BEGIN');
    await owner.query(`SET LOCAL app.is_platform_admin = 'true'`);
    await owner.query(
      `INSERT INTO "organizations"
        ("id", "slug", "legalName", "displayName", "status", "deploymentMode", "createdAt", "updatedAt")
       VALUES ($1, $2, 'WHA-1047 Test Co', 'WHA-1047 Test', 'ACTIVE', 'SHARED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [orgId, `wha1047-${suffix}`]
    );
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await owner.end();
  }

  const [scopedDb, devices, credentials, establish, unlock, switchOperator, open] =
    await Promise.all([
      import('@/lib/tenancy/scoped-db'),
      import('./devices'),
      import('./operator-credentials'),
      import('@/app/api/restaurant/terminal/establish/route'),
      import('@/app/api/restaurant/terminal/unlock/route'),
      import('@/app/api/restaurant/terminal/switch/route'),
      import('@/app/api/restaurant/orders/open/route'),
    ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    enrollDevice: devices.enrollDevice,
    hashOperatorCredential: credentials.hashOperatorCredential,
    routes: { establish, unlock, switchOperator, open },
  };

  await assertRlsEnforcingRole(deps.withPlatformDb);
  await expect(
    deps.withPlatformDb((tx) =>
      tx.$queryRawUnsafe<Array<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }>>(
        `SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`
      )
    )
  ).resolves.toEqual([{ rolcanlogin: true, rolsuper: false, rolbypassrls: false }]);
  await deps.withPlatformDb(async (tx) => {
    await seedDepartments(tx, [orgId], ['OPERATIONS']);
    const pos = await ensurePlatformModule(tx, 'restaurant-pos', {
      name: 'POS',
      category: 'Operations',
    });
    await tx.organizationModule.create({ data: { organizationId: orgId, moduleId: pos.id } });
  });

  await deps.withTenantDb(orgId, async (tx) => {
    const cashierTemplate = RESTAURANT_ROLE_TEMPLATES.find((role) => role.key === 'cashier')!;
    const cashierRole = await tx.organizationRole.create({
      data: {
        key: cashierTemplate.key,
        name: cashierTemplate.name,
        permissions: {
          create: cashierTemplate.capabilities.map((capability) => ({
            capability,
            effect: 'ALLOW',
          })),
        },
      },
    });
    const cashierUser = await tx.user.create({
      data: {
        id: `user_cashier_${suffix}`,
        name: 'Default cashier',
        email: `cashier_${suffix}@test.local`,
        department: 'OPERATIONS',
        title: 'Cashier',
        organizationRoleId: cashierRole.id,
      },
    });
    await tx.organizationLimit.create({
      data: { organizationId: orgId, key: 'pos.orders.monthly', value: 100 },
    });
    await tx.restaurantBranch.create({ data: { id: branchId, name: 'Main' } });
    await tx.restaurantStaffProfile.createMany({
      data: [
        {
          id: denied.id,
          displayName: 'Denied operator',
          primaryBranchId: branchId,
          status: 'ACTIVE',
        },
        {
          id: cashier.id,
          userId: cashierUser.id,
          displayName: 'Default cashier',
          primaryBranchId: branchId,
          status: 'ACTIVE',
        },
      ],
    });
    for (const operator of [denied, cashier]) {
      await tx.restaurantOperatorCredential.create({
        data: {
          staffProfileId: operator.id,
          type: 'PIN',
          credentialHash: await deps.hashOperatorCredential('PIN', operator.pin),
        },
      });
    }
    await tx.restaurantCustomer.create({
      data: { id: customerId, displayName: 'Trusted customer' },
    });
  });

  const enrolled = await deps.withTenantDb(orgId, (tx) =>
    deps.enrollDevice(tx, { branchId, name: 'wha1047-pos' })
  );
  deviceId = enrolled.device.id;
  deviceSecret = enrolled.secret;
  const established = await call(deps.routes.establish);
  expect(established.status).toBe(201);
  sessionToken = established.json.sessionToken as string;
  const unlocked = await call(deps.routes.unlock, {
    staffProfileId: denied.id,
    type: 'PIN',
    secret: denied.pin,
  });
  expect(unlocked.status).toBe(200);
  expect(unlocked.json.composerProof).toEqual(expect.any(String));
  composerProof = unlocked.json.composerProof as string;
});

describeIfDatabase('WHA-1047 DELIVERY capability denial (real DB)', () => {
  it('denies before writes and leaves the key reusable by a default cashier', async () => {
    const idempotencyKey = `delivery-capability-${suffix}`;
    const body = { channel: 'DELIVERY', customerId };

    const deniedResponse = await call(deps.routes.open, body, idempotencyKey);
    expect(deniedResponse).toEqual({
      status: 403,
      json: { error: 'This operator lacks the "orders:take" capability.' },
    });

    const effectsAfterDenial = await deps.withTenantDb(orgId, async (tx) => ({
      orders: await tx.restaurantOrder.count({ where: { branchId } }),
      keys: await tx.restaurantOrderIdempotencyKey.count({
        where: { deviceId, key: idempotencyKey },
      }),
      events: await tx.restaurantOrderEvent.count({ where: { order: { branchId } } }),
    }));
    expect(effectsAfterDenial).toEqual({ orders: 0, keys: 0, events: 0 });

    const switched = await call(deps.routes.switchOperator, {
      staffProfileId: cashier.id,
      type: 'PIN',
      secret: cashier.pin,
    });
    expect(switched.status).toBe(200);
    expect(switched.json.composerProof).toEqual(expect.any(String));
    composerProof = switched.json.composerProof as string;

    const accepted = await call(deps.routes.open, body, idempotencyKey);
    expect(accepted.status).toBe(201);
    expect(accepted.json.replayed).toBe(false);
    expect(typeof accepted.json.orderId).toBe('string');

    const created = await deps.withTenantDb(orgId, async (tx) => ({
      order: await tx.restaurantOrder.findUnique({
        where: { id: accepted.json.orderId as string },
        select: { channel: true, customerId: true, staffProfileId: true },
      }),
      keys: await tx.restaurantOrderIdempotencyKey.count({
        where: { deviceId, key: idempotencyKey },
      }),
      events: await tx.restaurantOrderEvent.count({
        where: { orderId: accepted.json.orderId as string, eventType: 'order.opened' },
      }),
    }));
    expect(created).toEqual({
      order: { channel: 'DELIVERY', customerId, staffProfileId: cashier.id },
      keys: 1,
      events: 1,
    });
  });
});
