import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { workspaceDateRange } from '@/lib/timezone';

import { grossMarginQuery } from './finance-reports';
import {
  hasPharmacyReportDimension,
  lotDimension,
  medicineHasIngredient,
} from './report-dimensions';

export const MAX_PHARMACY_REPORT_DAYS = 90;
export const MAX_PHARMACY_REPORT_BRANCHES = 100;

export type PharmacyReportFilters = {
  branchIds: string[];
  from: string;
  to: string;
  supplierId?: string;
  ingredientId?: string;
  batchId?: string;
  /** Workspace IANA zone: event timestamps are bounded by its midnights (UTC when absent). */
  timeZone?: string | null;
};

export type PharmacyMetricContract = {
  key: string;
  label: string;
  definition: string;
  source: string | null;
  scope: string;
  drillThrough: string | null;
  permission: 'reports:operational' | 'reports:financial';
};

export const PHARMACY_METRIC_CONTRACT: readonly PharmacyMetricContract[] = [
  [
    'salesMinor',
    "Today's sales",
    'Completed sale line revenue less line discounts.',
    'pharmacy_sales + pharmacy_sale_lines',
    'selected branches and business dates',
    '/pharmacy/reports?section=sales',
    'reports:financial',
  ],
  [
    'marginMinor',
    'Gross margin',
    'Posted revenue less discounts and exact allocated lot cost, including return and reversal postings. Missing journal evidence is unknown; source completeness is not asserted.',
    'finance_journal_entries + finance_journal_lines',
    'selected branches and posting times within workspace dates',
    '/pharmacy/reports?section=sales',
    'reports:financial',
  ],
  [
    'cashMinor',
    "Today's cash",
    'Cash tender amounts less change given.',
    'pharmacy_tenders',
    'selected branches and business dates',
    '/pharmacy/reports?section=finance',
    'reports:financial',
  ],
  [
    'cashVarianceMinor',
    'Cash variance',
    'Counted cash less expected cash on final daily closes.',
    'pharmacy_daily_closes',
    'selected branches and business dates',
    '/pharmacy/reports?section=finance',
    'reports:financial',
  ],
  [
    'refundsMinor',
    'Refunds',
    'Refund tender amounts recorded in the selected period.',
    'pharmacy_refunds',
    'selected branches and business dates',
    '/pharmacy/reports?section=finance',
    'reports:financial',
  ],
  [
    'openStockSignals',
    'Open stock signals',
    'Open low-stock, stockout, expiry, recall, quarantine, and related signals.',
    'pharmacy_stock_signals',
    'selected branches at read time',
    '/pharmacy/inventory',
    'reports:operational',
  ],
  [
    'lostDemandEvents',
    'Recorded lost-demand events',
    'Unfulfilled-demand events captured at the counter in the selected period. This is recorded demand only; missing capture is unknown, not zero, and no revenue value is estimated.',
    'pharmacy_unfulfilled_demand_events',
    'selected branches and event creation dates',
    '/pharmacy/reports?section=demand',
    'reports:operational',
  ],
  [
    'recommendedOrders',
    'Recommended orders',
    'Open stock signals with a linked requisition action.',
    'pharmacy_stock_signals + pharmacy_stock_signal_actions',
    'selected branches at read time',
    '/pharmacy/purchasing',
    'reports:operational',
  ],
  [
    'expiryValueMinor30',
    'Expiry value · 30 days',
    'On-hand units in AVAILABLE disposition and ACTIVE batches, expiring after read time and before 30 days, multiplied by frozen unit cost.',
    'pharmacy_stock_balances + pharmacy_inventory_lots + pharmacy_manufacturing_batches',
    'selected branches at read time',
    '/pharmacy/inventory/expiry?within=30',
    'reports:operational',
  ],
  [
    'expiryValueMinor60',
    'Expiry value · 60 days',
    'On-hand units in AVAILABLE disposition and ACTIVE batches, expiring after read time and before 60 days, multiplied by frozen unit cost.',
    'pharmacy_stock_balances + pharmacy_inventory_lots + pharmacy_manufacturing_batches',
    'selected branches at read time',
    '/pharmacy/inventory/expiry?within=60',
    'reports:operational',
  ],
  [
    'expiryValueMinor90',
    'Expiry value · 90 days',
    'On-hand units in AVAILABLE disposition and ACTIVE batches, expiring after read time and before 90 days, multiplied by frozen unit cost.',
    'pharmacy_stock_balances + pharmacy_inventory_lots + pharmacy_manufacturing_batches',
    'selected branches at read time',
    '/pharmacy/inventory/expiry?within=90',
    'reports:operational',
  ],
  [
    'expiryValueMinor180',
    'Expiry value · 180 days',
    'On-hand units in AVAILABLE disposition and ACTIVE batches, expiring after read time and before 180 days, multiplied by frozen unit cost.',
    'pharmacy_stock_balances + pharmacy_inventory_lots + pharmacy_manufacturing_batches',
    'selected branches at read time',
    '/pharmacy/inventory/expiry?within=180',
    'reports:operational',
  ],
  [
    'openRecalls',
    'Open recalls',
    'Recall notices still open in the tenant.',
    'pharmacy_recall_notices',
    'organization',
    '/pharmacy/inventory',
    'reports:operational',
  ],
  [
    'quarantineUnits',
    'Quarantined units',
    'On-hand units in quarantine disposition or blocked batches.',
    'pharmacy_stock_balances + pharmacy_manufacturing_batches',
    'selected branches at read time',
    '/pharmacy/inventory',
    'reports:operational',
  ],
  [
    'openClaims',
    'Open supplier claims',
    'Supplier claims not released or submitted.',
    'pharmacy_supplier_claims',
    'selected branches at read time',
    '/pharmacy/purchasing/returns',
    'reports:operational',
  ],
  [
    'openReceivingExceptions',
    'Open receiving exceptions',
    'Unresolved three-way-match receiving exceptions.',
    'pharmacy_receiving_exceptions',
    'selected branches at read time',
    '/pharmacy/purchasing/receiving',
    'reports:operational',
  ],
  [
    'pharmacistCoverage',
    'Pharmacist coverage',
    'Branches with a current regulatory qualified-person coverage record.',
    'pharmacy_branch_regulatory_profiles',
    'selected branches at read time',
    '/pharmacy/regulatory',
    'reports:operational',
  ],
  [
    'safetyQueue',
    'Safety queue',
    'Unsigned pharmacist review items plus open controlled-register incidents.',
    'pharmacy_pharmacist_review_items + pharmacy_pharmacist_review_decisions + pharmacy_register_incidents',
    'selected branches at read time',
    '/pharmacy/pharmacist-queue',
    'reports:operational',
  ],
  [
    'accountsPayableMinor',
    'Accounts payable',
    'Unknown in this report. Recorded accounts payable balances are available in Finance with financial-report permission and Pharmacy Reports access. Open-item and due-date aging remain unknown; full posting coverage is not asserted.',
    null,
    'not asserted',
    '/pharmacy/finance',
    'reports:financial',
  ],
  [
    'accountsReceivableMinor',
    'Accounts receivable',
    'Unknown in this report. Recorded accounts receivable balances are available in Finance with financial-report permission and Pharmacy Reports access. Open-item and due-date aging remain unknown; full posting coverage is not asserted.',
    null,
    'not asserted',
    '/pharmacy/finance',
    'reports:financial',
  ],
  [
    'khataAgingMinor',
    'Khata aging',
    'Outstanding amount on Khata charges whose due date has passed, net of payments allocated to each charge.',
    'pharmacy_khata_events',
    'selected branches at read time',
    '/pharmacy/reports?section=finance',
    'reports:financial',
  ],
  [
    'agingFiscalDocuments',
    'Aging fiscal documents',
    'Queued or submitting fiscal documents that have remained unresolved for at least 15 minutes.',
    'pharmacy_fiscal_documents',
    'selected branches at read time',
    '/pharmacy/reports?section=fiscal',
    'reports:operational',
  ],
  [
    'rejectedFiscalDocuments',
    'Rejected fiscal incidents',
    'Fiscal documents rejected by an integrator or moved to the bounded dead-letter state.',
    'pharmacy_fiscal_documents',
    'selected branches at read time',
    '/pharmacy/reports?section=fiscal',
    'reports:operational',
  ],
  [
    'deviceFiscalOfflineExceptions',
    'Device/fiscal/offline exceptions',
    'Not available: no pharmacy device/fiscal/offline exception ledger exists in this release.',
    null,
    'not asserted',
    null,
    'reports:operational',
  ],
].map(
  ([key, label, definition, source, scope, drillThrough, permission]) =>
    ({ key, label, definition, source, scope, drillThrough, permission }) as PharmacyMetricContract
);

