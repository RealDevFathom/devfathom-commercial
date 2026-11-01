import 'server-only';
import { reportNetSales } from './report-net-sales';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { businessDateToUtcDate } from './business-date';
import { money } from './money';

export type InsightReportKind = 'operational' | 'financial';

export type InsightRangeInput = {
  branchId?: string;
  from?: string;
  to?: string;
  limit?: number;
};

export type LabourCostInput = {
  branchId: string;
  businessDate: string;
  labourHours: string;
  labourCost: string;
  source: string;
  idempotencyKey: string;
};

export type InsightErrorReason = 'INVALID' | 'NOT_FOUND';

export class InsightError extends Error {
  constructor(
    message: string,
    readonly reason: InsightErrorReason
  ) {
    super(message);
    this.name = 'InsightError';
  }
}

const DAILY_SELECT = {
  id: true,
  branchId: true,
  businessDate: true,
  sourceDailyCloseId: true,
  orderCount: true,
  coverCount: true,
  grossSales: true,
  netSales: true,
  deliveryFeeSales: true,
  deliveryFeeRefunds: true,
  compTotal: true,
  refundTotal: true,
  voidTotal: true,
  drawerVariance: true,
  computedAt: true,
  createdAt: true,
  updatedAt: true,
  branch: { select: { name: true, timezone: true } },
  sourceDailyClose: {
    select: {
      grossSales: true,
      netSales: true,
      compTotal: true,
      discountTotal: true,
      refundTotal: true,
      supersededBy: { select: { id: true }, take: 1 },
    },
  },
} as const;

const ITEM_SELECT = {
  productId: true,
  quantity: true,
  grossSales: true,
  netSales: true,
  compTotal: true,
  product: { select: { name: true } },
} as const;

const LABOUR_SELECT = {
  id: true,
  branchId: true,
  businessDate: true,
  labourHours: true,
  labourCost: true,
  source: true,
  idempotencyKey: true,
  importedAt: true,
  createdAt: true,
  branch: { select: { name: true, timezone: true } },
} as const;

type DailyRow = {
  id: string;
  branchId: string;
  businessDate: Date;
  sourceDailyCloseId: string;
  orderCount: number;
  coverCount: number;
  grossSales: Prisma.Decimal;
  netSales: Prisma.Decimal;
  deliveryFeeSales: Prisma.Decimal;
  deliveryFeeRefunds: Prisma.Decimal;
  compTotal: Prisma.Decimal;
  refundTotal: Prisma.Decimal;
  voidTotal: Prisma.Decimal;
  drawerVariance: Prisma.Decimal;
  computedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  branch: { name: string; timezone: string };
  sourceDailyClose: {
    grossSales: Prisma.Decimal;
    compTotal: Prisma.Decimal;
    discountTotal: Prisma.Decimal;
    refundTotal: Prisma.Decimal;
    supersededBy: Array<{ id: string }>;
  };
};

type ItemRow = {
  productId: string;
  quantity: number;
  grossSales: Prisma.Decimal;
  netSales: Prisma.Decimal;
  compTotal: Prisma.Decimal;
  product: { name: string };
};

type LabourRow = {
  id: string;
  branchId: string;
  businessDate: Date;
  labourHours: Prisma.Decimal;
  labourCost: Prisma.Decimal;
  source: string;
  idempotencyKey: string;
  importedAt: Date;
  createdAt: Date;
  branch: { name: string; timezone: string };
};

