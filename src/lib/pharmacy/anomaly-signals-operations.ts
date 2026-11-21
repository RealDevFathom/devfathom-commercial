import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { pharmacyBranchDayWindows } from './business-day';
import {
  detectPharmacyAnomalies,
  type AnomalyCandidate,
  type AnomalyFactSet,
} from './anomaly-signals';
import { validatePharmacyReportFilters, type PharmacyReportFilters } from './reports';

const LIVE_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'SNOOZED', 'STALE'] as const;

type ShrinkageRow = {
  countLineId: string;
  branchId: string;
  userId: string;
  medicineId: string;
  batchId: string;
  expectedUnits: number;
  countedUnits: number;
  varianceUnits: number;
  approvedThresholdUnits: number;
  occurredAt: Date;
};
type DiscountRow = {
  branchId: string;
  userId: string;
  affectedLines: number;
  approvedOverrideLines: number;
  grossMinor: number;
  discountMinor: number;
  occurredAt: Date;
};
type ReturnRow = {
  branchId: string;
  userId: string;
  unmatchedRefunds: number;
  unmatchedAmountMinor: number;
  occurredAt: Date;
};
type CashRow = {
  closeId: string;
  branchId: string;
  userId: string;
  businessDate: Date;
  expectedMinor: number;
  countedMinor: number;
  varianceMinor: number;
  occurredAt: Date;
};
type StaffVoidRow = {
  branchId: string;
  userId: string;
  voidEvents: number;
  /** DEV-1004: of `voidEvents`, the bill lines whose changes took value off overall. */
  lineVoids: number;
  lineVoidNetMinor: number;
  completedSales: number;
  occurredAt: Date;
};
type TenderMismatchRow = {
  closeId: string;
  branchId: string;
  userId: string;
  businessDate: Date;
  tenderNetMinor: number;
  closeExpectedMinor: number;
  mismatchMinor: number;
  occurredAt: Date;
};
type PriceRow = {
  receiptLineId: string;
  branchId: string;
  supplierId: string;
  medicineId: string;
  packLevelId: string;
  batchId: string;
  currentUnitCostMinor: number;
  trailingUnitCostMinor: number;
  comparisonReceipts: number;
  occurredAt: Date;
};

function medicineFilter(ingredientId?: string) {
  return ingredientId
    ? Prisma.sql`AND EXISTS (SELECT 1 FROM "pharmacy_medicine_strength_components" msc WHERE msc."medicineId"=lot."batchMedicineId" AND msc."ingredientId"=${ingredientId})`
    : Prisma.empty;
}

