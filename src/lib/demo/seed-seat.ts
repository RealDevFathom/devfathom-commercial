import 'server-only';

import { createDemoRestaurantSeedContext } from '@/lib/demo/seed-bootstrap';
import { seedDemoRestaurantCatalog } from '@/lib/demo/seed-catalog';
import {
  buildDemoRestaurantSeed,
  demoRestaurantSeedCounts,
  type DemoSeatIdentity,
  type DemoSeedCounts,
} from '@/lib/demo/seed-data';
import {
  reconcileDemoRestaurantInventory,
  seedDemoRestaurantInventory,
} from '@/lib/demo/seed-inventory';
import { seedDemoRestaurantHistory } from '@/lib/demo/seed-history';
import { seedDemoRestaurantOperations } from '@/lib/demo/seed-operations';
import { rollupDay } from '@/lib/restaurant/insight-rollups';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export type DemoRestaurantSeatResult = {
  organizationId: string;
  seatNumber: number;
  managerUserId: string;
  managerEmail: string;
  counts: DemoSeedCounts;
};

type CountValue = number | bigint;
type CountRow = Record<keyof DemoSeedCounts, CountValue>;

const COUNT_KEYS = [
  'branches',
  'floors',
  'tables',
  'modifierGroups',
  'modifierOptions',
  'products',
  'ingredients',
  'recipes',
  'recipeLines',
  'suppliers',
  'purchaseOrders',
  'purchaseReceipts',
  'stockBalances',
  'stockMovements',
  'stockCounts',
  'stockCountLines',
  'lowStockRules',
  'triggeredLowStockRules',
  'historicalBusinessDates',
  'historicalOrders',
  'historicalOrderLines',
  'bills',
  'settlements',
  'splitTenderOrders',
  'refunds',
  'dailyCloses',
  'dailyCloseCorrections',
  'liveOrders',
  'kdsTickets',
  'loyaltyCustomers',
  'promotions',
  'staff',
  'rosterShifts',
  'sopTemplates',
  'sopSteps',
  'sopOccurrences',
  'sopEvidence',
  'notifications',
] as const satisfies ReadonlyArray<keyof DemoSeedCounts>;

