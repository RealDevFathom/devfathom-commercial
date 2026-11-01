/**
 * WHA-143 / M8 correction E2 — terminal order command errors must escape the
 * request-owning tenant transaction before they are mapped to HTTP responses.
 *
 * These checks drive the real close and void route modules over real Requests.
 * They require TEST_DATABASE_URL to name a migrated disposable database reached
 * through a NOSUPERUSER / NOBYPASSRLS role; the role guard refuses weaker proof.
 */
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { assertRlsEnforcingRole } from '@/lib/testing/rls-role-guard';
import { ensurePlatformModule, seedDepartments } from '@/lib/test-support/departments';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
process.env.AUTH_SECRET ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha143_${suffix}`;
const foreignOrgId = `org_wha143_foreign_${suffix}`;
const businessDate = new Date('2026-08-25T00:00:00.000Z');
const PIN = '616161';
const OLD_LAST_SEEN = new Date('2020-01-01T00:00:00.000Z');

type RouteModule = { POST?: (request: Request) => Promise<Response> };

type Deps = {
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  enrollDevice: (typeof import('@/lib/restaurant/devices'))['enrollDevice'];
  hashOperatorCredential: (typeof import('@/lib/restaurant/operator-credentials'))['hashOperatorCredential'];
  bills: typeof import('@/lib/restaurant/bills');
  routes: {
    close: RouteModule;
    void: RouteModule;
    cancel: RouteModule;
    establish: RouteModule;
    unlock: RouteModule;
  };
};

let deps: Deps;
let orderNumber = 0;

const ids = {
  branch: `branch_${suffix}`,
  operator: `staff_operator_${suffix}`,
  operatorUser: `user_operator_${suffix}`,
  approver: `staff_approver_${suffix}`,
  unauthorizedApprover: `staff_unauthorized_${suffix}`,
  foreignApprover: `staff_foreign_${suffix}`,
  approverUser: `user_approver_${suffix}`,
  unauthorizedUser: `user_unauthorized_${suffix}`,
  approverRole: `role_approver_${suffix}`,
  operatorRole: `role_operator_${suffix}`,
  unauthorizedRole: `role_unauthorized_${suffix}`,
  plainProduct: `product_plain_${suffix}`,
  recipeProduct: `product_recipe_${suffix}`,
  customer: `customer_${suffix}`,
  loyaltyAccount: `loyalty_account_${suffix}`,
  loyaltyProgram: `loyalty_program_${suffix}`,
  gram: `unit_gram_${suffix}`,
  kilogram: `unit_kilogram_${suffix}`,
  ingredient: `ingredient_${suffix}`,
  stockItem: `stock_item_${suffix}`,
  stockLocation: `stock_location_${suffix}`,
  recipe: `recipe_${suffix}`,
  recipeVersion: `recipe_version_${suffix}`,
  deviceId: '',
  deviceSecret: '',
  session: '',
  composerProof: '',
};

async function call(
  route: RouteModule,
  opts: { key?: string; body?: unknown; session?: string }
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${ids.deviceSecret}`,
    'content-type': 'application/json',
  };
  const session = opts.session ?? ids.session;
  if (session) headers['x-terminal-session'] = session;
  if (ids.composerProof) headers['x-pos-composer-proof'] = ids.composerProof;
  if (opts.key) headers['idempotency-key'] = opts.key;

  const response = await route.POST!(
    new Request('https://tenant.test/api/restaurant/probe', {
      method: 'POST',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
  );
  return {
    status: response.status,
    json: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

const key = (label: string) => `${label}_${suffix}_${randomBytes(3).toString('hex')}`;

async function seedPayableOrder(productId: string, customerId: string | null) {
  orderNumber += 1;
  return deps.withTenantDb(orgId, async (tx) => {
    const order = await tx.restaurantOrder.create({
      data: {
        branchId: ids.branch,
        orderNumber,
        businessDate,
        status: 'PAYMENT_PENDING',
        channel: 'DINE_IN',
        staffProfileId: ids.operator,
        deviceId: ids.deviceId,
        customerId,
      },
      select: { id: true },
    });
    const item = await tx.restaurantOrderItem.create({
      data: {
        orderId: order.id,
        productId,
        name: 'Rollback item',
        unitPrice: '10.00',
        quantity: 1,
        status: 'SERVED',
      },
      select: { id: true },
    });
    const bill = await tx.restaurantBill.create({
      data: {
        orderId: order.id,
        branchId: ids.branch,
        businessDate,
        subtotal: '10.00',
        grandTotal: '10.00',
        openerStaffProfileId: ids.operator,
        deviceId: ids.deviceId,
        lines: {
          create: {
            orderItemId: item.id,
            name: 'Rollback item',
            unitPrice: '10.00',
            lineSubtotal: '10.00',
            lineTotal: '10.00',
          },
        },
      },
      select: { id: true },
    });
    return { orderId: order.id, itemId: item.id, billId: bill.id };
  });
}

const settle = (billId: string) =>
  deps.withTenantDb(orgId, (tx) =>
    deps.bills.settleBill(tx, {
      billId,
      staffProfileId: ids.operator,
      deviceId: ids.deviceId,
      at: new Date(),
    })
  );

async function orderEffects(orderId: string, idempotencyKey: string) {
  return deps.withTenantDb(orgId, async (tx) => ({
    order: await tx.restaurantOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true, closedAt: true },
    }),
    closedEvents: await tx.restaurantOrderEvent.count({
      where: { orderId, eventType: 'order.closed' },
    }),
    outbox: await tx.restaurantEventOutbox.count({
      where: { aggregateId: orderId, eventType: 'order.closed' },
    }),
    key: await tx.restaurantOrderIdempotencyKey.findUnique({
      where: { deviceId_key: { deviceId: ids.deviceId, key: idempotencyKey } },
      select: { resultRef: true },
    }),
    earns: await tx.loyaltyPointsEntry.count({
      where: { kind: 'EARN', bill: { orderId } },
    }),
    movements: await tx.restaurantStockMovement.count({ where: { orderId } }),
  }));
}