/** Reads only existing pharmacy ledgers/documents and returns detector facts. */
export async function readPharmacyAnomalyFacts(
  db: ScopedDb,
  filters: PharmacyReportFilters,
  observedAt = new Date()
): Promise<{ facts: AnomalyFactSet; windowStart: Date; windowEnd: Date }> {
  const window = validatePharmacyReportFilters(filters);
  // Business-date columns compare against `window`; event timestamps (count approvals, sale
  // events, receipt postings) use the workspace day, so 00:30 in Karachi counts on that date.
  // DEV-958A: the branches' business days, ending at their "day ends at" hour. One window per
  // call: refresh and read split a mixed set of branches into groups that share one.
  const events = singleWindow(filters);
  const branches = Prisma.join(filters.branchIds);
  const ingredient = medicineFilter(filters.ingredientId);
  const batch = filters.batchId
    ? Prisma.sql`AND lot."manufacturingBatchId"=${filters.batchId}`
    : Prisma.empty;

  const shrinkage = filters.supplierId
    ? []
    : await db.$queryRaw<ShrinkageRow[]>(Prisma.sql`
        SELECT cl."id" AS "countLineId", cl."branchId", c."createdById" AS "userId", lot."batchMedicineId" AS "medicineId",
               lot."manufacturingBatchId" AS "batchId", cl."expectedUnits", cl."countedUnits",
               cl."varianceUnits", c."varianceThreshold" AS "approvedThresholdUnits", c."approvedAt" AS "occurredAt"
        FROM "pharmacy_inventory_count_lines" cl
        JOIN "pharmacy_inventory_counts" c ON c."organizationId"=cl."organizationId" AND c."id"=cl."countId"
        JOIN (
          SELECT il.*, mb."medicineId" AS "batchMedicineId"
          FROM "pharmacy_inventory_lots" il
          JOIN "pharmacy_manufacturing_batches" mb ON mb."organizationId"=il."organizationId" AND mb."id"=il."manufacturingBatchId"
        ) lot ON lot."organizationId"=cl."organizationId" AND lot."branchId"=cl."branchId" AND lot."id"=cl."inventoryLotId"
        WHERE cl."branchId" IN (${branches}) AND c."status"='APPROVED' AND cl."varianceUnits" IS NOT NULL
          AND c."approvedAt">=${events.from} AND c."approvedAt"<${events.to} ${ingredient} ${batch}
        ORDER BY c."approvedAt" DESC LIMIT 500`);

  const discountOverride =
    filters.supplierId || filters.ingredientId || filters.batchId
      ? []
      : await db.$queryRaw<DiscountRow[]>(Prisma.sql`
          SELECT s."branchId", s."createdByUserId" AS "userId", COUNT(*)::int AS "affectedLines",
                 COUNT(*) FILTER (WHERE l."approvedByUserId" IS NOT NULL)::int AS "approvedOverrideLines",
                 COALESCE(SUM(l."grossMinor"),0)::int AS "grossMinor",
                 COALESCE(SUM(l."discountMinor"),0)::int AS "discountMinor", MAX(s."completedAt") AS "occurredAt"
          FROM "pharmacy_sale_lines" l
          JOIN "pharmacy_sales" s ON s."organizationId"=l."organizationId" AND s."branchId"=l."branchId" AND s."id"=l."saleId"
          WHERE s."branchId" IN (${branches}) AND s."status"='COMPLETED'
            AND s."businessDate">=${window.from} AND s."businessDate"<${window.to}
            AND (l."discountMinor">0 OR l."approvedByUserId" IS NOT NULL)
          GROUP BY s."branchId", s."createdByUserId" ORDER BY MAX(s."completedAt") DESC LIMIT 200`);

  const ghostReturn =
    filters.supplierId || filters.ingredientId || filters.batchId
      ? []
      : await db.$queryRaw<ReturnRow[]>(Prisma.sql`
          SELECT r."branchId", r."actorId" AS "userId", COUNT(*)::int AS "unmatchedRefunds",
                 COALESCE(SUM(r."amountMinor"),0)::int AS "unmatchedAmountMinor", MAX(r."createdAt") AS "occurredAt"
          FROM "pharmacy_refunds" r
          WHERE r."branchId" IN (${branches}) AND r."businessDate">=${window.from} AND r."businessDate"<${window.to}
            AND NOT EXISTS (SELECT 1 FROM "pharmacy_sale_returns" sr WHERE sr."organizationId"=r."organizationId" AND sr."branchId"=r."branchId" AND sr."originalSaleId"=r."saleId")
          GROUP BY r."branchId", r."actorId" ORDER BY MAX(r."createdAt") DESC LIMIT 200`);

  // DEV-1004: since DEV-977B a bill line lowered at the counter is taken off onto its own void
  // record, so every reduction (3 to 1, and 1 back to 3) wrote a void. Each line is now followed
  // through its own changes: a quantity or unit change nets only against the line that replaced
  // it, and that line against its own replacement, so 3 to 1 and back to 3 takes nothing off and
  // 3 to 1 takes off the value of 2. A removal ends the line and counts its value in full.
  // Nothing on one line offsets another line or another medicine: removing one line while
  // raising or adding another still counts the removal, and each add-then-remove counts once.
  // Values leave out a line's whole-bill discount share, which a bill discount given later
  // rewrites in place (bill-discount-service.ts). The line is credited to whoever made its last
  // change. Whole-bill voids count one each, as before. The shift report and the cash-close
  // check still count every void (cash-shifts.ts, cash-close-check-operations.ts).
  const staffVoidRows =
    filters.supplierId || filters.ingredientId || filters.batchId
      ? []
      : await db.$queryRaw<
          Array<Omit<StaffVoidRow, 'lineVoidNetMinor'> & { lineVoidNetMinor: bigint | number }>
        >(Prisma.sql`
          WITH RECURSIVE window_events AS (
            SELECT e."organizationId", e."branchId", e."actorId", e."kind", e."payload", e."occurredAt"
            FROM "pharmacy_sale_events" e
            WHERE e."branchId" IN (${branches}) AND e."occurredAt">=${events.from} AND e."occurredAt"<${events.to}
          ),
          line_changes AS (
            SELECT e."branchId", e."actorId", e."occurredAt", moved."id" AS "movedId",
                   replacement."id" AS "replacementId",
                   (moved."grossMinor"-(moved."discountMinor"-moved."billDiscountMinor"))::bigint
                     - COALESCE((replacement."grossMinor"-(replacement."discountMinor"-replacement."billDiscountMinor"))::bigint, 0)
                     AS "takenOffMinor"
            FROM window_events e
            JOIN "pharmacy_sale_lines" moved
              ON moved."organizationId"=e."organizationId" AND moved."id"=e."payload"->>'saleLineId'
            LEFT JOIN "pharmacy_sale_lines" replacement
              ON e."payload"->>'cause'='LINE_CHANGED' AND replacement."organizationId"=e."organizationId"
             AND replacement."idempotencyKey"=e."payload"->>'lineChangeKey'
            WHERE e."kind"='CREATED' AND (e."payload"->>'lineChangeKey') IS NOT NULL
          ),
          line_chains AS (
            SELECT c."movedId" AS "rootId", c."replacementId", c."takenOffMinor", c."branchId",
                   c."actorId", c."occurredAt", 1 AS "depth"
            FROM line_changes c
            WHERE NOT EXISTS (SELECT 1 FROM line_changes earlier WHERE earlier."replacementId"=c."movedId")
            UNION ALL
            SELECT chain."rootId", next."replacementId", next."takenOffMinor", next."branchId",
                   next."actorId", next."occurredAt", chain."depth"+1
            FROM line_chains chain
            JOIN line_changes next ON next."movedId"=chain."replacementId"
          ),
          line_voids AS (
            SELECT (ARRAY_AGG("branchId" ORDER BY "depth" DESC))[1] AS "branchId",
                   (ARRAY_AGG("actorId" ORDER BY "depth" DESC))[1] AS "userId",
                   SUM("takenOffMinor") AS "netMinor", MAX("occurredAt") AS "occurredAt"
            FROM line_chains
            GROUP BY "rootId"
          ),
          staff_activity AS (
            SELECT e."branchId", e."actorId" AS "userId",
                   COUNT(*) FILTER (WHERE e."kind"='VOIDED' AND (e."payload"->>'fromSaleId') IS NULL)::int AS "voidEvents",
                   0::int AS "lineVoids", 0::bigint AS "lineVoidNetMinor",
                   0::int AS "completedSales", MAX(e."occurredAt") AS "occurredAt"
            FROM window_events e
            GROUP BY e."branchId", e."actorId"
            UNION ALL
            SELECT v."branchId", v."userId",
                   COUNT(*) FILTER (WHERE v."netMinor">0)::int,
                   COUNT(*) FILTER (WHERE v."netMinor">0)::int,
                   COALESCE(SUM(v."netMinor") FILTER (WHERE v."netMinor">0), 0)::bigint,
                   0::int, MAX(v."occurredAt")
            FROM line_voids v
            GROUP BY v."branchId", v."userId"
            UNION ALL
            SELECT s."branchId", s."createdByUserId", 0::int, 0::int, 0::bigint, COUNT(*)::int, MAX(s."completedAt")
            FROM "pharmacy_sales" s
            WHERE s."branchId" IN (${branches}) AND s."status"='COMPLETED'
              AND s."businessDate">=${window.from} AND s."businessDate"<${window.to}
            GROUP BY s."branchId", s."createdByUserId"
          )
          SELECT "branchId", "userId", SUM("voidEvents")::int AS "voidEvents",
                 SUM("lineVoids")::int AS "lineVoids",
                 SUM("lineVoidNetMinor")::bigint AS "lineVoidNetMinor",
                 SUM("completedSales")::int AS "completedSales", MAX("occurredAt") AS "occurredAt"
          FROM staff_activity GROUP BY "branchId", "userId"
          ORDER BY MAX("occurredAt") DESC LIMIT 200`);
  // The net value is summed as a 64-bit number in the database; it reaches the signal as a
  // JavaScript number, exact for any total below 2^53 minor units.
  const staffVoid: StaffVoidRow[] = staffVoidRows.map((row) => ({
    ...row,
    lineVoidNetMinor: Number(row.lineVoidNetMinor),
  }));

  // A close that was superseded, or reopened for trading (DEV-631) and so awaiting the
  // close that restates the day, is not the day's standing close.
  const cashVariance =
    filters.supplierId || filters.ingredientId || filters.batchId
      ? []
      : await db.$queryRaw<CashRow[]>(Prisma.sql`
          SELECT c."id" AS "closeId", c."branchId", c."actorId" AS "userId", c."businessDate", c."cashExpectedMinor" AS "expectedMinor",
                 c."cashCountedMinor" AS "countedMinor", c."cashVarianceMinor" AS "varianceMinor", c."createdAt" AS "occurredAt"
          FROM "pharmacy_daily_closes" c
          WHERE c."branchId" IN (${branches}) AND c."isFinal"=true
            AND c."businessDate">=${window.from} AND c."businessDate"<${window.to}
            AND NOT EXISTS (SELECT 1 FROM "pharmacy_daily_closes" newer WHERE newer."organizationId"=c."organizationId" AND newer."branchId"=c."branchId" AND newer."businessDate"=c."businessDate" AND newer."sequence">c."sequence")
            AND NOT EXISTS (SELECT 1 FROM "pharmacy_day_reopens" reopen WHERE reopen."organizationId"=c."organizationId" AND reopen."closeId"=c."id")
          ORDER BY c."businessDate" DESC LIMIT 200`);

  const tenderMismatch =
    filters.supplierId || filters.ingredientId || filters.batchId
      ? []
      : await db.$queryRaw<TenderMismatchRow[]>(Prisma.sql`
          SELECT c."id" AS "closeId", c."branchId", c."actorId" AS "userId", c."businessDate",
                 (cash."tenderMinor"-cash."refundMinor")::int AS "tenderNetMinor",
                 (c."cashExpectedMinor"-drawer."adjustmentMinor")::int AS "closeExpectedMinor",
                 (cash."tenderMinor"-cash."refundMinor"-c."cashExpectedMinor"+drawer."adjustmentMinor")::int AS "mismatchMinor",
                 c."createdAt" AS "occurredAt"
          FROM "pharmacy_daily_closes" c
          CROSS JOIN LATERAL (
            SELECT COALESCE(SUM(t."amountMinor"),0)::int AS "tenderMinor",
                   COALESCE((SELECT SUM(r."amountMinor") FROM "pharmacy_refunds" r
                     JOIN "pharmacy_tenders" original ON original."organizationId"=r."organizationId" AND original."id"=r."originalTenderId"
                     WHERE r."organizationId"=c."organizationId" AND r."branchId"=c."branchId"
                       AND r."businessDate"=c."businessDate" AND original."type"='CASH'),0)::int AS "refundMinor"
            FROM "pharmacy_tenders" t
            WHERE t."organizationId"=c."organizationId" AND t."branchId"=c."branchId"
              AND t."businessDate"=c."businessDate" AND t."type"='CASH'
          ) cash
          -- The close includes opening floats and paid-in/out movements. Remove
          -- those adjustments to compare both sides on a net cash-tender basis.
          CROSS JOIN LATERAL (
            SELECT COALESCE(SUM(CASE WHEN m."kind"='PAID_OUT' THEN -m."amountMinor" ELSE m."amountMinor" END),0)::int AS "adjustmentMinor"
            FROM "pharmacy_drawer_sessions" d
            JOIN "pharmacy_drawer_movements" m ON m."organizationId"=d."organizationId" AND m."drawerSessionId"=d."id"
            WHERE d."organizationId"=c."organizationId" AND d."branchId"=c."branchId"
              AND d."businessDate"=c."businessDate"
              AND m."kind" IN ('OPENING_FLOAT', 'PAID_IN', 'PAID_OUT')
          ) drawer
          WHERE c."branchId" IN (${branches}) AND c."isFinal"=true
            AND c."businessDate">=${window.from} AND c."businessDate"<${window.to}
            AND NOT EXISTS (SELECT 1 FROM "pharmacy_daily_closes" newer WHERE newer."organizationId"=c."organizationId" AND newer."branchId"=c."branchId" AND newer."businessDate"=c."businessDate" AND newer."sequence">c."sequence")
            AND NOT EXISTS (SELECT 1 FROM "pharmacy_day_reopens" reopen WHERE reopen."organizationId"=c."organizationId" AND reopen."closeId"=c."id")
          ORDER BY c."businessDate" DESC LIMIT 200`);

  const supplier = filters.supplierId
    ? Prisma.sql`AND gr."supplierId"=${filters.supplierId}`
    : Prisma.empty;
  const purchasePriceDrift = await db.$queryRaw<PriceRow[]>(Prisma.sql`
    SELECT line."id" AS "receiptLineId", line."branchId", gr."supplierId", line."medicineId", line."packLevelId",
           lot."manufacturingBatchId" AS "batchId", line."unitCostMinor" AS "currentUnitCostMinor",
           baseline."trailingUnitCostMinor", baseline."comparisonReceipts", gr."postedAt" AS "occurredAt"
    FROM "pharmacy_goods_receipt_lines" line
    JOIN "pharmacy_goods_receipts" gr ON gr."organizationId"=line."organizationId" AND gr."branchId"=line."branchId" AND gr."id"=line."goodsReceiptId"
    JOIN (
      SELECT il.*, mb."medicineId" AS "batchMedicineId"
      FROM "pharmacy_inventory_lots" il
      JOIN "pharmacy_manufacturing_batches" mb ON mb."organizationId"=il."organizationId" AND mb."id"=il."manufacturingBatchId"
    ) lot ON lot."organizationId"=line."organizationId" AND lot."branchId"=line."branchId" AND lot."id"=line."inventoryLotId"
    JOIN LATERAL (
      SELECT ROUND(AVG(previous."unitCostMinor"))::int AS "trailingUnitCostMinor", COUNT(*)::int AS "comparisonReceipts"
      FROM "pharmacy_goods_receipt_lines" previous
      JOIN "pharmacy_goods_receipts" previous_gr ON previous_gr."organizationId"=previous."organizationId" AND previous_gr."branchId"=previous."branchId" AND previous_gr."id"=previous."goodsReceiptId"
      WHERE previous."organizationId"=line."organizationId" AND previous."branchId"=line."branchId"
        AND previous."medicineId"=line."medicineId" AND previous."packLevelId"=line."packLevelId"
        AND previous_gr."status"='POSTED' AND previous_gr."postedAt"<gr."postedAt"
        AND previous_gr."postedAt">=gr."postedAt"-interval '30 days'
    ) baseline ON baseline."comparisonReceipts">0
    WHERE line."branchId" IN (${branches}) AND gr."status"='POSTED'
      AND gr."postedAt">=${events.from} AND gr."postedAt"<${events.to} ${supplier} ${ingredient} ${batch}
    ORDER BY gr."postedAt" DESC LIMIT 500`);

  const stamp = <T extends object>(rows: T[]) =>
    rows.map((row) => ({ ...row, sourceObservedAt: observedAt }));
  return {
    windowStart: events.from,
    windowEnd: events.to,
    facts: {
      shrinkage: stamp(shrinkage),
      discountOverride: stamp(discountOverride),
      staffVoid: stamp(staffVoid),
      ghostReturn: stamp(ghostReturn),
      cashVariance: stamp(cashVariance).map((row) => ({
        ...row,
        businessDate: row.businessDate.toISOString().slice(0, 10),
      })),
      tenderMismatch: stamp(tenderMismatch).map((row) => ({
        ...row,
        businessDate: row.businessDate.toISOString().slice(0, 10),
      })),
      purchasePriceDrift: stamp(purchasePriceDrift),
    },
  };
}

