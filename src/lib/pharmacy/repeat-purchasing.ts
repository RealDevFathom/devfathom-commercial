import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const DAY = 86_400_000;
export const REPEAT_SCAN_LIMIT = 10_000;
const DETAIL_LIMIT = 1_000;
export const REPEAT_DEFINITION =
  'First observed qualifying original completed receipt across all available data in selected authorized branches; not first-ever customers. Enrollment dates are inclusive UTC days, clipped at the frozen as-of instant. Follow-up uses elapsed 24-hour days; a repeat is a distinct receipt strictly later than first observation, at or before the horizon boundary.';
export const REPEAT_LIMITS =
  'Qualification requires a receipt number, completion timestamp, positive original line value and remaining original units after posted returns, with posted refunds below original line value, all as of cutoff. Partial reversals can qualify. Returns and refunds have no direct matching link: these are independent exclusion tests, not a reconciled net-revenue measure. Current sale status and commercial identity are used; past status/identity changes cannot be reconstructed. Data start, missing receipts, ingestion delays, outages and off-system purchases are unknown; elapsed follow-up does not prove complete observation. No adherence, competitor churn or uplift inference. Anonymous receipts remain in coverage totals, outside person rates. Interactive scans fail explicitly above 10,000 receipts or 1,000 details per relation; no truncated rates.';

export type RepeatFilters = { branchIds: string[]; from: string; to: string; asOf: string };
export function validateRepeatFilters(input: RepeatFilters, now = new Date()) {
  const from = new Date(`${input.from}T00:00:00.000Z`);
  const to = new Date(`${input.to}T00:00:00.000Z`);
  const asOf = new Date(input.asOf);
  if (
    !input.branchIds.length ||
    input.branchIds.length > 100 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.to) ||
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(to.getTime()) ||
    from.toISOString().slice(0, 10) !== input.from ||
    to.toISOString().slice(0, 10) !== input.to ||
    !Number.isFinite(asOf.getTime()) ||
    asOf > now ||
    from > to ||
    to > asOf ||
    to.getTime() - from.getTime() >= 90 * DAY
  )
    throw new Error(
      'Use valid UTC enrollment dates (maximum 90 days), ending on or before a nonfuture as-of cutoff, and 1–100 authorized branches.'
    );
  return { from, toExclusive: new Date(to.getTime() + DAY), asOf };
}

type ReturnLine = {
  id: string;
  canonicalUnits: number;
  createdAt: Date;
  saleReturn: { createdAt: Date };
};
type Line = {
  id: string;
  quantity: number;
  unitPriceMinor: number;
  discountMinor: number;
  canonicalUnits: number;
  createdAt: Date;
  returnLines: ReturnLine[];
};
export type RepeatReceipt = {
  id: string;
  organizationId: string;
  branchId: string;
  status: string;
  originalSaleId: string | null;
  customerId: string | null;
  completedAt: Date | null;
  receiptNumber: number | null;
  createdAt: Date;
  lines: Line[];
  refunds: { id: string; amountMinor: number; createdAt: Date }[];
};
const distinct = <T extends { id: string }>(rows: T[]) => [
  ...new Map(rows.map((row) => [row.id, row])).values(),
];

