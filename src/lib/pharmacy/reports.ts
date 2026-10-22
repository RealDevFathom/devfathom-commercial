import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { grossMarginQuery } from './finance-reports';
import {
  activeReportDimensions,
  andLotMatches,
  andMedicineHasIngredient,
  lotFromSupplier,
  type PharmacyReportDimension,
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
};

export type PharmacyMetricContract = {
  key: string;
  label: string;
  definition: string;
  source: string | null;
  scope: string;
  drillThrough: string | null;
  permission: 'reports:operational' | 'reports:financial';
  /** #402: how the supplier, ingredient and batch filters narrow this metric. */
  filters: string;
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
    "Ingredient: sale lines whose medicine contains it. Batch and supplier: each lot allocation's share of line revenue less discount, apportioned by units exactly as the sale-line posting does.",
  ],
  [
    'marginMinor',
    'Gross margin',
    'Posted revenue less discounts and exact allocated lot cost, including return and reversal postings. Missing journal evidence is unknown; source completeness is not asserted.',
    'finance_journal_entries + finance_journal_lines',
    'selected branches and UTC posting dates',
    '/pharmacy/reports?section=sales',
    'reports:financial',
    'Ingredient: journal legs whose product contains it. Batch and supplier: journal legs on lots of that batch or from that supplier; legs without a lot are left out.',
  ],
  [
    'cashMinor',
    "Today's cash",
    'Cash tender amounts less change given.',
    'pharmacy_tenders',
    'selected branches and business dates',
    '/pharmacy/reports?section=finance',
    'reports:financial',
    'Not attributable to a supplier, ingredient or batch, so unavailable while one of those filters is set.',
  ],
  [
    'cashVarianceMinor',
    'Cash variance',
    'Counted cash less expected cash on final daily closes.',
    'pharmacy_daily_closes',
    'selected branches and business dates',
    '/pharmacy/reports?section=finance',
    'reports:financial',
    'Not attributable to a supplier, ingredient or batch, so unavailable while one of those filters is set.',
  ],
  [
    'refundsMinor',
    'Refunds',
    'Refund tender amounts recorded in the selected period.',
    'pharmacy_refunds',
    'selected branches and business dates',
    '/pharmacy/reports?section=finance',
    'reports:financial',
    'Not attributable to a supplier, ingredient or batch (refunds are tender amounts), so unavailable while one of those filters is set.',
  ],
  [
    'openStockSignals',
    'Open stock signals',
    'Open low-stock, stockout, expiry, recall, quarantine, and related signals.',
    'pharmacy_stock_signals',
    'selected branches at read time',
    '/pharmacy/inventory',
    'reports:operational',
    "Ingredient: the signal's medicine. Batch and supplier: the signal's lot; medicine-level signals without a lot are left out.",
  ],
  [
    'recommendedOrders',
    'Recommended orders',
    'Open stock signals with a linked requisition action.',
    'pharmacy_stock_signals + pharmacy_stock_signal_actions',
    'selected branches at read time',
    '/pharmacy/procurement',
    'reports:operational',
    "Ingredient: the signal's medicine. Batch and supplier: the signal's lot; medicine-level signals without a lot are left out.",
  ],
  [
    'expiryValueMinor30',
    'Expiry value · 30 days',
    'On-hand units in AVAILABLE disposition and ACTIVE batches, expiring after read time and before 30 days, multiplied by frozen unit cost.',
    'pharmacy_stock_balances + pharmacy_inventory_lots + pharmacy_manufacturing_batches',
    'selected branches at read time',
    '/pharmacy/inventory',
    'reports:operational',
    "Ingredient: the batch's medicine. Batch: the lot's batch. Supplier: the lot's supplier.",
  ],
  [
    'expiryValueMinor60',
    'Expiry value · 60 days',
    'On-hand units in AVAILABLE disposition and ACTIVE batches, expiring after read time and before 60 days, multiplied by frozen unit cost.',
    'pharmacy_stock_balances + pharmacy_inventory_lots + pharmacy_manufacturing_batches',
    'selected branches at read time',
    '/pharmacy/inventory',
    'reports:operational',
    "Ingredient: the batch's medicine. Batch: the lot's batch. Supplier: the lot's supplier.",
  ],
  [
    'expiryValueMinor90',
    'Expiry value · 90 days',
    'On-hand units in AVAILABLE disposition and ACTIVE batches, expiring after read time and before 90 days, multiplied by frozen unit cost.',
    'pharmacy_stock_balances + pharmacy_inventory_lots + pharmacy_manufacturing_batches',
    'selected branches at read time',
    '/pharmacy/inventory',
    'reports:operational',
    "Ingredient: the batch's medicine. Batch: the lot's batch. Supplier: the lot's supplier.",
  ],
  [
    'expiryValueMinor180',
    'Expiry value · 180 days',
    'On-hand units in AVAILABLE disposition and ACTIVE batches, expiring after read time and before 180 days, multiplied by frozen unit cost.',
    'pharmacy_stock_balances + pharmacy_inventory_lots + pharmacy_manufacturing_batches',
    'selected branches at read time',
    '/pharmacy/inventory',
    'reports:operational',
    "Ingredient: the batch's medicine. Batch: the lot's batch. Supplier: the lot's supplier.",
  ],
  [
    'openRecalls',
    'Open recalls',
    'Recall notices still open in the tenant.',
    'pharmacy_recall_notices',
    'organization',
    '/pharmacy/safety',
    'reports:operational',
    'Ingredient: the recalled medicine. Batch: recalls naming the batch or its medicine. Supplier: recalls covering a lot from that supplier.',
  ],
  [
    'quarantineUnits',
    'Quarantined units',
    'On-hand units in quarantine disposition or blocked batches.',
    'pharmacy_stock_balances + pharmacy_manufacturing_batches',
    'selected branches at read time',
    '/pharmacy/inventory',
    'reports:operational',
    "Ingredient: the batch's medicine. Batch: the lot's batch. Supplier: the lot's supplier.",
  ],
  [
    'openClaims',
    'Open supplier claims',
    'Supplier claims not released or submitted.',
    'pharmacy_supplier_claims',
    'selected branches at read time',
    '/pharmacy/procurement',
    'reports:operational',
    "Through the claimed lot: its batch, its medicine's ingredients and its supplier.",
  ],
  [
    'openReceivingExceptions',
    'Open receiving exceptions',
    'Unresolved three-way-match receiving exceptions.',
    'pharmacy_receiving_exceptions',
    'selected branches at read time',
    '/pharmacy/procurement',
    'reports:operational',
    "Supplier: the goods receipt's supplier. Ingredient and batch: the receipt line's medicine and batch number.",
  ],
  [
    'pharmacistCoverage',
    'Pharmacist coverage',
    'Branches with a current regulatory qualified-person coverage record.',
    'pharmacy_branch_regulatory_profiles',
    'selected branches at read time',
    '/pharmacy/safety',
    'reports:operational',
    'Not attributable to a supplier, ingredient or batch (coverage is per branch), so unavailable while one of those filters is set.',
  ],
  [
    'safetyQueue',
    'Safety queue',
    'Unsigned pharmacist review items plus open controlled-register incidents.',
    'pharmacy_pharmacist_review_items + pharmacy_pharmacist_review_decisions + pharmacy_register_incidents',
    'selected branches at read time',
    '/pharmacy/safety',
    'reports:operational',
    "Through the reviewed sale line or the incident's register entry: the medicine's ingredients and the lot's batch and supplier.",
  ],
  [
    'accountsPayableMinor',
    'Accounts payable',
    'Unknown in this report. Recorded accounts payable balances are available in Finance with financial-report permission and Pharmacy Reports access. Open-item and due-date aging remain unknown; full posting coverage is not asserted.',
    null,
    'not asserted',
    '/pharmacy/finance',
    'reports:financial',
    'Not asserted in this report.',
  ],
  [
    'accountsReceivableMinor',
    'Accounts receivable',
    'Unknown in this report. Recorded accounts receivable balances are available in Finance with financial-report permission and Pharmacy Reports access. Open-item and due-date aging remain unknown; full posting coverage is not asserted.',
    null,
    'not asserted',
    '/pharmacy/finance',
    'reports:financial',
    'Not asserted in this report.',
  ],
  [
    'khataAgingMinor',
    'Khata aging',
    'Outstanding amount on Khata charges whose due date has passed, net of payments allocated to each charge.',
    'pharmacy_khata_events',
    'selected branches at read time',
    '/pharmacy/reports?section=finance',
    'reports:financial',
    'Not attributable to a supplier, ingredient or batch (Khata is customer credit), so unavailable while one of those filters is set.',
  ],
  [
    'agingFiscalDocuments',
    'Aging fiscal documents',
    'Queued or submitting fiscal documents that have remained unresolved for at least 15 minutes.',
    'pharmacy_fiscal_documents',
    'selected branches at read time',
    '/pharmacy/reports?section=fiscal',
    'reports:operational',
    'Not attributable to a supplier, ingredient or batch (fiscal documents cover whole bills), so unavailable while one of those filters is set.',
  ],
  [
    'rejectedFiscalDocuments',
    'Rejected fiscal incidents',
    'Fiscal documents rejected by an integrator or moved to the bounded dead-letter state.',
    'pharmacy_fiscal_documents',
    'selected branches at read time',
    '/pharmacy/reports?section=fiscal',
    'reports:operational',
    'Not attributable to a supplier, ingredient or batch (fiscal documents cover whole bills), so unavailable while one of those filters is set.',
  ],
  [
    'deviceFiscalOfflineExceptions',
    'Device/fiscal/offline exceptions',
    'Not available: no pharmacy device/fiscal/offline exception ledger exists in this release.',
    null,
    'not asserted',
    null,
    'reports:operational',
    'Not available in this release.',
  ],
].map(
  ([key, label, definition, source, scope, drillThrough, permission, filters]) =>
    ({
      key,
      label,
      definition,
      source,
      scope,
      drillThrough,
      permission,
      filters,
    }) as PharmacyMetricContract
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
  salesMinor: number;
  marginMinor: number | null;
  cashMinor: number | null;
  refundsMinor: number | null;
  cashVarianceMinor: number | null;
};