function scopeMatches(
  scope: Prisma.JsonValue,
  filters: Pick<PharmacyReportFilters, 'supplierId' | 'ingredientId' | 'batchId'>,
  ingredientMedicineIds: ReadonlySet<string>
) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return false;
  const value = scope as Record<string, unknown>;
  if (filters.supplierId && value.supplierId !== filters.supplierId) return false;
  if (filters.batchId && value.batchId !== filters.batchId) return false;
  if (
    filters.ingredientId &&
    (typeof value.medicineId !== 'string' || !ingredientMedicineIds.has(value.medicineId))
  )
    return false;
  return true;
}

/**
 * DEV-958A: the one window of `filters`' branches. Signals are stored per branch with the
 * window they were computed over, so a call covers branches that share one; `byWindow` splits a
 * mixed set into such groups.
 */
function singleWindow(filters: PharmacyReportFilters) {
  const windows = pharmacyBranchDayWindows(filters.from, filters.to, filters.branchIds, filters);
  if (windows.length !== 1) throw new RangeError('Read anomaly facts one shared window at a time.');
  return windows[0]!;
}

/** `filters` split into groups of branches whose own business days give the same window. */
function byWindow(filters: PharmacyReportFilters): PharmacyReportFilters[] {
  return pharmacyBranchDayWindows(filters.from, filters.to, filters.branchIds, filters).map(
    (window) => ({ ...filters, branchIds: window.branchIds })
  );
}

