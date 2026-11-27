/** WHA-74 — binding M6 inventory/purchasing acceptance through real tRPC + PostgreSQL. */
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { seedDepartments } from '@/lib/test-support/departments';
import type { TRPCContext } from '@/server/trpc';

const mocks = vi.hoisted(() => ({
  can: vi.fn<(subject: unknown, action: unknown) => Promise<boolean>>(() => Promise.resolve(true)),
  annotateAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: ['restaurant-pos'] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: mocks.annotateAudit,
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PLATFORM_ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

const describeIfDatabase = TEST_DATABASE_URL ? describe : describe.skip;
const suffix = randomBytes(6).toString('hex');
const orgId = `org_wha74_${suffix}`;
const foreignOrgId = `org_wha918_foreign_${suffix}`;
const ids = {
  inventoryBranch: `branch_inventory_${suffix}`,
  recipeBranch: `branch_recipe_${suffix}`,
  each: `unit_each_${suffix}`,
  case: `unit_case_${suffix}`,
  gram: `unit_g_${suffix}`,
  kilogram: `unit_kg_${suffix}`,
  portion: `unit_portion_${suffix}`,
  receiptIngredient: `ingredient_receipt_${suffix}`,
  countIngredient: `ingredient_count_${suffix}`,
  transferIngredient: `ingredient_transfer_${suffix}`,
  negativeIngredient: `ingredient_negative_${suffix}`,
  recipeIngredient: `ingredient_recipe_${suffix}`,
  receiptItem: `stock_receipt_${suffix}`,
  countItem: `stock_count_${suffix}`,
  transferItem: `stock_transfer_${suffix}`,
  negativeItem: `stock_negative_${suffix}`,
  recipeItem: `stock_recipe_${suffix}`,
  receiptLocation: `location_receipt_${suffix}`,
  countLocation: `location_count_${suffix}`,
  transferSource: `location_transfer_source_${suffix}`,
  transferDestination: `location_transfer_destination_${suffix}`,
  negativeLocation: `location_negative_${suffix}`,
  recipeLocation: `location_recipe_${suffix}`,
  product: `product_recipe_${suffix}`,
  recipe: `recipe_${suffix}`,
  recipeVersion: `recipe_version_${suffix}`,
  user: `user_inventory_${suffix}`,
  staff: `staff_${suffix}`,
  inactiveUser: `user_inactive_${suffix}`,
  inactiveStaff: `staff_inactive_${suffix}`,
  crossBranchUser: `user_cross_branch_${suffix}`,
  crossBranchStaff: `staff_cross_branch_${suffix}`,
  foreignUser: `user_foreign_${suffix}`,
  foreignStaff: `staff_foreign_${suffix}`,
  foreignBranch: `branch_foreign_${suffix}`,
  inventoryDevice: `device_inventory_${suffix}`,
  recipeDevice: `device_recipe_${suffix}`,
  reversalOrder: `order_reversal_${suffix}`,
  reversalOrderItem: `order_item_reversal_${suffix}`,
  recipeOrder: `order_recipe_${suffix}`,
};

type InventoryCaller = ReturnType<
  (typeof import('@/server/routers/restaurant-inventory'))['restaurantInventoryRouter']['createCaller']
>;
type OrdersCaller = ReturnType<
  (typeof import('@/server/routers/restaurant-orders'))['restaurantOrdersRouter']['createCaller']
>;
type PurchasingCaller = ReturnType<
  (typeof import('@/server/routers/restaurant-purchasing'))['restaurantPurchasingRouter']['createCaller']
>;
type Deps = {
  createTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['createTenantDb'];
  withTenantDb: (typeof import('@/lib/tenancy/scoped-db'))['withTenantDb'];
  withPlatformDb: (typeof import('@/lib/tenancy/scoped-db'))['withPlatformDb'];
  completeStockTransfer: (typeof import('@/lib/restaurant/inventory'))['completeStockTransfer'];
  cutBills: (typeof import('@/lib/restaurant/bills'))['cutBills'];
  settleBill: (typeof import('@/lib/restaurant/bills'))['settleBill'];
};

let deps: Deps;
let api: { inventory: InventoryCaller; orders: OrdersCaller; purchasing: PurchasingCaller };
let inventoryCallerFor: (userId: string) => InventoryCaller;
let purchasingCallerFor: (userId: string) => PurchasingCaller;

function failAfterFirstMovementCreate(tx: ScopedDb): ScopedDb {
  const movements = new Proxy(tx.restaurantStockMovement, {
    get(target, key, receiver) {
      if (key !== 'create') return Reflect.get(target, key, receiver);
      return async (args: Prisma.RestaurantStockMovementCreateArgs) => {
        await target.create(args);
        throw new Error('forced failure after first movement create');
      };
    },
  });
  const wrapped = new Proxy(tx, {
    get(target, key, receiver) {
      if (key === '$transaction') {
        return (run: (inner: ScopedDb) => Promise<unknown>) => run(wrapped);
      }
      if (key === 'restaurantStockMovement') return movements;
      return Reflect.get(target, key, receiver);
    },
  });
  return wrapped;
}

beforeAll(async () => {
  if (!TEST_DATABASE_URL) return;
  const [scopedDb, inventoryDomain, billsDomain, inventoryRouter, ordersRouter, purchasingRouter] =
    await Promise.all([
      import('@/lib/tenancy/scoped-db'),
      import('@/lib/restaurant/inventory'),
      import('@/lib/restaurant/bills'),
      import('@/server/routers/restaurant-inventory'),
      import('@/server/routers/restaurant-orders'),
      import('@/server/routers/restaurant-purchasing'),
    ]);
  deps = {
    createTenantDb: scopedDb.createTenantDb,
    withTenantDb: scopedDb.withTenantDb,
    withPlatformDb: scopedDb.withPlatformDb,
    completeStockTransfer: inventoryDomain.completeStockTransfer,
    cutBills: billsDomain.cutBills,
    settleBill: billsDomain.settleBill,
  };

  await deps.withPlatformDb(async (tx) => {
    await tx.organization.create({
      data: {
        id: orgId,
        slug: `wha74-${suffix}`,
        legalName: 'WHA-74 Acceptance',
        displayName: 'WHA-74 Acceptance',
        status: 'ACTIVE',
      },
    });
    await tx.organization.create({
      data: {
        id: foreignOrgId,
        slug: `wha918-foreign-${suffix}`,
        legalName: 'WHA-918 Foreign Tenant',
        displayName: 'WHA-918 Foreign Tenant',
        status: 'ACTIVE',
      },
    });
    await seedDepartments(tx, [orgId, foreignOrgId], ['LEADERSHIP']);
  });
  await deps.withTenantDb(orgId, async (tx) => {
    await tx.restaurantBranch.createMany({
      data: [
        { id: ids.inventoryBranch, name: 'Inventory Branch', timezone: 'UTC' },
        { id: ids.recipeBranch, name: 'Recipe Branch', timezone: 'UTC' },
      ],
    });
    await tx.restaurantUnit.createMany({
      data: [
        { id: ids.each, name: 'Each', abbreviation: 'ea' },
        { id: ids.case, name: 'Case', abbreviation: 'case' },
        { id: ids.gram, name: 'Gram', abbreviation: 'g' },
        { id: ids.kilogram, name: 'Kilogram', abbreviation: 'kg' },
        { id: ids.portion, name: 'Portion', abbreviation: 'portion' },
      ],
    });
    await tx.restaurantUnitConversion.createMany({
      data: [
        { fromUnitId: ids.case, toUnitId: ids.each, factor: '12' },
        { fromUnitId: ids.kilogram, toUnitId: ids.gram, factor: '1000' },
      ],
    });
    await tx.restaurantIngredient.createMany({
      data: [
        { id: ids.receiptIngredient, name: 'Receipt ingredient', baseUnitId: ids.each },
        { id: ids.countIngredient, name: 'Count ingredient', baseUnitId: ids.each },
        { id: ids.transferIngredient, name: 'Transfer ingredient', baseUnitId: ids.each },
        { id: ids.negativeIngredient, name: 'Negative ingredient', baseUnitId: ids.each },
        { id: ids.recipeIngredient, name: 'Recipe ingredient', baseUnitId: ids.gram },
      ],
    });
    await tx.restaurantStockItem.createMany({
      data: [
        {
          id: ids.receiptItem,
          ingredientId: ids.receiptIngredient,
          canonicalUnitId: ids.each,
        },
        { id: ids.countItem, ingredientId: ids.countIngredient, canonicalUnitId: ids.each },
        {
          id: ids.transferItem,
          ingredientId: ids.transferIngredient,
          canonicalUnitId: ids.each,
        },
        {
          id: ids.negativeItem,
          ingredientId: ids.negativeIngredient,
          canonicalUnitId: ids.each,
        },
        { id: ids.recipeItem, ingredientId: ids.recipeIngredient, canonicalUnitId: ids.gram },
      ],
    });
    await tx.restaurantStockLocation.createMany({
      data: [
        { id: ids.receiptLocation, branchId: ids.inventoryBranch, name: 'Receiving' },
        { id: ids.countLocation, branchId: ids.inventoryBranch, name: 'Counting' },
        { id: ids.transferSource, branchId: ids.inventoryBranch, name: 'Transfer source' },
        {
          id: ids.transferDestination,
          branchId: ids.inventoryBranch,
          name: 'Transfer destination',
        },
        { id: ids.negativeLocation, branchId: ids.inventoryBranch, name: 'Negative stock' },
        { id: ids.recipeLocation, branchId: ids.recipeBranch, name: 'Recipe stock' },
      ],
    });
    await tx.restaurantProduct.create({ data: { id: ids.product, name: 'Recipe product' } });
    await tx.restaurantRecipe.create({
      data: { id: ids.recipe, productId: ids.product, name: 'Yield recipe' },
    });
    await tx.restaurantRecipeVersion.create({
      data: {
        id: ids.recipeVersion,
        recipeId: ids.recipe,
        versionNumber: 1,
        status: 'ACTIVE',
        yieldQuantity: '4',
        yieldUnitId: ids.portion,
        portionCount: 4,
        activatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    await tx.restaurantRecipeLine.create({
      data: {
        recipeVersionId: ids.recipeVersion,
        ingredientId: ids.recipeIngredient,
        quantity: '2',
        unitId: ids.kilogram,
      },
    });
    await tx.user.create({
      data: {
        id: ids.user,
        name: 'Inventory Administrator',
        email: `inventory_admin_${suffix}@test.local`,
        department: 'LEADERSHIP',
        title: 'Administrator',
        role: 'ADMIN',
      },
    });
    await tx.restaurantStaffProfile.create({
      data: {
        id: ids.staff,
        userId: ids.user,
        displayName: 'Acceptance Staff',
        primaryBranchId: ids.inventoryBranch,
        status: 'ACTIVE',
      },
    });
    for (const [userId, staffId, status, primaryBranchId] of [
      [ids.inactiveUser, ids.inactiveStaff, 'SUSPENDED', ids.inventoryBranch],
      [ids.crossBranchUser, ids.crossBranchStaff, 'ACTIVE', ids.recipeBranch],
    ] as const) {
      await tx.user.create({
        data: {
          id: userId,
          name: userId,
          email: `${userId}@test.local`,
          department: 'LEADERSHIP',
          title: 'Inventory test user',
        },
      });
      await tx.restaurantStaffProfile.create({
        data: { id: staffId, userId, displayName: staffId, primaryBranchId, status },
      });
    }
    await tx.restaurantRegisteredDevice.createMany({
      data: [
        {
          id: ids.inventoryDevice,
          branchId: ids.inventoryBranch,
          name: 'Inventory device',
          deviceSecretHash: `inventory_secret_${suffix}`,
        },
        {
          id: ids.recipeDevice,
          branchId: ids.recipeBranch,
          name: 'Recipe device',
          deviceSecretHash: `recipe_secret_${suffix}`,
        },
      ],
    });
    await tx.restaurantOrder.create({
      data: {
        id: ids.reversalOrder,
        branchId: ids.inventoryBranch,
        orderNumber: 1,
        businessDate: new Date('2026-08-19T00:00:00.000Z'),
        status: 'CLOSED',
        channel: 'DINE_IN',
        staffProfileId: ids.staff,
        deviceId: ids.inventoryDevice,
        closedAt: new Date('2026-08-19T12:00:00.000Z'),
        items: {
          create: {
            id: ids.reversalOrderItem,
            productId: ids.product,
            name: 'Closed item',
            unitPrice: '0',
            quantity: 1,
            status: 'SERVED',
          },
        },
      },
    });
  });
  await deps.withTenantDb(foreignOrgId, async (tx) => {
    await tx.restaurantBranch.create({
      data: { id: ids.foreignBranch, name: 'Foreign Branch', timezone: 'UTC' },
    });
    await tx.user.create({
      data: {
        id: ids.foreignUser,
        name: 'Foreign User',
        email: `foreign_${suffix}@test.local`,
        department: 'LEADERSHIP',
        title: 'Foreign User',
      },
    });
    await tx.restaurantStaffProfile.create({
      data: {
        id: ids.foreignStaff,
        userId: ids.foreignUser,
        displayName: 'Foreign Staff',
        primaryBranchId: ids.foreignBranch,
      },
    });
  });

  inventoryCallerFor = (userId) =>
    inventoryRouter.restaurantInventoryRouter.createCaller({
      db: scopedDb.createTenantDb(orgId),
      entitlements: {
        organizationId: orgId,
        enabledModules: ['restaurant-pos'],
        activeSeats: 1,
        seatLimit: 50,
        modules: [],
      },
      session: {
        expires: 'later',
        user: { id: userId, role: 'ADMIN', status: 'ACTIVE', organizationId: orgId },
      },
      organization: null,
      support: null,
      requestMeta: { ip: null, userAgent: null },
      audit: { detail: {} },
    } as unknown as TRPCContext);
  purchasingCallerFor = (userId) =>
    purchasingRouter.restaurantPurchasingRouter.createCaller({
      db: scopedDb.createTenantDb(orgId),
      entitlements: {
        organizationId: orgId,
        enabledModules: ['restaurant-pos'],
        activeSeats: 1,
        seatLimit: 50,
        modules: [],
      },
      session: {
        expires: 'later',
        user: { id: userId, role: 'ADMIN', status: 'ACTIVE', organizationId: orgId },
      },
      organization: null,
      support: null,
      requestMeta: { ip: null, userAgent: null },
      audit: { detail: {} },
    } as unknown as TRPCContext);
  const context = {
    db: scopedDb.createTenantDb(orgId),
    entitlements: {
      organizationId: orgId,
      enabledModules: ['restaurant-pos'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
    },
    session: {
      expires: 'later',
      user: { id: ids.user, role: 'ADMIN', status: 'ACTIVE', organizationId: orgId },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  api = {
    inventory: inventoryCallerFor(ids.user),
    orders: ordersRouter.restaurantOrdersRouter.createCaller(context),
    purchasing: purchasingCallerFor(ids.user),
  };
}, 60_000);

afterAll(async () => {
  if (!TEST_DATABASE_URL || !deps) return;
  // This flow creates append-only money idempotency evidence. Its database
  // trigger rejects DELETE (including FK cascades), so the randomly-suffixed
  // primary fixture remains in the suite's required disposable test database.
  await deps.withPlatformDb((tx) => tx.organization.deleteMany({ where: { id: foreignOrgId } }));
}, 60_000);

describeIfDatabase('WHA-74 M6 inventory/purchasing acceptance (real PostgreSQL + API)', () => {
  it.each([
    { exact: false, rollback: false },
    { exact: true, rollback: false },
    { exact: false, rollback: true },
    { exact: true, rollback: true },
  ])(
    'consumes uncommitted variant-order recipes (exact=$exact, rollback=$rollback)',
    async ({ exact, rollback }) => {
      const { closeOrder } = await import('@/lib/restaurant/orders');
      const key = `recipe_tx_${exact}_${rollback}_${suffix}`;
      const transaction = deps.withTenantDb(orgId, async (tx) => {
        const product = await tx.restaurantProduct.create({ data: { id: key, name: key } });
        const variant = await tx.restaurantProductVariant.create({
          data: { productId: product.id, name: 'Regular' },
        });
        const ingredient = await tx.restaurantIngredient.create({
          data: { name: key, baseUnitId: ids.gram },
        });
        const stockItem = await tx.restaurantStockItem.create({
          data: { ingredientId: ingredient.id, canonicalUnitId: ids.gram },
        });
        for (const variantId of exact ? [null, variant.id] : [null]) {
          const recipe = await tx.restaurantRecipe.create({
            data: { productId: product.id, variantId, name: key },
          });
          const version = await tx.restaurantRecipeVersion.create({
            data: {
              recipeId: recipe.id,
              versionNumber: 1,
              status: 'ACTIVE',
              yieldQuantity: '4',
              yieldUnitId: ids.portion,
              portionCount: 4,
            },
          });
          await tx.restaurantRecipeLine.create({
            data: {
              recipeVersionId: version.id,
              ingredientId: ingredient.id,
              quantity: variantId ? '3' : '2',
              unitId: ids.kilogram,
            },
          });
        }
        const order = await tx.restaurantOrder.create({
          data: {
            id: key,
            branchId: ids.recipeBranch,
            orderNumber: 100 + Number(exact) + 2 * Number(rollback),
            businessDate: new Date('2026-08-19T00:00:00.000Z'),
            status: 'PAYMENT_PENDING',
            channel: 'DINE_IN',
            staffProfileId: ids.staff,
            deviceId: ids.recipeDevice,
            items: {
              create: {
                productId: product.id,
                variantId: variant.id,
                name: key,
                unitPrice: '0',
                quantity: 2,
                status: 'SERVED',
              },
            },
          },
        });
        const actor = {
          staffProfileId: ids.staff,
          deviceId: ids.recipeDevice,
          idempotencyKey: key,
        };
        const cut = await deps.cutBills(tx, {
          orderId: order.id,
          branchId: ids.recipeBranch,
          split: { kind: 'NONE' },
          actor: { ...actor, idempotencyKey: `${key}_bill` },
        });
        const now = new Date('2026-08-19T13:00:00.000Z');
        await deps.settleBill(tx, { billId: cut.billIds[0]!, ...actor, at: now });
        await closeOrder(rollback ? failAfterFirstMovementCreate(tx) : tx, {
          orderId: order.id,
          actor,
          now,
        });
        const movements = await tx.restaurantStockMovement.findMany({
          where: { orderId: order.id },
          include: { location: true, order: true },
        });
        expect(movements).toHaveLength(1);
        expect(movements[0]).toMatchObject({
          organizationId: orgId,
          stockItemId: stockItem.id,
          locationId: ids.recipeLocation,
          orderId: order.id,
          reason: 'RECIPE_CONSUMPTION',
          occurredAt: now,
          location: { branchId: ids.recipeBranch },
          order: { branchId: ids.recipeBranch, status: 'CLOSED', closedAt: now },
        });
        expect(movements[0]!.quantity.toString()).toBe(exact ? '-1500' : '-1000');
      });
      if (rollback) {
        await expect(transaction).rejects.toThrow('forced failure after first movement create');
      } else {
        await transaction;
      }
      await deps.withTenantDb(orgId, async (tx) => {
        expect(await tx.restaurantStockMovement.count({ where: { orderId: key } })).toBe(
          rollback ? 0 : 1
        );
        expect(await tx.restaurantOrder.count({ where: { id: key } })).toBe(rollback ? 0 : 1);
        expect(await tx.restaurantProduct.count({ where: { id: key } })).toBe(rollback ? 0 : 1);
      });
    }
  );

  it('runs through a LOGIN role that is neither SUPERUSER nor BYPASSRLS', async () => {
    const role = await deps.withTenantDb(
      orgId,
      (tx) =>
        tx.$queryRaw<Array<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean }>>`
        SELECT rolcanlogin, rolsuper, rolbypassrls
        FROM pg_catalog.pg_roles
        WHERE rolname = current_user
      `
    );
    expect(role).toEqual([{ rolcanlogin: true, rolsuper: false, rolbypassrls: false }]);
  });

  it('rejects cross-branch purchasing locations before creating or receiving stock', async () => {
    const supplier = await api.purchasing.createSupplier({ name: `Branch Bound ${suffix}` });
    const order = await api.purchasing.createPurchaseOrder({
      supplierId: supplier.id,
      branchId: ids.inventoryBranch,
      locationId: ids.receiptLocation,
      lines: [
        {
          stockItemId: ids.receiptItem,
          orderedQuantity: '1',
          unitId: ids.each,
          unitCost: '1',
        },
      ],
    });
    await api.purchasing.submitPurchaseOrder({ purchaseOrderId: order.id });
    await api.purchasing.approvePurchaseOrder({ purchaseOrderId: order.id });
    const before = await deps.withTenantDb(orgId, async (tx) => ({
      orders: await tx.restaurantPurchaseOrder.count(),
      receipts: await tx.restaurantPurchaseReceipt.count(),
      receiptLines: await tx.restaurantPurchaseReceiptLine.count(),
      movements: await tx.restaurantStockMovement.count(),
      idempotencyKeys: await tx.restaurantInventoryIdempotencyKey.count(),
      audits: await tx.auditLog.count(),
    }));
    mocks.annotateAudit.mockClear();

    await expect(
      api.purchasing.createPurchaseOrder({
        supplierId: supplier.id,
        branchId: ids.inventoryBranch,
        locationId: ids.recipeLocation,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      api.purchasing.receivePurchaseOrder({
        purchaseOrderId: order.id,
        locationId: ids.recipeLocation,
        idempotencyKey: `cross_branch_receipt_${suffix}`,
        lines: [{ purchaseOrderLineId: order.lines[0]!.id, receivedQuantity: '1' }],
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const after = await deps.withTenantDb(orgId, async (tx) => ({
      orders: await tx.restaurantPurchaseOrder.count(),
      receipts: await tx.restaurantPurchaseReceipt.count(),
      receiptLines: await tx.restaurantPurchaseReceiptLine.count(),
      movements: await tx.restaurantStockMovement.count(),
      idempotencyKeys: await tx.restaurantInventoryIdempotencyKey.count(),
      audits: await tx.auditLog.count(),
    }));
    expect(after).toEqual(before);
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });

  it('denies invalid staff mappings across purchasing entry points without partial rows', async () => {
    const supplier = await api.purchasing.createSupplier({ name: `Denied Mapping ${suffix}` });
    const order = await api.purchasing.createPurchaseOrder({
      supplierId: supplier.id,
      branchId: ids.inventoryBranch,
      locationId: ids.receiptLocation,
      lines: [
        {
          stockItemId: ids.receiptItem,
          orderedQuantity: '1',
          unitId: ids.each,
          unitCost: '1',
        },
      ],
    });
    await api.purchasing.submitPurchaseOrder({ purchaseOrderId: order.id });
    const snapshot = () =>
      deps.withTenantDb(orgId, async (tx) => ({
        orders: await tx.restaurantPurchaseOrder.count(),
        orderLines: await tx.restaurantPurchaseOrderLine.count(),
        receipts: await tx.restaurantPurchaseReceipt.count(),
        receiptLines: await tx.restaurantPurchaseReceiptLine.count(),
        batches: await tx.restaurantStockBatch.count(),
        movements: await tx.restaurantStockMovement.count(),
        idempotencyKeys: await tx.restaurantInventoryIdempotencyKey.count(),
        audits: await tx.auditLog.count(),
      }));
    const before = await snapshot();
    mocks.annotateAudit.mockClear();
    mocks.can.mockImplementation(async (_subject, action) => action !== 'restaurant:configure');

    try {
      for (const userId of [
        `user_absent_${suffix}`,
        ids.inactiveUser,
        ids.foreignUser,
        ids.crossBranchUser,
      ]) {
        const denied = purchasingCallerFor(userId);
        await expect(
          denied.createPurchaseOrder({
            supplierId: supplier.id,
            branchId: ids.inventoryBranch,
            locationId: ids.receiptLocation,
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        // Entry points addressed by purchase-order id hide the record's existence
        // from a caller without access to its branch, so they deny as NOT_FOUND.
        await expect(
          denied.approvePurchaseOrder({ purchaseOrderId: order.id })
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(
          denied.receivePurchaseOrder({
            purchaseOrderId: order.id,
            idempotencyKey: `denied_receipt_${userId}`,
            lines: [{ purchaseOrderLineId: order.lines[0]!.id, receivedQuantity: '1' }],
          })
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(
          denied.createSupplierReturn({
            locationId: ids.receiptLocation,
            idempotencyKey: `denied_return_${userId}`,
            lines: [{ stockItemId: ids.receiptItem, quantity: '1', unitId: ids.each }],
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
    } finally {
      mocks.can.mockResolvedValue(true);
    }

    expect(await snapshot()).toEqual(before);
    expect(mocks.annotateAudit).not.toHaveBeenCalled();
  });

  it('receives converted PO cases idempotently and derives exact read-time WAC', async () => {
    const supplier = await api.purchasing.createSupplier({ name: 'Case Supplier' });
    const created = await api.purchasing.createPurchaseOrder({
      supplierId: supplier.id,
      branchId: ids.inventoryBranch,
      locationId: ids.receiptLocation,
      reference: 'PO-cases',
      lines: [
        {
          stockItemId: ids.receiptItem,
          orderedQuantity: '2',
          unitId: ids.case,
          unitCost: '120',
        },
      ],
    });
    expect(created.lines[0]).toMatchObject({
      orderedQuantity: '2',
      orderedQuantityCanonical: '24',
      receivedQuantityCanonical: '0',
    });
    await api.purchasing.submitPurchaseOrder({ purchaseOrderId: created.id });
    await api.purchasing.approvePurchaseOrder({ purchaseOrderId: created.id });
    expect(
      await deps.withTenantDb(orgId, (tx) =>
        tx.restaurantPurchaseOrder.findUniqueOrThrow({
          where: { id: created.id },
          select: { createdByStaffProfileId: true, approvedByStaffProfileId: true },
        })
      )
    ).toEqual({
      createdByStaffProfileId: ids.staff,
      approvedByStaffProfileId: ids.staff,
    });

    const firstInput = {
      purchaseOrderId: created.id,
      idempotencyKey: `receipt_first_${suffix}`,
      lines: [
        {
          purchaseOrderLineId: created.lines[0]!.id,
          receivedQuantity: '1',
          unitId: ids.case,
          unitCost: '120',
          discrepancies: [
            {
              kind: 'SHORTAGE' as const,
              expectedQuantity: '2',
              receivedQuantity: '1',
              note: 'One of two cases received',
            },
          ],
        },
      ],
    };
    const first = await api.purchasing.receivePurchaseOrder(firstInput);
    expect(first.purchaseOrderStatus).toBe('PARTIALLY_RECEIVED');
    expect(first.replayed).toBe(false);
    expect(first.movements).toHaveLength(1);
    expect(first.movements[0]).toMatchObject({ quantity: '12', unitCost: '10' });
    expect(
      await deps.withTenantDb(orgId, (tx) =>
        tx.restaurantPurchaseReceipt.findUniqueOrThrow({
          where: { id: first.receiptId },
          select: { staffProfileId: true, deviceId: true },
        })
      )
    ).toEqual({ staffProfileId: ids.staff, deviceId: null });

    const replay = await api.purchasing.receivePurchaseOrder(firstInput);
    expect(replay).toEqual({ ...first, replayed: true });
    const afterReplay = await api.inventory.listStockMovements({
      stockItemId: ids.receiptItem,
      locationId: ids.receiptLocation,
    });
    expect(afterReplay.items).toHaveLength(1);
    expect(
      await deps.withTenantDb(orgId, (tx) =>
        tx.restaurantPurchaseReceipt.count({ where: { purchaseOrderId: created.id } })
      )
    ).toBe(1);

    const second = await api.purchasing.receivePurchaseOrder({
      purchaseOrderId: created.id,
      idempotencyKey: `receipt_second_${suffix}`,
      lines: [
        {
          purchaseOrderLineId: created.lines[0]!.id,
          receivedQuantity: '1',
          unitId: ids.case,
          unitCost: '240',
        },
      ],
    });
    expect(second.purchaseOrderStatus).toBe('RECEIVED');
    expect(second.movements).toHaveLength(1);
    expect(second.movements[0]).toMatchObject({ quantity: '12', unitCost: '20' });

    const order = await api.purchasing.getPurchaseOrder({ purchaseOrderId: created.id });
    expect(order.status).toBe('RECEIVED');
    expect(order.lines[0]).toMatchObject({
      orderedQuantityCanonical: '24',
      receivedQuantityCanonical: '24',
      fullyReceived: true,
    });
    const receipt = await api.purchasing.getReceipt({ receiptId: first.receiptId });
    expect(receipt.lines[0]).toMatchObject({ receivedQuantity: '1', unitCost: '120' });
    expect(receipt.discrepancies).toEqual([
      expect.objectContaining({
        kind: 'SHORTAGE',
        expectedQuantity: '2',
        receivedQuantity: '1',
        note: 'One of two cases received',
      }),
    ]);

    expect(
      await api.inventory.listStockOnHand({
        stockItemId: ids.receiptItem,
        locationId: ids.receiptLocation,
      })
    ).toEqual([
      expect.objectContaining({
        stockItemId: ids.receiptItem,
        locationId: ids.receiptLocation,
        onHand: '24',
        weightedAverageCost: '15',
      }),
    ]);

    const returned = await api.purchasing.createSupplierReturn({
      locationId: ids.receiptLocation,
      idempotencyKey: `return_${suffix}`,
      lines: [{ stockItemId: ids.receiptItem, quantity: '1', unitId: ids.each }],
    });
    expect(returned.movements).toHaveLength(1);
    expect(
      await deps.withTenantDb(orgId, (tx) =>
        tx.restaurantStockMovement.findUniqueOrThrow({
          where: { id: returned.movements[0]!.id },
          select: { staffProfileId: true, deviceId: true, reason: true },
        })
      )
    ).toEqual({ staffProfileId: ids.staff, deviceId: null, reason: 'SUPPLIER_RETURN' });
  });

  it('freezes zero count snapshot, posts +7, and triggers threshold 8', async () => {
    const rule = await api.inventory.createLowStockRule({
      stockItemId: ids.countItem,
      locationId: ids.countLocation,
      threshold: '8',
    });
    expect(rule.threshold).toBe('8');
    const count = await api.inventory.createStockCount({
      locationId: ids.countLocation,
      reference: 'count-seven',
    });
    expect(
      await deps.withTenantDb(orgId, (tx) =>
        tx.restaurantStockCount.findUniqueOrThrow({
          where: { id: count.id },
          select: { staffProfileId: true },
        })
      )
    ).toEqual({ staffProfileId: ids.staff });
    await api.inventory.addStockCountLine({
      stockCountId: count.id,
      stockItemId: ids.countItem,
      countedQuantity: '7',
    });
    await api.inventory.submitStockCount({ stockCountId: count.id });

    const line = await deps.withTenantDb(orgId, (tx) =>
      tx.restaurantStockCountLine.findFirstOrThrow({
        where: { stockCountId: count.id, stockItemId: ids.countItem },
        select: { countedQuantity: true, snapshotQuantity: true, varianceQuantity: true },
      })
    );
    expect({
      counted: line.countedQuantity.toString(),
      snapshot: line.snapshotQuantity.toString(),
      variance: line.varianceQuantity.toString(),
    }).toEqual({ counted: '7', snapshot: '0', variance: '7' });

    expect(await api.inventory.postStockCount({ stockCountId: count.id })).toEqual({
      stockCountId: count.id,
      movementsPosted: 1,
    });
    const movements = await api.inventory.listStockMovements({
      stockItemId: ids.countItem,
      locationId: ids.countLocation,
    });
    expect(movements.items).toEqual([
      expect.objectContaining({
        reason: 'PHYSICAL_COUNT_ADJUSTMENT',
        quantity: '7',
        countId: count.id,
      }),
    ]);
    expect(
      await api.inventory.listStockOnHand({
        stockItemId: ids.countItem,
        locationId: ids.countLocation,
      })
    ).toEqual([expect.objectContaining({ onHand: '7', isNegative: false })]);
    expect(
      await api.inventory.evaluateLowStockRules({
        stockItemId: ids.countItem,
        locationId: ids.countLocation,
      })
    ).toEqual([expect.objectContaining({ threshold: '8', onHand: '7', isTriggered: true })]);
  });

  it('rolls back a transfer fault, then posts the paired API completion atomically', async () => {
    const transfer = await api.inventory.createStockTransfer({
      sourceLocationId: ids.transferSource,
      destinationLocationId: ids.transferDestination,
      reference: 'atomic-four',
    });
    expect(
      await deps.withTenantDb(orgId, (tx) =>
        tx.restaurantStockTransfer.findUniqueOrThrow({
          where: { id: transfer.id },
          select: { staffProfileId: true },
        })
      )
    ).toEqual({ staffProfileId: ids.staff });
    await api.inventory.addStockTransferLine({
      stockTransferId: transfer.id,
      stockItemId: ids.transferItem,
      quantity: '4',
    });

    await expect(
      deps.withTenantDb(orgId, (tx) =>
        deps.completeStockTransfer(failAfterFirstMovementCreate(tx), {
          stockTransferId: transfer.id,
        })
      )
    ).rejects.toThrow('forced failure after first movement create');
    const rolledBack = await deps.withTenantDb(orgId, async (tx) => ({
      transfer: await tx.restaurantStockTransfer.findUniqueOrThrow({
        where: { id: transfer.id },
        select: { status: true },
      }),
      movements: await tx.restaurantStockMovement.count({ where: { transferId: transfer.id } }),
    }));
    expect(rolledBack).toEqual({ transfer: { status: 'DRAFT' }, movements: 0 });

    expect(await api.inventory.completeStockTransfer({ stockTransferId: transfer.id })).toEqual({
      stockTransferId: transfer.id,
      movementsPosted: 2,
    });
    const ledger = await api.inventory.listStockMovements({ stockItemId: ids.transferItem });
    const pair = ledger.items.filter((movement) => movement.transferId === transfer.id);
    expect(pair).toHaveLength(2);
    expect(
      pair
        .map(({ locationId, quantity }) => ({ locationId, quantity }))
        .sort((left, right) => left.locationId.localeCompare(right.locationId))
    ).toEqual(
      [
        { locationId: ids.transferSource, quantity: '-4' },
        { locationId: ids.transferDestination, quantity: '4' },
      ].sort((left, right) => left.locationId.localeCompare(right.locationId))
    );
    const transfers = await api.inventory.listStockTransfers({
      sourceLocationId: ids.transferSource,
      destinationLocationId: ids.transferDestination,
    });
    expect(transfers.items).toEqual([
      expect.objectContaining({ id: transfer.id, status: 'RECEIVED' }),
    ]);
  });

  it('allows negative stock and appends a backdated post-close reversal immutably', async () => {
    const wastageOccurredAt = new Date('2024-02-02T12:00:00.000Z');
    const wastage = await api.inventory.postWastage({
      stockItemId: ids.negativeItem,
      locationId: ids.negativeLocation,
      reason: 'WASTAGE',
      quantity: '2',
      occurredAt: wastageOccurredAt,
    });
    expect(wastage.quantity).toBe('-2');
    expect(
      await deps.withTenantDb(orgId, (tx) =>
        tx.restaurantStockMovement.findUniqueOrThrow({
          where: { id: wastage.id },
          select: { staffProfileId: true },
        })
      )
    ).toEqual({ staffProfileId: ids.staff });
    expect(
      await api.inventory.listStockOnHand({
        stockItemId: ids.negativeItem,
        locationId: ids.negativeLocation,
      })
    ).toEqual([expect.objectContaining({ onHand: '-2', isNegative: true })]);

    const before = await api.inventory.listStockMovements({
      stockItemId: ids.negativeItem,
      locationId: ids.negativeLocation,
    });
    expect(before.items).toHaveLength(1);
    const originalBytes = JSON.stringify(before.items[0]);
    const reversalOccurredAt = new Date('2024-01-01T12:00:00.000Z');
    const appendStarted = Date.now();
    const reversalResult = await api.inventory.postSaleReversal({
      stockItemId: ids.negativeItem,
      locationId: ids.negativeLocation,
      quantity: '2',
      orderId: ids.reversalOrder,
      occurredAt: reversalOccurredAt,
    });
    const appendFinished = Date.now();
    expect(reversalResult.quantity).toBe('2');
    expect(
      await deps.withTenantDb(orgId, (tx) =>
        tx.restaurantStockMovement.findUniqueOrThrow({
          where: { id: reversalResult.id },
          select: { staffProfileId: true },
        })
      )
    ).toEqual({ staffProfileId: ids.staff });

    const after = await api.inventory.listStockMovements({
      stockItemId: ids.negativeItem,
      locationId: ids.negativeLocation,
    });
    expect(after.items).toHaveLength(before.items.length + 1);
    expect(JSON.stringify(after.items.find((movement) => movement.id === wastage.id))).toBe(
      originalBytes
    );
    const reversal = after.items.find((movement) => movement.id === reversalResult.id)!;
    expect(reversal).toMatchObject({
      reason: 'SALE_REVERSAL',
      quantity: '2',
      occurredAt: reversalOccurredAt,
      orderId: ids.reversalOrder,
    });
    expect(reversal.recordedAt.getTime()).toBeGreaterThanOrEqual(appendStarted);
    expect(reversal.recordedAt.getTime()).toBeLessThanOrEqual(appendFinished);
    expect(reversal.occurredAt.getTime()).toBeLessThan(wastageOccurredAt.getTime());
  });

  it('denies absent, inactive, cross-tenant, and cross-branch mappings before inventory writes', async () => {
    mocks.can.mockImplementation(async (_subject, action) => action !== 'restaurant:configure');
    const before = await deps.withTenantDb(orgId, async (tx) => ({
      counts: await tx.restaurantStockCount.count(),
      transfers: await tx.restaurantStockTransfer.count(),
      movements: await tx.restaurantStockMovement.count(),
    }));

    try {
      for (const userId of [
        `user_absent_${suffix}`,
        ids.inactiveUser,
        ids.foreignUser,
        ids.crossBranchUser,
      ]) {
        const denied = inventoryCallerFor(userId);
        await expect(
          denied.createStockCount({ locationId: ids.countLocation })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(
          denied.createStockTransfer({
            sourceLocationId: ids.transferSource,
            destinationLocationId: ids.transferDestination,
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(
          denied.postWastage({
            stockItemId: ids.negativeItem,
            locationId: ids.negativeLocation,
            reason: 'WASTAGE',
            quantity: '1',
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(
          denied.postSaleReversal({
            stockItemId: ids.negativeItem,
            locationId: ids.negativeLocation,
            quantity: '1',
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
    } finally {
      mocks.can.mockResolvedValue(true);
    }

    const after = await deps.withTenantDb(orgId, async (tx) => ({
      counts: await tx.restaurantStockCount.count(),
      transfers: await tx.restaurantStockTransfer.count(),
      movements: await tx.restaurantStockMovement.count(),
    }));
    expect(after).toEqual(before);
  });

  it('binds recipe yield, kg-to-g conversion, and C6 void dispositions', async () => {
    const itemCount = await deps.withTenantDb(orgId, async (tx) => {
      await tx.restaurantOrder.create({
        data: {
          id: ids.recipeOrder,
          branchId: ids.recipeBranch,
          orderNumber: 1,
          businessDate: new Date('2026-08-19T00:00:00.000Z'),
          status: 'PAYMENT_PENDING',
          channel: 'DINE_IN',
          staffProfileId: ids.staff,
          deviceId: ids.recipeDevice,
          items: {
            create: [
              {
                productId: ids.product,
                name: 'Normal two portions',
                unitPrice: '0',
                quantity: 2,
                status: 'SERVED',
              },
              {
                productId: ids.product,
                name: 'Waste one portion',
                unitPrice: '0',
                quantity: 1,
                status: 'VOIDED',
                voidedPostPrep: true,
                wastageDisposition: 'WASTE',
              },
              {
                productId: ids.product,
                name: 'Restock one portion',
                unitPrice: '0',
                quantity: 1,
                status: 'VOIDED',
                voidedPostPrep: true,
                wastageDisposition: 'RESTOCK',
              },
              {
                productId: ids.product,
                name: 'No movement one portion',
                unitPrice: '0',
                quantity: 1,
                status: 'VOIDED',
                voidedPostPrep: true,
                wastageDisposition: 'NONE',
              },
            ],
          },
        },
      });
      return tx.restaurantOrderItem.count({ where: { orderId: ids.recipeOrder } });
    });
    expect(itemCount).toBe(4);

    const cut = await deps.cutBills(deps.createTenantDb(orgId), {
      orderId: ids.recipeOrder,
      branchId: ids.recipeBranch,
      split: { kind: 'NONE' },
      actor: {
        staffProfileId: ids.staff,
        deviceId: ids.recipeDevice,
        idempotencyKey: `recipe_bill_${suffix}`,
      },
    });
    await deps.withTenantDb(orgId, (tx) =>
      deps.settleBill(tx, {
        billId: cut.billIds[0]!,
        staffProfileId: ids.staff,
        deviceId: ids.recipeDevice,
        at: new Date('2026-08-19T13:00:00.000Z'),
      })
    );
    expect(
      await api.orders.close({
        orderId: ids.recipeOrder,
        actor: {
          staffProfileId: ids.staff,
          deviceId: ids.recipeDevice,
          idempotencyKey: `recipe_close_${suffix}`,
        },
      })
    ).toEqual({ orderId: ids.recipeOrder, replayed: false });

    const ledger = await api.inventory.listStockMovements({
      stockItemId: ids.recipeItem,
      locationId: ids.recipeLocation,
    });
    const orderMovements = ledger.items.filter((movement) => movement.orderId === ids.recipeOrder);
    expect(orderMovements).toHaveLength(2);
    expect(orderMovements.map((movement) => movement.reason).sort()).toEqual([
      'RECIPE_CONSUMPTION',
      'WASTAGE',
    ]);
    expect(
      Object.fromEntries(
        orderMovements.map((movement) => [movement.reason, movement.quantity] as const)
      )
    ).toEqual({ RECIPE_CONSUMPTION: '-1000', WASTAGE: '-500' });
  });
});