/**
 * #402: metrics with no supplier, ingredient or batch behind them (tenders, drawer
 * closes, customer credit, branch coverage and whole-bill fiscal documents). While one
 * of those filters is set they are unavailable (null), never an unfiltered total shown
 * as if it were filtered.
 */
export const PHARMACY_UNATTRIBUTABLE_METRICS = [
  'cashMinor',
  'cashVarianceMinor',
  'refundsMinor',
  'pharmacistCoverage',
  'khataAgingMinor',
  'agingFiscalDocuments',
  'rejectedFiscalDocuments',
] as const;

const saleLineMedicine = {
  id: Prisma.sql`l."medicineId"`,
  organizationId: Prisma.sql`l."organizationId"`,
};
const batchMedicine = {
  id: Prisma.sql`b."medicineId"`,
  organizationId: Prisma.sql`b."organizationId"`,
};

/**
 * Completed sales for the dimension filters. The ingredient keeps or drops whole lines
 * (a line has one medicine). A batch or supplier takes each lot allocation's share of
 * the line's gross and discount, apportioned by allocated units exactly as
 * `postSaleLineEntry` does: floor shares in allocation-id order, the last allocation
 * taking the remainder, so the per-lot sales here equal the per-lot journal legs.
 */
function narrowedSalesSql(filters: PharmacyReportFilters, from: Date, to: Date) {
  const branches = Prisma.join(filters.branchIds);
  const completed = Prisma.sql`FROM "pharmacy_sale_lines" l JOIN "pharmacy_sales" s ON s."organizationId"=l."organizationId" AND s."branchId"=l."branchId" AND s."id"=l."saleId" WHERE l."branchId" IN (${branches}) AND s."status"='COMPLETED' AND s."businessDate">=${from} AND s."businessDate"<${to}${andMedicineHasIngredient(filters, saleLineMedicine)}`;
  if (!filters.batchId && !filters.supplierId)
    return Prisma.sql`COALESCE((SELECT SUM(l."quantity" * l."unitPriceMinor" - l."discountMinor") ${completed}),0)::int`;
  return Prisma.sql`COALESCE((WITH sold AS (SELECT l."organizationId", l."id", l."quantity"::bigint * l."unitPriceMinor" AS gross, l."discountMinor"::bigint AS discount ${completed}), parts AS (SELECT a."organizationId", a."branchId", a."saleLineId", a."inventoryLotId", sold.gross, sold.discount, a."canonicalUnits"::bigint AS units, SUM(a."canonicalUnits"::bigint) OVER (PARTITION BY a."organizationId", a."saleLineId") AS "lineUnits", ROW_NUMBER() OVER (PARTITION BY a."organizationId", a."saleLineId" ORDER BY a."id" DESC) AS "fromLast" FROM "pharmacy_sale_line_allocations" a JOIN sold ON sold."organizationId"=a."organizationId" AND sold."id"=a."saleLineId"), floored AS (SELECT parts.*, div(gross::numeric * units, "lineUnits") AS "grossFloor", div(discount::numeric * units, "lineUnits") AS "discountFloor" FROM parts WHERE "lineUnits">0), shares AS (SELECT floored.*, CASE WHEN "fromLast"=1 THEN gross - (SUM("grossFloor") OVER line_parts - "grossFloor") ELSE "grossFloor" END AS "grossShare", CASE WHEN "fromLast"=1 THEN discount - (SUM("discountFloor") OVER line_parts - "discountFloor") ELSE "discountFloor" END AS "discountShare" FROM floored WINDOW line_parts AS (PARTITION BY "organizationId", "saleLineId")) SELECT SUM(shares."grossShare" - shares."discountShare") FROM shares JOIN "pharmacy_inventory_lots" lot ON lot."organizationId"=shares."organizationId" AND lot."branchId"=shares."branchId" AND lot."id"=shares."inventoryLotId" WHERE TRUE${andLotMatches(filters)}),0)::int`;
}