export async function readPharmacyAnomalySignals(
  db: ScopedDb,
  filters: PharmacyReportFilters
): Promise<Awaited<ReturnType<typeof readPharmacyAnomalySignalsInWindow>>> {
  validatePharmacyReportFilters(filters);
  const groups = byWindow(filters);
  if (groups.length === 1) return readPharmacyAnomalySignalsInWindow(db, filters);
  // DEV-958A: each branch's signals on its own business days, in the one order a single read
  // gives, before the same 200-row cut.
  const rows = (
    await Promise.all(groups.map((group) => readPharmacyAnomalySignalsInWindow(db, group)))
  ).flat();
  return rows.sort(compareSignals).slice(0, 200);
}

/** Postgres orders an enum by declaration order: these mirror the schema's enums. */
const STATUS_ORDER = ['OPEN', 'ACKNOWLEDGED', 'SNOOZED', 'CLOSED', 'STALE'];
const SEVERITY_ORDER = ['NOTICE', 'REVIEW', 'URGENT'];

/** The read's own order: status ascending, severity descending, newest computed first. */
function compareSignals(
  a: { status: string; severity: string; computedAt: Date },
  b: { status: string; severity: string; computedAt: Date }
) {
  return (
    STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
    SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity) ||
    b.computedAt.getTime() - a.computedAt.getTime()
  );
}