export function dateColumnToString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Stable branch-local display; UTC ISO remains alongside it for machines. */
export function formatBranchTimestamp(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}:${value('second')}[${timeZone}]`;
}

function rangeWhere(input: InsightRangeInput) {
  const from = input.from ? businessDateToUtcDate(input.from) : undefined;
  const to = input.to ? businessDateToUtcDate(input.to) : undefined;
  if (from && to && from > to) {
    throw new InsightError('The report start date must not be after the end date.', 'INVALID');
  }
  return {
    ...(input.branchId ? { branchId: input.branchId } : {}),
    ...(from || to
      ? { businessDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {}),
  };
}

function serializeDaily(
  row: DailyRow,
  kind: InsightReportKind,
  loyaltyLiability: Prisma.Decimal = new Prisma.Decimal(0)
) {
  return {
    id: row.id,
    branchId: row.branchId,
    branchName: row.branch.name,
    businessDate: dateColumnToString(row.businessDate),
    orderCount: row.orderCount,
    coverCount: row.coverCount,
    ...(kind === 'financial'
      ? {
          grossSales: row.grossSales.toString(),
          // Read the source components even for cached pre-v4 projections.
          netSales: reportNetSales(row.sourceDailyClose).toString(),
          deliveryFeeSales: row.deliveryFeeSales.toString(),
          deliveryFeeRefunds: row.deliveryFeeRefunds.toString(),
          compTotal: row.compTotal.toString(),
          refundTotal: row.refundTotal.toString(),
          voidTotal: row.voidTotal.toString(),
          drawerVariance: row.drawerVariance.toString(),
          loyaltyLiability: loyaltyLiability.toString(),
        }
      : {}),
    freshness: {
      status:
        row.sourceDailyClose.supersededBy.length === 0 ? ('CURRENT' as const) : ('STALE' as const),
      sourceDailyCloseId: row.sourceDailyCloseId,
      computedAtUtc: row.computedAt.toISOString(),
      computedAtLocal: formatBranchTimestamp(row.computedAt, row.branch.timezone),
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeItem(row: ItemRow, kind: InsightReportKind) {
  return {
    productId: row.productId,
    productName: row.product.name,
    quantity: row.quantity,
    ...(kind === 'financial'
      ? {
          grossSales: row.grossSales.toString(),
          netSales: row.netSales.toString(),
          compTotal: row.compTotal.toString(),
        }
      : {}),
  };
}

export async function listInsightReports(
  db: ScopedDb,
  kind: InsightReportKind,
  input: InsightRangeInput
) {
  const rows = await db.insightDailyRollup.findMany({
    where: rangeWhere(input),
    orderBy: [{ businessDate: 'desc' }, { branchId: 'asc' }],
    take: input.limit ?? 200,
    select: DAILY_SELECT,
  });
  if (kind !== 'financial') return rows.map((row) => serializeDaily(row as DailyRow, kind));
  const dates = [...new Set(rows.map((row) => dateColumnToString(row.businessDate)))];
  const liabilities = await db.insightLoyaltyLiability.findMany({
    where: { businessDate: { in: dates.map(businessDateToUtcDate) } },
    select: { businessDate: true, liability: true },
  });
  const byDate = new Map(
    liabilities.map((fact) => [dateColumnToString(fact.businessDate), fact.liability])
  );
  const emitted = new Set<string>();
  return rows.map((row) => {
    const date = dateColumnToString(row.businessDate);
    const liability = emitted.has(date) ? new Prisma.Decimal(0) : byDate.get(date);
    emitted.add(date);
    return serializeDaily(row as DailyRow, kind, liability);
  });
}

export async function readInsightReport(
  db: ScopedDb,
  kind: InsightReportKind,
  input: { branchId: string; businessDate: string }
) {
  const businessDate = businessDateToUtcDate(input.businessDate);
  const row = await db.insightDailyRollup.findFirst({
    where: { branchId: input.branchId, businessDate },
    select: DAILY_SELECT,
  });
  if (!row) throw new InsightError('Insight report not found.', 'NOT_FOUND');
  const items = await db.insightItemMixRollup.findMany({
    where: { branchId: input.branchId, businessDate },
    orderBy: { productId: 'asc' },
    select: ITEM_SELECT,
  });
  const liability =
    kind === 'financial'
      ? await db.insightLoyaltyLiability.findFirst({
          where: { businessDate },
          select: { liability: true },
        })
      : null;
  return {
    ...serializeDaily(row as DailyRow, kind, liability?.liability),
    itemMix: items.map((item) => serializeItem(item as ItemRow, kind)),
  };
}

function csvCell(value: unknown): string {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows: Array<Record<string, unknown>>, columns: readonly string[]): string {
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(',')),
  ].join('\n');
}

export async function exportInsightReports(
  db: ScopedDb,
  kind: InsightReportKind,
  input: Omit<InsightRangeInput, 'limit'>
) {
  const rows = await listInsightReports(db, kind, { ...input, limit: 5_000 });
  const columns =
    kind === 'financial'
      ? [
          'branchId',
          'branchName',
          'businessDate',
          'orderCount',
          'coverCount',
          'grossSales',
          'netSales',
          'deliveryFeeSales',
          'deliveryFeeRefunds',
          'compTotal',
          'refundTotal',
          'voidTotal',
          'drawerVariance',
          'loyaltyLiability',
        ]
      : ['branchId', 'branchName', 'businessDate', 'orderCount', 'coverCount'];
  return {
    filename: `restaurant-${kind}-report.csv`,
    contentType: 'text/csv; charset=utf-8',
    content: toCsv(rows as Array<Record<string, unknown>>, columns),
  };
}

function serializeLabour(row: LabourRow) {
  return {
    id: row.id,
    branchId: row.branchId,
    branchName: row.branch.name,
    businessDate: dateColumnToString(row.businessDate),
    labourHours: row.labourHours.toString(),
    labourCost: row.labourCost.toString(),
    source: row.source,
    idempotencyKey: row.idempotencyKey,
    importedAtUtc: row.importedAt.toISOString(),
    importedAtLocal: formatBranchTimestamp(row.importedAt, row.branch.timezone),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function importLabourCost(db: ScopedDb, input: LabourCostInput) {
  const labourHours = money(input.labourHours);
  const labourCost = money(input.labourCost);
  if (labourHours.isNegative() || labourCost.isNegative()) {
    throw new InsightError('Labour hours and cost must be non-negative.', 'INVALID');
  }
  const existing = await db.labourCostFact.findFirst({
    where: { idempotencyKey: input.idempotencyKey },
    select: LABOUR_SELECT,
  });
  if (existing) return { fact: serializeLabour(existing as LabourRow), deduplicated: true };
  try {
    const fact = await db.labourCostFact.create({
      data: {
        branchId: input.branchId,
        businessDate: businessDateToUtcDate(input.businessDate),
        labourHours,
        labourCost,
        source: input.source.trim(),
        idempotencyKey: input.idempotencyKey.trim(),
      },
      select: LABOUR_SELECT,
    });
    return { fact: serializeLabour(fact as LabourRow), deduplicated: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const raced = await db.labourCostFact.findFirst({
        where: { idempotencyKey: input.idempotencyKey },
        select: LABOUR_SELECT,
      });
      if (raced) return { fact: serializeLabour(raced as LabourRow), deduplicated: true };
    }
    throw error;
  }
}

export async function listLabourCosts(db: ScopedDb, input: InsightRangeInput) {
  const rows = await db.labourCostFact.findMany({
    where: rangeWhere(input),
    orderBy: [{ businessDate: 'desc' }, { id: 'desc' }],
    take: input.limit ?? 200,
    select: LABOUR_SELECT,
  });
  return rows.map((row) => serializeLabour(row as LabourRow));
}

export async function readLabourCost(db: ScopedDb, id: string) {
  const row = await db.labourCostFact.findUnique({ where: { id }, select: LABOUR_SELECT });
  if (!row) throw new InsightError('Labour cost fact not found.', 'NOT_FOUND');
  return serializeLabour(row as LabourRow);
}

export async function exportLabourCosts(db: ScopedDb, input: Omit<InsightRangeInput, 'limit'>) {
  const rows = await listLabourCosts(db, { ...input, limit: 5_000 });
  return {
    filename: 'restaurant-labour-costs.csv',
    contentType: 'text/csv; charset=utf-8',
    content: toCsv(rows, [
      'branchId',
      'branchName',
      'businessDate',
      'labourHours',
      'labourCost',
      'source',
      'importedAtUtc',
      'importedAtLocal',
    ]),
  };
}
