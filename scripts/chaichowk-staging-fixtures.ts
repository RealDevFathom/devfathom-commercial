import type { Prisma } from '../src/generated/prisma/client';
import type { ScopedDb } from '../src/lib/tenancy/scoped-db';
import { requireSeed, type SeedTarget } from './seed-chaichowk-staging';

export const GROUPS = [
  { key: 'catalog', modules: ['restaurant-menu'], capabilities: ['menu:read', 'menu:write'] },
  { key: 'floor', modules: ['restaurant-pos'], capabilities: ['floor:manage'] },
  {
    key: 'inventory',
    modules: ['restaurant-menu', 'restaurant-inventory'],
    capabilities: ['menu:write', 'inventory:read', 'inventory:adjust'],
  },
  {
    key: 'purchasing',
    modules: ['restaurant-menu', 'restaurant-inventory', 'restaurant-purchasing'],
    capabilities: [
      'menu:write',
      'inventory:read',
      'inventory:adjust',
      'purchasing:create',
      'purchasing:approve',
    ],
  },
  {
    key: 'orders',
    modules: ['restaurant-menu', 'restaurant-pos'],
    capabilities: ['menu:write', 'orders:read', 'orders:manage'],
  },
  { key: 'workforce', modules: ['restaurant-core'], capabilities: ['staff:manage'] },
  {
    key: 'customers',
    modules: ['restaurant-loyalty'],
    capabilities: ['customers:read', 'customers:manage'],
  },
  {
    key: 'catering',
    modules: ['restaurant-menu', 'restaurant-core'],
    capabilities: ['menu:write', 'catering:read', 'catering:manage'],
  },
  { key: 'sop', modules: ['restaurant-sop'], capabilities: ['sop:manage'] },
] as const;

export const ALWAYS_GATED = [
  'settlements/payments/refunds/financial history/insight projections: no approved tax configuration or financial scenarios in v1; no fabricated approvals',
  'loyalty accrual/redemption: requires settled-order/program scenarios; customers only',
  'SOP completed/verified outcomes and attendance: no fabricated completion or clock-in evidence; templates and scheduled shifts only',
  'Catering lifecycle/consumption/delivery/deposits: draft planning only; console hardcodes USD despite PKR',
  'devices/printers/email/webhooks/AI/payment integrations: disabled; no hardware or external success claimed',
  'Pharmacy: separate workspace/account decision required; no provisioning',
  'absent owner: secure owner provisioning required before this existing-account package can run',
];

