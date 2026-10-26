import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const DAY = 86_400_000;
const QUERY_TIMEOUT_MS = 10_000;
export const REPEAT_DEFINITION =
  'First observed qualifying original completed receipt across all available data in selected authorized branches; not first-ever customers. Enrollment dates are inclusive UTC days, clipped at the frozen as-of instant. Follow-up uses elapsed 24-hour days; a repeat is a distinct receipt strictly later than first observation, at or before the horizon boundary.';
export const REPEAT_LIMITS =
  'Qualification requires a receipt number, completion timestamp, positive original line value and remaining original units after posted returns, with posted refunds below original line value, all as of cutoff. Partial reversals can qualify. Returns and refunds have no direct matching link: these are independent exclusion tests, not a reconciled net-revenue measure. Current sale status and commercial identity are used; past status/identity changes cannot be reconstructed. Data start, missing receipts, ingestion delays, outages and off-system purchases are unknown; elapsed follow-up does not prove complete observation. No adherence, competitor churn or uplift inference. Anonymous receipts remain in coverage totals, outside person rates. All available selected history is aggregated in the database; receipt and detail counts are not truncated. Reports exceeding the 10-second database execution budget fail without partial rates. Large branch or chain histories may still exceed this budget; narrower enrollment dates do not reduce the history required.';

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

