import { createHash } from 'node:crypto';
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
  {
    key: 'billing',
    modules: ['restaurant-menu', 'restaurant-pos'],
    capabilities: ['menu:write', 'orders:read', 'orders:manage', 'payments:collect'],
  },
  {
    key: 'customers',
    modules: ['restaurant-loyalty'],
    capabilities: ['customers:read', 'customers:manage'],
  },
  {
    key: 'catering',
    modules: ['restaurant-menu', 'restaurant-core', 'restaurant-loyalty'],
    capabilities: ['menu:write', 'catering:read', 'catering:manage', 'customers:manage'],
  },
  {
    key: 'operations',
    modules: ['restaurant-workforce', 'restaurant-sop'],
    capabilities: ['staff:manage', 'sop:manage', 'sop:complete', 'sop:verify'],
  },
] as const;

export const ALWAYS_GATED = [
  'settlements/payments/refunds/financial history/insight projections: settlement scenarios remain unimplemented; no tax approvals fabricated (open bills/splits only when payments:collect is already granted)',
  'loyalty accrual/redemption: requires settled-order/program scenarios; customers only',
  'Catering confirmed/production/consumption/delivery/deposits: unavailable; console hardcodes USD despite PKR',
  'devices/printers/email/webhooks/AI/payment integrations: disabled; no hardware or external success claimed',
  'Pharmacy: separate workspace/account decision required; no provisioning',
  'absent owner: secure owner provisioning required before this existing-account package can run',
];

export const MODEL_TABLES = {
  restaurantBill: 'restaurant_bills',
  restaurantBillLine: 'restaurant_bill_lines',
  restaurantMoneyIdempotencyKey: 'restaurant_money_idempotency_keys',
  restaurantCateringDelivery: 'restaurant_catering_deliveries',
  restaurantCateringEvent: 'restaurant_catering_events',
  restaurantShiftBreak: 'restaurant_shift_breaks',
  restaurantShiftEvent: 'restaurant_shift_events',
  restaurantShiftSwapRequest: 'restaurant_shift_swap_requests',
  restaurantShiftSwapDecision: 'restaurant_shift_swap_decisions',
  restaurantWorkforceCommand: 'restaurant_workforce_commands',
  restaurantSopAssignment: 'restaurant_sop_assignments',
  restaurantSopOccurrence: 'restaurant_sop_occurrences',
  restaurantSopOccurrenceStep: 'restaurant_sop_occurrence_steps',
  restaurantSopEvidence: 'restaurant_sop_evidence',
  restaurantSopVerification: 'restaurant_sop_verifications',

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
export type RowReference = { model: Model; id: string; hash?: string };
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
  if (has('customers'))
    for (let i = 1; i <= 2; i++)
      add('restaurantCustomer', `customer-${i}`, {
        displayName: `Demo · Training guest ${i}`,
        notes: 'Synthetic guest. No real contact or personal details.',
      });
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
/** Hash scalar rows without emitting their contents. JSON normalizes Dates/Decimals. */
export function rowHash(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, canonical(child)])
      );
    return item;
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical(JSON.parse(JSON.stringify(value)))))
    .digest('hex');
}
export async function verifyRows(tx: ScopedDb, rows: RowReference[], capture = false) {
  const counts: Record<string, number> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    requireSeed(
      row && typeof row.id === 'string' && !seen.has(`${row.model}:${row.id}`),
      'RECEIPT_ROW_INVALID'
    );
    seen.add(`${row.model}:${row.id}`);
    const actual = await delegate(tx, row.model).findFirst({ where: { id: row.id } });
    requireSeed(actual, 'SEED_ROW_MISSING');
    const hash = rowHash(actual);
    if (capture) row.hash = hash;
    else requireSeed(row.hash === hash, 'SEED_ROW_CHANGED');
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
    if (ctx.enabled.includes('billing')) {
      const { cutBills } = await import('../src/lib/restaurant/bills');
      const billIds: string[] = [];
      for (const [index, orderId] of orderIds.entries()) {
        const result = await cutBills(tx, {
          orderId,
          branchId: t.branchId,
          split: index === 2 ? { kind: 'FRACTIONAL', weights: [1, 1] } : { kind: 'NONE' },
          actor: {
            staffProfileId: ctx.ownerStaffProfileId,
            deviceId: id('device'),
            idempotencyKey: id(`bill-${index}`),
          },
        });
        billIds.push(...result.billIds);
      }
      remember(
        'restaurantBill',
        billIds.map((id) => ({ id }))
      );
      remember(
        'restaurantBillLine',
        await tx.restaurantBillLine.findMany({
          where: { billId: { in: billIds } },
          select: { id: true },
        })
      );
      remember(
        'restaurantMoneyIdempotencyKey',
        await tx.restaurantMoneyIdempotencyKey.findMany({
          where: { deviceId: id('device') },
          select: { id: true },
        })
      );
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