export const MODEL_TABLES = {
  restaurantStaffProfile: 'restaurant_staff_profiles',
  restaurantBrand: 'restaurant_brands',
  restaurantCategory: 'restaurant_categories',
  restaurantProduct: 'restaurant_products',
  restaurantModifierGroup: 'restaurant_modifier_groups',
  restaurantModifierOption: 'restaurant_modifier_options',
  restaurantProductModifierGroup: 'restaurant_product_modifier_groups',
  restaurantMenu: 'restaurant_menus',
  restaurantMenuSection: 'restaurant_menu_sections',
  restaurantMenuItem: 'restaurant_menu_items',
  restaurantPriceList: 'restaurant_price_lists',
  restaurantPriceListVersion: 'restaurant_price_list_versions',
  restaurantPriceListEntry: 'restaurant_price_list_entries',
  restaurantBranchMenuPublication: 'restaurant_branch_menu_publications',
  restaurantUnit: 'restaurant_units',
  restaurantIngredient: 'restaurant_ingredients',
  restaurantRecipe: 'restaurant_recipes',
  restaurantRecipeVersion: 'restaurant_recipe_versions',
  restaurantRecipeLine: 'restaurant_recipe_lines',
  restaurantFloor: 'restaurant_floors',
  restaurantTable: 'restaurant_tables',
  restaurantStockLocation: 'restaurant_stock_locations',
  restaurantStockItem: 'restaurant_stock_items',
  restaurantStockMovement: 'restaurant_stock_movements',
  restaurantSupplier: 'restaurant_suppliers',
  restaurantPurchaseOrder: 'restaurant_purchase_orders',
  restaurantPurchaseOrderLine: 'restaurant_purchase_order_lines',
  restaurantPurchaseReceipt: 'restaurant_purchase_receipts',
  restaurantPurchaseReceiptLine: 'restaurant_purchase_receipt_lines',
  restaurantInventoryIdempotencyKey: 'restaurant_inventory_idempotency_keys',
  restaurantCustomer: 'restaurant_customers',
  restaurantCateringOrder: 'restaurant_catering_orders',
  restaurantCateringOrderLine: 'restaurant_catering_order_lines',
  restaurantCateringExtraCost: 'restaurant_catering_extra_costs',
  restaurantShift: 'restaurant_shifts',
  restaurantSopTemplate: 'restaurant_sop_templates',
  restaurantSopTemplateVersion: 'restaurant_sop_template_versions',
  restaurantSopTemplateStep: 'restaurant_sop_template_steps',
  restaurantNotification: 'restaurant_notifications',
  restaurantRegisteredDevice: 'restaurant_registered_devices',
  restaurantKitchenStation: 'restaurant_kitchen_stations',
  restaurantStationRoutingRule: 'restaurant_station_routing_rules',
  restaurantOrder: 'restaurant_orders',
  restaurantOrderItem: 'restaurant_order_items',
  restaurantOrderItemModifier: 'restaurant_order_item_modifiers',
  restaurantOrderEvent: 'restaurant_order_events',
  restaurantOrderIdempotencyKey: 'restaurant_order_idempotency_keys',
  restaurantEventOutbox: 'restaurant_event_outbox',
  restaurantKitchenTicket: 'restaurant_kitchen_tickets',
  restaurantKitchenTicketItem: 'restaurant_kitchen_ticket_items',
} as const;
export const REQUIRED_RLS_TABLES = [
  'organizations',
  'users',
  'restaurant_branches',
  'restaurant_branch_assignments',
  'audit_logs',
  ...Object.values(MODEL_TABLES),
];
export type Model = keyof typeof MODEL_TABLES;
export type RowReference = { model: Model; id: string };
export type PlannedRow = RowReference & { data: Record<string, unknown> };
export type FixtureContext = {
  target: SeedTarget;
  id: (key: string) => string;
  enabled: string[];
  ownerStaffProfileId: string;
  limits: Record<string, number>;
};

type Delegate = {
  create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  findFirst(args: { where: { id: string } }): Promise<{ id: string } | null>;
};
function delegate(tx: ScopedDb, model: Model): Delegate {
  requireSeed(Object.hasOwn(MODEL_TABLES, model), 'RECEIPT_MODEL_INVALID');
  return tx[model] as unknown as Delegate;
}