/** Open recalls covering the filtered stock: a recall names one batch or a whole medicine. */
async function countOpenRecalls(db: ScopedDb, filters: PharmacyReportFilters): Promise<number> {
  if (!activeReportDimensions(filters).length)
    return db.pharmacyRecallNotice.count({ where: { status: 'OPEN' } });
  const batch = filters.batchId
    ? Prisma.sql` AND (r."batchId"=${filters.batchId} OR r."medicineId"=(SELECT b."medicineId" FROM "pharmacy_manufacturing_batches" b WHERE b."organizationId"=r."organizationId" AND b."id"=${filters.batchId}))`
    : Prisma.empty;
  const ingredient = andMedicineHasIngredient(filters, {
    id: Prisma.sql`COALESCE(r."medicineId",(SELECT b."medicineId" FROM "pharmacy_manufacturing_batches" b WHERE b."organizationId"=r."organizationId" AND b."id"=r."batchId"))`,
    organizationId: Prisma.sql`r."organizationId"`,
  });
  const supplier = filters.supplierId
    ? Prisma.sql` AND EXISTS (SELECT 1 FROM "pharmacy_inventory_lots" lot JOIN "pharmacy_manufacturing_batches" b ON b."organizationId"=lot."organizationId" AND b."id"=lot."manufacturingBatchId" WHERE lot."organizationId"=r."organizationId" AND (b."id"=r."batchId" OR b."medicineId"=r."medicineId")${filters.batchId ? Prisma.sql` AND b."id"=${filters.batchId}` : Prisma.empty} AND ${lotFromSupplier(filters.supplierId)})`
    : Prisma.empty;
  const rows = await db.$queryRaw<Array<{ value: number }>>(
    Prisma.sql`SELECT COUNT(*)::int AS value FROM "pharmacy_recall_notices" r WHERE r."organizationId"=current_setting('app.current_organization_id',true) AND r."status"='OPEN'${batch}${ingredient}${supplier}`
  );
  return rows[0]?.value ?? 0;
}