async function readPharmacyAnomalySignalsInWindow(db: ScopedDb, filters: PharmacyReportFilters) {
  // Signals are stored with the workspace-day window refresh evaluated (readPharmacyAnomalyFacts).
  const window = singleWindow(filters);
  const [rows, ingredientMedicines] = await Promise.all([
    db.pharmacyAnomalySignal.findMany({
      where: {
        branchId: { in: filters.branchIds },
        status: { in: [...LIVE_STATUSES] },
        dataWindowStart: window.from,
        dataWindowEnd: window.to,
      },
      orderBy: [{ status: 'asc' }, { severity: 'desc' }, { computedAt: 'desc' }],
      take: 200,
    }),
    filters.ingredientId
      ? db.medicineStrengthComponent.findMany({
          where: { ingredientId: filters.ingredientId },
          select: { medicineId: true },
          take: 5_000,
        })
      : Promise.resolve([]),
  ]);
  const medicineIds = new Set(ingredientMedicines.map((item) => item.medicineId));
  return rows.filter((row) => scopeMatches(row.scope, filters, medicineIds));
}

export async function refreshPharmacyAnomalySignals(
  db: ScopedDb,
  filters: PharmacyReportFilters,
  actorId: string,
  at = new Date()
): Promise<Awaited<ReturnType<typeof refreshPharmacyAnomalySignalsInWindow>>> {
  const groups = byWindow(filters);
  if (groups.length === 1) return refreshPharmacyAnomalySignalsInWindow(db, filters, actorId, at);
  // DEV-958A: each branch's signals computed on its own business days.
  const merged: Awaited<ReturnType<typeof refreshPharmacyAnomalySignalsInWindow>> = {
    evaluated: 0,
    signals: [],
  };
  for (const group of groups) {
    const result = await refreshPharmacyAnomalySignalsInWindow(db, group, actorId, at);
    merged.evaluated += result.evaluated;
    merged.signals.push(...result.signals);
  }
  return merged;
}