export function validatePharmacyReportFilters(filters: PharmacyReportFilters) {
  if (filters.branchIds.length === 0)
    throw new Error('Choose at least one active pharmacy branch.');
  if (filters.branchIds.length > MAX_PHARMACY_REPORT_BRANCHES)
    throw new Error('Too many pharmacy branches for one report.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(filters.from) || !/^\d{4}-\d{2}-\d{2}$/.test(filters.to))
    throw new Error('Report dates must be YYYY-MM-DD.');
  const from = new Date(`${filters.from}T00:00:00.000Z`);
  const to = new Date(`${filters.to}T00:00:00.000Z`);
  if (
    Number.isNaN(from.getTime()) ||
    Number.isNaN(to.getTime()) ||
    from.toISOString().slice(0, 10) !== filters.from ||
    to.toISOString().slice(0, 10) !== filters.to
  )
    throw new Error('Report dates must be valid calendar dates.');
  if (from > to) throw new Error('The report start date must not be after the end date.');
  const days = Math.floor((to.getTime() - from.getTime()) / 86_400_000) + 1;
  if (days > MAX_PHARMACY_REPORT_DAYS)
    throw new Error(
      `Interactive pharmacy reports are limited to ${MAX_PHARMACY_REPORT_DAYS} days.`
    );
  return { from, to: new Date(to.getTime() + 86_400_000), days };
}

type MoneyCounts = {
  salesMinor: number | null;
  marginMinor: number | null;
  cashMinor: number | null;
  refundsMinor: number | null;
  cashVarianceMinor: number | null;
};

async function readKhataAgingMinor(
  db: Prisma.TransactionClient,
  branchIds: readonly string[]
): Promise<number> {
  const context = await db.$queryRaw<Array<{ branchId: string | null }>>(
    Prisma.sql`SELECT NULLIF(current_setting('app.current_branch_id', true), '') AS "branchId"`
  );
  const previousBranchId = context[0]?.branchId ?? '';
  let total = BigInt(0);

  try {
    // Khata tables enforce organization + exactly one branch through FORCE RLS. Read each
    // authorized report branch under its own branch context rather than bypassing that boundary.
    for (const branchId of branchIds) {
      await db.$queryRaw(Prisma.sql`SELECT set_config('app.current_branch_id', ${branchId}, true)`);
      const rows = await db.$queryRaw<Array<{ value: bigint }>>(
        // A dishonoured cheque re-opens what it bounced, exactly as readKhataBalance counts it:
        // linked to a payment it re-opens that payment's charge, linked to a charge it re-opens
        // that charge, and otherwise it is owed now with no due date of its own.
        Prisma.sql`WITH settlements AS (SELECT e."organizationId", e."branchId", e."kind", e."amountMinor"::bigint AS amount, COALESCE(bounced."settlesChargeId", e."settlesChargeId") AS "chargeId" FROM "pharmacy_khata_events" e LEFT JOIN "pharmacy_khata_events" bounced ON e."kind"='DISHONOURED_CHEQUE' AND bounced."kind"='PAYMENT' AND bounced."organizationId"=e."organizationId" AND bounced."branchId"=e."branchId" AND bounced."id"=e."settlesChargeId" WHERE e."organizationId"=current_setting('app.current_organization_id',true) AND e."branchId"=${branchId} AND e."kind" IN ('PAYMENT','DISHONOURED_CHEQUE')), payments AS (SELECT "organizationId", "branchId", "chargeId" AS "settlesChargeId", SUM(CASE WHEN "kind"='PAYMENT' THEN amount ELSE -amount END) AS paid FROM settlements WHERE "chargeId" IS NOT NULL GROUP BY "organizationId", "branchId", "chargeId"), unlinked AS (SELECT COALESCE(SUM(s.amount),0) AS owed FROM settlements s WHERE s."kind"='DISHONOURED_CHEQUE' AND NOT EXISTS (SELECT 1 FROM "pharmacy_khata_events" c WHERE c."organizationId"=s."organizationId" AND c."branchId"=s."branchId" AND c."id"=s."chargeId" AND c."kind"='CHARGE')) SELECT (COALESCE(SUM(GREATEST(charge."amountMinor"::bigint-COALESCE(payments.paid,0),0)),0)+(SELECT owed FROM unlinked))::bigint AS value FROM "pharmacy_khata_events" charge LEFT JOIN payments ON payments."organizationId"=charge."organizationId" AND payments."branchId"=charge."branchId" AND payments."settlesChargeId"=charge."id" WHERE charge."organizationId"=current_setting('app.current_organization_id',true) AND charge."branchId"=${branchId} AND charge."kind"='CHARGE' AND charge."dueAt"<=CURRENT_TIMESTAMP`
      );
      total += rows[0]?.value ?? BigInt(0);
    }
  } finally {
    await db.$queryRaw(
      Prisma.sql`SELECT set_config('app.current_branch_id', ${previousBranchId}, true)`
    );
  }

  const value = Number(total);
  if (!Number.isSafeInteger(value)) {
    throw new Error('Khata aging total exceeds the safe integer range.');
  }
  return value;
}

export async function readPharmacyOwnerCommandCentre(
  db: Prisma.TransactionClient,
  filters: PharmacyReportFilters
) {
  const parsed = validatePharmacyReportFilters(filters);
  // Business-date columns compare against `parsed`; event and posting timestamps use the
  // workspace day, so 00:00–04:59 PKT counts on the Karachi date it happened on.
  const eventWindow = workspaceDateRange(filters.from, filters.to, filters.timeZone);
  const at = new Date();
  const branches = Prisma.join(filters.branchIds);
  // Supplier, ingredient and batch filters narrow every metric that can be traced to stock;
  // metrics that cannot (cash, refunds, closes, fiscal, Khata, coverage) read unknown instead
  // of silently reporting the unfiltered total.
  const dimensional = hasPharmacyReportDimension(filters);
  const lotScoped = Boolean(filters.batchId || filters.supplierId);
  const ingredientOf = (organizationId: Prisma.Sql, medicineId: Prisma.Sql) =>
    filters.ingredientId
      ? Prisma.sql`AND ${medicineHasIngredient(organizationId, medicineId, filters.ingredientId)}`
      : Prisma.empty;
  const lot = Prisma.raw('lot');
  // Same signed journal query as Finance: no rounded sale-unit cost arithmetic. Sale, return
  // and reversal legs each carry their product and lot, so the filters narrow them exactly.
  const marginQuery = grossMarginQuery(
    {
      organizationId: Prisma.sql`current_setting('app.current_organization_id', true)`,
      branchIds: filters.branchIds,
    },
    {
      from: eventWindow.from,
      to: eventWindow.to,
      by: 'branch',
      where: Prisma.sql`${ingredientOf(Prisma.sql`line."organizationId"`, Prisma.sql`line."productId"`)} ${lotDimension(lot, filters, false)}`,
    }
  );
  const saleWindow = Prisma.sql`l."branchId" IN (${branches}) AND s."status"='COMPLETED' AND s."businessDate">=${parsed.from} AND s."businessDate"<${parsed.to}`;
  // Batch and supplier live on the lots a line drew from: sum each allocation's charged money.
  // Historical allocations without that snapshot make the filtered total unknown, not guessed.
  const salesQuery = lotScoped
    ? Prisma.sql`(SELECT CASE WHEN BOOL_OR(a."grossMinor" IS NULL OR a."discountMinor" IS NULL) THEN NULL ELSE COALESCE(SUM(a."grossMinor" - a."discountMinor"),0) END FROM "pharmacy_sale_line_allocations" a JOIN "pharmacy_sale_lines" l ON l."organizationId"=a."organizationId" AND l."branchId"=a."branchId" AND l."id"=a."saleLineId" JOIN "pharmacy_sales" s ON s."organizationId"=l."organizationId" AND s."branchId"=l."branchId" AND s."id"=l."saleId" JOIN "pharmacy_inventory_lots" lot ON lot."organizationId"=a."organizationId" AND lot."branchId"=a."branchId" AND lot."id"=a."inventoryLotId" WHERE ${saleWindow} ${ingredientOf(Prisma.sql`l."organizationId"`, Prisma.sql`l."medicineId"`)} ${lotDimension(lot, filters, false)})::int`
    : Prisma.sql`COALESCE((SELECT SUM(l."grossMinor" - l."discountMinor") FROM "pharmacy_sale_lines" l JOIN "pharmacy_sales" s ON s."organizationId"=l."organizationId" AND s."branchId"=l."branchId" AND s."id"=l."saleId" WHERE ${saleWindow} ${ingredientOf(Prisma.sql`l."organizationId"`, Prisma.sql`l."medicineId"`)}),0)::int`;
  const tenderMoney = dimensional
    ? Prisma.sql`NULL::int AS "cashMinor", NULL::int AS "refundsMinor", NULL::int AS "cashVarianceMinor"`
    : Prisma.sql`COALESCE((SELECT SUM(t."amountMinor") FROM "pharmacy_tenders" t WHERE t."branchId" IN (${branches}) AND t."type"='CASH' AND t."businessDate">=${parsed.from} AND t."businessDate"<${parsed.to}),0)::int AS "cashMinor", COALESCE((SELECT SUM(r."amountMinor") FROM "pharmacy_refunds" r WHERE r."branchId" IN (${branches}) AND r."businessDate">=${parsed.from} AND r."businessDate"<${parsed.to}),0)::int AS "refundsMinor", COALESCE((SELECT SUM(c."cashVarianceMinor") FROM "pharmacy_daily_closes" c WHERE c."branchId" IN (${branches}) AND c."businessDate">=${parsed.from} AND c."businessDate"<${parsed.to} AND c."isFinal"=true AND NOT EXISTS (SELECT 1 FROM "pharmacy_daily_closes" newer WHERE newer."organizationId"=c."organizationId" AND newer."branchId"=c."branchId" AND newer."businessDate"=c."businessDate" AND newer."sequence">c."sequence")),0)::int AS "cashVarianceMinor"`;
  const signalScope = Prisma.sql`${ingredientOf(Prisma.sql`s."organizationId"`, Prisma.sql`s."medicineId"`)} ${
    lotScoped
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM "pharmacy_inventory_lots" lot WHERE lot."organizationId"=s."organizationId" AND lot."branchId"=s."branchId" AND lot."id"=s."inventoryLotId" ${lotDimension(lot, filters, false)})`
      : Prisma.empty
  }`;
  const none = Promise.resolve(null);
  const [money, stock, lostDemand, expiry, recalls, claims, receiving, coverage, safety, fiscal] =
    await Promise.all([
      db.$queryRaw<MoneyCounts[]>(
        Prisma.sql`SELECT ${salesQuery} AS "salesMinor", (SELECT SUM("grossMarginMinor")::int FROM (${marginQuery}) journal_margin) AS "marginMinor", ${tenderMoney}`
      ),
      db.$queryRaw<Array<{ open: number; recommended: number }>>(
        Prisma.sql`SELECT COUNT(*)::int AS "open", COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "pharmacy_stock_signal_actions" a WHERE a."organizationId"=s."organizationId" AND a."branchId"=s."branchId" AND a."signalId"=s."id" AND a."kind"='DRAFT_REQUISITION' AND a."requisitionId" IS NOT NULL))::int AS "recommended" FROM "pharmacy_stock_signals" s WHERE s."branchId" IN (${branches}) AND s."status" IN ('OPEN','ACKNOWLEDGED','SNOOZED') ${signalScope}`
      ),
      // Unfulfilled demand names a requested medicine, never a supplier or a batch.
      lotScoped
        ? none
        : db.$queryRaw<Array<{ value: number }>>(
            Prisma.sql`SELECT COUNT(*)::int AS value FROM "pharmacy_unfulfilled_demand_events" WHERE "organizationId"=current_setting('app.current_organization_id',true) AND "branchId" IN (${branches}) AND "createdAt">=${eventWindow.from} AND "createdAt"<${eventWindow.to} ${ingredientOf(Prisma.sql`"pharmacy_unfulfilled_demand_events"."organizationId"`, Prisma.sql`"pharmacy_unfulfilled_demand_events"."requestedMedicineId"`)}`
          ),
      db.$queryRaw<
        Array<{ d30: number; d60: number; d90: number; d180: number; quarantine: number }>
      >(
        Prisma.sql`SELECT COALESCE(SUM(CASE WHEN bal."disposition"='AVAILABLE' AND b."state"='ACTIVE' AND b."expiresAt">CURRENT_TIMESTAMP AND b."expiresAt"<CURRENT_TIMESTAMP+interval '30 days' THEN bal."onHandUnits"*lot."unitCostMinor" ELSE 0 END),0)::int AS "d30", COALESCE(SUM(CASE WHEN bal."disposition"='AVAILABLE' AND b."state"='ACTIVE' AND b."expiresAt">CURRENT_TIMESTAMP AND b."expiresAt"<CURRENT_TIMESTAMP+interval '60 days' THEN bal."onHandUnits"*lot."unitCostMinor" ELSE 0 END),0)::int AS "d60", COALESCE(SUM(CASE WHEN bal."disposition"='AVAILABLE' AND b."state"='ACTIVE' AND b."expiresAt">CURRENT_TIMESTAMP AND b."expiresAt"<CURRENT_TIMESTAMP+interval '90 days' THEN bal."onHandUnits"*lot."unitCostMinor" ELSE 0 END),0)::int AS "d90", COALESCE(SUM(CASE WHEN bal."disposition"='AVAILABLE' AND b."state"='ACTIVE' AND b."expiresAt">CURRENT_TIMESTAMP AND b."expiresAt"<CURRENT_TIMESTAMP+interval '180 days' THEN bal."onHandUnits"*lot."unitCostMinor" ELSE 0 END),0)::int AS "d180", COALESCE(SUM(CASE WHEN bal."disposition"='QUARANTINE' OR b."state"='QUARANTINED' THEN bal."onHandUnits" ELSE 0 END),0)::int AS "quarantine" FROM "pharmacy_stock_balances" bal JOIN "pharmacy_inventory_lots" lot ON lot."organizationId"=bal."organizationId" AND lot."branchId"=bal."branchId" AND lot."id"=bal."inventoryLotId" JOIN "pharmacy_manufacturing_batches" b ON b."organizationId"=lot."organizationId" AND b."id"=lot."manufacturingBatchId" WHERE bal."branchId" IN (${branches}) AND bal."onHandUnits">0 AND (bal."disposition"='AVAILABLE' OR bal."disposition"='QUARANTINE') ${ingredientOf(Prisma.sql`b."organizationId"`, Prisma.sql`b."medicineId"`)} ${lotDimension(lot, filters, false)}`
      ),
      !dimensional
        ? db.pharmacyRecallNotice.count({ where: { status: 'OPEN' } })
        : filters.supplierId
          ? // Recall notices name a batch or medicine, never the supplier it came from.
            none
          : db
              .$queryRaw<Array<{ value: number }>>(
                Prisma.sql`SELECT COUNT(*)::int AS value FROM "pharmacy_recall_notices" r WHERE r."organizationId"=current_setting('app.current_organization_id',true) AND r."status"='OPEN' ${filters.batchId ? Prisma.sql`AND (r."batchId"=${filters.batchId} OR EXISTS (SELECT 1 FROM "pharmacy_manufacturing_batches" recalled WHERE recalled."organizationId"=r."organizationId" AND recalled."id"=${filters.batchId} AND recalled."medicineId"=r."medicineId"))` : Prisma.empty} ${filters.ingredientId ? Prisma.sql`AND (${medicineHasIngredient(Prisma.sql`r."organizationId"`, Prisma.sql`r."medicineId"`, filters.ingredientId)} OR EXISTS (SELECT 1 FROM "pharmacy_manufacturing_batches" rb WHERE rb."organizationId"=r."organizationId" AND rb."id"=r."batchId" AND ${medicineHasIngredient(Prisma.sql`rb."organizationId"`, Prisma.sql`rb."medicineId"`, filters.ingredientId)}))` : Prisma.empty}`
              )
              .then((rows) => rows[0]?.value ?? 0),
      !dimensional
        ? db.pharmacySupplierClaim.count({
            where: { branchId: { in: filters.branchIds }, status: 'RESERVED' },
          })
        : db
            .$queryRaw<Array<{ value: number }>>(
              Prisma.sql`SELECT COUNT(*)::int AS value FROM "pharmacy_supplier_claims" c JOIN "pharmacy_inventory_lots" lot ON lot."organizationId"=c."organizationId" AND lot."branchId"=c."branchId" AND lot."id"=c."inventoryLotId" WHERE c."branchId" IN (${branches}) AND c."status"='RESERVED' ${lotDimension(lot, filters, true)}`
            )
            .then((rows) => rows[0]?.value ?? 0),
      !dimensional
        ? db.pharmacyReceivingException.count({
            where: { branchId: { in: filters.branchIds }, status: 'OPEN' },
          })
        : db
            .$queryRaw<Array<{ value: number }>>(
              // An exception can precede the lot, so a batch also matches the receipt line's
              // medicine and printed batch number.
              Prisma.sql`SELECT COUNT(*)::int AS value FROM "pharmacy_receiving_exceptions" x JOIN "pharmacy_goods_receipts" gr ON gr."organizationId"=x."organizationId" AND gr."branchId"=x."branchId" AND gr."id"=x."goodsReceiptId" JOIN "pharmacy_goods_receipt_lines" gl ON gl."organizationId"=x."organizationId" AND gl."branchId"=x."branchId" AND gl."id"=x."goodsReceiptLineId" WHERE x."branchId" IN (${branches}) AND x."status"='OPEN' ${filters.supplierId ? Prisma.sql`AND gr."supplierId"=${filters.supplierId}` : Prisma.empty} ${ingredientOf(Prisma.sql`gl."organizationId"`, Prisma.sql`gl."medicineId"`)} ${filters.batchId ? Prisma.sql`AND (EXISTS (SELECT 1 FROM "pharmacy_inventory_lots" lot WHERE lot."organizationId"=gl."organizationId" AND lot."branchId"=gl."branchId" AND lot."id"=gl."inventoryLotId" AND lot."manufacturingBatchId"=${filters.batchId}) OR EXISTS (SELECT 1 FROM "pharmacy_manufacturing_batches" xb WHERE xb."organizationId"=gl."organizationId" AND xb."id"=${filters.batchId} AND xb."medicineId"=gl."medicineId" AND xb."batchNumber"=gl."batchNumber"))` : Prisma.empty}`
            )
            .then((rows) => rows[0]?.value ?? 0),
      dimensional
        ? none
        : db.branchRegulatoryProfile.count({
            where: {
              branchId: { in: filters.branchIds },
              effectiveFrom: { lte: at },
              OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
              qualifiedPersonValidFrom: { lte: at },
              qualifiedPersonValidTo: { gt: at },
            },
          }),
      db.$queryRaw<Array<{ value: number }>>(
        Prisma.sql`SELECT (SELECT COUNT(*)::int FROM "pharmacy_pharmacist_review_items" i WHERE i."organizationId"=current_setting('app.current_organization_id',true) AND NOT EXISTS (SELECT 1 FROM "pharmacy_pharmacist_review_decisions" d WHERE d."organizationId"=i."organizationId" AND d."reviewItemId"=i."id" AND d."kind"='SIGN')) + (SELECT COUNT(*)::int FROM "pharmacy_register_incidents" r WHERE r."organizationId"=current_setting('app.current_organization_id',true) AND r."status"='OPEN') AS value`
      ),
      dimensional
        ? none
        : db.$queryRaw<Array<{ aging: number; rejected: number }>>(
            Prisma.sql`SELECT COUNT(*) FILTER (WHERE "status" IN ('QUEUED','SUBMITTING') AND "createdAt"<=CURRENT_TIMESTAMP-interval '15 minutes')::int AS aging, COUNT(*) FILTER (WHERE "status" IN ('REJECTED','DEAD'))::int AS rejected FROM "pharmacy_fiscal_documents" WHERE "branchId" IN (${branches})`
          ),
    ]);
  const khataAgingMinor = dimensional ? null : await readKhataAgingMinor(db, filters.branchIds);
  const m = money[0] ?? {
    salesMinor: 0,
    marginMinor: null,
    cashMinor: dimensional ? null : 0,
    refundsMinor: dimensional ? null : 0,
    cashVarianceMinor: dimensional ? null : 0,
  };
  const s = stock[0] ?? { open: 0, recommended: 0 };
  const e = expiry[0] ?? { d30: 0, d60: 0, d90: 0, d180: 0, quarantine: 0 };
  return {
    filters,
    metricScopes: {
      safetyQueue: 'organization' as const,
    },
    freshness: {
      status: 'CURRENT' as const,
      asOf: at.toISOString(),
      source: 'transactional pharmacy ledgers',
    },
    metrics: {
      ...m,
      openStockSignals: s.open,
      lostDemandEvents: lostDemand ? (lostDemand[0]?.value ?? 0) : null,
      recommendedOrders: s.recommended,
      expiryValueMinor30: e.d30,
      expiryValueMinor60: e.d60,
      expiryValueMinor90: e.d90,
      expiryValueMinor180: e.d180,
      openRecalls: recalls,
      quarantineUnits: e.quarantine,
      openClaims: claims,
      openReceivingExceptions: receiving,
      pharmacistCoverage: coverage,
      safetyQueue: safety[0]?.value ?? 0,
      agingFiscalDocuments: fiscal ? (fiscal[0]?.aging ?? 0) : null,
      rejectedFiscalDocuments: fiscal ? (fiscal[0]?.rejected ?? 0) : null,
      accountsPayableMinor: null,
      accountsReceivableMinor: null,
      khataAgingMinor,
      deviceFiscalOfflineExceptions: null,
    },
  };
}

export function pharmacyReportCatalog() {
  return [
    {
      key: 'sales-margin',
      label: 'Sales and margin',
      metrics: ['salesMinor', 'marginMinor'],
      filters: ['branch', 'date', 'supplier', 'ingredient', 'batch'],
    },
    {
      key: 'inventory-expiry',
      label: 'Inventory and expiry',
      metrics: [
        'expiryValueMinor30',
        'expiryValueMinor60',
        'expiryValueMinor90',
        'expiryValueMinor180',
        'openStockSignals',
      ],
      filters: ['branch', 'supplier', 'ingredient', 'batch'],
    },
    {
      key: 'procurement-suppliers',
      label: 'Procurement and suppliers',
      metrics: ['recommendedOrders', 'openClaims', 'openReceivingExceptions'],
      filters: ['branch', 'date', 'supplier', 'ingredient', 'batch'],
    },
    {
      key: 'dispensing-safety',
      label: 'Dispensing and safety',
      metrics: ['safetyQueue', 'openRecalls', 'quarantineUnits'],
      filters: ['branch', 'date', 'ingredient', 'batch'],
    },
    {
      key: 'finance-compliance',
      label: 'Finance and compliance',
      metrics: ['cashMinor', 'cashVarianceMinor', 'refundsMinor', 'pharmacistCoverage'],
      filters: ['branch', 'date'],
    },
  ] as const;
}