/** Pure relational fixture plan; no source executable imports, connections or effects. */
export function planFixtures(ctx: FixtureContext): PlannedRow[] {
  const { target: t, id, enabled } = ctx;
  const has = (key: string) => enabled.includes(key);
  const at = new Date(t.scenarioAt);
  const date = new Date(`${t.businessDate}T00:00:00.000Z`);
  const plan: PlannedRow[] = [];
  function add<M extends Model>(
    model: M,
    key: string,
    data: Omit<Prisma.Args<ScopedDb[M], 'create'>['data'], 'id' | 'organizationId'>
  ) {
    plan.push({
      model,
      id: id(key),
      data: { ...data, id: id(key), organizationId: t.organizationId },
    });
  }
  // Existing owner profiles are never updated, even to repair status/branch access.
  if (ctx.ownerStaffProfileId === id('owner')) {
    add('restaurantStaffProfile', 'owner', {
      userId: t.ownerUserId,
      displayName: 'Chai Chowk owner',
      primaryBranchId: t.branchId,
      status: 'ACTIVE',
    });
  }
  add('restaurantNotification', 'notice', {
    recipientStaffProfileId: ctx.ownerStaffProfileId,
    branchId: t.branchId,
    category: 'SYSTEM',
    title: 'Synthetic staging demo',
    body: 'Synthetic training fixtures only. External delivery and hardware integrations are disabled; financial and regulatory approvals are not represented.',
  });
  add('restaurantBrand', 'brand', { name: 'Demo · Chai Chowk', isDefault: false });
  add('restaurantCategory', 'category', { name: 'Demo · Café menu' });
  add('restaurantUnit', 'unit', { name: 'Demo gram', abbreviation: 'g' });
  add('restaurantMenu', 'menu', {
    brandId: id('brand'),
    name: 'Demo · Chai Chowk menu',
    description: 'Synthetic training menu, PKR. No regulatory/tax approval implied.',
  });
  add('restaurantMenuSection', 'section', { menuId: id('menu'), name: 'Demo · Chai and kitchen' });
  add('restaurantPriceList', 'prices', { name: 'Demo · PKR prices', isDefault: false });
  add('restaurantPriceListVersion', 'price-version', {
    priceListId: id('prices'),
    versionNumber: 1,
    status: 'ACTIVE',
    effectiveFrom: at,
    activatedAt: at,
  });
  add('restaurantModifierGroup', 'modifier', {
    name: 'Demo · Chai sweetness',
    minSelect: 0,
    maxSelect: 1,
  });
  add('restaurantModifierOption', 'modifier-option', {
    modifierGroupId: id('modifier'),
    name: 'No added sugar',
    priceDelta: '0',
  });
  const products = [
    {
      key: 'chai',
      name: 'Doodh Patti',
      price: '220.00',
      ingredient: 'Tea blend',
      quantity: '5',
      cost: '2.00',
    },
    {
      key: 'paratha',
      name: 'Paratha',
      price: '180.00',
      ingredient: 'Flour mix',
      quantity: '100',
      cost: '0.20',
    },
    {
      key: 'rice',
      name: 'Vegetable Rice',
      price: '450.00',
      ingredient: 'Rice mix',
      quantity: '150',
      cost: '0.40',
    },
  ];
  for (const [i, product] of products.entries()) {
    const key = product.key;
    add('restaurantProduct', `product-${key}`, {
      categoryId: id('category'),
      name: `Demo · ${product.name}`,
      description:
        'Synthetic training dish; illustrative recipe, not a food-safety or allergen specification.',
      sortOrder: i,
    });
    add('restaurantMenuItem', `menu-${key}`, {
      sectionId: id('section'),
      productId: id(`product-${key}`),
      sortOrder: i,
    });
    add('restaurantPriceListEntry', `price-${key}`, {
      priceListVersionId: id('price-version'),
      productId: id(`product-${key}`),
      price: product.price,
    });
    add('restaurantIngredient', `ingredient-${key}`, {
      name: `Demo · ${product.ingredient}`,
      baseUnitId: id('unit'),
      referenceCost: product.cost,
    });
    add('restaurantRecipe', `recipe-${key}`, {
      productId: id(`product-${key}`),
      name: `Demo · ${product.name} recipe`,
    });
    add('restaurantRecipeVersion', `recipe-version-${key}`, {
      recipeId: id(`recipe-${key}`),
      versionNumber: 1,
      status: 'ACTIVE',
      yieldQuantity: '1',
      portionCount: 1,
      activatedAt: at,
      notes: 'Synthetic illustrative BOM; no clinical, allergen or regulatory approval.',
    });
    add('restaurantRecipeLine', `recipe-line-${key}`, {
      recipeVersionId: id(`recipe-version-${key}`),
      ingredientId: id(`ingredient-${key}`),
      quantity: product.quantity,
      unitId: id('unit'),
    });
    if (has('inventory') || has('purchasing'))
      add('restaurantStockItem', `stock-${key}`, {
        ingredientId: id(`ingredient-${key}`),
        canonicalUnitId: id('unit'),
      });
  }
  add('restaurantProductModifierGroup', 'product-modifier', {
    productId: id('product-chai'),
    modifierGroupId: id('modifier'),
  });
  add('restaurantBranchMenuPublication', 'publication', {
    branchId: t.branchId,
    menuId: id('menu'),
    priceListId: id('prices'),
    status: 'PUBLISHED',
    channels: ['TAKEAWAY', 'DINE_IN'],
    publishedAt: at,
  });
  if (has('floor')) {
    add('restaurantFloor', 'floor', { branchId: t.branchId, name: 'Demo · Training floor' });
    for (let i = 1; i <= 3; i++)
      add('restaurantTable', `table-${i}`, {
        floorId: id('floor'),
        code: `DEMO-${i}`,
        capacity: i * 2,
      });
  }
  if (has('inventory') || has('purchasing'))
    add('restaurantStockLocation', 'stock-location', {
      branchId: t.branchId,
      name: 'Demo · Isolated training pantry',
      code: id('pantry'),
    });
  if (has('purchasing')) {
    add('restaurantSupplier', 'supplier', {
      name: 'Demo · Synthetic supplies',
      code: id('supplier'),
    });
    add('restaurantPurchaseOrder', 'purchase', {
      supplierId: id('supplier'),
      branchId: t.branchId,
      locationId: id('stock-location'),
      reference: id('purchase'),
      expectedDate: date,
      createdByStaffProfileId: ctx.ownerStaffProfileId,
    });
    for (const product of products)
      add('restaurantPurchaseOrderLine', `purchase-${product.key}`, {
        purchaseOrderId: id('purchase'),
        stockItemId: id(`stock-${product.key}`),
        orderedQuantity: '1000',
        unitId: id('unit'),
        unitCost: product.cost,
      });
  }
  if (has('workforce')) {
    for (let i = 1; i <= 2; i++) {
      add('restaurantStaffProfile', `staff-${i}`, {
        displayName: `Demo · Training colleague ${i}`,
        primaryBranchId: t.branchId,
        status: 'ACTIVE',
      });
      add('restaurantShift', `shift-${i}`, {
        branchId: t.branchId,
        staffProfileId: id(`staff-${i}`),
        businessDate: date,
        startAt: at,
        endAt: new Date(at.getTime() + 8 * 3_600_000),
        notes: 'Synthetic scheduled shift; no attendance claimed.',
      });
    }
  }
  if (has('customers'))
    for (let i = 1; i <= 2; i++)
      add('restaurantCustomer', `customer-${i}`, {
        displayName: `Demo · Training guest ${i}`,
        notes: 'Synthetic guest. No real contact or personal details.',
      });
  if (has('catering')) {
    add('restaurantCateringOrder', 'catering', {
      branchId: t.branchId,
      eventName: 'Demo · Team tea gathering',
      eventDate: date,
      headcount: 20,
      status: 'DRAFT',
      notes: 'Synthetic draft; no payment, deposit, delivery or stock consumption claimed.',
      createdByStaffId: ctx.ownerStaffProfileId,
      customerId: has('customers') ? id('customer-1') : null,
    });
    for (const key of ['chai', 'paratha'])
      add('restaurantCateringOrderLine', `catering-${key}`, {
        orderId: id('catering'),
        productId: id(`product-${key}`),
        recipeId: id(`recipe-${key}`),
        description: `Demo · ${key}`,
        portions: '20',
        unitPrice: key === 'chai' ? '220.00' : '180.00',
      });
    add('restaurantCateringExtraCost', 'catering-cost', {
      orderId: id('catering'),
      kind: 'TRANSPORT',
      label: 'Demo · Estimated transport',
      amount: '500.00',
    });
  }
  if (has('sop')) {
    add('restaurantSopTemplate', 'sop', {
      name: 'Demo · Opening walkthrough',
      description: 'Synthetic draft checklist; no completed or verified outcome.',
    });
    add('restaurantSopTemplateVersion', 'sop-version', {
      templateId: id('sop'),
      versionNumber: 1,
      status: 'DRAFT',
    });
    add('restaurantSopTemplateStep', 'sop-step', {
      templateVersionId: id('sop-version'),
      stepOrder: 1,
      title: 'Review the training area',
      instructions: 'Demo-only checklist. Do not represent this as a real inspection.',
    });
  }
  if (has('orders')) {
    add('restaurantKitchenStation', 'station', {
      branchId: t.branchId,
      name: 'Demo · Training kitchen',
      isDefault: false,
    });
    add('restaurantStationRoutingRule', 'station-rule', {
      stationId: id('station'),
      categoryId: id('category'),
    });
    // A revoked, credential-less device is attribution only, never an enrolled terminal.
    add('restaurantRegisteredDevice', 'device', {
      branchId: t.branchId,
      name: 'Demo · Disabled attribution device',
      deviceSecretHash: id('not-a-login-secret'),
      status: 'REVOKED',
      revokedAt: at,
    });
  }
  return plan;
}

