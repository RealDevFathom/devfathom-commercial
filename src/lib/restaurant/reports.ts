import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { businessDateToUtcDate } from './business-date';

export const MAX_REPORT_DAYS = 90;
export const MAX_REPORT_BRANCHES = 100;
export const MAX_INTERACTIVE_ROWS = 200;
export const MAX_EXPORT_ROWS = 5_000;

export type RestaurantReportRange = {
  branchIds: string[];
  from: string;
  to: string;
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

type CloseRow = Awaited<ReturnType<typeof loadReportBackbone>>['closes'][number];

async function loadReportBackbone(db: ScopedDb, range: RestaurantReportRange) {
  const parsed = validateRestaurantReportRange(range);
  const where = {
    branchId: { in: range.branchIds },
    businessDate: { gte: parsed.from, lte: parsed.to },
  } as const;
  const [closes, rollups] = await Promise.all([
    db.restaurantDailyClose.findMany({
      where: { ...where, supersededBy: { none: {} } },
      orderBy: [{ businessDate: 'asc' }, { branchId: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        branchId: true,
        businessDate: true,
        supersedesCloseId: true,
        grossSales: true,
        netSales: true,
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
  return { closes, rollups, parsed };
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
        SELECT
          mix."productId" AS "productId",
          product."name" AS "productName",
          SUM(mix."quantity")::bigint AS "quantity"
        FROM "restaurant_insight_item_mix_rollups" mix
        JOIN "restaurant_daily_closes" close
          ON close."id" = mix."sourceDailyCloseId"
        JOIN "restaurant_products" product ON product."id" = mix."productId"
        WHERE mix."branchId" IN (${Prisma.join(range.branchIds)})
          AND mix."businessDate" >= ${parsed.from}
          AND mix."businessDate" <= ${parsed.to}
          AND NOT EXISTS (
            SELECT 1
            FROM "restaurant_daily_closes" successor
            WHERE successor."supersedesCloseId" = close."id"
          )
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
    key: keyof Pick<
      CloseRow,
      | 'grossSales'
      | 'netSales'
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
    >
  ) => add(closes.map((close) => close[key]));
  const netSales = total('netSales');
  return {
    range,
    freshness: freshnessFor(range, parsed, closes, rollups),
    grossSales: serializeDecimal(total('grossSales')),
    netSales: serializeDecimal(netSales),
    averageCheck: serializeDecimal(orderCount > 0 ? netSales.dividedBy(orderCount) : ZERO),
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
      LIMIT ${MAX_INTERACTIVE_ROWS + 1}
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
  const attributionRows = boundedRows(attribution);
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
  'overview' | 'payments' | 'inventory' | 'purchasing' | 'workforce' | 'sop';

export async function exportRestaurantReportCsv(
  db: ScopedDb,
  section: RestaurantReportSection,
  range: RestaurantReportRange,
  options: { includeLabourCosts: boolean }
) {
  let rows: Record<string, unknown>[];
  let columns: string[];
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
    columns = [
      'from',
      'to',
      'grossSales',
      'netSales',
      'averageCheck',
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
    ];
    rows = [
      {
        from: range.from,
        to: range.to,
        grossSales: report.grossSales,
        netSales: report.netSales,
        averageCheck: report.averageCheck,
        tax: report.taxTotal,
        service: report.serviceChargeTotal,
        tips: report.tipTotal,
        discounts: report.discountTotal,
        comps: report.compTotal,
        refunds: report.refundTotal,
        voids: report.voidTotal,
        cashExpected: report.cashExpected,
        cashCounted: report.cashCounted,
        cashVariance: report.cashVariance,
      },
    ];
  } else if (section === 'inventory') {
    const report = await readInventoryReport(db, range);
    columns = ['branchId', 'ingredient', 'location', 'onHand', 'weightedAverageCost', 'negative'];
    rows = report.onHand.slice(0, MAX_EXPORT_ROWS).map((row) => ({
      branchId: row.branchId,
      ingredient: row.ingredientName,
      location: row.locationName,
      onHand: row.onHand,
      weightedAverageCost: row.weightedAverageCost,
      negative: row.isNegative,
    }));
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
  };
}