async function countReservedClaims(db: ScopedDb, filters: PharmacyReportFilters): Promise<number> {
  if (!activeReportDimensions(filters).length)
    return db.pharmacySupplierClaim.count({
      where: { branchId: { in: filters.branchIds }, status: 'RESERVED' },
    });
  const rows = await db.$queryRaw<Array<{ value: number }>>(
    Prisma.sql`SELECT COUNT(*)::int AS value FROM "pharmacy_supplier_claims" c JOIN "pharmacy_inventory_lots" lot ON lot."organizationId"=c."organizationId" AND lot."branchId"=c."branchId" AND lot."id"=c."inventoryLotId" JOIN "pharmacy_manufacturing_batches" b ON b."organizationId"=lot."organizationId" AND b."id"=lot."manufacturingBatchId" WHERE c."branchId" IN (${Prisma.join(filters.branchIds)}) AND c."status"='RESERVED'${andMedicineHasIngredient(filters, batchMedicine)}${andLotMatches(filters)}`
  );
  return rows[0]?.value ?? 0;
}

/** A receiving exception belongs to its receipt's supplier and its line's medicine and batch. */
async function countOpenReceivingExceptions(
  db: ScopedDb,
  filters: PharmacyReportFilters
): Promise<number> {
  if (!activeReportDimensions(filters).length)
    return db.pharmacyReceivingException.count({
      where: { branchId: { in: filters.branchIds }, status: 'OPEN' },
    });
  const supplier = filters.supplierId
    ? Prisma.sql` AND gr."supplierId"=${filters.supplierId}`
    : Prisma.empty;
  const batch = filters.batchId
    ? Prisma.sql` AND EXISTS (SELECT 1 FROM "pharmacy_manufacturing_batches" b WHERE b."organizationId"=grl."organizationId" AND b."id"=${filters.batchId} AND b."medicineId"=grl."medicineId" AND b."batchNumber"=grl."batchNumber")`
    : Prisma.empty;
  const rows = await db.$queryRaw<Array<{ value: number }>>(
    Prisma.sql`SELECT COUNT(*)::int AS value FROM "pharmacy_receiving_exceptions" x JOIN "pharmacy_goods_receipts" gr ON gr."organizationId"=x."organizationId" AND gr."branchId"=x."branchId" AND gr."id"=x."goodsReceiptId" JOIN "pharmacy_goods_receipt_lines" grl ON grl."organizationId"=x."organizationId" AND grl."branchId"=x."branchId" AND grl."id"=x."goodsReceiptLineId" WHERE x."branchId" IN (${Prisma.join(filters.branchIds)}) AND x."status"='OPEN'${supplier}${andMedicineHasIngredient(
      filters,
      { id: Prisma.sql`grl."medicineId"`, organizationId: Prisma.sql`grl."organizationId"` }
    )}${batch}`
  );
  return rows[0]?.value ?? 0;
}