export function summarizeRepeatPurchasing(
  rows: RepeatReceipt[],
  organizationId: string,
  input: RepeatFilters,
  now = new Date()
) {
  const { from, toExclusive, asOf } = validateRepeatFilters(input, now);
  if (rows.length > REPEAT_SCAN_LIMIT)
    throw new Error(
      'Repeat report unavailable: receipt scan limit exceeded. Select fewer authorized branches; no partial rates were calculated.'
    );
  const selected = distinct(rows).filter(
    (s) =>
      s.organizationId === organizationId &&
      input.branchIds.includes(s.branchId) &&
      s.status === 'COMPLETED' &&
      !s.originalSaleId &&
      s.createdAt <= asOf &&
      (!s.completedAt || s.completedAt <= asOf)
  );
  let missingTimestamp = 0,
    missingReceipt = 0,
    excludedPurchases = 0,
    completedReceipts = 0,
    identifiedReceipts = 0;
  const purchases = new Map<string, Date[]>();
  let earliestObservedAt: Date | null = null;
  for (const sale of selected) {
    if (!sale.completedAt) {
      missingTimestamp++;
      continue;
    }
    if (!earliestObservedAt || sale.completedAt < earliestObservedAt)
      earliestObservedAt = sale.completedAt;
    const enrolledReceipt = sale.completedAt >= from && sale.completedAt < toExclusive;
    if (enrolledReceipt) {
      completedReceipts++;
      if (sale.customerId?.trim()) identifiedReceipts++;
    }
    if (sale.receiptNumber == null) {
      missingReceipt++;
      if (enrolledReceipt) excludedPurchases++;
      continue;
    }
    if (
      sale.lines.length > DETAIL_LIMIT ||
      sale.refunds.length > DETAIL_LIMIT ||
      sale.lines.some((l) => l.returnLines.length > DETAIL_LIMIT)
    )
      throw new Error(
        'Repeat report unavailable: receipt detail limit exceeded. No partial rates were calculated.'
      );
    const lines = distinct(sale.lines).filter((l) => l.createdAt <= asOf);
    const gross = lines.reduce(
      (sum, l) => sum + l.quantity * l.unitPriceMinor - l.discountMinor,
      0
    );
    const units = lines.reduce(
      (sum, l) =>
        sum +
        Math.max(
          0,
          l.canonicalUnits -
            distinct(l.returnLines)
              .filter((r) => r.createdAt <= asOf && r.saleReturn.createdAt <= asOf)
              .reduce((n, r) => n + r.canonicalUnits, 0)
        ),
      0
    );
    const refunded = distinct(sale.refunds)
      .filter((r) => r.createdAt <= asOf)
      .reduce((sum, r) => sum + r.amountMinor, 0);
    if (gross <= 0 || units <= 0 || refunded >= gross) {
      if (enrolledReceipt) excludedPurchases++;
      continue;
    }
    if (sale.customerId?.trim()) {
      const dates = purchases.get(sale.customerId) ?? [];
      dates.push(sale.completedAt);
      purchases.set(sale.customerId, dates);
    }
  }
  const cohorts: { first: Date; repeat: Date | undefined }[] = [];
  let firstObservedBeforeEnrollment = 0;
  for (const dates of purchases.values()) {
    dates.sort((a, b) => a.getTime() - b.getTime());
    const first = dates[0];
    if (first < from) {
      firstObservedBeforeEnrollment++;
      continue;
    }
    if (first >= toExclusive) continue;
    cohorts.push({ first, repeat: dates.find((d) => d > first) });
  }
  return {
    from: input.from,
    to: input.to,
    asOf: asOf.toISOString(),
    earliestObservedAt: earliestObservedAt?.toISOString() ?? null,
    completedReceipts,
    identifiedReceipts,
    anonymousReceipts: completedReceipts - identifiedReceipts,
    identificationCoveragePercent: completedReceipts
      ? (identifiedReceipts / completedReceipts) * 100
      : null,
    missingTimestamp,
    missingReceipt,
    excludedPurchases,
    firstObservedBeforeEnrollment,
    enrolledCustomers: cohorts.length,
    horizons: [30, 60, 90].map((days) => {
      const eligible = cohorts.filter((c) => c.first.getTime() + days * DAY <= asOf.getTime());
      const repeated = eligible.filter(
        (c) => c.repeat && c.repeat.getTime() <= c.first.getTime() + days * DAY
      ).length;
      return {
        days,
        eligible: eligible.length,
        repeated,
        immature: cohorts.length - eligible.length,
        ratePercent: eligible.length ? (repeated / eligible.length) * 100 : null,
      };
    }),
  };
}

export async function readRepeatPurchasing(
  db: ScopedDb,
  organizationId: string,
  input: RepeatFilters
) {
  const { asOf } = validateRepeatFilters(input);
  // ponytail: fail closed at explicit interactive limits; move aggregation to SQL if larger scopes are required.
  const rows = await db.pharmacySale.findMany({
    where: {
      organizationId,
      branchId: { in: input.branchIds },
      status: 'COMPLETED',
      originalSaleId: null,
      createdAt: { lte: asOf },
      OR: [{ completedAt: null }, { completedAt: { lte: asOf } }],
    },
    take: REPEAT_SCAN_LIMIT + 1,
    select: {
      id: true,
      organizationId: true,
      branchId: true,
      status: true,
      originalSaleId: true,
      customerId: true,
      completedAt: true,
      receiptNumber: true,
      createdAt: true,
      lines: {
        take: DETAIL_LIMIT + 1,
        select: {
          id: true,
          quantity: true,
          unitPriceMinor: true,
          discountMinor: true,
          canonicalUnits: true,
          createdAt: true,
          returnLines: {
            take: DETAIL_LIMIT + 1,
            where: {
              organizationId,
              branchId: { in: input.branchIds },
              createdAt: { lte: asOf },
              saleReturn: { createdAt: { lte: asOf } },
            },
            select: {
              id: true,
              canonicalUnits: true,
              createdAt: true,
              saleReturn: { select: { createdAt: true } },
            },
          },
        },
      },
      refunds: {
        take: DETAIL_LIMIT + 1,
        where: { organizationId, branchId: { in: input.branchIds }, createdAt: { lte: asOf } },
        select: { id: true, amountMinor: true, createdAt: true },
      },
    },
  });
  return summarizeRepeatPurchasing(rows, organizationId, input);
}