const resetLastSeen = () =>
  deps.withTenantDb(orgId, (tx) =>
    tx.restaurantRegisteredDevice.update({
      where: { id: ids.deviceId },
      data: { lastSeenAt: OLD_LAST_SEEN },
    })
  );

const lastSeen = () =>
  deps.withTenantDb(
    orgId,
    async (tx) =>
      (
        await tx.restaurantRegisteredDevice.findUniqueOrThrow({
          where: { id: ids.deviceId },
          select: { lastSeenAt: true },
        })
      ).lastSeenAt
  );

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, devices, credentials, bills, close, voidRoute, cancel, establish, unlock] =
    await Promise.all([
      import('@/lib/tenancy/scoped-db'),
      import('@/lib/restaurant/devices'),
      import('@/lib/restaurant/operator-credentials'),
      import('@/lib/restaurant/bills'),
      import('@/app/api/restaurant/orders/close/route'),
      import('@/app/api/restaurant/orders/void/route'),
      import('@/app/api/restaurant/orders/cancel/route'),
      import('@/app/api/restaurant/terminal/establish/route'),
      import('@/app/api/restaurant/terminal/unlock/route'),
    ]);
  deps = {
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    enrollDevice: devices.enrollDevice,
    hashOperatorCredential: credentials.hashOperatorCredential,
    bills,
    routes: { close, void: voidRoute, cancel, establish, unlock },
  };

  await assertRlsEnforcingRole(deps.withPlatformDb);
  await deps.withPlatformDb(async (tx) => {
    await tx.organization.create({
      data: {
        id: orgId,
        slug: `wha143-${suffix}`,
        legalName: 'WHA-143 Rollback Co',
        displayName: 'WHA-143 Rollback',
        status: 'ACTIVE',
      },
    });
    await tx.organization.create({
      data: {
        id: foreignOrgId,
        slug: `wha143-foreign-${suffix}`,
        legalName: 'WHA-143 Foreign Co',
        displayName: 'WHA-143 Foreign',
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
  });

  await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantBranch.create({ data: { id: ids.branch, name: 'Rollback' } });
    await tx.organizationRole.create({
      data: {
        id: ids.operatorRole,
        key: `operator_${suffix}`,
        name: 'Operator',
        permissions: { create: [{ capability: 'orders:take', effect: 'ALLOW' }] },
      },
    });
    await tx.organizationRole.create({
      data: {
        id: ids.approverRole,
        key: `approver_${suffix}`,
        name: 'Approver',
        permissions: { create: [{ capability: 'coauth:approve', effect: 'ALLOW' }] },
      },
    });
    await tx.organizationRole.create({
      data: {
        id: ids.unauthorizedRole,
        key: `unauthorized_${suffix}`,
        name: 'Unauthorized',
        permissions: { create: [{ capability: 'menu:read', effect: 'ALLOW' }] },
      },
    });
    for (const [id, roleId, label] of [
      [ids.operatorUser, ids.operatorRole, 'operator'],
      [ids.approverUser, ids.approverRole, 'approver'],
      [ids.unauthorizedUser, ids.unauthorizedRole, 'unauthorized'],
    ] as const) {
      await tx.user.create({
        data: {
          id,
          name: label,
          email: `${label}_${suffix}@test.local`,
          department: 'LEADERSHIP',
          title: label,
          organizationRoleId: roleId,
        },
      });
    }
    await tx.restaurantProduct.createMany({
      data: [
        { id: ids.plainProduct, name: 'Plain' },
        { id: ids.recipeProduct, name: 'Recipe' },
      ],
    });
    for (const [staffProfileId, displayName] of [
      [ids.operator, 'Operator'],
      [ids.approver, 'Approver'],
      [ids.unauthorizedApprover, 'Unauthorized'],
    ] as const) {
      await tx.restaurantStaffProfile.create({
        data: {
          id: staffProfileId,
          displayName,
          primaryBranchId: ids.branch,
          status: 'ACTIVE',
          ...(staffProfileId === ids.approver
            ? { userId: ids.approverUser }
            : staffProfileId === ids.operator
              ? { userId: ids.operatorUser }
              : staffProfileId === ids.unauthorizedApprover
                ? { userId: ids.unauthorizedUser }
                : {}),
        },
      });
      await tx.restaurantOperatorCredential.create({
        data: {
          staffProfileId,
          type: 'PIN',
          credentialHash: await deps.hashOperatorCredential('PIN', PIN),
        },
      });
    }
    await tx.restaurantCustomer.create({
      data: { id: ids.customer, displayName: 'Loyal guest' },
    });
    await tx.loyaltyAccount.create({
      data: { id: ids.loyaltyAccount, customerId: ids.customer },
    });
    await tx.loyaltyProgramVersion.create({
      data: {
        id: ids.loyaltyProgram,
        versionNumber: 1,
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
        earnRate: '1',
        redemptionValue: '0.01',
      },
    });
    await tx.restaurantUnit.createMany({
      data: [
        { id: ids.gram, name: 'Gram', abbreviation: 'g' },
        { id: ids.kilogram, name: 'Kilogram', abbreviation: 'kg' },
      ],
    });
    await tx.restaurantIngredient.create({
      data: { id: ids.ingredient, name: 'Ingredient', baseUnitId: ids.kilogram },
    });
    await tx.restaurantStockItem.create({
      data: {
        id: ids.stockItem,
        ingredientId: ids.ingredient,
        canonicalUnitId: ids.gram,
      },
    });
    await tx.restaurantStockLocation.create({
      data: { id: ids.stockLocation, branchId: ids.branch, name: 'Primary stock' },
    });
    await tx.restaurantRecipe.create({
      data: { id: ids.recipe, productId: ids.recipeProduct, name: 'Failing conversion' },
    });
    await tx.restaurantRecipeVersion.create({
      data: {
        id: ids.recipeVersion,
        recipeId: ids.recipe,
        versionNumber: 1,
        status: 'ACTIVE',
        yieldQuantity: '1',
        yieldUnitId: ids.kilogram,
        portionCount: 1,
        activatedAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    });
    await tx.restaurantRecipeLine.create({
      data: {
        recipeVersionId: ids.recipeVersion,
        ingredientId: ids.ingredient,
        quantity: '1',
        unitId: ids.kilogram,
      },
    });
  });

  await deps.withTenantDb(foreignOrgId, async (tx) => {
    const branchId = `branch_foreign_${suffix}`;
    await tx.restaurantBranch.create({ data: { id: branchId, name: 'Foreign' } });
    await tx.restaurantStaffProfile.create({
      data: {
        id: ids.foreignApprover,
        displayName: 'Foreign Approver',
        primaryBranchId: branchId,
        status: 'ACTIVE',
      },
    });
    await tx.restaurantOperatorCredential.create({
      data: {
        staffProfileId: ids.foreignApprover,
        type: 'PIN',
        credentialHash: await deps.hashOperatorCredential('PIN', PIN),
      },
    });
  });

  const enrolled = await deps.withTenantDb(orgId, (tx) =>
    deps.enrollDevice(tx, { branchId: ids.branch, name: 'pos-rollback' })
  );
  ids.deviceId = enrolled.device.id;
  ids.deviceSecret = enrolled.secret;

  const established = await call(deps.routes.establish, { session: '' });
  expect(established.status).toBe(201);
  ids.session = established.json.sessionToken as string;
  const unlocked = await call(deps.routes.unlock, {
    body: { staffProfileId: ids.operator, type: 'PIN', secret: PIN },
  });
  expect(unlocked.status).toBe(200);
  expect(unlocked.json.composerProof).toEqual(expect.any(String));
  ids.composerProof = unlocked.json.composerProof as string;
});