async function refreshPharmacyAnomalySignalsInWindow(
  db: ScopedDb,
  filters: PharmacyReportFilters,
  actorId: string,
  at = new Date()
) {
  const { facts, windowStart, windowEnd } = await readPharmacyAnomalyFacts(db, filters, at);
  const candidates = detectPharmacyAnomalies(facts, {
    windowStart,
    windowEnd,
    computedAt: at,
  });
  const persisted = [];
  for (const candidate of candidates) {
    const signal = await db.$transaction(async (tx) => {
      const current = await tx.pharmacyAnomalySignal.findFirst({
        where: {
          branchId: candidate.branchId,
          dedupKey: candidate.dedupKey,
          status: { in: [...LIVE_STATUSES] },
        },
      });
      const retainedStatus =
        candidate.status === 'STALE'
          ? 'STALE'
          : current?.status === 'ACKNOWLEDGED' ||
              (current?.status === 'SNOOZED' &&
                current.snoozedUntil &&
                current.snoozedUntil.getTime() > at.getTime())
            ? current.status
            : 'OPEN';
      const data = {
        kind: candidate.kind,
        status: retainedStatus,
        severity: candidate.severity,
        scope: candidate.scope,
        policyVersion: candidate.policyVersion,
        exactNumbers: candidate.exactNumbers,
        explanation: candidate.explanation,
        dataWindowStart: candidate.dataWindowStart,
        dataWindowEnd: candidate.dataWindowEnd,
        sourceObservedAt: candidate.sourceObservedAt,
        freshnessSeconds: candidate.freshnessSeconds,
        estimateMethod: candidate.estimateMethod,
        estimateWindow: candidate.estimateWindow,
        estimateExclusions: candidate.estimateExclusions,
        estimateConfidence: candidate.estimateConfidence,
        computedAt: candidate.computedAt,
        markedStaleAt: candidate.status === 'STALE' ? at : null,
        snoozedUntil: retainedStatus === 'SNOOZED' ? current?.snoozedUntil : null,
        snoozeReason: retainedStatus === 'SNOOZED' ? current?.snoozeReason : null,
      } satisfies Prisma.PharmacyAnomalySignalUncheckedUpdateInput;
      const updated = current
        ? await tx.pharmacyAnomalySignal.update({ where: { id: current.id }, data })
        : await tx.pharmacyAnomalySignal.create({
            data: {
              branchId: candidate.branchId,
              dedupKey: candidate.dedupKey,
              ...data,
            },
          });
      await tx.pharmacyAnomalySignalEvent.create({
        data: {
          branchId: updated.branchId,
          signalId: updated.id,
          kind: current
            ? candidate.status === 'STALE' && current.status !== 'STALE'
              ? 'MARKED_STALE'
              : 'REFRESHED'
            : 'RAISED',
          actorId,
          detail: `Policy ${candidate.policyVersion}; source observed ${candidate.sourceObservedAt.toISOString()}.`,
        },
      });
      return updated;
    });
    persisted.push(signal);
  }
  return { evaluated: candidates.length, signals: persisted };
}

