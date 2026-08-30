import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { businessDateToUtcDate } from './business-date';
import { listStockOnHand } from './inventory';
import { summarizeSopReport } from './sop-reporting';

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
const WASTAGE_REASONS = ['WASTAGE', 'SPOILAGE', 'STAFF_MEAL'] as const;

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
  const itemRows = closes.length
    ? await db.insightItemMixRollup.findMany({
        where: {
          branchId: { in: range.branchIds },
          businessDate: { gte: parsed.from, lte: parsed.to },
        },
        orderBy: [{ businessDate: 'asc' }, { branchId: 'asc' }, { productId: 'asc' }],
        take: MAX_EXPORT_ROWS,
        select: {
          branchId: true,
          businessDate: true,
          sourceDailyCloseId: true,
          productId: true,
          quantity: true,
          product: { select: { name: true } },
        },
      })
    : [];
  const currentItems = itemRows.filter(
    (row) => tipByDay.get(`${row.branchId}:${dateKey(row.businessDate)}`) === row.sourceDailyCloseId
  );
  const topItems = new Map<string, { productId: string; productName: string; quantity: number }>();
  for (const row of currentItems) {
    const current = topItems.get(row.productId) ?? {
      productId: row.productId,
      productName: row.product.name,
      quantity: 0,
    };
    current.quantity += row.quantity;
    topItems.set(row.productId, current);
  }
  return {
    range,
    freshness: freshnessFor(range, parsed, closes, rollups),
    orderCount: currentRollups.reduce((total, row) => total + row.orderCount, 0),
    coverCount: currentRollups.reduce((total, row) => total + row.coverCount, 0),
    topItems: [...topItems.values()]
      .sort(
        (left, right) =>
          right.quantity - left.quantity || left.productId.localeCompare(right.productId)
      )
      .slice(0, 10),
    itemRowsTruncated: itemRows.length === MAX_EXPORT_ROWS,
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
  const byBranch = await Promise.all(
    range.branchIds.map(async (branchId) => ({
      branchId,
      rows: await listStockOnHand(db, { branchId }),
    }))
  );
  const rows = byBranch.flatMap(({ branchId, rows: branchRows }) =>
    branchRows.map((row) => ({ ...row, branchId }))
  );
  rows.sort(
    (left, right) =>
      left.branchId.localeCompare(right.branchId) ||
      left.ingredientName.localeCompare(right.ingredientName) ||
      left.locationId.localeCompare(right.locationId)
  );
  const locationIds = [...new Set(rows.map((row) => row.locationId))];
  const [rules, movements] = await Promise.all([
    locationIds.length
      ? db.restaurantLowStockRule.findMany({
          where: { locationId: { in: locationIds } },
          orderBy: [{ locationId: 'asc' }, { stockItemId: 'asc' }, { id: 'asc' }],
          take: MAX_EXPORT_ROWS,
          select: { id: true, stockItemId: true, locationId: true, threshold: true },
        })
      : [],
    db.restaurantStockMovement.findMany({
      where: {
        location: { branchId: { in: range.branchIds } },
        occurredAt: { gte: parsed.from, lt: parsed.toExclusive },
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: MAX_INTERACTIVE_ROWS,
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
  const balanceByKey = new Map(
    rows.map((row) => [`${row.stockItemId}:${row.locationId}`, row.onHand])
  );
  const lowStock = rules
    .filter((rule) =>
      (balanceByKey.get(`${rule.stockItemId}:${rule.locationId}`) ?? ZERO).lessThan(rule.threshold)
    )
    .map((rule) => ({
      ruleId: rule.id,
      stockItemId: rule.stockItemId,
      locationId: rule.locationId,
      threshold: rule.threshold.toString(),
      onHand: (balanceByKey.get(`${rule.stockItemId}:${rule.locationId}`) ?? ZERO).toString(),
    }));
  const valuation = add(rows.map((row) => row.onHand.times(row.weightedAverageCost)));
  const wastage = movements.filter((movement) =>
    WASTAGE_REASONS.includes(movement.reason as (typeof WASTAGE_REASONS)[number])
  );
  return {
    range,
    onHand: rows.slice(0, MAX_INTERACTIVE_ROWS).map((row) => ({
      branchId: row.branchId,
      stockItemId: row.stockItemId,
      ingredientName: row.ingredientName,
      locationId: row.locationId,
      locationName: row.locationName,
      onHand: row.onHand.toString(),
      isNegative: row.isNegative,
      weightedAverageCost: row.weightedAverageCost.toString(),
    })),
    negativeStockCount: rows.filter((row) => row.isNegative).length,
    lowStock: lowStock.slice(0, MAX_INTERACTIVE_ROWS),
    valuation: serializeDecimal(valuation),
    movements: movements.map((movement) => ({
      ...movement,
      quantity: movement.quantity.toString(),
      unitCost: movement.unitCost?.toString() ?? null,
      occurredAt: movement.occurredAt.toISOString(),
    })),
    wastage: {
      movementCount: wastage.length,
      quantity: wastage.reduce((total, row) => total.plus(row.quantity.abs()), ZERO).toString(),
    },
    truncated:
      rows.length > MAX_INTERACTIVE_ROWS ||
      rules.length === MAX_EXPORT_ROWS ||
      movements.length === MAX_INTERACTIVE_ROWS,
  };
}

export async function readPurchasingReport(db: ScopedDb, range: RestaurantReportRange) {
  const parsed = validateRestaurantReportRange(range);
  const [orderCount, orders, receiptCount, receipts] = await Promise.all([
    db.restaurantPurchaseOrder.count({
      where: {
        branchId: { in: range.branchIds },
        createdAt: { gte: parsed.from, lt: parsed.toExclusive },
      },
    }),
    db.restaurantPurchaseOrder.findMany({
      where: {
        branchId: { in: range.branchIds },
        createdAt: { gte: parsed.from, lt: parsed.toExclusive },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_INTERACTIVE_ROWS,
      select: {
        id: true,
        branchId: true,
        status: true,
        createdAt: true,
        supplier: { select: { name: true } },
        lines: { orderBy: { id: 'asc' }, select: { orderedQuantity: true, unitCost: true } },
      },
    }),
    db.restaurantPurchaseReceipt.count({
      where: {
        branchId: { in: range.branchIds },
        receivedAt: { gte: parsed.from, lt: parsed.toExclusive },
      },
    }),
    db.restaurantPurchaseReceipt.findMany({
      where: {
        branchId: { in: range.branchIds },
        receivedAt: { gte: parsed.from, lt: parsed.toExclusive },
      },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      take: MAX_INTERACTIVE_ROWS,
      select: {
        id: true,
        branchId: true,
        receivedAt: true,
        supplier: { select: { name: true } },
        lines: { orderBy: { id: 'asc' }, select: { receivedQuantity: true, unitCost: true } },
        discrepancies: { orderBy: { id: 'asc' }, select: { id: true, kind: true } },
      },
    }),
  ]);
  const statusCounts: Record<string, number> = {};
  for (const order of orders) statusCounts[order.status] = (statusCounts[order.status] ?? 0) + 1;
  const orderValue = add(
    orders.flatMap((order) => order.lines.map((line) => line.orderedQuantity.times(line.unitCost)))
  );
  const supplierSpend = new Map<string, Prisma.Decimal>();
  for (const receipt of receipts) {
    const value = add(receipt.lines.map((line) => line.receivedQuantity.times(line.unitCost)));
    supplierSpend.set(
      receipt.supplier.name,
      (supplierSpend.get(receipt.supplier.name) ?? ZERO).plus(value)
    );
  }
  return {
    range,
    purchaseOrderCount: orderCount,
    statusCounts,
    purchaseOrderValue: serializeDecimal(orderValue),
    receiptCount,
    receivedSupplierSpend: serializeDecimal(add([...supplierSpend.values()])),
    supplierSpend: [...supplierSpend.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([supplierName, amount]) => ({ supplierName, amount: serializeDecimal(amount) })),
    discrepancyCount: receipts.reduce((total, receipt) => total + receipt.discrepancies.length, 0),
    discrepancies: receipts
      .flatMap((receipt) =>
        receipt.discrepancies.map((item) => ({
          id: item.id,
          kind: item.kind,
          supplierName: receipt.supplier.name,
          receivedAt: receipt.receivedAt.toISOString(),
        }))
      )
      .slice(0, MAX_INTERACTIVE_ROWS),
    truncated: orderCount > orders.length || receiptCount > receipts.length,
  };
}

export async function readWorkforceReport(
  db: ScopedDb,
  range: RestaurantReportRange,
  options: { includeLabourCosts: boolean }
) {
  const parsed = validateRestaurantReportRange(range);
  const [shiftCount, shifts, labour] = await Promise.all([
    db.restaurantShift.count({
      where: {
        branchId: { in: range.branchIds },
        businessDate: { gte: parsed.from, lte: parsed.to },
        status: { not: 'CANCELLED' },
      },
    }),
    db.restaurantShift.findMany({
      where: {
        branchId: { in: range.branchIds },
        businessDate: { gte: parsed.from, lte: parsed.to },
        status: { not: 'CANCELLED' },
      },
      orderBy: [{ businessDate: 'asc' }, { startAt: 'asc' }, { id: 'asc' }],
      take: MAX_EXPORT_ROWS,
      select: {
        id: true,
        branchId: true,
        businessDate: true,
        startAt: true,
        endAt: true,
        status: true,
      },
    }),
    options.includeLabourCosts
      ? db.labourCostFact.findMany({
          where: {
            branchId: { in: range.branchIds },
            businessDate: { gte: parsed.from, lte: parsed.to },
          },
          orderBy: [{ businessDate: 'asc' }, { branchId: 'asc' }, { id: 'asc' }],
          take: MAX_EXPORT_ROWS,
          select: { labourHours: true, labourCost: true },
        })
      : [],
  ]);
  const scheduledMilliseconds = shifts.reduce(
    (total, shift) => total + Math.max(0, shift.endAt.getTime() - shift.startAt.getTime()),
    0
  );
  return {
    range,
    scheduledShiftCount: shiftCount,
    scheduledHours: (scheduledMilliseconds / 3_600_000).toFixed(2),
    rosterLabel: 'Scheduled roster — not actual attendance',
    labourCostsVisible: options.includeLabourCosts,
    labourHours: options.includeLabourCosts
      ? add(labour.map((row) => row.labourHours))
          .toDecimalPlaces(2)
          .toString()
      : null,
    labourCost: options.includeLabourCosts
      ? serializeDecimal(add(labour.map((row) => row.labourCost)))
      : null,
    truncated: shiftCount > shifts.length || labour.length === MAX_EXPORT_ROWS,
  };
}

export async function readSopReport(db: ScopedDb, range: RestaurantReportRange) {
  const parsed = validateRestaurantReportRange(range);
  const total = await db.restaurantSopOccurrence.count({
    where: {
      branchId: { in: range.branchIds },
      businessDate: { gte: parsed.from, lte: parsed.to },
    },
  });
  const rows = await db.restaurantSopOccurrence.findMany({
    where: {
      branchId: { in: range.branchIds },
      businessDate: { gte: parsed.from, lte: parsed.to },
    },
    orderBy: [{ businessDate: 'asc' }, { dueAt: 'asc' }, { id: 'asc' }],
    take: MAX_EXPORT_ROWS,
    select: {
      id: true,
      status: true,
      dueAt: true,
      windowEndsAt: true,
      submittedAt: true,
      resolvedAt: true,
      assignedStaff: {
        select: { id: true, displayName: true, user: { select: { department: true } } },
      },
      claimedBy: {
        select: { id: true, displayName: true, user: { select: { department: true } } },
      },
      steps: {
        select: {
          completed: true,
          completedBy: {
            select: { id: true, displayName: true, user: { select: { department: true } } },
          },
        },
      },
      evidence: { select: { id: true } },
      verifications: { select: { action: true } },
      escalationEvents: { select: { kind: true } },
    },
  });
  return { range, ...summarizeSopReport(rows), truncated: total > rows.length };
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