/**
 * The organization-wide safety queue for the dimension filters: a review item through
 * its sale line (medicine, and the lots it was allocated from), an incident through its
 * register entry (medicine and lot).
 */
function narrowedSafetySql(filters: PharmacyReportFilters) {
  const reviewLots =
    filters.batchId || filters.supplierId
      ? Prisma.sql` AND EXISTS (SELECT 1 FROM "pharmacy_sale_line_allocations" a JOIN "pharmacy_inventory_lots" lot ON lot."organizationId"=a."organizationId" AND lot."branchId"=a."branchId" AND lot."id"=a."inventoryLotId" WHERE a."organizationId"=l."organizationId" AND a."saleLineId"=l."id"${andLotMatches(filters)})`
      : Prisma.empty;
  return Prisma.sql`SELECT (SELECT COUNT(*)::int FROM "pharmacy_pharmacist_review_items" i JOIN "pharmacy_sale_lines" l ON l."organizationId"=i."organizationId" AND l."id"=i."saleLineId" WHERE i."organizationId"=current_setting('app.current_organization_id',true) AND NOT EXISTS (SELECT 1 FROM "pharmacy_pharmacist_review_decisions" d WHERE d."organizationId"=i."organizationId" AND d."reviewItemId"=i."id" AND d."kind"='SIGN')${andMedicineHasIngredient(filters, saleLineMedicine)}${reviewLots}) + (SELECT COUNT(*)::int FROM "pharmacy_register_incidents" r JOIN "pharmacy_controlled_register_entries" e ON e."organizationId"=r."organizationId" AND e."id"=r."registerEntryId" JOIN "pharmacy_inventory_lots" lot ON lot."organizationId"=e."organizationId" AND lot."branchId"=e."branchId" AND lot."id"=e."inventoryLotId" JOIN "pharmacy_manufacturing_batches" b ON b."organizationId"=lot."organizationId" AND b."id"=lot."manufacturingBatchId" WHERE r."organizationId"=current_setting('app.current_organization_id',true) AND r."status"='OPEN'${andMedicineHasIngredient(
    filters,
    {
      id: Prisma.sql`COALESCE(e."medicineId", b."medicineId")`,
      organizationId: Prisma.sql`e."organizationId"`,
    }
  )}${andLotMatches(filters)}) AS value`;
}