async function persistedCounts(
  db: ScopedDb,
  organizationId: string,
  historicalBusinessDates: string[]
): Promise<DemoSeedCounts> {
  if (!historicalBusinessDates.length) throw new Error('Demo history needs business dates.');
  const dateParameters = historicalBusinessDates
    .map((_, index) => `$${index + 2}::date`)
    .join(', ');
  const [row] = await db.$queryRawUnsafe<CountRow[]>(
    `SELECT
      (SELECT count(*)::int FROM restaurant_branches WHERE "organizationId" = $1) AS branches,
      (SELECT count(*)::int FROM restaurant_floors WHERE "organizationId" = $1) AS floors,
      (SELECT count(*)::int FROM restaurant_tables WHERE "organizationId" = $1) AS tables,
      (SELECT count(*)::int FROM restaurant_modifier_groups WHERE "organizationId" = $1) AS "modifierGroups",
      (SELECT count(*)::int FROM restaurant_modifier_options WHERE "organizationId" = $1) AS "modifierOptions",
      (SELECT count(*)::int FROM restaurant_products WHERE "organizationId" = $1) AS products,
      (SELECT count(*)::int FROM restaurant_ingredients WHERE "organizationId" = $1) AS ingredients,
      (SELECT count(*)::int FROM restaurant_recipes WHERE "organizationId" = $1) AS recipes,
      (SELECT count(*)::int FROM restaurant_recipe_lines WHERE "organizationId" = $1) AS "recipeLines",
      (SELECT count(*)::int FROM restaurant_suppliers WHERE "organizationId" = $1) AS suppliers,
      (SELECT count(*)::int FROM restaurant_purchase_orders WHERE "organizationId" = $1) AS "purchaseOrders",
      (SELECT count(*)::int FROM restaurant_purchase_receipts WHERE "organizationId" = $1) AS "purchaseReceipts",
      (SELECT count(*)::int FROM (
        SELECT "stockItemId", "locationId" FROM restaurant_stock_movements
         WHERE "organizationId" = $1 GROUP BY "stockItemId", "locationId"
      ) AS balances) AS "stockBalances",
      (SELECT count(*)::int FROM restaurant_stock_movements WHERE "organizationId" = $1) AS "stockMovements",
      (SELECT count(*)::int FROM restaurant_stock_counts WHERE "organizationId" = $1) AS "stockCounts",
      (SELECT count(*)::int FROM restaurant_stock_count_lines WHERE "organizationId" = $1) AS "stockCountLines",
      (SELECT count(*)::int FROM restaurant_low_stock_rules WHERE "organizationId" = $1) AS "lowStockRules",
      (SELECT count(*)::int FROM restaurant_low_stock_rules AS rule
        WHERE rule."organizationId" = $1
          AND COALESCE((
            SELECT sum(movement.quantity) FROM restaurant_stock_movements AS movement
             WHERE movement."organizationId" = $1
               AND movement."stockItemId" = rule."stockItemId"
               AND movement."locationId" = rule."locationId"
          ), 0) < rule.threshold) AS "triggeredLowStockRules",
      (SELECT count(DISTINCT "businessDate")::int FROM restaurant_orders
        WHERE "organizationId" = $1 AND "businessDate" IN (${dateParameters})) AS "historicalBusinessDates",
      (SELECT count(*)::int FROM restaurant_orders
        WHERE "organizationId" = $1 AND "businessDate" IN (${dateParameters})) AS "historicalOrders",
      (SELECT count(*)::int FROM restaurant_order_items AS item
        JOIN restaurant_orders AS restaurant_order ON restaurant_order.id = item."orderId"
        WHERE item."organizationId" = $1
          AND restaurant_order."businessDate" IN (${dateParameters})) AS "historicalOrderLines",
      (SELECT count(*)::int FROM restaurant_bills WHERE "organizationId" = $1) AS bills,
      (SELECT count(*)::int FROM restaurant_tenders WHERE "organizationId" = $1) AS settlements,
      (SELECT count(*)::int FROM (
        SELECT "billId" FROM restaurant_tenders WHERE "organizationId" = $1
        GROUP BY "billId" HAVING count(*) > 1
      ) AS split_bills) AS "splitTenderOrders",
      (SELECT count(*)::int FROM restaurant_refunds WHERE "organizationId" = $1) AS refunds,
      (SELECT count(*)::int FROM restaurant_daily_closes WHERE "organizationId" = $1) AS "dailyCloses",
      (SELECT count(*)::int FROM restaurant_daily_closes
        WHERE "organizationId" = $1 AND "supersedesCloseId" IS NOT NULL) AS "dailyCloseCorrections",
      (SELECT count(*)::int FROM restaurant_orders
        WHERE "organizationId" = $1 AND "businessDate" NOT IN (${dateParameters})) AS "liveOrders",
      (SELECT count(*)::int FROM restaurant_kitchen_tickets WHERE "organizationId" = $1) AS "kdsTickets",
      (SELECT count(DISTINCT "customerId")::int FROM restaurant_loyalty_accounts
        WHERE "organizationId" = $1) AS "loyaltyCustomers",
      (SELECT count(*)::int FROM restaurant_promotions WHERE "organizationId" = $1) AS promotions,
      (SELECT count(*)::int FROM restaurant_staff_profiles WHERE "organizationId" = $1) AS staff,
      (SELECT count(*)::int FROM restaurant_shifts WHERE "organizationId" = $1) AS "rosterShifts",
      (SELECT count(*)::int FROM restaurant_sop_templates WHERE "organizationId" = $1) AS "sopTemplates",
      (SELECT count(*)::int FROM restaurant_sop_template_steps WHERE "organizationId" = $1) AS "sopSteps",
      (SELECT count(*)::int FROM restaurant_sop_occurrences WHERE "organizationId" = $1) AS "sopOccurrences",
      (SELECT count(*)::int FROM restaurant_sop_evidence WHERE "organizationId" = $1) AS "sopEvidence",
      (SELECT count(*)::int FROM restaurant_notifications WHERE "organizationId" = $1) AS notifications`,
    organizationId,
    ...historicalBusinessDates
  );
  if (!row) throw new Error('Demo seed count query returned no row.');

  const counts: Partial<DemoSeedCounts> = {};
  for (const key of COUNT_KEYS) {
    const raw = row[key];
    const count = typeof raw === 'bigint' ? Number(raw) : raw;
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) counts[key] = count;
  }
  const missing = COUNT_KEYS.filter((key) => counts[key] === undefined);
  if (missing.length) {
    throw new Error(`Demo persisted-count query omitted: ${missing.join(', ')}`);
  }
  return counts as DemoSeedCounts;
}