export function planCounts(plan: PlannedRow[]) {
  const counts: Record<string, number> = {};
  for (const row of plan) counts[row.model] = (counts[row.model] ?? 0) + 1;
  return counts;
}
export async function assertNoCollisions(tx: ScopedDb, plan: PlannedRow[]) {
  for (const row of plan)
    requireSeed(
      !(await delegate(tx, row.model).findFirst({ where: { id: row.id } })),
      'SYNTHETIC_ID_COLLISION'
    );
}
export async function verifyRows(tx: ScopedDb, rows: RowReference[]) {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    requireSeed(
      row &&
        typeof row.id === 'string' &&
        (await delegate(tx, row.model).findFirst({ where: { id: row.id } })),
      'SEED_ROW_MISSING'
    );
    counts[row.model] = (counts[row.model] ?? 0) + 1;
  }
  return counts;
}

/** One owning transaction, only newly created fixture rows may be transitioned. */
export async function seedChaichowkFixtures(tx: ScopedDb, ctx: FixtureContext, plan: PlannedRow[]) {
  const { target: t, id } = ctx;
  const rows: RowReference[] = [];
  const remember = (model: Model, records: { id: string }[]) => {
    for (const row of records) rows.push({ model, id: row.id });
  };
  for (const row of plan) {
    await delegate(tx, row.model).create({ data: row.data });
    remember(row.model, [row]);
  }
  if (ctx.enabled.includes('purchasing')) {
    const { submitPurchaseOrder, approvePurchaseOrder, receivePurchaseOrder } =
      await import('../src/lib/restaurant/purchasing');
    const now = new Date(t.scenarioAt);
    await submitPurchaseOrder(tx, id('purchase'), now);
    await approvePurchaseOrder(tx, id('purchase'), {
      approvedByStaffProfileId: ctx.ownerStaffProfileId,
      now,
    });
    const receipt = await receivePurchaseOrder(tx, {
      purchaseOrderId: id('purchase'),
      locationId: id('stock-location'),
      reference: id('synthetic-receipt'),
      receivedAt: now,
      now,
      actor: { staffProfileId: ctx.ownerStaffProfileId, idempotencyKey: id('receive') },
      lines: ['chai', 'paratha', 'rice'].map((key) => ({
        purchaseOrderLineId: id(`purchase-${key}`),
        receivedQuantity: '1000',
      })),
    });
    remember('restaurantPurchaseReceipt', [{ id: receipt.receiptId }]);
    remember('restaurantStockMovement', receipt.movements);
    remember(
      'restaurantPurchaseReceiptLine',
      await tx.restaurantPurchaseReceiptLine.findMany({
        where: { purchaseReceiptId: receipt.receiptId },
        select: { id: true },
      })
    );
    remember(
      'restaurantInventoryIdempotencyKey',
      await tx.restaurantInventoryIdempotencyKey.findMany({
        where: { key: id('receive') },
        select: { id: true },
      })
    );
  }
  if (ctx.enabled.includes('orders')) {
    const { openOrder, addItem, sendOrder, advanceItem } =
      await import('../src/lib/restaurant/orders');
    const orderIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const actor = (command: string) => ({
        staffProfileId: ctx.ownerStaffProfileId,
        deviceId: id('device'),
        idempotencyKey: id(`order-${i}-${command}`),
      });
      const order = await openOrder(tx, {
        organizationId: t.organizationId,
        entitlementLimits: ctx.limits,
        branchId: t.branchId,
        channel: 'TAKEAWAY',
        publicationId: id('publication'),
        actor: actor('open'),
        now: new Date(t.scenarioAt),
      });
      orderIds.push(order.orderId);
      const item = await addItem(tx, {
        orderId: order.orderId,
        menuItemId: id('menu-chai'),
        modifierOptionIds: [id('modifier-option')],
        actor: actor('item'),
        now: new Date(t.scenarioAt),
      });
      await sendOrder(tx, { orderId: order.orderId, actor: actor('send') });
      if (i >= 1)
        await advanceItem(tx, {
          orderId: order.orderId,
          itemId: item.itemId,
          toStatus: 'FIRING',
          actor: actor('fire'),
        });
      if (i >= 2)
        await advanceItem(tx, {
          orderId: order.orderId,
          itemId: item.itemId,
          toStatus: 'PREPARED',
          actor: actor('prepare'),
        });
    }
    const items = await tx.restaurantOrderItem.findMany({
      where: { orderId: { in: orderIds } },
      select: { id: true },
    });
    const tickets = await tx.restaurantKitchenTicket.findMany({
      where: { orderId: { in: orderIds } },
      select: { id: true },
    });
    // A concurrent route change must not let this transaction commit a print intent.
    requireSeed(
      (await tx.restaurantPrintJob.count({
        where: {
          branchId: t.branchId,
          idempotencyKey: { in: tickets.map((ticket) => `kitchen-ticket:${ticket.id}:v1`) },
        },
      })) === 0,
      'PRINT_ROUTE_CHANGED'
    );
    // DEAD is the existing outbox terminal state. Retain honest suppression evidence;
    // never mark an external event dispatched. Only this transaction's new orders.
    await tx.restaurantEventOutbox.updateMany({
      where: { aggregateId: { in: orderIds } },
      data: {
        status: 'DEAD',
        lastError: 'Synthetic staging seed: external delivery intentionally disabled',
        nextAttemptAt: null,
      },
    });
    remember(
      'restaurantOrder',
      orderIds.map((id) => ({ id }))
    );
    remember('restaurantOrderItem', items);
    remember('restaurantKitchenTicket', tickets);
    remember(
      'restaurantOrderItemModifier',
      await tx.restaurantOrderItemModifier.findMany({
        where: { orderItemId: { in: items.map((row) => row.id) } },
        select: { id: true },
      })
    );
    remember(
      'restaurantKitchenTicketItem',
      await tx.restaurantKitchenTicketItem.findMany({
        where: { ticketId: { in: tickets.map((row) => row.id) } },
        select: { id: true },
      })
    );
    remember(
      'restaurantOrderEvent',
      await tx.restaurantOrderEvent.findMany({
        where: { orderId: { in: orderIds } },
        select: { id: true },
      })
    );
    remember(
      'restaurantEventOutbox',
      await tx.restaurantEventOutbox.findMany({
        where: { aggregateId: { in: orderIds } },
        select: { id: true },
      })
    );
    remember(
      'restaurantOrderIdempotencyKey',
      await tx.restaurantOrderIdempotencyKey.findMany({
        where: { deviceId: id('device') },
        select: { id: true },
      })
    );
  }
  return rows;
}
