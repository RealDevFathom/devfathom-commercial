import 'server-only';
import { reportNetSales } from './report-net-sales';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { businessDateToUtcDate } from './business-date';
import { resolveChainTip } from './daily-close';
import { computeRecipeCost, RecipeCostingError } from './recipe-costing';

export const MAX_REPORT_DAYS = 90;
export const MAX_REPORT_BRANCHES = 100;
export const MAX_INTERACTIVE_ROWS = 200;
export const MAX_EXPORT_ROWS = 5_000;

export type RestaurantReportRange = {
  branchIds: string[];
  from: string;
  to: string;
};

export type RestaurantStockReportRange = RestaurantReportRange & {
  stockLocationId?: string;
};

export type ReportFreshnessStatus = 'CURRENT' | 'STALE' | 'PARTIAL' | 'NO_CLOSED_DAYS';

export class RestaurantReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestaurantReportError';
  }
}

const ZERO = new Prisma.Decimal(0);

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function nextUtcDay(value: Date): Date {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function add(values: readonly Prisma.Decimal[]): Prisma.Decimal {
  return values.reduce((total, value) => total.plus(value), ZERO);
}

function serializeDecimal(value: Prisma.Decimal): string {
  return value.toDecimalPlaces(2).toString();
}

function shareOfTotal(value: Prisma.Decimal, total: Prisma.Decimal): string {
  return total.isZero() ? '0' : serializeDecimal(value.dividedBy(total).times(100));
}

function boundedRows<T>(rows: readonly T[], limit = MAX_INTERACTIVE_ROWS) {
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

export function validateRestaurantReportRange(range: RestaurantReportRange) {
  if (range.branchIds.length === 0) {
    throw new RestaurantReportError('Choose at least one active Restaurant branch.');
  }
  if (range.branchIds.length > MAX_REPORT_BRANCHES) {
    throw new RestaurantReportError(`Reports are limited to ${MAX_REPORT_BRANCHES} branches.`);
  }
  let from: Date;
  let to: Date;
  try {
    from = businessDateToUtcDate(range.from);
    to = businessDateToUtcDate(range.to);
  } catch {
    throw new RestaurantReportError('Report dates must be valid YYYY-MM-DD calendar dates.');
  }
  if (from > to) {
    throw new RestaurantReportError('The report start date must not be after the end date.');
  }
  const days = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
  if (days > MAX_REPORT_DAYS) {
    throw new RestaurantReportError(
      `Interactive Restaurant reports are limited to ${MAX_REPORT_DAYS} closed days.`
    );
  }
  return { from, to, toExclusive: nextUtcDay(to), days };
}

async function loadReportBackbone(db: ScopedDb, range: RestaurantReportRange) {
  const parsed = validateRestaurantReportRange(range);
  const where = {
    branchId: { in: range.branchIds },
    businessDate: { gte: parsed.from, lte: parsed.to },
  } as const;
  const [closes, rollups] = await Promise.all([
    db.restaurantDailyClose.findMany({
      where,
      orderBy: [{ businessDate: 'asc' }, { branchId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        branchId: true,
        businessDate: true,
        supersedesCloseId: true,
        grossSales: true,
        netSales: true,
        deliveryFeeSales: true,
        deliveryFeeRefunds: true,
        taxTotal: true,
        serviceChargeTotal: true,
        tipTotal: true,
        compTotal: true,
        discountTotal: true,
        refundTotal: true,
        voidTotal: true,
        cashExpected: true,
        cashCounted: true,
        cashVariance: true,
        createdAt: true,
        branch: { select: { name: true } },
        tenderTotals: {
          orderBy: [{ tenderType: 'asc' }, { id: 'asc' }],
          select: { tenderType: true, amount: true, tipAmount: true, count: true },
        },
      },
    }),
    db.insightDailyRollup.findMany({
      where,
      orderBy: [{ businessDate: 'asc' }, { branchId: 'asc' }],
      select: {
        id: true,
        branchId: true,
        businessDate: true,
        sourceDailyCloseId: true,
        orderCount: true,
        coverCount: true,
        computedAt: true,
      },
    }),
  ]);
  const closesByDay = new Map<string, (typeof closes)[number][]>();
  for (const close of closes) {
    const key = `${close.branchId}:${dateKey(close.businessDate)}`;
    const day = closesByDay.get(key) ?? [];
    day.push(close);
    closesByDay.set(key, day);
  }
  const authoritativeCloses = [...closesByDay.values()]
    .map((day) => resolveChainTip(day))
    .filter((close): close is (typeof closes)[number] => close !== null);
  return { closes: authoritativeCloses, rollups, parsed };
}

function freshnessFor(
  range: RestaurantReportRange,
  parsed: ReturnType<typeof validateRestaurantReportRange>,
  closes: readonly { id: string; branchId: string; businessDate: Date }[],
  rollups: readonly {
    branchId: string;
    businessDate: Date;
    sourceDailyCloseId: string;
  }[]
) {
  const expectedDayCount = parsed.days * range.branchIds.length;
  const tipByDay = new Map(
    closes.map((close) => [`${close.branchId}:${dateKey(close.businessDate)}`, close.id])
  );
  const rollupByDay = new Map(
    rollups.map((rollup) => [`${rollup.branchId}:${dateKey(rollup.businessDate)}`, rollup])
  );
  let staleDayCount = 0;
  let unprojectedDayCount = 0;
  for (const [key, closeId] of tipByDay) {
    const rollup = rollupByDay.get(key);
    if (!rollup) unprojectedDayCount += 1;
    else if (rollup.sourceDailyCloseId !== closeId) staleDayCount += 1;
  }
  const closedDayCount = closes.length;
  const status: ReportFreshnessStatus =
    closedDayCount === 0
      ? 'NO_CLOSED_DAYS'
      : staleDayCount > 0
        ? 'STALE'
        : closedDayCount < expectedDayCount || unprojectedDayCount > 0
          ? 'PARTIAL'
          : 'CURRENT';
  return {
    status,
    expectedDayCount,
    closedDayCount,
    missingClosedDayCount: Math.max(0, expectedDayCount - closedDayCount),
    staleDayCount,
    unprojectedDayCount,
    correctedDayCount: closes.filter(
      (close) => 'supersedesCloseId' in close && close.supersedesCloseId
    ).length,
  };
}

export async function readOverviewReport(db: ScopedDb, range: RestaurantReportRange) {
  const { closes, rollups, parsed } = await loadReportBackbone(db, range);
  const tipByDay = new Map(
    closes.map((close) => [`${close.branchId}:${dateKey(close.businessDate)}`, close.id])
  );
  const currentRollups = rollups.filter(
    (row) => tipByDay.get(`${row.branchId}:${dateKey(row.businessDate)}`) === row.sourceDailyCloseId
  );
  const topItems = closes.length
    ? await db.$queryRaw<
        Array<{ productId: string; productName: string; quantity: bigint }>
      >(Prisma.sql`
        WITH unsuperseded_tips AS (
          SELECT close."id",
            ROW_NUMBER() OVER (
              PARTITION BY close."branchId", close."businessDate"
              ORDER BY close."createdAt" DESC, close."id" DESC
            ) AS authority_rank
          FROM "restaurant_daily_closes" close
          WHERE close."branchId" IN (${Prisma.join(range.branchIds)})
            AND close."businessDate" >= ${parsed.from}
            AND close."businessDate" <= ${parsed.to}
            AND NOT EXISTS (
              SELECT 1 FROM "restaurant_daily_closes" successor
              WHERE successor."supersedesCloseId" = close."id"
            )
        )
        SELECT
          mix."productId" AS "productId",
          product."name" AS "productName",
          SUM(mix."quantity")::bigint AS "quantity"
        FROM "restaurant_insight_item_mix_rollups" mix
        JOIN unsuperseded_tips close
          ON close."id" = mix."sourceDailyCloseId" AND close.authority_rank = 1
        JOIN "restaurant_products" product ON product."id" = mix."productId"
        WHERE mix."branchId" IN (${Prisma.join(range.branchIds)})
          AND mix."businessDate" >= ${parsed.from}
          AND mix."businessDate" <= ${parsed.to}
        GROUP BY mix."productId", product."name"
        ORDER BY SUM(mix."quantity") DESC, mix."productId" ASC
        LIMIT 10
      `)
    : [];
  return {
    range,
    freshness: freshnessFor(range, parsed, closes, rollups),
    orderCount: currentRollups.reduce((total, row) => total + row.orderCount, 0),
    coverCount: currentRollups.reduce((total, row) => total + row.coverCount, 0),
    topItems: topItems.map((row) => ({ ...row, quantity: Number(row.quantity) })),
  };
}

export async function readPaymentsReport(db: ScopedDb, range: RestaurantReportRange) {
  const { closes, rollups, parsed } = await loadReportBackbone(db, range);
  const cashCountCoverage = await readCashCountCoverage(db, range, parsed, closes);
  const tipByDay = new Map(
    closes.map((close) => [`${close.branchId}:${dateKey(close.businessDate)}`, close.id])
  );
  const orderCount = rollups
    .filter(
      (row) =>
        tipByDay.get(`${row.branchId}:${dateKey(row.businessDate)}`) === row.sourceDailyCloseId
    )
    .reduce((total, row) => total + row.orderCount, 0);
  const tenderMap = new Map<
    string,
    { tenderType: string; amount: Prisma.Decimal; tips: Prisma.Decimal; count: number }
  >();
  for (const close of closes) {
    for (const tender of close.tenderTotals) {
      const current = tenderMap.get(tender.tenderType) ?? {
        tenderType: tender.tenderType,
        amount: ZERO,
        tips: ZERO,
        count: 0,
      };
      current.amount = current.amount.plus(tender.amount);
      current.tips = current.tips.plus(tender.tipAmount);
      current.count += tender.count;
      tenderMap.set(tender.tenderType, current);
    }
  }
  const total = (
    key:
      | 'grossSales'
      | 'netSales'
      | 'deliveryFeeSales'
      | 'deliveryFeeRefunds'
      | 'taxTotal'
      | 'serviceChargeTotal'
      | 'tipTotal'
      | 'compTotal'
      | 'discountTotal'
      | 'refundTotal'
      | 'voidTotal'
      | 'cashExpected'
      | 'cashCounted'
      | 'cashVariance'
  ) => add(closes.map((close) => close[key]));
  const netSales = add(closes.map(reportNetSales));
  return {
    range,
    freshness: freshnessFor(range, parsed, closes, rollups),
    cashCountCoverage,
    grossSales: serializeDecimal(total('grossSales')),
    netSales: serializeDecimal(netSales),
    averageCheck: serializeDecimal(orderCount > 0 ? netSales.dividedBy(orderCount) : ZERO),
    deliveryFeeSales: serializeDecimal(total('deliveryFeeSales')),
    deliveryFeeRefunds: serializeDecimal(total('deliveryFeeRefunds')),
    taxTotal: serializeDecimal(total('taxTotal')),
    serviceChargeTotal: serializeDecimal(total('serviceChargeTotal')),
    tipTotal: serializeDecimal(total('tipTotal')),
    compTotal: serializeDecimal(total('compTotal')),
    discountTotal: serializeDecimal(total('discountTotal')),
    refundTotal: serializeDecimal(total('refundTotal')),
    voidTotal: serializeDecimal(total('voidTotal')),
    cashExpected: serializeDecimal(total('cashExpected')),
    cashCounted: serializeDecimal(total('cashCounted')),
    cashVariance: serializeDecimal(total('cashVariance')),
    tenders: [...tenderMap.values()]
      .sort((left, right) => left.tenderType.localeCompare(right.tenderType))
      .map((row) => ({
        tenderType: row.tenderType,
        amount: serializeDecimal(row.amount),
        tipAmount: serializeDecimal(row.tips),
        count: row.count,
      })),
  };
}

/** Counts are evidence for the existing close amounts, never replacement totals. */
async function readCashCountCoverage(
  db: ScopedDb,
  range: RestaurantReportRange,
  parsed: ReturnType<typeof validateRestaurantReportRange>,
  closes: Awaited<ReturnType<typeof loadReportBackbone>>['closes']
) {
  const days = new Map(
    closes.map((close) => [
      `${close.branchId}:${dateKey(close.businessDate)}`,
      { close, counted: ZERO, incomplete: false },
    ])
  );
  // Stream drawer evidence: a busy 90-day range can contain arbitrarily many
  // sessions, while the fold only retains one accumulator per closed day.
  async function* drawerPages() {
    if (!closes.length) return;
    let cursor: string | undefined;
    while (true) {
      const page = await db.restaurantDrawerSession.findMany({
        take: 500,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        where: {
          branchId: { in: range.branchIds },
          businessDate: { gte: parsed.from, lte: parsed.to },
        },
        select: {
          id: true,
          branchId: true,
          businessDate: true,
          createdAt: true,
          closedAt: true,
          status: true,
          countedCash: true,
        },
      });
      yield* page;
      if (page.length < 500) return;
      cursor = page[page.length - 1].id;
    }
  }
  let drawerSessionCount = 0;
  let missingCountSessionCount = 0;
  let unverifiedCloseSessionCount = 0;
  for await (const drawer of drawerPages()) {
    const day = days.get(`${drawer.branchId}:${dateKey(drawer.businessDate)}`);
    // Match the source close's drawer business date and creation cutoff. Later
    // sessions and days without an authoritative close cannot validate its cash.
    if (!day || drawer.createdAt > day.close.createdAt) continue;
    drawerSessionCount += 1;
    if (drawer.countedCash === null) {
      missingCountSessionCount += 1;
      day.incomplete = true;
    } else {
      day.counted = day.counted.plus(drawer.countedCash);
    }
    if (
      drawer.status !== 'CLOSED' ||
      drawer.closedAt === null ||
      drawer.closedAt > day.close.createdAt
    ) {
      unverifiedCloseSessionCount += 1;
      day.incomplete = true;
    }
  }
  const mismatchedCloseDayCount = [...days.values()].filter(
    (day) => !day.incomplete && !day.counted.equals(day.close.cashCounted)
  ).length;
  const status = !closes.length
    ? ('NO_CLOSED_DAYS' as const)
    : missingCountSessionCount || unverifiedCloseSessionCount || mismatchedCloseDayCount
      ? ('INCOMPLETE' as const)
      : ('COMPLETE' as const);
  return {
    status,
    drawerSessionCount,
    missingCountSessionCount,
    unverifiedCloseSessionCount,
    mismatchedCloseDayCount,
    definition:
      'Drawer sessions on authoritative closed branch-days, created by each source close. COMPLETE requires every such session to have a non-null count and CLOSED timestamp by that close, and each daily count sum to match its close. Explicit zero is counted; no sessions with a zero close is complete. Coverage does not fill missing branch-days or establish a historical snapshot. Legacy payment cash totals remain source-close amounts and require this qualification.',
  };
}

type ProductSalesRow = {
  branchId: string;
  branchName: string;
  productId: string;
  productName: string;
  variantId: string | null;
  categoryId: string | null;
  categoryName: string | null;
  quantity: bigint;
  netSales: Prisma.Decimal;
};

type CostedProductRow = {
  productId: string;
  productName: string;
  categoryId: string | null;
  categoryName: string;
  quantity: string;
  netSales: string;
  theoreticalCost: string;
  foodCostPercent: string;
  grossMargin: string;
  marginPerItem: string;
};

type CostAggregate = {
  id: string;
  name: string;
  quantity: Prisma.Decimal;
  netSales: Prisma.Decimal;
  theoreticalCost: Prisma.Decimal;
};

export type FoodCostExclusionReason =
  'NO_RECIPE' | 'RECIPE_UNAVAILABLE' | 'NO_PORTION_COST' | 'MISSING_INGREDIENT_COST';

async function readProductSalesRows(db: ScopedDb, range: RestaurantReportRange) {
  const parsed = validateRestaurantReportRange(range);
  const rows = await db.$queryRaw<ProductSalesRow[]>(Prisma.sql`
    WITH bill_lines AS (
      SELECT
        bill."id" AS "billId",
        bill."branchId",
        bill."discountTotal",
        line."orderItemId",
        line."lineSubtotal" - line."compAmount" AS "eligibleSales",
        SUM(line."lineSubtotal" - line."compAmount") OVER (
          PARTITION BY bill."id"
        ) AS "billEligibleSales"
      FROM "restaurant_bills" bill
      JOIN "restaurant_bill_lines" line ON line."billId" = bill."id"
      WHERE bill."status" = 'SETTLED'
        AND bill."branchId" IN (${Prisma.join(range.branchIds)})
        AND bill."businessDate" >= ${parsed.from}
        AND bill."businessDate" <= ${parsed.to}
    ), allocated_lines AS (
      SELECT
        bill_lines.*,
        CASE
          WHEN bill_lines."billEligibleSales" = 0 THEN bill_lines."eligibleSales"
          ELSE bill_lines."eligibleSales" - (
            bill_lines."discountTotal" * bill_lines."eligibleSales"
            / bill_lines."billEligibleSales"
          )
        END AS "netSales"
      FROM bill_lines
    )
    SELECT
      allocated."branchId" AS "branchId",
      branch."name" AS "branchName",
      item."productId" AS "productId",
      product."name" AS "productName",
      item."variantId" AS "variantId",
      category."id" AS "categoryId",
      category."name" AS "categoryName",
      SUM(line."quantity")::bigint AS "quantity",
      SUM(allocated."netSales") AS "netSales"
    FROM allocated_lines allocated
    JOIN "restaurant_bill_lines" line ON line."orderItemId" = allocated."orderItemId"
      AND line."billId" = allocated."billId"
    JOIN "restaurant_order_items" item ON item."id" = allocated."orderItemId"
    JOIN "restaurant_products" product ON product."id" = item."productId"
    JOIN "restaurant_branches" branch ON branch."id" = allocated."branchId"
    LEFT JOIN "restaurant_categories" category ON category."id" = product."categoryId"
    GROUP BY
      allocated."branchId", branch."name", item."productId", product."name",
      item."variantId", category."id", category."name"
    ORDER BY product."name" ASC, item."productId" ASC, allocated."branchId" ASC,
      item."variantId" ASC NULLS FIRST
  `);
  return rows;
}

function accumulateCost(
  map: Map<string, CostAggregate>,
  key: string,
  name: string,
  quantity: Prisma.Decimal,
  netSales: Prisma.Decimal,
  theoreticalCost: Prisma.Decimal
) {
  const current = map.get(key) ?? {
    id: key,
    name,
    quantity: ZERO,
    netSales: ZERO,
    theoreticalCost: ZERO,
  };
  current.quantity = current.quantity.plus(quantity);
  current.netSales = current.netSales.plus(netSales);
  current.theoreticalCost = current.theoreticalCost.plus(theoreticalCost);
  map.set(key, current);
}

function serializeCostAggregate(row: CostAggregate) {
  const grossMargin = row.netSales.minus(row.theoreticalCost);
  return {
    id: row.id,
    name: row.name,
    quantity: row.quantity.toString(),
    netSales: serializeDecimal(row.netSales),
    theoreticalCost: serializeDecimal(row.theoreticalCost),
    foodCostPercent: shareOfTotal(row.theoreticalCost, row.netSales),
    grossMargin: serializeDecimal(grossMargin),
    marginPerItem: row.quantity.isZero()
      ? '0'
      : serializeDecimal(grossMargin.dividedBy(row.quantity)),
  };
}

/**
 * Product profitability is derived from immutable settled bill-line snapshots.
 * Bill-level discounts are allocated proportionally so product net sales still
 * reconcile to the bill ledger; current recipe costs remain explicitly
 * theoretical and never overwrite historical financial facts.
 */
async function buildFoodCostReport(db: ScopedDb, range: RestaurantReportRange) {
  const salesRows = await readProductSalesRows(db, range);
  const recipes = salesRows.length
    ? await db.restaurantRecipe.findMany({
        where: { productId: { in: [...new Set(salesRows.map((row) => row.productId))] } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, organizationId: true, productId: true, variantId: true },
      })
    : [];
  const recipesByProduct = new Map<string, typeof recipes>();
  for (const recipe of recipes) {
    const current = recipesByProduct.get(recipe.productId) ?? [];
    current.push(recipe);
    recipesByProduct.set(recipe.productId, current);
  }
  const recipeCosts = new Map<string, Awaited<ReturnType<typeof computeRecipeCost>>>();
  const recipeFailures = new Set<string>();
  const products = new Map<
    string,
    CostAggregate & { categoryId: string | null; categoryName: string }
  >();
  const categories = new Map<string, CostAggregate>();
  const branches = new Map<string, CostAggregate>();
  const exclusions = new Map<
    string,
    {
      productId: string;
      productName: string;
      categoryName: string;
      branchNames: Set<string>;
      quantity: Prisma.Decimal;
      netSales: Prisma.Decimal;
      reason: FoodCostExclusionReason;
      missingIngredientCount: number;
    }
  >();
  let netSales = ZERO;
  let costedNetSales = ZERO;
  let theoreticalCost = ZERO;

  for (const row of salesRows) {
    const quantity = new Prisma.Decimal(row.quantity.toString());
    netSales = netSales.plus(row.netSales);
    const linked = recipesByProduct.get(row.productId) ?? [];
    const recipe =
      linked.find((candidate) => candidate.variantId === row.variantId) ??
      linked.find((candidate) => candidate.variantId === null);
    let reason: FoodCostExclusionReason | null = recipe ? null : 'NO_RECIPE';
    let missingIngredientCount = 0;
    let costPerPortion: Prisma.Decimal | null = null;
    if (recipe) {
      let cost = recipeCosts.get(recipe.id);
      if (!cost && !recipeFailures.has(recipe.id)) {
        try {
          cost = await computeRecipeCost({
            organizationId: recipe.organizationId,
            recipeId: recipe.id,
          });
          recipeCosts.set(recipe.id, cost);
        } catch (error) {
          if (!(error instanceof RecipeCostingError)) throw error;
          recipeFailures.add(recipe.id);
          reason = 'RECIPE_UNAVAILABLE';
        }
      }
      if (cost) {
        missingIngredientCount = cost.missing.length;
        if (cost.missing.length > 0) reason = 'MISSING_INGREDIENT_COST';
        else if (!cost.costPerPortion) reason = 'NO_PORTION_COST';
        else costPerPortion = cost.costPerPortion;
      }
    }
    const categoryName = row.categoryName ?? 'Uncategorized';
    if (reason || !costPerPortion) {
      const exclusionReason = reason ?? 'NO_PORTION_COST';
      const key = `${row.productId}:${exclusionReason}`;
      const current = exclusions.get(key) ?? {
        productId: row.productId,
        productName: row.productName,
        categoryName,
        branchNames: new Set<string>(),
        quantity: ZERO,
        netSales: ZERO,
        reason: exclusionReason,
        missingIngredientCount: 0,
      };
      current.branchNames.add(row.branchName);
      current.quantity = current.quantity.plus(quantity);
      current.netSales = current.netSales.plus(row.netSales);
      current.missingIngredientCount = Math.max(
        current.missingIngredientCount,
        missingIngredientCount
      );
      exclusions.set(key, current);
      continue;
    }
    const rowCost = quantity.times(costPerPortion);
    costedNetSales = costedNetSales.plus(row.netSales);
    theoreticalCost = theoreticalCost.plus(rowCost);
    const product = products.get(row.productId) ?? {
      id: row.productId,
      name: row.productName,
      categoryId: row.categoryId,
      categoryName,
      quantity: ZERO,
      netSales: ZERO,
      theoreticalCost: ZERO,
    };
    product.quantity = product.quantity.plus(quantity);
    product.netSales = product.netSales.plus(row.netSales);
    product.theoreticalCost = product.theoreticalCost.plus(rowCost);
    products.set(row.productId, product);
    accumulateCost(
      categories,
      row.categoryId ?? 'uncategorized',
      categoryName,
      quantity,
      row.netSales,
      rowCost
    );
    accumulateCost(branches, row.branchId, row.branchName, quantity, row.netSales, rowCost);
  }

  const productRows: CostedProductRow[] = [...products.values()]
    .map((row) => {
      const serialized = serializeCostAggregate(row);
      return {
        productId: row.id,
        productName: row.name,
        categoryId: row.categoryId,
        categoryName: row.categoryName,
        quantity: serialized.quantity,
        netSales: serialized.netSales,
        theoreticalCost: serialized.theoreticalCost,
        foodCostPercent: serialized.foodCostPercent,
        grossMargin: serialized.grossMargin,
        marginPerItem: serialized.marginPerItem,
      };
    })
    .sort(
      (left, right) =>
        new Prisma.Decimal(right.netSales).comparedTo(left.netSales) ||
        left.productName.localeCompare(right.productName)
    );
  const grossMargin = costedNetSales.minus(theoreticalCost);
  return {
    range,
    totals: {
      netSales: serializeDecimal(netSales),
      costedNetSales: serializeDecimal(costedNetSales),
      uncostedNetSales: serializeDecimal(netSales.minus(costedNetSales)),
      theoreticalCost: serializeDecimal(theoreticalCost),
      foodCostPercent: shareOfTotal(theoreticalCost, costedNetSales),
      grossMargin: serializeDecimal(grossMargin),
    },
    products: productRows,
    categories: [...categories.values()]
      .map(serializeCostAggregate)
      .sort((left, right) => left.name.localeCompare(right.name)),
    branches: [...branches.values()]
      .map(serializeCostAggregate)
      .sort((left, right) => left.name.localeCompare(right.name)),
    uncostedProducts: [...exclusions.values()]
      .map((row) => ({
        productId: row.productId,
        productName: row.productName,
        categoryName: row.categoryName,
        branchNames: [...row.branchNames].sort().join(', '),
        quantity: row.quantity.toString(),
        netSales: serializeDecimal(row.netSales),
        reason: row.reason,
        missingIngredientCount: row.missingIngredientCount,
      }))
      .sort((left, right) => left.productName.localeCompare(right.productName)),
  };
}

export async function readFoodCostReport(
  db: ScopedDb,
  range: RestaurantReportRange,
  limit = MAX_INTERACTIVE_ROWS
) {
  const report = await buildFoodCostReport(db, range);
  return {
    ...report,
    products: report.products.slice(0, limit),
    categories: report.categories.slice(0, limit),
    branches: report.branches.slice(0, limit),
    uncostedProducts: report.uncostedProducts.slice(0, limit),
    truncated:
      report.products.length > limit ||
      report.categories.length > limit ||
      report.branches.length > limit ||
      report.uncostedProducts.length > limit,
  };
}

function decimalMedian(values: readonly string[]): Prisma.Decimal {
  if (!values.length) return ZERO;
  const ordered = values
    .map((value) => new Prisma.Decimal(value))
    .sort((left, right) => left.comparedTo(right));
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]!
    : ordered[middle - 1]!.plus(ordered[middle]!).dividedBy(2);
}

export type MenuEngineeringQuadrant = 'STAR' | 'PLOWHORSE' | 'PUZZLE' | 'DOG';

export async function readDishProfitabilityReport(
  db: ScopedDb,
  range: RestaurantReportRange,
  limit = MAX_INTERACTIVE_ROWS
) {
  const foodCost = await buildFoodCostReport(db, range);
  const medianVolume = decimalMedian(foodCost.products.map((row) => row.quantity));
  const medianMargin = decimalMedian(foodCost.products.map((row) => row.marginPerItem));
  const menuEngineering = foodCost.products.map((row) => {
    const highVolume = new Prisma.Decimal(row.quantity).greaterThanOrEqualTo(medianVolume);
    const highMargin = new Prisma.Decimal(row.marginPerItem).greaterThanOrEqualTo(medianMargin);
    const quadrant: MenuEngineeringQuadrant = highVolume
      ? highMargin
        ? 'STAR'
        : 'PLOWHORSE'
      : highMargin
        ? 'PUZZLE'
        : 'DOG';
    return { ...row, quadrant };
  });
  return {
    ...foodCost,
    products: foodCost.products.slice(0, limit),
    categories: foodCost.categories.slice(0, limit),
    branches: foodCost.branches.slice(0, limit),
    uncostedProducts: foodCost.uncostedProducts.slice(0, limit),
    thresholds: {
      medianVolume: medianVolume.toString(),
      medianMargin: serializeDecimal(medianMargin),
    },
    byMargin: [...menuEngineering].sort(
      (left, right) =>
        new Prisma.Decimal(right.marginPerItem).comparedTo(left.marginPerItem) ||
        left.productName.localeCompare(right.productName)
    ).slice(0, limit),
    byVolume: [...menuEngineering].sort(
      (left, right) =>
        new Prisma.Decimal(right.quantity).comparedTo(left.quantity) ||
        new Prisma.Decimal(right.marginPerItem).comparedTo(left.marginPerItem) ||
        left.productName.localeCompare(right.productName)
    ).slice(0, limit),
    menuEngineering: menuEngineering.slice(0, limit),
    quadrantCounts: menuEngineering.reduce<Record<MenuEngineeringQuadrant, number>>(
      (counts, row) => ({ ...counts, [row.quadrant]: counts[row.quadrant] + 1 }),
      { STAR: 0, PLOWHORSE: 0, PUZZLE: 0, DOG: 0 }
    ),
    truncated:
      foodCost.products.length > limit ||
      foodCost.categories.length > limit ||
      foodCost.branches.length > limit ||
      foodCost.uncostedProducts.length > limit,
  };
}

export async function readCateringReport(
  db: ScopedDb,
  range: RestaurantReportRange,
  limit = MAX_INTERACTIVE_ROWS
) {
  const parsed = validateRestaurantReportRange(range);
  const rows = await db.restaurantCateringOrder.findMany({
    where: {
      branchId: { in: range.branchIds },
      eventDate: { gte: parsed.from, lte: parsed.to },
    },
    orderBy: [{ eventDate: 'asc' }, { id: 'asc' }],
    take: limit + 1,
    select: {
      id: true,
      organizationId: true,
      eventName: true,
      eventDate: true,
      status: true,
      quotedTotal: true,
      branch: { select: { id: true, name: true } },
      lines: {
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: {
          recipeId: true,
          description: true,
          portions: true,
          costPerPortionSnapshot: true,
        },
      },
      extraCosts: { select: { amount: true } },
      delivery: { select: { scheduledAt: true, deliveredAt: true } },
    },
  });
  const costCache = new Map<
    string,
    Awaited<ReturnType<typeof computeRecipeCost>> | RecipeCostingError
  >();
  const statusRows = new Map<
    string,
    {
      status: string;
      orderCount: number;
      revenue: Prisma.Decimal;
      knownIngredientCost: Prisma.Decimal;
      extras: Prisma.Decimal;
      knownMargin: Prisma.Decimal;
      incompleteMarginCount: number;
    }
  >();
  let revenue = ZERO;
  let knownIngredientCost = ZERO;
  let extras = ZERO;
  let knownMargin = ZERO;
  let missingCostLineCount = 0;
  let missingRevenueOrderCount = 0;
  let incompleteMarginCount = 0;
  let deliveredCount = 0;
  let deliveredOnTimeCount = 0;
  const orders = [];
  for (const order of rows.slice(0, limit)) {
    let orderIngredientCost = ZERO;
    let orderMissingCostLineCount = 0;
    for (const line of order.lines) {
      let costPerPortion = line.costPerPortionSnapshot;
      if (!costPerPortion && line.recipeId) {
        let cost = costCache.get(line.recipeId);
        if (!cost) {
          try {
            cost = await computeRecipeCost({
              organizationId: order.organizationId,
              recipeId: line.recipeId,
            });
          } catch (error) {
            if (!(error instanceof RecipeCostingError)) throw error;
            cost = error;
          }
          costCache.set(line.recipeId, cost);
        }
        if (!(cost instanceof RecipeCostingError) && cost.missing.length === 0)
          costPerPortion = cost.costPerPortion;
      }
      if (!costPerPortion) orderMissingCostLineCount += 1;
      else orderIngredientCost = orderIngredientCost.plus(line.portions.times(costPerPortion));
    }
    const orderExtras = add(order.extraCosts.map((cost) => cost.amount));
    const orderMargin =
      order.quotedTotal && orderMissingCostLineCount === 0
        ? order.quotedTotal.minus(orderIngredientCost).minus(orderExtras)
        : null;
    revenue = revenue.plus(order.quotedTotal ?? ZERO);
    knownIngredientCost = knownIngredientCost.plus(orderIngredientCost);
    extras = extras.plus(orderExtras);
    missingCostLineCount += orderMissingCostLineCount;
    if (!order.quotedTotal) missingRevenueOrderCount += 1;
    if (orderMargin) knownMargin = knownMargin.plus(orderMargin);
    else incompleteMarginCount += 1;
    const deliveredOnTime = order.delivery?.deliveredAt
      ? order.delivery.deliveredAt <= order.delivery.scheduledAt
      : null;
    if (order.delivery?.deliveredAt) {
      deliveredCount += 1;
      if (deliveredOnTime) deliveredOnTimeCount += 1;
    }
    const status = statusRows.get(order.status) ?? {
      status: order.status,
      orderCount: 0,
      revenue: ZERO,
      knownIngredientCost: ZERO,
      extras: ZERO,
      knownMargin: ZERO,
      incompleteMarginCount: 0,
    };
    status.orderCount += 1;
    status.revenue = status.revenue.plus(order.quotedTotal ?? ZERO);
    status.knownIngredientCost = status.knownIngredientCost.plus(orderIngredientCost);
    status.extras = status.extras.plus(orderExtras);
    if (orderMargin) status.knownMargin = status.knownMargin.plus(orderMargin);
    else status.incompleteMarginCount += 1;
    statusRows.set(order.status, status);
    orders.push({
      id: order.id,
      eventName: order.eventName,
      eventDate: dateKey(order.eventDate),
      branchId: order.branch.id,
      branchName: order.branch.name,
      status: order.status,
      quotedTotal: order.quotedTotal ? serializeDecimal(order.quotedTotal) : null,
      ingredientCost:
        orderMissingCostLineCount === 0 ? serializeDecimal(orderIngredientCost) : null,
      extras: serializeDecimal(orderExtras),
      margin: orderMargin ? serializeDecimal(orderMargin) : null,
      missingCostLineCount: orderMissingCostLineCount,
      deliveredOnTime,
    });
  }
  return {
    range,
    totals: {
      orderCount: orders.length,
      revenue: serializeDecimal(revenue),
      knownIngredientCost: serializeDecimal(knownIngredientCost),
      extras: serializeDecimal(extras),
      margin: incompleteMarginCount === 0 ? serializeDecimal(knownMargin) : null,
      missingCostLineCount,
      missingRevenueOrderCount,
      deliveredCount,
      deliveredOnTimeCount,
      deliveredOnTimeRate:
        deliveredCount > 0
          ? serializeDecimal(
              new Prisma.Decimal(deliveredOnTimeCount).dividedBy(deliveredCount).times(100)
            )
          : null,
    },
    byStatus: [...statusRows.values()]
      .sort((left, right) => left.status.localeCompare(right.status))
      .map((row) => ({
        status: row.status,
        orderCount: row.orderCount,
        revenue: serializeDecimal(row.revenue),
        knownIngredientCost: serializeDecimal(row.knownIngredientCost),
        extras: serializeDecimal(row.extras),
        margin: row.incompleteMarginCount === 0 ? serializeDecimal(row.knownMargin) : null,
        incompleteMarginCount: row.incompleteMarginCount,
      })),
    orders,
    truncated: rows.length > limit,
  };
}

export async function readInventoryReport(db: ScopedDb, range: RestaurantReportRange) {
  const parsed = validateRestaurantReportRange(range);
  const [summaryRows, onHandRows, lowStockRows, movementRows] = await Promise.all([
    db.$queryRaw<
      Array<{
        negativeStockCount: number;
        lowStockCount: number;
        valuation: Prisma.Decimal;
        wastageMovementCount: number;
        wastageQuantity: Prisma.Decimal;
      }>
    >(Prisma.sql`
      WITH balances AS (
        SELECT
          movement."stockItemId",
          movement."locationId",
          SUM(movement."quantity") AS "onHand"
        FROM "restaurant_stock_movements" movement
        JOIN "restaurant_stock_locations" location ON location."id" = movement."locationId"
        WHERE location."branchId" IN (${Prisma.join(range.branchIds)})
          AND location."isActive" = true
        GROUP BY movement."stockItemId", movement."locationId"
      ), costs AS (
        SELECT
          movement."stockItemId",
          movement."locationId",
          SUM(movement."quantity" * movement."unitCost") AS "totalCost",
          SUM(movement."quantity") AS "totalQuantity"
        FROM "restaurant_stock_movements" movement
        JOIN "restaurant_stock_locations" location ON location."id" = movement."locationId"
        WHERE location."branchId" IN (${Prisma.join(range.branchIds)})
          AND location."isActive" = true
          AND movement."unitCost" IS NOT NULL
        GROUP BY movement."stockItemId", movement."locationId"
      ), inventory AS (
        SELECT
          balance."stockItemId",
          balance."locationId",
          balance."onHand",
          COALESCE(cost."totalCost" / NULLIF(cost."totalQuantity", 0), 0) AS "weightedAverageCost"
        FROM balances balance
        LEFT JOIN costs cost
          ON cost."stockItemId" = balance."stockItemId"
         AND cost."locationId" = balance."locationId"
      )
      SELECT
        COUNT(*) FILTER (WHERE inventory."onHand" < 0)::int AS "negativeStockCount",
        (
          SELECT COUNT(*)::int
          FROM "restaurant_low_stock_rules" rule
          JOIN "restaurant_stock_locations" location ON location."id" = rule."locationId"
          LEFT JOIN balances balance
            ON balance."stockItemId" = rule."stockItemId"
           AND balance."locationId" = rule."locationId"
          WHERE location."branchId" IN (${Prisma.join(range.branchIds)})
            AND location."isActive" = true
            AND COALESCE(balance."onHand", 0) < rule."threshold"
        ) AS "lowStockCount",
        COALESCE(SUM(inventory."onHand" * inventory."weightedAverageCost"), 0) AS "valuation",
        (
          SELECT COUNT(*)::int
          FROM "restaurant_stock_movements" movement
          JOIN "restaurant_stock_locations" location ON location."id" = movement."locationId"
          WHERE location."branchId" IN (${Prisma.join(range.branchIds)})
            AND movement."occurredAt" >= ${parsed.from}
            AND movement."occurredAt" < ${parsed.toExclusive}
            AND movement."reason" IN ('WASTAGE', 'SPOILAGE', 'STAFF_MEAL')
        ) AS "wastageMovementCount",
        (
          SELECT COALESCE(SUM(ABS(movement."quantity")), 0)
          FROM "restaurant_stock_movements" movement
          JOIN "restaurant_stock_locations" location ON location."id" = movement."locationId"
          WHERE location."branchId" IN (${Prisma.join(range.branchIds)})
            AND movement."occurredAt" >= ${parsed.from}
            AND movement."occurredAt" < ${parsed.toExclusive}
            AND movement."reason" IN ('WASTAGE', 'SPOILAGE', 'STAFF_MEAL')
        ) AS "wastageQuantity"
      FROM inventory
    `),
    db.$queryRaw<
      Array<{
        branchId: string;
        stockItemId: string;
        ingredientName: string;
        locationId: string;
        locationName: string;
        onHand: Prisma.Decimal;
        weightedAverageCost: Prisma.Decimal;
      }>
    >(Prisma.sql`
      WITH balances AS (
        SELECT
          movement."stockItemId",
          movement."locationId",
          SUM(movement."quantity") AS "onHand"
        FROM "restaurant_stock_movements" movement
        JOIN "restaurant_stock_locations" location ON location."id" = movement."locationId"
        WHERE location."branchId" IN (${Prisma.join(range.branchIds)})
          AND location."isActive" = true
        GROUP BY movement."stockItemId", movement."locationId"
      ), costs AS (
        SELECT
          movement."stockItemId",
          movement."locationId",
          SUM(movement."quantity" * movement."unitCost") AS "totalCost",
          SUM(movement."quantity") AS "totalQuantity"
        FROM "restaurant_stock_movements" movement
        JOIN "restaurant_stock_locations" location ON location."id" = movement."locationId"
        WHERE location."branchId" IN (${Prisma.join(range.branchIds)})
          AND location."isActive" = true
          AND movement."unitCost" IS NOT NULL
        GROUP BY movement."stockItemId", movement."locationId"
      )
      SELECT
        location."branchId" AS "branchId",
        balance."stockItemId" AS "stockItemId",
        ingredient."name" AS "ingredientName",
        balance."locationId" AS "locationId",
        location."name" AS "locationName",
        balance."onHand" AS "onHand",
        COALESCE(cost."totalCost" / NULLIF(cost."totalQuantity", 0), 0) AS "weightedAverageCost"
      FROM balances balance
      JOIN "restaurant_stock_locations" location ON location."id" = balance."locationId"
      JOIN "restaurant_stock_items" item ON item."id" = balance."stockItemId"
      JOIN "restaurant_ingredients" ingredient ON ingredient."id" = item."ingredientId"
      LEFT JOIN costs cost
        ON cost."stockItemId" = balance."stockItemId"
       AND cost."locationId" = balance."locationId"
      ORDER BY location."branchId" ASC, ingredient."name" ASC, balance."locationId" ASC
      LIMIT ${MAX_INTERACTIVE_ROWS + 1}
    `),
    db.$queryRaw<
      Array<{
        ruleId: string;
        stockItemId: string;
        locationId: string;
        threshold: Prisma.Decimal;
        onHand: Prisma.Decimal;
      }>
    >(Prisma.sql`
      WITH balances AS (
        SELECT
          movement."stockItemId",
          movement."locationId",
          SUM(movement."quantity") AS "onHand"
        FROM "restaurant_stock_movements" movement
        JOIN "restaurant_stock_locations" location ON location."id" = movement."locationId"
        WHERE location."branchId" IN (${Prisma.join(range.branchIds)})
          AND location."isActive" = true
        GROUP BY movement."stockItemId", movement."locationId"
      )
      SELECT
        rule."id" AS "ruleId",
        rule."stockItemId" AS "stockItemId",
        rule."locationId" AS "locationId",
        rule."threshold" AS "threshold",
        COALESCE(balance."onHand", 0) AS "onHand"
      FROM "restaurant_low_stock_rules" rule
      JOIN "restaurant_stock_locations" location ON location."id" = rule."locationId"
      LEFT JOIN balances balance
        ON balance."stockItemId" = rule."stockItemId"
       AND balance."locationId" = rule."locationId"
      WHERE location."branchId" IN (${Prisma.join(range.branchIds)})
        AND location."isActive" = true
        AND COALESCE(balance."onHand", 0) < rule."threshold"
      ORDER BY rule."locationId" ASC, rule."stockItemId" ASC, rule."id" ASC
      LIMIT ${MAX_INTERACTIVE_ROWS + 1}
    `),
    db.restaurantStockMovement.findMany({
      where: {
        location: { branchId: { in: range.branchIds } },
        occurredAt: { gte: parsed.from, lt: parsed.toExclusive },
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: MAX_INTERACTIVE_ROWS + 1,
      select: {
        id: true,
        stockItemId: true,
        locationId: true,
        reason: true,
        quantity: true,
        unitCost: true,
        occurredAt: true,
      },
    }),
  ]);
  const summary = summaryRows[0] ?? {
    negativeStockCount: 0,
    lowStockCount: 0,
    valuation: ZERO,
    wastageMovementCount: 0,
    wastageQuantity: ZERO,
  };
  const onHand = boundedRows(onHandRows);
  const lowStock = boundedRows(lowStockRows);
  const movements = boundedRows(movementRows);
  return {
    range,
    onHand: onHand.rows.map((row) => ({
      branchId: row.branchId,
      stockItemId: row.stockItemId,
      ingredientName: row.ingredientName,
      locationId: row.locationId,
      locationName: row.locationName,
      onHand: row.onHand.toString(),
      isNegative: row.onHand.lessThan(ZERO),
      weightedAverageCost: row.weightedAverageCost.toString(),
    })),
    negativeStockCount: summary.negativeStockCount,
    lowStockCount: summary.lowStockCount,
    lowStock: lowStock.rows.map((row) => ({
      ...row,
      threshold: row.threshold.toString(),
      onHand: row.onHand.toString(),
    })),
    valuation: serializeDecimal(summary.valuation),
    movements: movements.rows.map((movement) => ({
      ...movement,
      quantity: movement.quantity.toString(),
      unitCost: movement.unitCost?.toString() ?? null,
      occurredAt: movement.occurredAt.toISOString(),
    })),
    wastage: {
      movementCount: summary.wastageMovementCount,
      quantity: summary.wastageQuantity.toString(),
    },
    detailLimits: {
      onHand: onHand.truncated,
      lowStock: lowStock.truncated,
      movements: movements.truncated,
    },
    truncated: onHand.truncated || lowStock.truncated || movements.truncated,
  };
}

async function readInventoryExportRows(db: ScopedDb, range: RestaurantReportRange) {
  validateRestaurantReportRange(range);
  const rows = await db.$queryRaw<
    Array<{
      branchId: string;
      ingredientName: string;
      locationId: string;
      locationName: string;
      stockItemId: string;
      onHand: Prisma.Decimal;
      weightedAverageCost: Prisma.Decimal;
    }>
  >(Prisma.sql`
    WITH balances AS (
      SELECT movement."stockItemId", movement."locationId", SUM(movement."quantity") AS "onHand"
      FROM "restaurant_stock_movements" movement
      JOIN "restaurant_stock_locations" location ON location."id" = movement."locationId"
      WHERE location."branchId" IN (${Prisma.join(range.branchIds)})
        AND location."isActive" = true
      GROUP BY movement."stockItemId", movement."locationId"
    ), costs AS (
      SELECT movement."stockItemId", movement."locationId",
        SUM(movement."quantity" * movement."unitCost") AS "totalCost",
        SUM(movement."quantity") AS "totalQuantity"
      FROM "restaurant_stock_movements" movement
      JOIN "restaurant_stock_locations" location ON location."id" = movement."locationId"
      WHERE location."branchId" IN (${Prisma.join(range.branchIds)})
        AND location."isActive" = true
        AND movement."unitCost" IS NOT NULL
      GROUP BY movement."stockItemId", movement."locationId"
    )
    SELECT location."branchId" AS "branchId", ingredient."name" AS "ingredientName",
      balance."locationId" AS "locationId", location."name" AS "locationName",
      balance."stockItemId" AS "stockItemId", balance."onHand" AS "onHand",
      COALESCE(cost."totalCost" / NULLIF(cost."totalQuantity", 0), 0) AS "weightedAverageCost"
    FROM balances balance
    JOIN "restaurant_stock_locations" location ON location."id" = balance."locationId"
    JOIN "restaurant_stock_items" item ON item."id" = balance."stockItemId"
    JOIN "restaurant_ingredients" ingredient ON ingredient."id" = item."ingredientId"
    LEFT JOIN costs cost ON cost."stockItemId" = balance."stockItemId"
      AND cost."locationId" = balance."locationId"
    ORDER BY location."branchId" ASC, ingredient."name" ASC,
      balance."locationId" ASC, balance."stockItemId" ASC
    LIMIT ${MAX_EXPORT_ROWS + 1}
  `);
  return boundedRows(rows, MAX_EXPORT_ROWS);
}

type WastageAggregateRow = {
  movementCount: number;
  quantity: Prisma.Decimal;
  cost: Prisma.Decimal;
  estimatedCost: Prisma.Decimal;
  estimatedMovementCount: number;
  unvaluedMovementCount: number;
};

type WastageReasonRow = WastageAggregateRow & { reason: string };
type WastageDayRow = WastageAggregateRow & { day: string };
type WastageIngredientRow = WastageAggregateRow & {
  stockItemId: string;
  ingredientName: string;
  canonicalUnit: string;
};

function stockLocationClause(range: RestaurantStockReportRange) {
  return range.stockLocationId
    ? Prisma.sql`AND movement."locationId" = ${range.stockLocationId}`
    : Prisma.empty;
}

function valuedWastageCte(
  range: RestaurantStockReportRange,
  parsed: ReturnType<typeof validateRestaurantReportRange>
) {
  return Prisma.sql`
    WITH current_costs AS (
      SELECT
        movement."stockItemId",
        movement."locationId",
        SUM(movement."quantity" * movement."unitCost")
          / NULLIF(SUM(movement."quantity"), 0) AS "weightedAverageCost"
      FROM "restaurant_stock_movements" movement
      WHERE movement."unitCost" IS NOT NULL
      GROUP BY movement."stockItemId", movement."locationId"
    ), valued_wastage AS (
      SELECT
        movement."id",
        movement."stockItemId",
        movement."locationId",
        location."branchId",
        branch."name" AS "branchName",
        location."name" AS "locationName",
        ingredient."name" AS "ingredientName",
        COALESCE(unit."abbreviation", unit."name") AS "canonicalUnit",
        movement."reason"::text AS "reason",
        movement."occurredAt",
        ABS(movement."quantity") AS "quantity",
        COALESCE(
          movement."unitCost",
          current_costs."weightedAverageCost",
          ingredient."referenceCost"
        ) AS "effectiveUnitCost",
        CASE
          WHEN movement."unitCost" IS NOT NULL THEN 'RECORDED'
          WHEN current_costs."weightedAverageCost" IS NOT NULL THEN 'WEIGHTED_AVERAGE'
          WHEN ingredient."referenceCost" IS NOT NULL THEN 'REFERENCE'
          ELSE 'UNAVAILABLE'
        END AS "valuationSource"
      FROM "restaurant_stock_movements" movement
      JOIN "restaurant_stock_locations" location ON location."id" = movement."locationId"
      JOIN "restaurant_branches" branch ON branch."id" = location."branchId"
      JOIN "restaurant_stock_items" item ON item."id" = movement."stockItemId"
      JOIN "restaurant_ingredients" ingredient ON ingredient."id" = item."ingredientId"
      JOIN "restaurant_units" unit ON unit."id" = item."canonicalUnitId"
      LEFT JOIN current_costs
        ON current_costs."stockItemId" = movement."stockItemId"
       AND current_costs."locationId" = movement."locationId"
      WHERE location."branchId" IN (${Prisma.join(range.branchIds)})
        ${stockLocationClause(range)}
        AND movement."occurredAt" >= ${parsed.from}
        AND movement."occurredAt" < ${parsed.toExclusive}
        AND (
          movement."reason" IN ('WASTAGE', 'SPOILAGE', 'STAFF_MEAL')
          OR (movement."reason" = 'MANUAL_CORRECTION' AND movement."quantity" < 0)
        )
    )
  `;
}

function wastageAggregateSelect() {
  return Prisma.sql`
    COUNT(*)::int AS "movementCount",
    COALESCE(SUM("quantity"), 0) AS "quantity",
    COALESCE(SUM("quantity" * COALESCE("effectiveUnitCost", 0)), 0) AS "cost",
    COALESCE(SUM("quantity" * COALESCE("effectiveUnitCost", 0))
      FILTER (WHERE "valuationSource" <> 'RECORDED'), 0) AS "estimatedCost",
    COUNT(*) FILTER (WHERE "valuationSource" <> 'RECORDED')::int
      AS "estimatedMovementCount",
    COUNT(*) FILTER (WHERE "valuationSource" = 'UNAVAILABLE')::int
      AS "unvaluedMovementCount"
  `;
}

function wastageValuationStatus(row: WastageAggregateRow) {
  if (row.unvaluedMovementCount === row.movementCount) return 'UNVALUED' as const;
  if (row.estimatedMovementCount === 0) return 'RECORDED' as const;
  if (row.estimatedMovementCount === row.movementCount && row.unvaluedMovementCount === 0)
    return 'ESTIMATED' as const;
  return 'MIXED' as const;
}

function serializeWastageGroup<T extends WastageAggregateRow>(row: T, totalCost: Prisma.Decimal) {
  return {
    ...row,
    quantity: row.quantity.toString(),
    cost: serializeDecimal(row.cost),
    estimatedCost: serializeDecimal(row.estimatedCost),
    estimated: row.estimatedMovementCount > 0,
    valuationStatus: wastageValuationStatus(row),
    shareOfTotal: shareOfTotal(row.cost, totalCost),
  };
}

async function readWastageIngredientRows(
  db: ScopedDb,
  range: RestaurantStockReportRange,
  limit: number
) {
  const parsed = validateRestaurantReportRange(range);
  const rows = await db.$queryRaw<WastageIngredientRow[]>(Prisma.sql`
    ${valuedWastageCte(range, parsed)}
    SELECT
      "stockItemId",
      "ingredientName",
      "canonicalUnit",
      ${wastageAggregateSelect()}
    FROM valued_wastage
    GROUP BY "stockItemId", "ingredientName", "canonicalUnit"
    ORDER BY SUM("quantity" * COALESCE("effectiveUnitCost", 0)) DESC,
      "ingredientName" ASC, "stockItemId" ASC
    LIMIT ${limit + 1}
  `);
  return boundedRows(rows, limit);
}

export async function readWastageReport(db: ScopedDb, range: RestaurantStockReportRange) {
  const parsed = validateRestaurantReportRange(range);
  const [reasonRows, dayRows, ingredients] = await Promise.all([
    db.$queryRaw<WastageReasonRow[]>(Prisma.sql`
      ${valuedWastageCte(range, parsed)}
      SELECT "reason", ${wastageAggregateSelect()}
      FROM valued_wastage
      GROUP BY "reason"
      ORDER BY "reason" ASC
    `),
    db.$queryRaw<WastageDayRow[]>(Prisma.sql`
      ${valuedWastageCte(range, parsed)}
      SELECT TO_CHAR("occurredAt", 'YYYY-MM-DD') AS "day", ${wastageAggregateSelect()}
      FROM valued_wastage
      GROUP BY TO_CHAR("occurredAt", 'YYYY-MM-DD')
      ORDER BY "day" ASC
    `),
    readWastageIngredientRows(db, range, MAX_INTERACTIVE_ROWS),
  ]);
  const totals = reasonRows.reduce<WastageAggregateRow>(
    (total, row) => ({
      movementCount: total.movementCount + row.movementCount,
      quantity: total.quantity.plus(row.quantity),
      cost: total.cost.plus(row.cost),
      estimatedCost: total.estimatedCost.plus(row.estimatedCost),
      estimatedMovementCount: total.estimatedMovementCount + row.estimatedMovementCount,
      unvaluedMovementCount: total.unvaluedMovementCount + row.unvaluedMovementCount,
    }),
    {
      movementCount: 0,
      quantity: ZERO,
      cost: ZERO,
      estimatedCost: ZERO,
      estimatedMovementCount: 0,
      unvaluedMovementCount: 0,
    }
  );
  return {
    range,
    totals: {
      movementCount: totals.movementCount,
      quantity: totals.quantity.toString(),
      cost: serializeDecimal(totals.cost),
      estimatedCost: serializeDecimal(totals.estimatedCost),
      estimatedMovementCount: totals.estimatedMovementCount,
      unvaluedMovementCount: totals.unvaluedMovementCount,
    },
    byReason: reasonRows.map((row) => serializeWastageGroup(row, totals.cost)),
    byIngredient: ingredients.rows.map((row) => serializeWastageGroup(row, totals.cost)),
    byDay: dayRows.map((row) => serializeWastageGroup(row, totals.cost)),
    truncated: ingredients.truncated,
  };
}

type StockMovementGroupRow = {
  stockItemId: string;
  ingredientName: string;
  canonicalUnit: string;
  movementCount: number;
  openingQuantity: Prisma.Decimal;
  inQuantity: Prisma.Decimal;
  outQuantity: Prisma.Decimal;
  netQuantity: Prisma.Decimal;
  closingQuantity: Prisma.Decimal;
  openingCost: Prisma.Decimal;
  inCost: Prisma.Decimal;
  outCost: Prisma.Decimal;
  netCost: Prisma.Decimal;
  closingCost: Prisma.Decimal;
  estimatedMovementCount: number;
  unvaluedMovementCount: number;
  totalOpeningQuantity: Prisma.Decimal;
  totalInQuantity: Prisma.Decimal;
  totalOutQuantity: Prisma.Decimal;
  totalNetQuantity: Prisma.Decimal;
  totalClosingQuantity: Prisma.Decimal;
  totalOpeningCost: Prisma.Decimal;
  totalInCost: Prisma.Decimal;
  totalOutCost: Prisma.Decimal;
  totalNetCost: Prisma.Decimal;
  totalClosingCost: Prisma.Decimal;
  totalMovementCount: number;
  totalIngredientCount: number;
  totalEstimatedMovementCount: number;
  totalUnvaluedMovementCount: number;
  totalActivityCost: Prisma.Decimal;
};

async function readStockMovementRows(
  db: ScopedDb,
  range: RestaurantStockReportRange,
  limit: number
) {
  const parsed = validateRestaurantReportRange(range);
  const rows = await db.$queryRaw<StockMovementGroupRow[]>(Prisma.sql`
    WITH current_costs AS (
      SELECT
        movement."stockItemId",
        movement."locationId",
        SUM(movement."quantity" * movement."unitCost")
          / NULLIF(SUM(movement."quantity"), 0) AS "weightedAverageCost"
      FROM "restaurant_stock_movements" movement
      WHERE movement."unitCost" IS NOT NULL
      GROUP BY movement."stockItemId", movement."locationId"
    ), scoped_movements AS (
      SELECT
        movement."stockItemId",
        ingredient."name" AS "ingredientName",
        COALESCE(unit."abbreviation", unit."name") AS "canonicalUnit",
        movement."quantity",
        movement."unitCost",
        movement."occurredAt",
        COALESCE(
          movement."unitCost",
          current_costs."weightedAverageCost",
          ingredient."referenceCost"
        ) AS "effectiveUnitCost",
        COALESCE(current_costs."weightedAverageCost", ingredient."referenceCost")
          AS "balanceUnitCost"
      FROM "restaurant_stock_movements" movement
      JOIN "restaurant_stock_locations" location ON location."id" = movement."locationId"
      JOIN "restaurant_stock_items" item ON item."id" = movement."stockItemId"
      JOIN "restaurant_ingredients" ingredient ON ingredient."id" = item."ingredientId"
      JOIN "restaurant_units" unit ON unit."id" = item."canonicalUnitId"
      LEFT JOIN current_costs
        ON current_costs."stockItemId" = movement."stockItemId"
       AND current_costs."locationId" = movement."locationId"
      WHERE location."branchId" IN (${Prisma.join(range.branchIds)})
        ${stockLocationClause(range)}
        AND movement."occurredAt" < ${parsed.toExclusive}
    ), grouped AS (
      SELECT
        "stockItemId",
        "ingredientName",
        "canonicalUnit",
        COUNT(*) FILTER (WHERE "occurredAt" >= ${parsed.from})::int AS "movementCount",
        COALESCE(SUM("quantity") FILTER (WHERE "occurredAt" < ${parsed.from}), 0)
          AS "openingQuantity",
        COALESCE(SUM("quantity") FILTER (
          WHERE "occurredAt" >= ${parsed.from} AND "quantity" > 0
        ), 0) AS "inQuantity",
        COALESCE(SUM(ABS("quantity")) FILTER (
          WHERE "occurredAt" >= ${parsed.from} AND "quantity" < 0
        ), 0) AS "outQuantity",
        COALESCE(SUM("quantity") FILTER (WHERE "occurredAt" >= ${parsed.from}), 0)
          AS "netQuantity",
        COALESCE(SUM("quantity"), 0) AS "closingQuantity",
        COALESCE(SUM("quantity" * COALESCE("balanceUnitCost", 0)) FILTER (
          WHERE "occurredAt" < ${parsed.from}
        ), 0) AS "openingCost",
        COALESCE(SUM("quantity" * COALESCE("effectiveUnitCost", 0)) FILTER (
          WHERE "occurredAt" >= ${parsed.from} AND "quantity" > 0
        ), 0) AS "inCost",
        COALESCE(SUM(ABS("quantity") * COALESCE("effectiveUnitCost", 0)) FILTER (
          WHERE "occurredAt" >= ${parsed.from} AND "quantity" < 0
        ), 0) AS "outCost",
        COALESCE(SUM("quantity" * COALESCE("effectiveUnitCost", 0)) FILTER (
          WHERE "occurredAt" >= ${parsed.from}
        ), 0) AS "netCost",
        COALESCE(SUM("quantity" * COALESCE("balanceUnitCost", 0)), 0) AS "closingCost",
        COUNT(*) FILTER (
          WHERE "occurredAt" >= ${parsed.from} AND "unitCost" IS NULL
        )::int AS "estimatedMovementCount",
        COUNT(*) FILTER (
          WHERE "occurredAt" >= ${parsed.from} AND "effectiveUnitCost" IS NULL
        )::int AS "unvaluedMovementCount"
      FROM scoped_movements
      GROUP BY "stockItemId", "ingredientName", "canonicalUnit"
      HAVING COUNT(*) FILTER (WHERE "occurredAt" >= ${parsed.from}) > 0
    )
    SELECT
      grouped.*,
      SUM("openingQuantity") OVER () AS "totalOpeningQuantity",
      SUM("inQuantity") OVER () AS "totalInQuantity",
      SUM("outQuantity") OVER () AS "totalOutQuantity",
      SUM("netQuantity") OVER () AS "totalNetQuantity",
      SUM("closingQuantity") OVER () AS "totalClosingQuantity",
      SUM("openingCost") OVER () AS "totalOpeningCost",
      SUM("inCost") OVER () AS "totalInCost",
      SUM("outCost") OVER () AS "totalOutCost",
      SUM("netCost") OVER () AS "totalNetCost",
      SUM("closingCost") OVER () AS "totalClosingCost",
      SUM("movementCount") OVER ()::int AS "totalMovementCount",
      COUNT(*) OVER ()::int AS "totalIngredientCount",
      SUM("estimatedMovementCount") OVER ()::int AS "totalEstimatedMovementCount",
      SUM("unvaluedMovementCount") OVER ()::int AS "totalUnvaluedMovementCount",
      SUM("inCost" + "outCost") OVER () AS "totalActivityCost"
    FROM grouped
    ORDER BY ("inCost" + "outCost") DESC, "ingredientName" ASC, "stockItemId" ASC
    LIMIT ${limit + 1}
  `);
  return boundedRows(rows, limit);
}

function serializeStockMovementRow(row: StockMovementGroupRow) {
  return {
    stockItemId: row.stockItemId,
    ingredientName: row.ingredientName,
    canonicalUnit: row.canonicalUnit,
    movementCount: row.movementCount,
    openingQuantity: row.openingQuantity.toString(),
    inQuantity: row.inQuantity.toString(),
    outQuantity: row.outQuantity.toString(),
    netQuantity: row.netQuantity.toString(),
    closingQuantity: row.closingQuantity.toString(),
    openingCost: serializeDecimal(row.openingCost),
    inCost: serializeDecimal(row.inCost),
    outCost: serializeDecimal(row.outCost),
    netCost: serializeDecimal(row.netCost),
    closingCost: serializeDecimal(row.closingCost),
    estimatedMovementCount: row.estimatedMovementCount,
    unvaluedMovementCount: row.unvaluedMovementCount,
    estimated: row.estimatedMovementCount > 0,
    shareOfTotal: shareOfTotal(row.inCost.plus(row.outCost), row.totalActivityCost),
  };
}

export async function readStockMovementReport(db: ScopedDb, range: RestaurantStockReportRange) {
  const result = await readStockMovementRows(db, range, MAX_INTERACTIVE_ROWS);
  const first = result.rows[0];
  return {
    range,
    totals: {
      movementCount: first?.totalMovementCount ?? 0,
      ingredientCount: first?.totalIngredientCount ?? 0,
      openingQuantity: first?.totalOpeningQuantity.toString() ?? '0',
      inQuantity: first?.totalInQuantity.toString() ?? '0',
      outQuantity: first?.totalOutQuantity.toString() ?? '0',
      netQuantity: first?.totalNetQuantity.toString() ?? '0',
      closingQuantity: first?.totalClosingQuantity.toString() ?? '0',
      openingCost: serializeDecimal(first?.totalOpeningCost ?? ZERO),
      inCost: serializeDecimal(first?.totalInCost ?? ZERO),
      outCost: serializeDecimal(first?.totalOutCost ?? ZERO),
      netCost: serializeDecimal(first?.totalNetCost ?? ZERO),
      closingCost: serializeDecimal(first?.totalClosingCost ?? ZERO),
      estimatedMovementCount: first?.totalEstimatedMovementCount ?? 0,
      unvaluedMovementCount: first?.totalUnvaluedMovementCount ?? 0,
    },
    ingredients: result.rows.map(serializeStockMovementRow),
    truncated: result.truncated,
  };
}

async function readWastageExportRows(db: ScopedDb, range: RestaurantStockReportRange) {
  const parsed = validateRestaurantReportRange(range);
  const rows = await db.$queryRaw<
    Array<{
      id: string;
      day: string;
      branchName: string;
      locationName: string;
      ingredientName: string;
      canonicalUnit: string;
      reason: string;
      quantity: Prisma.Decimal;
      effectiveUnitCost: Prisma.Decimal | null;
      cost: Prisma.Decimal;
      valuationSource: string;
    }>
  >(Prisma.sql`
    ${valuedWastageCte(range, parsed)}
    SELECT
      "id",
      TO_CHAR("occurredAt", 'YYYY-MM-DD') AS "day",
      "branchName",
      "locationName",
      "ingredientName",
      "canonicalUnit",
      "reason",
      "quantity",
      "effectiveUnitCost",
      "quantity" * COALESCE("effectiveUnitCost", 0) AS "cost",
      "valuationSource"
    FROM valued_wastage
    ORDER BY "occurredAt" ASC, "id" ASC
    LIMIT ${MAX_EXPORT_ROWS + 1}
  `);
  return boundedRows(rows, MAX_EXPORT_ROWS);
}

export async function readPurchasingReport(db: ScopedDb, range: RestaurantReportRange) {
  const parsed = validateRestaurantReportRange(range);
  const [summaryRows, statusRows, supplierRows, discrepancyRows] = await Promise.all([
    db.$queryRaw<
      Array<{
        purchaseOrderCount: number;
        purchaseOrderValue: Prisma.Decimal;
        receiptCount: number;
        receivedSupplierSpend: Prisma.Decimal;
        discrepancyCount: number;
      }>
    >(Prisma.sql`
      SELECT
        (
          SELECT COUNT(*)::int
          FROM "restaurant_purchase_orders" purchase_order
          WHERE purchase_order."branchId" IN (${Prisma.join(range.branchIds)})
            AND purchase_order."createdAt" >= ${parsed.from}
            AND purchase_order."createdAt" < ${parsed.toExclusive}
        ) AS "purchaseOrderCount",
        (
          SELECT COALESCE(SUM(line."orderedQuantity" * line."unitCost"), 0)
          FROM "restaurant_purchase_order_lines" line
          JOIN "restaurant_purchase_orders" purchase_order
            ON purchase_order."id" = line."purchaseOrderId"
          WHERE purchase_order."branchId" IN (${Prisma.join(range.branchIds)})
            AND purchase_order."createdAt" >= ${parsed.from}
            AND purchase_order."createdAt" < ${parsed.toExclusive}
        ) AS "purchaseOrderValue",
        (
          SELECT COUNT(*)::int
          FROM "restaurant_purchase_receipts" receipt
          WHERE receipt."branchId" IN (${Prisma.join(range.branchIds)})
            AND receipt."receivedAt" >= ${parsed.from}
            AND receipt."receivedAt" < ${parsed.toExclusive}
        ) AS "receiptCount",
        (
          SELECT COALESCE(SUM(line."receivedQuantity" * line."unitCost"), 0)
          FROM "restaurant_purchase_receipt_lines" line
          JOIN "restaurant_purchase_receipts" receipt
            ON receipt."id" = line."purchaseReceiptId"
          WHERE receipt."branchId" IN (${Prisma.join(range.branchIds)})
            AND receipt."receivedAt" >= ${parsed.from}
            AND receipt."receivedAt" < ${parsed.toExclusive}
        ) AS "receivedSupplierSpend",
        (
          SELECT COUNT(*)::int
          FROM "restaurant_receiving_discrepancies" discrepancy
          JOIN "restaurant_purchase_receipts" receipt
            ON receipt."id" = discrepancy."purchaseReceiptId"
          WHERE receipt."branchId" IN (${Prisma.join(range.branchIds)})
            AND receipt."receivedAt" >= ${parsed.from}
            AND receipt."receivedAt" < ${parsed.toExclusive}
        ) AS "discrepancyCount"
    `),
    db.$queryRaw<Array<{ status: string; count: number }>>(Prisma.sql`
      SELECT purchase_order."status"::text AS "status", COUNT(*)::int AS "count"
      FROM "restaurant_purchase_orders" purchase_order
      WHERE purchase_order."branchId" IN (${Prisma.join(range.branchIds)})
        AND purchase_order."createdAt" >= ${parsed.from}
        AND purchase_order."createdAt" < ${parsed.toExclusive}
      GROUP BY purchase_order."status"
      ORDER BY purchase_order."status" ASC
    `),
    db.$queryRaw<Array<{ supplierName: string; amount: Prisma.Decimal }>>(Prisma.sql`
      SELECT supplier."name" AS "supplierName",
        SUM(line."receivedQuantity" * line."unitCost") AS "amount"
      FROM "restaurant_purchase_receipt_lines" line
      JOIN "restaurant_purchase_receipts" receipt
        ON receipt."id" = line."purchaseReceiptId"
      JOIN "restaurant_suppliers" supplier ON supplier."id" = receipt."supplierId"
      WHERE receipt."branchId" IN (${Prisma.join(range.branchIds)})
        AND receipt."receivedAt" >= ${parsed.from}
        AND receipt."receivedAt" < ${parsed.toExclusive}
      GROUP BY supplier."name"
      ORDER BY supplier."name" ASC
    `),
    db.restaurantReceivingDiscrepancy.findMany({
      where: {
        purchaseReceipt: {
          branchId: { in: range.branchIds },
          receivedAt: { gte: parsed.from, lt: parsed.toExclusive },
        },
      },
      orderBy: [{ purchaseReceipt: { receivedAt: 'asc' } }, { id: 'asc' }],
      take: MAX_INTERACTIVE_ROWS + 1,
      select: {
        id: true,
        kind: true,
        purchaseReceipt: {
          select: { receivedAt: true, supplier: { select: { name: true } } },
        },
      },
    }),
  ]);
  const summary = summaryRows[0] ?? {
    purchaseOrderCount: 0,
    purchaseOrderValue: ZERO,
    receiptCount: 0,
    receivedSupplierSpend: ZERO,
    discrepancyCount: 0,
  };
  const discrepancies = boundedRows(discrepancyRows);
  return {
    range,
    purchaseOrderCount: summary.purchaseOrderCount,
    statusCounts: Object.fromEntries(statusRows.map((row) => [row.status, row.count])),
    purchaseOrderValue: serializeDecimal(summary.purchaseOrderValue),
    receiptCount: summary.receiptCount,
    receivedSupplierSpend: serializeDecimal(summary.receivedSupplierSpend),
    supplierSpend: supplierRows.map((row) => ({
      supplierName: row.supplierName,
      amount: serializeDecimal(row.amount),
    })),
    discrepancyCount: summary.discrepancyCount,
    discrepancies: discrepancies.rows.map((item) => ({
      id: item.id,
      kind: item.kind,
      supplierName: item.purchaseReceipt.supplier.name,
      receivedAt: item.purchaseReceipt.receivedAt.toISOString(),
    })),
    truncated: discrepancies.truncated,
  };
}

export async function readWorkforceReport(
  db: ScopedDb,
  range: RestaurantReportRange,
  options: { includeLabourCosts: boolean }
) {
  const parsed = validateRestaurantReportRange(range);
  const [shiftRows, labour] = await Promise.all([
    db.$queryRaw<Array<{ scheduledShiftCount: number; scheduledHours: Prisma.Decimal }>>(
      Prisma.sql`
        SELECT
          COUNT(*)::int AS "scheduledShiftCount",
          COALESCE(
            SUM(GREATEST(EXTRACT(EPOCH FROM (shift."endAt" - shift."startAt")), 0)) / 3600,
            0
          ) AS "scheduledHours"
        FROM "restaurant_shifts" shift
        WHERE shift."branchId" IN (${Prisma.join(range.branchIds)})
          AND shift."businessDate" >= ${parsed.from}
          AND shift."businessDate" <= ${parsed.to}
          AND shift."status" <> 'CANCELLED'
      `
    ),
    options.includeLabourCosts
      ? db.labourCostFact.aggregate({
          where: {
            branchId: { in: range.branchIds },
            businessDate: { gte: parsed.from, lte: parsed.to },
          },
          _sum: { labourHours: true, labourCost: true },
        })
      : null,
  ]);
  const shifts = shiftRows[0] ?? { scheduledShiftCount: 0, scheduledHours: ZERO };
  return {
    range,
    scheduledShiftCount: shifts.scheduledShiftCount,
    scheduledHours: shifts.scheduledHours.toDecimalPlaces(2).toString(),
    rosterLabel: 'Scheduled roster — not actual attendance',
    labourCostsVisible: options.includeLabourCosts,
    labourHours: options.includeLabourCosts
      ? (labour?._sum.labourHours ?? ZERO).toDecimalPlaces(2).toString()
      : null,
    labourCost: options.includeLabourCosts
      ? serializeDecimal(labour?._sum.labourCost ?? ZERO)
      : null,
    truncated: false,
  };
}

export async function readSopReport(db: ScopedDb, range: RestaurantReportRange) {
  const parsed = validateRestaurantReportRange(range);
  const [summaryRows, outcomeRows, attribution] = await Promise.all([
    db.$queryRaw<
      Array<{
        total: number;
        onTime: number;
        late: number;
        withProof: number;
        verified: number;
        escalated: number;
        performancePoints: Prisma.Decimal;
      }>
    >(Prisma.sql`
      SELECT
        COUNT(*)::int AS "total",
        COUNT(*) FILTER (
          WHERE occurrence."status" IN ('VERIFIED', 'WAIVED', 'MISSED')
            AND COALESCE(occurrence."resolvedAt", occurrence."submittedAt") IS NOT NULL
            AND COALESCE(occurrence."resolvedAt", occurrence."submittedAt") <= occurrence."windowEndsAt"
        )::int AS "onTime",
        COUNT(*) FILTER (
          WHERE occurrence."status" IN ('VERIFIED', 'WAIVED', 'MISSED')
            AND COALESCE(occurrence."resolvedAt", occurrence."submittedAt") IS NOT NULL
            AND COALESCE(occurrence."resolvedAt", occurrence."submittedAt") > occurrence."windowEndsAt"
        )::int AS "late",
        COUNT(*) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM "restaurant_sop_evidence" evidence
            WHERE evidence."occurrenceId" = occurrence."id"
          )
        )::int AS "withProof",
        COUNT(*) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM "restaurant_sop_verifications" verification
            WHERE verification."occurrenceId" = occurrence."id"
              AND verification."action" = 'VERIFY'
          )
        )::int AS "verified",
        COUNT(*) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM "restaurant_sop_escalation_events" event
            WHERE event."occurrenceId" = occurrence."id"
              AND event."kind" = 'FIRED'
          )
        )::int AS "escalated",
        COALESCE(SUM(
          CASE
            WHEN occurrence."status" = 'WAIVED' THEN 50
            WHEN occurrence."status" = 'VERIFIED'
              AND occurrence."resolvedAt" <= occurrence."windowEndsAt" THEN 100
            WHEN occurrence."status" = 'VERIFIED' THEN 75
            ELSE 0
          END
        ), 0)::numeric AS "performancePoints"
      FROM "restaurant_sop_occurrences" occurrence
      WHERE occurrence."branchId" IN (${Prisma.join(range.branchIds)})
        AND occurrence."businessDate" >= ${parsed.from}
        AND occurrence."businessDate" <= ${parsed.to}
    `),
    db.$queryRaw<Array<{ status: string; count: number }>>(Prisma.sql`
      SELECT occurrence."status"::text AS "status", COUNT(*)::int AS "count"
      FROM "restaurant_sop_occurrences" occurrence
      WHERE occurrence."branchId" IN (${Prisma.join(range.branchIds)})
        AND occurrence."businessDate" >= ${parsed.from}
        AND occurrence."businessDate" <= ${parsed.to}
      GROUP BY occurrence."status"
      ORDER BY occurrence."status" ASC
    `),
    db.$queryRaw<
      Array<{
        staffProfileId: string;
        displayName: string;
        department: string | null;
        owned: number;
        completed: number;
      }>
    >(Prisma.sql`
      WITH owned AS (
        SELECT
          COALESCE(occurrence."assignedStaffProfileId", occurrence."claimedByStaffProfileId") AS "staffProfileId",
          COUNT(*)::int AS "owned"
        FROM "restaurant_sop_occurrences" occurrence
        WHERE occurrence."branchId" IN (${Prisma.join(range.branchIds)})
          AND occurrence."businessDate" >= ${parsed.from}
          AND occurrence."businessDate" <= ${parsed.to}
          AND COALESCE(occurrence."assignedStaffProfileId", occurrence."claimedByStaffProfileId") IS NOT NULL
        GROUP BY COALESCE(occurrence."assignedStaffProfileId", occurrence."claimedByStaffProfileId")
      ), completed AS (
        SELECT
          step."completedByStaffProfileId" AS "staffProfileId",
          COUNT(DISTINCT step."occurrenceId")::int AS "completed"
        FROM "restaurant_sop_occurrence_steps" step
        JOIN "restaurant_sop_occurrences" occurrence ON occurrence."id" = step."occurrenceId"
        WHERE occurrence."branchId" IN (${Prisma.join(range.branchIds)})
          AND occurrence."businessDate" >= ${parsed.from}
          AND occurrence."businessDate" <= ${parsed.to}
          AND step."completed" = true
          AND step."completedByStaffProfileId" IS NOT NULL
        GROUP BY step."completedByStaffProfileId"
      ), people AS (
        SELECT owned."staffProfileId" FROM owned
        UNION
        SELECT completed."staffProfileId" FROM completed
      )
      SELECT
        profile."id" AS "staffProfileId",
        profile."displayName" AS "displayName",
        web_user."department" AS "department",
        COALESCE(owned."owned", 0)::int AS "owned",
        COALESCE(completed."completed", 0)::int AS "completed"
      FROM people
      JOIN "restaurant_staff_profiles" profile ON profile."id" = people."staffProfileId"
      LEFT JOIN "users" web_user ON web_user."id" = profile."userId"
      LEFT JOIN owned ON owned."staffProfileId" = people."staffProfileId"
      LEFT JOIN completed ON completed."staffProfileId" = people."staffProfileId"
      ORDER BY profile."displayName" ASC, profile."id" ASC
      LIMIT ${MAX_EXPORT_ROWS + 1}
    `),
  ]);
  const summary = summaryRows[0] ?? {
    total: 0,
    onTime: 0,
    late: 0,
    withProof: 0,
    verified: 0,
    escalated: 0,
    performancePoints: ZERO,
  };
  const attributionRows = boundedRows(attribution, MAX_EXPORT_ROWS);
  return {
    range,
    total: summary.total,
    outcomes: Object.fromEntries(outcomeRows.map((row) => [row.status, row.count])),
    onTime: summary.onTime,
    late: summary.late,
    withProof: summary.withProof,
    verified: summary.verified,
    escalated: summary.escalated,
    performanceScore: summary.total
      ? Math.round(summary.performancePoints.toNumber() / summary.total)
      : 0,
    attribution: attributionRows.rows,
    truncated: attributionRows.truncated,
  };
}

function neutralizeFormula(value: unknown): string {
  const text = String(value ?? '');
  return /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
}

export function csvCell(value: unknown): string {
  const text = neutralizeFormula(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function rowsToCsv(
  rows: readonly Record<string, unknown>[],
  columns: readonly string[]
): string {
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(',')),
  ].join('\n');
}

export type RestaurantReportSection =
  | 'overview'
  | 'payments'
  | 'food-cost'
  | 'dish-profitability'
  | 'catering'
  | 'inventory'
  | 'wastage'
  | 'stock-movements'
  | 'purchasing'
  | 'workforce'
  | 'sop';

export async function exportRestaurantReportCsv(
  db: ScopedDb,
  section: RestaurantReportSection,
  range: RestaurantStockReportRange,
  options: { includeLabourCosts: boolean }
) {
  let rows: Record<string, unknown>[];
  let columns: string[];
  let truncated = false;
  if (section === 'overview') {
    const report = await readOverviewReport(db, range);
    columns = ['from', 'to', 'freshness', 'orders', 'covers', 'closedDays', 'expectedDays'];
    rows = [
      {
        from: range.from,
        to: range.to,
        freshness: report.freshness.status,
        orders: report.orderCount,
        covers: report.coverCount,
        closedDays: report.freshness.closedDayCount,
        expectedDays: report.freshness.expectedDayCount,
      },
    ];
  } else if (section === 'payments') {
    const report = await readPaymentsReport(db, range);
    const countComplete = report.cashCountCoverage.status === 'COMPLETE';
    columns = [
      'from',
      'to',
      'grossSales',
      'netSales',
      'averageCheck',
      'deliveryFeeSales',
      'deliveryFeeRefunds',
      'tax',
      'service',
      'tips',
      'discounts',
      'comps',
      'refunds',
      'voids',
      'cashExpected',
      'cashCounted',
      'cashVariance',
      'cashCountCoverage',
      'cashDrawerSessionCount',
      'cashMissingCountSessionCount',
      'cashUnverifiedCloseSessionCount',
      'cashMismatchedCloseDayCount',
      'cashCountDefinition',
    ];
    rows = [
      {
        from: range.from,
        to: range.to,
        grossSales: report.grossSales,
        netSales: report.netSales,
        averageCheck: report.averageCheck,
        deliveryFeeSales: report.deliveryFeeSales,
        deliveryFeeRefunds: report.deliveryFeeRefunds,
        tax: report.taxTotal,
        service: report.serviceChargeTotal,
        tips: report.tipTotal,
        discounts: report.discountTotal,
        comps: report.compTotal,
        refunds: report.refundTotal,
        voids: report.voidTotal,
        cashExpected: report.cashExpected,
        cashCounted: countComplete ? report.cashCounted : null,
        cashVariance: countComplete ? report.cashVariance : null,
        cashCountCoverage: report.cashCountCoverage.status,
        cashDrawerSessionCount: report.cashCountCoverage.drawerSessionCount,
        cashMissingCountSessionCount: report.cashCountCoverage.missingCountSessionCount,
        cashUnverifiedCloseSessionCount: report.cashCountCoverage.unverifiedCloseSessionCount,
        cashMismatchedCloseDayCount: report.cashCountCoverage.mismatchedCloseDayCount,
        cashCountDefinition:
          'Blank cashCounted/cashVariance means unavailable count evidence; populated values are source-close amounts with COMPLETE count coverage. ' +
          report.cashCountCoverage.definition,
      },
    ];
  } else if (section === 'food-cost') {
    const report = await readFoodCostReport(db, range, MAX_EXPORT_ROWS);
    truncated = report.truncated;
    columns = [
      'productId',
      'product',
      'category',
      'branches',
      'quantity',
      'netSales',
      'theoreticalCost',
      'foodCostPercent',
      'grossMargin',
      'marginPerItem',
      'costStatus',
      'missingIngredientCount',
    ];
    rows = [
      ...report.products.map((row) => ({
        productId: row.productId,
        product: row.productName,
        category: row.categoryName,
        branches: '',
        quantity: row.quantity,
        netSales: row.netSales,
        theoreticalCost: row.theoreticalCost,
        foodCostPercent: row.foodCostPercent,
        grossMargin: row.grossMargin,
        marginPerItem: row.marginPerItem,
        costStatus: 'COSTED',
        missingIngredientCount: 0,
      })),
      ...report.uncostedProducts.map((row) => ({
        productId: row.productId,
        product: row.productName,
        category: row.categoryName,
        branches: row.branchNames,
        quantity: row.quantity,
        netSales: row.netSales,
        theoreticalCost: '',
        foodCostPercent: '',
        grossMargin: '',
        marginPerItem: '',
        costStatus: row.reason,
        missingIngredientCount: row.missingIngredientCount,
      })),
    ].slice(0, MAX_EXPORT_ROWS);
    truncated ||= report.products.length + report.uncostedProducts.length > MAX_EXPORT_ROWS;
  } else if (section === 'dish-profitability') {
    const report = await readDishProfitabilityReport(db, range, MAX_EXPORT_ROWS);
    truncated = report.truncated;
    columns = [
      'marginRank',
      'productId',
      'product',
      'category',
      'quantity',
      'netSales',
      'theoreticalCost',
      'grossMargin',
      'marginPerItem',
      'foodCostPercent',
      'quadrant',
      'medianVolume',
      'medianMargin',
    ];
    rows = report.byMargin.slice(0, MAX_EXPORT_ROWS).map((row, index) => ({
      marginRank: index + 1,
      productId: row.productId,
      product: row.productName,
      category: row.categoryName,
      quantity: row.quantity,
      netSales: row.netSales,
      theoreticalCost: row.theoreticalCost,
      grossMargin: row.grossMargin,
      marginPerItem: row.marginPerItem,
      foodCostPercent: row.foodCostPercent,
      quadrant: row.quadrant,
      medianVolume: report.thresholds.medianVolume,
      medianMargin: report.thresholds.medianMargin,
    }));
  } else if (section === 'catering') {
    const report = await readCateringReport(db, range, MAX_EXPORT_ROWS);
    truncated = report.truncated;
    columns = [
      'eventDate',
      'branch',
      'event',
      'status',
      'quotedRevenue',
      'ingredientCost',
      'extras',
      'margin',
      'missingCostLines',
      'deliveredOnTime',
    ];
    rows = report.orders.map((row) => ({
      eventDate: row.eventDate,
      branch: row.branchName,
      event: row.eventName,
      status: row.status,
      quotedRevenue: row.quotedTotal ?? '',
      ingredientCost: row.ingredientCost ?? '',
      extras: row.extras,
      margin: row.margin ?? '',
      missingCostLines: row.missingCostLineCount,
      deliveredOnTime: row.deliveredOnTime ?? '',
    }));
  } else if (section === 'inventory') {
    const inventory = await readInventoryExportRows(db, range);
    truncated = inventory.truncated;
    columns = ['branchId', 'ingredient', 'location', 'onHand', 'weightedAverageCost', 'negative'];
    rows = inventory.rows.map((row) => ({
      branchId: row.branchId,
      ingredient: row.ingredientName,
      location: row.locationName,
      onHand: row.onHand.toString(),
      weightedAverageCost: row.weightedAverageCost.toString(),
      negative: row.onHand.lessThan(ZERO),
    }));
  } else if (section === 'wastage') {
    const wastage = await readWastageExportRows(db, range);
    truncated = wastage.truncated;
    columns = [
      'day',
      'branch',
      'location',
      'ingredient',
      'canonicalUnit',
      'reason',
      'quantity',
      'unitCost',
      'cost',
      'valuationSource',
      'estimated',
    ];
    rows = wastage.rows.map((row) => ({
      day: row.day,
      branch: row.branchName,
      location: row.locationName,
      ingredient: row.ingredientName,
      canonicalUnit: row.canonicalUnit,
      reason: row.reason,
      quantity: row.quantity.toString(),
      unitCost: row.effectiveUnitCost?.toString() ?? '',
      cost: serializeDecimal(row.cost),
      valuationSource: row.valuationSource,
      estimated: row.valuationSource !== 'RECORDED',
    }));
  } else if (section === 'stock-movements') {
    const movements = await readStockMovementRows(db, range, MAX_EXPORT_ROWS);
    truncated = movements.truncated;
    columns = [
      'ingredient',
      'canonicalUnit',
      'movements',
      'openingQuantity',
      'inQuantity',
      'outQuantity',
      'netQuantity',
      'closingQuantity',
      'openingCost',
      'inCost',
      'outCost',
      'netCost',
      'closingCost',
      'estimatedMovements',
      'unvaluedMovements',
      'shareOfTotal',
    ];
    rows = movements.rows.map((row) => {
      const serialized = serializeStockMovementRow(row);
      return {
        ingredient: serialized.ingredientName,
        canonicalUnit: serialized.canonicalUnit,
        movements: serialized.movementCount,
        openingQuantity: serialized.openingQuantity,
        inQuantity: serialized.inQuantity,
        outQuantity: serialized.outQuantity,
        netQuantity: serialized.netQuantity,
        closingQuantity: serialized.closingQuantity,
        openingCost: serialized.openingCost,
        inCost: serialized.inCost,
        outCost: serialized.outCost,
        netCost: serialized.netCost,
        closingCost: serialized.closingCost,
        estimatedMovements: serialized.estimatedMovementCount,
        unvaluedMovements: serialized.unvaluedMovementCount,
        shareOfTotal: serialized.shareOfTotal,
      };
    });
  } else if (section === 'purchasing') {
    const report = await readPurchasingReport(db, range);
    columns = [
      'from',
      'to',
      'purchaseOrders',
      'purchaseOrderValue',
      'receipts',
      'receivedSupplierSpend',
      'discrepancies',
    ];
    rows = [
      {
        from: range.from,
        to: range.to,
        purchaseOrders: report.purchaseOrderCount,
        purchaseOrderValue: report.purchaseOrderValue,
        receipts: report.receiptCount,
        receivedSupplierSpend: report.receivedSupplierSpend,
        discrepancies: report.discrepancyCount,
      },
    ];
  } else if (section === 'workforce') {
    const report = await readWorkforceReport(db, range, options);
    columns = [
      'from',
      'to',
      'scheduledShifts',
      'scheduledHours',
      'rosterBasis',
      ...(report.labourCostsVisible ? ['labourHours', 'labourCost'] : []),
    ];
    rows = [
      {
        from: range.from,
        to: range.to,
        scheduledShifts: report.scheduledShiftCount,
        scheduledHours: report.scheduledHours,
        rosterBasis: report.rosterLabel,
        ...(report.labourCostsVisible
          ? { labourHours: report.labourHours, labourCost: report.labourCost }
          : {}),
      },
    ];
  } else {
    const report = await readSopReport(db, range);
    truncated = report.truncated;
    columns = ['staffProfileId', 'displayName', 'department', 'owned', 'completed'];
    rows = report.attribution.slice(0, MAX_EXPORT_ROWS).map((row) => ({
      staffProfileId: row.staffProfileId,
      displayName: row.displayName,
      department: row.department,
      owned: row.owned,
      completed: row.completed,
    }));
  }
  return {
    filename: `restaurant-${section}-${range.from}-to-${range.to}.csv`,
    contentType: 'text/csv; charset=utf-8',
    content: rowsToCsv(rows, columns),
    truncated,
  };
}