describeIfDatabase('WHA-143 terminal order routes roll back before HTTP mapping', () => {
  it('rolls a mapped close refusal back, leaving the same key available for a corrected retry', async () => {
    const seeded = await seedPayableOrder(ids.plainProduct, null);
    const idempotencyKey = key('not-settled');
    await resetLastSeen();

    const refused = await call(deps.routes.close, {
      key: idempotencyKey,
      body: { orderId: seeded.orderId },
    });
    expect(refused.status).toBe(400);
    expect(String(refused.json.error)).toMatch(/fully settled/);
    expect(await orderEffects(seeded.orderId, idempotencyKey)).toEqual({
      order: { status: 'PAYMENT_PENDING', closedAt: null },
      closedEvents: 0,
      outbox: 0,
      key: null,
      earns: 0,
      movements: 0,
    });
    expect(await lastSeen()).toEqual(OLD_LAST_SEEN);

    await settle(seeded.billId);
    const retried = await call(deps.routes.close, {
      key: idempotencyKey,
      body: { orderId: seeded.orderId },
    });
    expect(retried.status).toBe(200);
    expect(retried.json.replayed).toBe(false);
    expect((await orderEffects(seeded.orderId, idempotencyKey)).order.status).toBe('CLOSED');
  });

  it('rolls order close and loyalty earn back when recipe consumption fails', async () => {
    const seeded = await seedPayableOrder(ids.recipeProduct, ids.customer);
    await settle(seeded.billId);
    const idempotencyKey = key('recipe-failure');

    const failed = await call(deps.routes.close, {
      key: idempotencyKey,
      body: { orderId: seeded.orderId },
    });
    expect(failed.status).toBe(500);
    expect(failed.json).toEqual({ error: 'Internal server error' });
    expect(await orderEffects(seeded.orderId, idempotencyKey)).toEqual({
      order: { status: 'PAYMENT_PENDING', closedAt: null },
      closedEvents: 0,
      outbox: 0,
      key: null,
      earns: 0,
      movements: 0,
    });

    await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantUnitConversion.create({
        data: { fromUnitId: ids.kilogram, toUnitId: ids.gram, factor: '1000' },
      })
    );
    const retried = await call(deps.routes.close, {
      key: idempotencyKey,
      body: { orderId: seeded.orderId },
    });
    expect(retried.status).toBe(200);
    expect(retried.json.replayed).toBe(false);
    const effects = await orderEffects(seeded.orderId, idempotencyKey);
    expect(effects.order.status).toBe('CLOSED');
    expect(effects.earns).toBe(1);
    expect(effects.movements).toBe(1);
  });

  it('keeps the durable failed-approver count when the longhand void/cancel routes return 401', async () => {
    await resetLastSeen();
    const voidOrder = await seedPayableOrder(ids.plainProduct, null);
    const cancelOrder = await seedPayableOrder(ids.plainProduct, null);
    const before = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantOperatorCredential.findFirstOrThrow({
        where: { staffProfileId: ids.approver },
        select: { failedAttempts: true },
      })
    );

    for (const [route, body] of [
      [deps.routes.void, { orderId: voidOrder.orderId, itemId: voidOrder.itemId }],
      [deps.routes.cancel, { orderId: cancelOrder.orderId }],
    ] as const) {
      const refused = await call(route, {
        key: key('bad-approver'),
        body: {
          ...body,
          reason: 'test refusal',
          wastageDisposition: 'NONE',
          approving: { staffProfileId: ids.approver, type: 'PIN', secret: '999999' },
        },
      });
      expect(refused.status).toBe(401);
    }

    const after = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantOperatorCredential.findFirstOrThrow({
        where: { staffProfileId: ids.approver },
        select: { failedAttempts: true },
      })
    );
    expect(after.failedAttempts).toBe(before.failedAttempts + 2);
    expect((await lastSeen())!.getTime()).toBeGreaterThan(OLD_LAST_SEEN.getTime());
  });

  it('keeps missing, foreign, unauthorized, and valid approvers oracle-safe', async () => {
    for (const route of [deps.routes.void, deps.routes.cancel]) {
      const seeded = await seedPayableOrder(ids.plainProduct, null);
      const existingOrderBody =
        route === deps.routes.void
          ? { orderId: seeded.orderId, itemId: seeded.itemId }
          : { orderId: seeded.orderId };
      for (const [staffProfileId, expectedStatus] of [
        [`missing_approver_${suffix}`, 401],
        [ids.foreignApprover, 401],
        [ids.unauthorizedApprover, 403],
      ] as const) {
        const refused = await call(route, {
          key: key('approver-contract'),
          body: {
            ...existingOrderBody,
            reason: 'contract probe',
            wastageDisposition: 'NONE',
            approving: { staffProfileId, type: 'PIN', secret: PIN },
          },
        });
        expect(
          refused.status,
          `${staffProfileId} via ${route === deps.routes.void ? 'void' : 'cancel'}`
        ).toBe(expectedStatus);
      }

      const missingOrderBody =
        route === deps.routes.void
          ? { orderId: `missing_order_${suffix}`, itemId: `missing_item_${suffix}` }
          : { orderId: `missing_order_${suffix}` };
      const missingOrder = await call(route, {
        key: key('missing-order-contract'),
        body: {
          ...missingOrderBody,
          reason: 'contract probe',
          wastageDisposition: 'NONE',
          approving: { staffProfileId: ids.approver, type: 'PIN', secret: PIN },
        },
      });
      expect(
        missingOrder.status,
        `missing order via ${route === deps.routes.void ? 'void' : 'cancel'}`
      ).toBe(404);
    }
  });
});