async function loadSignal(
  db: Pick<ScopedDb, 'pharmacyAnomalySignal'>,
  branchId: string,
  signalId: string
) {
  const signal = await db.pharmacyAnomalySignal.findFirst({ where: { id: signalId, branchId } });
  if (!signal) throw new Error('Anomaly signal not found in this branch.');
  if (signal.status === 'CLOSED' || signal.status === 'STALE')
    throw new Error('This anomaly signal is not actionable.');
  return signal;
}

export async function acknowledgePharmacyAnomalySignal(
  db: ScopedDb,
  input: { branchId: string; signalId: string; actorId: string; reason: string },
  at = new Date()
) {
  return db.$transaction(async (tx) => {
    const signal = await loadSignal(tx, input.branchId, input.signalId);
    const updated = await tx.pharmacyAnomalySignal.update({
      where: { id: signal.id },
      data: {
        status: 'ACKNOWLEDGED',
        acknowledgedAt: at,
        acknowledgedByUserId: input.actorId,
        snoozedUntil: null,
        snoozeReason: null,
      },
    });
    await tx.pharmacyAnomalySignalEvent.create({
      data: {
        branchId: signal.branchId,
        signalId: signal.id,
        kind: 'ACKNOWLEDGED',
        actorId: input.actorId,
        reason: input.reason,
      },
    });
    return updated;
  });
}