/** Pure reference for focused semantic tests; production reads aggregate in PostgreSQL. */
export function summarizeRepeatPurchasing(
  rows: RepeatReceipt[],
  organizationId: string,
  input: RepeatFilters,
  now = new Date()
) {
  const { from, toExclusive, asOf } = validateRepeatFilters(input, now);
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
    const lines = distinct(sale.lines).filter((l) => l.createdAt <= asOf);
    const gross = lines.reduce((sum, l) => sum + l.grossMinor - l.discountMinor, 0);
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
  const { from, toExclusive, asOf } = validateRepeatFilters(input);
  const branches = Prisma.join(input.branchIds);
  // Match String.trim() for identity presence, without changing identity grouping.
  const whitespace =
    ' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
  type Aggregate = {
    earliestObservedAt: Date | null;
    completedReceipts: bigint;
    identifiedReceipts: bigint;
    missingTimestamp: bigint;
    missingReceipt: bigint;
    excludedPurchases: bigint;
    firstObservedBeforeEnrollment: bigint;
    enrolledCustomers: bigint;
    days: number;
    eligible: bigint;
    repeated: bigint;
  };
  // ponytail: one snapshot, no nested Prisma payloads or lifetime receipt cap.
  // All relation fan-out stays in PostgreSQL; exactly three scalar rows leave it.
  const rows = await db.$transaction(async (tx) => {
    const [previous] = await tx.$queryRaw<{ timeout: string }[]>`
      SELECT current_setting('statement_timeout') AS timeout`;
    // Respect any stricter caller budget, then restore it after a successful read.
    await tx.$queryRaw(Prisma.sql`
      SELECT set_config('statement_timeout',
        CASE WHEN current_setting('statement_timeout')::interval > interval '0'
          AND current_setting('statement_timeout')::interval < interval '10 seconds'
          THEN current_setting('statement_timeout') ELSE ${String(QUERY_TIMEOUT_MS)} END, true)`);
    const result = await tx.$queryRaw<Aggregate[]>(Prisma.sql`
      WITH originals AS MATERIALIZED (
        SELECT s.id, s."organizationId", s."branchId", s."customerId", s."completedAt", s."receiptNumber",
          COALESCE(length(btrim(s."customerId", ${whitespace})) > 0, false) AS identified,
          s."completedAt" >= ${from} AND s."completedAt" < ${toExclusive} AS enrolled
        FROM pharmacy_sales s
        WHERE s."organizationId" = ${organizationId} AND s."branchId" IN (${branches})
          AND s.status = 'COMPLETED' AND s."originalSaleId" IS NULL
          AND s."createdAt" <= ${asOf} AND (s."completedAt" IS NULL OR s."completedAt" <= ${asOf})
      ), eligible_originals AS MATERIALIZED (
        SELECT * FROM originals WHERE "completedAt" IS NOT NULL AND "receiptNumber" IS NOT NULL
      ), lines AS MATERIALIZED (
        SELECT l.id, l."saleId", l."organizationId", l."branchId", l."canonicalUnits",
          l."grossMinor"::numeric - l."discountMinor" AS gross
        FROM pharmacy_sale_lines l JOIN eligible_originals s
          ON s.id = l."saleId" AND s."organizationId" = l."organizationId" AND s."branchId" = l."branchId"
        WHERE l."organizationId" = ${organizationId} AND l."branchId" IN (${branches}) AND l."createdAt" <= ${asOf}
      ), returned AS (
        SELECT l.id, sum(r."canonicalUnits"::numeric) AS units
        FROM lines l JOIN pharmacy_sale_return_lines r
          ON r."saleLineId" = l.id AND r."organizationId" = l."organizationId" AND r."branchId" = l."branchId"
        JOIN pharmacy_sale_returns h ON h.id = r."returnId" AND h."organizationId" = r."organizationId"
          AND h."branchId" = r."branchId" AND h."originalSaleId" = l."saleId"
        WHERE r."organizationId" = ${organizationId} AND r."branchId" IN (${branches}) AND r."createdAt" <= ${asOf}
          AND h."organizationId" = ${organizationId} AND h."branchId" IN (${branches}) AND h."createdAt" <= ${asOf}
        GROUP BY l.id
      ), line_totals AS (
        SELECT l."saleId", sum(l.gross) AS gross,
          sum(greatest(0, l."canonicalUnits" - coalesce(r.units, 0))) AS units
        FROM lines l LEFT JOIN returned r ON r.id = l.id GROUP BY l."saleId"
      ), refunded AS (
        SELECT s.id, sum(r."amountMinor"::numeric) AS amount
        FROM eligible_originals s JOIN pharmacy_refunds r
          ON r."saleId" = s.id AND r."organizationId" = s."organizationId" AND r."branchId" = s."branchId"
        WHERE r."organizationId" = ${organizationId} AND r."branchId" IN (${branches}) AND r."createdAt" <= ${asOf}
        GROUP BY s.id
      ), qualified AS (
        SELECT s.id FROM eligible_originals s JOIN line_totals l ON l."saleId" = s.id
        LEFT JOIN refunded r ON r.id = s.id
        WHERE l.gross > 0 AND l.units > 0 AND coalesce(r.amount, 0) < l.gross
      ), purchases AS (
        SELECT s."customerId", s."completedAt",
          dense_rank() OVER (PARTITION BY s."customerId" ORDER BY s."completedAt") AS observation
        FROM originals s JOIN qualified q ON q.id = s.id WHERE s.identified
      ), people AS (
        SELECT "customerId", min("completedAt") AS first,
          min("completedAt") FILTER (WHERE observation = 2) AS repeat
        FROM purchases GROUP BY "customerId"
      ), coverage AS (
        SELECT min(s."completedAt") AS "earliestObservedAt",
          count(*) FILTER (WHERE s.enrolled) AS "completedReceipts",
          count(*) FILTER (WHERE s.enrolled AND s.identified) AS "identifiedReceipts",
          count(*) FILTER (WHERE s."completedAt" IS NULL) AS "missingTimestamp",
          count(*) FILTER (WHERE s."completedAt" IS NOT NULL AND s."receiptNumber" IS NULL) AS "missingReceipt",
          count(*) FILTER (WHERE s.enrolled AND q.id IS NULL) AS "excludedPurchases"
        FROM originals s LEFT JOIN qualified q ON q.id = s.id
      ), cohorts AS (
        SELECT count(*) FILTER (WHERE first < ${from}) AS "firstObservedBeforeEnrollment",
          count(*) FILTER (WHERE first >= ${from} AND first < ${toExclusive}) AS "enrolledCustomers"
        FROM people
      ), horizons AS (
        SELECT h.days,
          count(*) FILTER (WHERE p.first + h.days * interval '24 hours' <= ${asOf}) AS eligible,
          count(*) FILTER (WHERE p.first + h.days * interval '24 hours' <= ${asOf}
            AND p.repeat <= p.first + h.days * interval '24 hours') AS repeated
        FROM (VALUES (30), (60), (90)) h(days)
        LEFT JOIN people p ON p.first >= ${from} AND p.first < ${toExclusive}
        GROUP BY h.days
      )
      SELECT * FROM coverage CROSS JOIN cohorts CROSS JOIN horizons ORDER BY days
    `);
    await tx.$queryRaw`SELECT set_config('statement_timeout', ${previous.timeout}, true)`;
    return result;
  });
  if (rows.length !== 3) throw new Error('Repeat report unavailable: incomplete aggregate result.');
  const count = (value: bigint) => {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0)
      throw new Error('Repeat report unavailable: aggregate count exceeds safe response limits.');
    return result;
  };
  const totals = rows[0];
  const completedReceipts = count(totals.completedReceipts);
  const identifiedReceipts = count(totals.identifiedReceipts);
  const enrolledCustomers = count(totals.enrolledCustomers);
  return {
    from: input.from,
    to: input.to,
    asOf: asOf.toISOString(),
    earliestObservedAt: totals.earliestObservedAt?.toISOString() ?? null,
    completedReceipts,
    identifiedReceipts,
    anonymousReceipts: completedReceipts - identifiedReceipts,
    identificationCoveragePercent: completedReceipts
      ? (identifiedReceipts / completedReceipts) * 100
      : null,
    missingTimestamp: count(totals.missingTimestamp),
    missingReceipt: count(totals.missingReceipt),
    excludedPurchases: count(totals.excludedPurchases),
    firstObservedBeforeEnrollment: count(totals.firstObservedBeforeEnrollment),
    enrolledCustomers,
    horizons: rows.map((row) => {
      const eligible = count(row.eligible);
      const repeated = count(row.repeated);
      return {
        days: row.days,
        eligible,
        repeated,
        immature: enrolledCustomers - eligible,
        ratePercent: eligible ? (repeated / eligible) * 100 : null,
      };
    }),
  };
}