async function readKhataAgingMinor(db: ScopedDb, branchIds: readonly string[]): Promise<number> {
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
        Prisma.sql`WITH payments AS (SELECT "organizationId", "branchId", "settlesChargeId", SUM("amountMinor") AS paid FROM "pharmacy_khata_events" WHERE "organizationId"=current_setting('app.current_organization_id',true) AND "branchId"=${branchId} AND "kind"='PAYMENT' GROUP BY "organizationId", "branchId", "settlesChargeId") SELECT COALESCE(SUM(GREATEST(charge."amountMinor"::bigint-COALESCE(payments.paid,0),0)),0)::bigint AS value FROM "pharmacy_khata_events" charge LEFT JOIN payments ON payments."organizationId"=charge."organizationId" AND payments."branchId"=charge."branchId" AND payments."settlesChargeId"=charge."id" WHERE charge."organizationId"=current_setting('app.current_organization_id',true) AND charge."branchId"=${branchId} AND charge."kind"='CHARGE' AND charge."dueAt"<=CURRENT_TIMESTAMP`
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

export async function readPharmacyOwnerCommandCentre(db: ScopedDb, filters: PharmacyReportFilters) {
  const parsed = validatePharmacyReportFilters(filters);
  const branches = Prisma.join(filters.branchIds);
  // #402: supplier, ingredient and batch narrow every attributable KPI; the rest are null.
  const dimensions: PharmacyReportDimension[] = activeReportDimensions(filters);
  const narrowed = dimensions.length > 0;
  // A signal reaches an ingredient through its medicine, a batch or supplier through its lot.
  const signalDimensions = Prisma.sql`${andMedicineHasIngredient(filters, {
    id: Prisma.sql`s."medicineId"`,
    organizationId: Prisma.sql`s."organizationId"`,
  })}${
    filters.batchId || filters.supplierId
      ? Prisma.sql` AND EXISTS (SELECT 1 FROM "pharmacy_inventory_lots" lot WHERE lot."organizationId"=s."organizationId" AND lot."branchId"=s."branchId" AND lot."id"=s."inventoryLotId"${andLotMatches(filters)})`
      : Prisma.empty
  }`;
  // Same signed journal query as Finance: no rounded sale-unit cost arithmetic.
  const marginQuery = grossMarginQuery(
    {
      organizationId: Prisma.sql`current_setting('app.current_organization_id', true)`,
      branchIds: filters.branchIds,
      supplierId: filters.supplierId,
      ingredientId: filters.ingredientId,
      batchId: filters.batchId,
    },
    { from: parsed.from, to: parsed.to, by: 'branch' }
  );
  const [money, stock, expiry, recalls, claims, receiving, coverage, safety, fiscal] =
    await Promise.all([
      narrowed
        ? db.$queryRaw<Array<Pick<MoneyCounts, 'salesMinor' | 'marginMinor'>>>(
            Prisma.sql`SELECT ${narrowedSalesSql(filters, parsed.from, parsed.to)} AS "salesMinor", (SELECT SUM("grossMarginMinor")::int FROM (${marginQuery}) journal_margin) AS "marginMinor"`
          )
        : db.$queryRaw<MoneyCounts[]>(
            Prisma.sql`SELECT COALESCE((SELECT SUM(l."quantity" * l."unitPriceMinor" - l."discountMinor") FROM "pharmacy_sale_lines" l JOIN "pharmacy_sales" s ON s."organizationId"=l."organizationId" AND s."branchId"=l."branchId" AND s."id"=l."saleId" WHERE l."branchId" IN (${branches}) AND s."status"='COMPLETED' AND s."businessDate">=${parsed.from} AND s."businessDate"<${parsed.to}),0)::int AS "salesMinor", (SELECT SUM("grossMarginMinor")::int FROM (${marginQuery}) journal_margin) AS "marginMinor", COALESCE((SELECT SUM(t."amountMinor") FROM "pharmacy_tenders" t WHERE t."branchId" IN (${branches}) AND t."type"='CASH' AND t."businessDate">=${parsed.from} AND t."businessDate"<${parsed.to}),0)::int AS "cashMinor", COALESCE((SELECT SUM(r."amountMinor") FROM "pharmacy_refunds" r WHERE r."branchId" IN (${branches}) AND r."businessDate">=${parsed.from} AND r."businessDate"<${parsed.to}),0)::int AS "refundsMinor", COALESCE((SELECT SUM(c."cashVarianceMinor") FROM "pharmacy_daily_closes" c WHERE c."branchId" IN (${branches}) AND c."businessDate">=${parsed.from} AND c."businessDate"<${parsed.to} AND c."isFinal"=true AND NOT EXISTS (SELECT 1 FROM "pharmacy_daily_closes" newer WHERE newer."organizationId"=c."organizationId" AND newer."branchId"=c."branchId" AND newer."businessDate"=c."businessDate" AND newer."sequence">c."sequence")),0)::int AS "cashVarianceMinor"`
          ),
      db.$queryRaw<Array<{ open: number; recommended: number }>>(
        Prisma.sql`SELECT COUNT(*)::int AS "open", COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "pharmacy_stock_signal_actions" a WHERE a."organizationId"=s."organizationId" AND a."branchId"=s."branchId" AND a."signalId"=s."id" AND a."kind"='DRAFT_REQUISITION' AND a."requisitionId" IS NOT NULL))::int AS "recommended" FROM "pharmacy_stock_signals" s WHERE s."branchId" IN (${branches}) AND s."status" IN ('OPEN','ACKNOWLEDGED','SNOOZED')${signalDimensions}`
      ),
      db.$queryRaw<
        Array<{ d30: number; d60: number; d90: number; d180: number; quarantine: number }>
      >(
        Prisma.sql`SELECT COALESCE(SUM(CASE WHEN bal."disposition"='AVAILABLE' AND b."state"='ACTIVE' AND b."expiresAt">CURRENT_TIMESTAMP AND b."expiresAt"<CURRENT_TIMESTAMP+interval '30 days' THEN bal."onHandUnits"*lot."unitCostMinor" ELSE 0 END),0)::int AS "d30", COALESCE(SUM(CASE WHEN bal."disposition"='AVAILABLE' AND b."state"='ACTIVE' AND b."expiresAt">CURRENT_TIMESTAMP AND b."expiresAt"<CURRENT_TIMESTAMP+interval '60 days' THEN bal."onHandUnits"*lot."unitCostMinor" ELSE 0 END),0)::int AS "d60", COALESCE(SUM(CASE WHEN bal."disposition"='AVAILABLE' AND b."state"='ACTIVE' AND b."expiresAt">CURRENT_TIMESTAMP AND b."expiresAt"<CURRENT_TIMESTAMP+interval '90 days' THEN bal."onHandUnits"*lot."unitCostMinor" ELSE 0 END),0)::int AS "d90", COALESCE(SUM(CASE WHEN bal."disposition"='AVAILABLE' AND b."state"='ACTIVE' AND b."expiresAt">CURRENT_TIMESTAMP AND b."expiresAt"<CURRENT_TIMESTAMP+interval '180 days' THEN bal."onHandUnits"*lot."unitCostMinor" ELSE 0 END),0)::int AS "d180", COALESCE(SUM(CASE WHEN bal."disposition"='QUARANTINE' OR b."state"='QUARANTINED' THEN bal."onHandUnits" ELSE 0 END),0)::int AS "quarantine" FROM "pharmacy_stock_balances" bal JOIN "pharmacy_inventory_lots" lot ON lot."organizationId"=bal."organizationId" AND lot."branchId"=bal."branchId" AND lot."id"=bal."inventoryLotId" JOIN "pharmacy_manufacturing_batches" b ON b."organizationId"=lot."organizationId" AND b."id"=lot."manufacturingBatchId" WHERE bal."branchId" IN (${branches}) AND bal."onHandUnits">0 AND (bal."disposition"='AVAILABLE' OR bal."disposition"='QUARANTINE')${andMedicineHasIngredient(filters, batchMedicine)}${andLotMatches(filters)}`
      ),
      countOpenRecalls(db, filters),
      countReservedClaims(db, filters),
      countOpenReceivingExceptions(db, filters),
      narrowed
        ? Promise.resolve(null)
        : db.branchRegulatoryProfile.count({
            where: {
              branchId: { in: filters.branchIds },
              effectiveFrom: { lte: new Date() },
              OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }],
            },
          }),
      db.$queryRaw<Array<{ value: number }>>(
        narrowed
          ? narrowedSafetySql(filters)
          : Prisma.sql`SELECT (SELECT COUNT(*)::int FROM "pharmacy_pharmacist_review_items" i WHERE i."organizationId"=current_setting('app.current_organization_id',true) AND NOT EXISTS (SELECT 1 FROM "pharmacy_pharmacist_review_decisions" d WHERE d."organizationId"=i."organizationId" AND d."reviewItemId"=i."id" AND d."kind"='SIGN')) + (SELECT COUNT(*)::int FROM "pharmacy_register_incidents" r WHERE r."organizationId"=current_setting('app.current_organization_id',true) AND r."status"='OPEN') AS value`
      ),
      narrowed
        ? Promise.resolve(null)
        : db.$queryRaw<Array<{ aging: number; rejected: number }>>(
            Prisma.sql`SELECT COUNT(*) FILTER (WHERE "status" IN ('QUEUED','SUBMITTING') AND "createdAt"<=CURRENT_TIMESTAMP-interval '15 minutes')::int AS aging, COUNT(*) FILTER (WHERE "status" IN ('REJECTED','DEAD'))::int AS rejected FROM "pharmacy_fiscal_documents" WHERE "branchId" IN (${branches})`
          ),
    ]);
  const khataAgingMinor = narrowed ? null : await readKhataAgingMinor(db, filters.branchIds);
  const m: MoneyCounts = narrowed
    ? {
        salesMinor: money[0]?.salesMinor ?? 0,
        marginMinor: money[0]?.marginMinor ?? null,
        cashMinor: null,
        refundsMinor: null,
        cashVarianceMinor: null,
      }
    : ((money[0] as MoneyCounts | undefined) ?? {
        salesMinor: 0,
        marginMinor: null,
        cashMinor: 0,
        refundsMinor: 0,
        cashVarianceMinor: 0,
      });
  const s = stock[0] ?? { open: 0, recommended: 0 };
  const e = expiry[0] ?? { d30: 0, d60: 0, d90: 0, d180: 0, quarantine: 0 };
  return {
    filters,
    metricScopes: {
      safetyQueue: 'organization' as const,
    },
    /** #402: the active dimension filters and the metrics they make unavailable. */
    filterCoverage: {
      dimensions,
      unavailableMetrics: narrowed ? [...PHARMACY_UNATTRIBUTABLE_METRICS] : [],
    },
    freshness: {
      status: 'CURRENT' as const,
      asOf: new Date().toISOString(),
      source: 'transactional pharmacy ledgers',
    },
    metrics: {
      ...m,
      openStockSignals: s.open,
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
      filters: ['branch', 'date', 'supplier', 'ingredient', 'batch'],
    },
    {
      key: 'finance-compliance',
      label: 'Finance and compliance',
      metrics: ['cashMinor', 'cashVarianceMinor', 'refundsMinor', 'pharmacistCoverage'],
      // #402: none of these can be attributed to a supplier, ingredient or batch.
      filters: ['branch', 'date'],
    },
  ] as const;
}