export async function snoozePharmacyAnomalySignal(
  db: ScopedDb,
  input: {
    branchId: string;
    signalId: string;
    actorId: string;
    reason: string;
    snoozedUntil: Date;
  },
  at = new Date()
) {
  if (input.snoozedUntil <= at || input.snoozedUntil.getTime() > at.getTime() + 30 * 86_400_000)
    throw new Error('Snooze must end within the next 30 days.');
  return db.$transaction(async (tx) => {
    const signal = await loadSignal(tx, input.branchId, input.signalId);
    const updated = await tx.pharmacyAnomalySignal.update({
      where: { id: signal.id },
      data: {
        status: 'SNOOZED',
        snoozedUntil: input.snoozedUntil,
        snoozeReason: input.reason,
      },
    });
    await tx.pharmacyAnomalySignalEvent.create({
      data: {
        branchId: signal.branchId,
        signalId: signal.id,
        kind: 'SNOOZED',
        actorId: input.actorId,
        reason: input.reason,
        detail: `Until ${input.snoozedUntil.toISOString()}.`,
      },
    });
    return updated;
  });
}

export function renderAnomalyDigest(
  signals: Awaited<ReturnType<typeof readPharmacyAnomalySignals>>
) {
  const visible = signals.filter((signal) => signal.status !== 'SNOOZED');
  return [
    `Anomaly review signals: ${visible.filter((signal) => signal.status !== 'STALE').length}`,
    ...visible.map(
      (signal) =>
        `- ${signal.kind.replaceAll('_', ' ').toLowerCase()} [${signal.severity.toLowerCase()}${signal.status === 'STALE' ? ', unusable' : ''}]: ${signal.explanation}`
    ),
  ];
}

export type { AnomalyCandidate };