export async function rebuildDemoRestaurantSeatInTransaction(
  db: ScopedDb,
  input: {
    identity: DemoSeatIdentity;
    now: Date;
    managerStaffProfileId: string;
    approverStaffProfileId: string;
  }
): Promise<DemoRestaurantSeatResult> {
  const seed = buildDemoRestaurantSeed(input.now, input.identity.seatNumber);
  if (seed.identity.organizationId !== input.identity.organizationId) {
    throw new Error('Demo seed identity does not match locked organization.');
  }
  const context = await createDemoRestaurantSeedContext(db, input.identity.organizationId);
  if (context.db !== db) throw new Error('Demo seed context must reuse the supplied transaction.');

  const catalog = await seedDemoRestaurantCatalog(db, seed, context);
  const operations = await seedDemoRestaurantOperations(db, seed, catalog, context);
  if (
    operations.managerStaffProfileId !== input.managerStaffProfileId ||
    operations.approverStaffProfileId !== input.approverStaffProfileId
  ) {
    throw new Error('Demo operations did not reuse preserved manager and approver staff.');
  }
  const inventory = await seedDemoRestaurantInventory(db, seed, catalog, context, operations);
  await seedDemoRestaurantHistory(db, seed, catalog, context, operations);
  await reconcileDemoRestaurantInventory(db, seed, catalog, context, operations, inventory);
  const projectedDays = new Set<string>();
  for (const close of seed.sales.dailyCloses) {
    const branchId = catalog.branch[close.branchId];
    if (!branchId) throw new Error(`Missing demo branch ${close.branchId}.`);
    const projectionKey = `${branchId}:${close.businessDate}`;
    if (projectedDays.has(projectionKey)) continue;
    projectedDays.add(projectionKey);
    await rollupDay(db, { branchId, businessDate: close.businessDate, computedAt: input.now });
  }
  const counts = await persistedCounts(
    db,
    input.identity.organizationId,
    seed.historicalBusinessDates
  );
  const minimums = demoRestaurantSeedCounts(seed);
  const incomplete = COUNT_KEYS.filter((key) => counts[key] < minimums[key]);
  if (
    incomplete.length ||
    counts.branches < 3 ||
    counts.historicalBusinessDates < 90 ||
    counts.historicalOrders < 1_200 ||
    counts.loyaltyCustomers < 200 ||
    counts.recipes < 25
  ) {
    throw new Error(
      `Restaurant demo rebuild is incomplete: ${incomplete.length ? incomplete.join(', ') : 'required showcase minimums'}`
    );
  }

  return {
    organizationId: input.identity.organizationId,
    seatNumber: input.identity.seatNumber,
    managerUserId: input.identity.managerUserId,
    managerEmail: input.identity.managerEmail,
    counts,
  };
}
