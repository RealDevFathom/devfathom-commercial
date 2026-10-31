import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { grossMarginQuery, marginDimensionFilter, supplierLotFilter } from './finance-reports';

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
    'selected branches and UTC posting dates',
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
    'recommendedOrders',
    'Recommended orders',
    'Open stock signals with a linked requisition action.',
    'pharmacy_stock_signals + pharmacy_stock_signal_actions',
    'selected branches at read time',
    '/pharmacy/procurement',
    'reports:operational',
  ],
  [
    'expiryValueMinor30',
    'Expiry value · 30 days',
    'On-hand units in AVAILABLE disposition and ACTIVE batches, expiring after read time and before 30 days, multiplied by frozen unit cost.',
    'pharmacy_stock_balances + pharmacy_inventory_lots + pharmacy_manufacturing_batches',
    'selected branches at read time',
    '/pharmacy/inventory',
    'reports:operational',
  ],
  [
    'expiryValueMinor60',
    'Expiry value · 60 days',
    'On-hand units in AVAILABLE disposition and ACTIVE batches, expiring after read time and before 60 days, multiplied by frozen unit cost.',
    'pharmacy_stock_balances + pharmacy_inventory_lots + pharmacy_manufacturing_batches',
    'selected branches at read time',
    '/pharmacy/inventory',
    'reports:operational',
  ],
  [
    'expiryValueMinor90',
    'Expiry value · 90 days',
    'On-hand units in AVAILABLE disposition and ACTIVE batches, expiring after read time and before 90 days, multiplied by frozen unit cost.',
    'pharmacy_stock_balances + pharmacy_inventory_lots + pharmacy_manufacturing_batches',
    'selected branches at read time',
    '/pharmacy/inventory',
    'reports:operational',
  ],
  [
    'expiryValueMinor180',
    'Expiry value · 180 days',
    'On-hand units in AVAILABLE disposition and ACTIVE batches, expiring after read time and before 180 days, multiplied by frozen unit cost.',
    'pharmacy_stock_balances + pharmacy_inventory_lots + pharmacy_manufacturing_batches',
    'selected branches at read time',
    '/pharmacy/inventory',
    'reports:operational',
  ],
  [
    'openRecalls',
    'Open recalls',
    'Recall notices still open in the tenant.',
    'pharmacy_recall_notices',
    'organization',
    '/pharmacy/safety',
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
    '/pharmacy/procurement',
    'reports:operational',
  ],
  [
    'openReceivingExceptions',
    'Open receiving exceptions',
    'Unresolved three-way-match receiving exceptions.',
    'pharmacy_receiving_exceptions',
    'selected branches at read time',
    '/pharmacy/procurement',
    'reports:operational',
  ],
  [
    'pharmacistCoverage',
    'Pharmacist coverage',
    'Branches with a current regulatory qualified-person coverage record.',
    'pharmacy_branch_regulatory_profiles',
    'selected branches at read time',
    '/pharmacy/safety',
    'reports:operational',
  ],
  [
    'safetyQueue',
    'Safety queue',
    'Unsigned pharmacist review items plus open controlled-register incidents.',
    'pharmacy_pharmacist_review_items + pharmacy_pharmacist_review_decisions + pharmacy_register_incidents',
    'selected branches at read time',
    '/pharmacy/safety',
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
  salesMinor: number;
  marginMinor: number | null;
  cashMinor: number;
  refundsMinor: number;
  cashVarianceMinor: number;
};

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
  const ingredientForMedicine = (medicine: Prisma.Sql) =>
    filters.ingredientId
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM "pharmacy_medicine_strength_components" component WHERE component."organizationId"=current_setting('app.current_organization_id',true) AND component."medicineId"=${medicine} AND component."ingredientId"=${filters.ingredientId})`
      : Prisma.empty;
  const lotDimensions = (lot: Prisma.Sql) => Prisma.sql`
    ${filters.batchId ? Prisma.sql`AND ${lot}."manufacturingBatchId"=${filters.batchId}` : Prisma.empty}
    ${filters.ingredientId ? Prisma.sql`AND EXISTS (SELECT 1 FROM "pharmacy_manufacturing_batches" filter_batch JOIN "pharmacy_medicine_strength_components" component ON component."organizationId"=filter_batch."organizationId" AND component."medicineId"=filter_batch."medicineId" WHERE filter_batch."organizationId"=${lot}."organizationId" AND filter_batch."id"=${lot}."manufacturingBatchId" AND component."ingredientId"=${filters.ingredientId})` : Prisma.empty}
    ${supplierLotFilter(lot, filters.supplierId)}`;
  // Replenishment signals describe a medicine, so they have no inventoryLotId.
  // Match their supplier/batch through that medicine's lots in the same branch.
  const stockDimensions = Prisma.sql`
    ${ingredientForMedicine(Prisma.sql`s."medicineId"`)}
    ${
      filters.batchId || filters.supplierId
        ? Prisma.sql`AND EXISTS (
      SELECT 1 FROM "pharmacy_inventory_lots" filter_lot
      WHERE filter_lot."organizationId"=s."organizationId"
        AND filter_lot."branchId"=s."branchId"
        AND (filter_lot."id"=s."inventoryLotId"
          OR (s."inventoryLotId" IS NULL AND EXISTS (
            SELECT 1 FROM "pharmacy_manufacturing_batches" signal_batch
            WHERE signal_batch."organizationId"=filter_lot."organizationId"
              AND signal_batch."id"=filter_lot."manufacturingBatchId"
              AND signal_batch."medicineId"=s."medicineId"
          )))
        ${lotDimensions(Prisma.sql`filter_lot`)}
    )`
        : Prisma.empty
    }`;
  const dimensionFiltered = Boolean(filters.supplierId || filters.ingredientId || filters.batchId);
  // A line can draw from several lots. The journal has revenue and discount apportioned onto
  // those lot legs. Keep the sales metric's completed-sale and business-date scope;
  // returns and reversals belong to the separate posted margin metric.
  const salesMinor = dimensionFiltered
    ? Prisma.sql`COALESCE((
        SELECT SUM(CASE WHEN line."side"='CREDIT' THEN line."amountMinor" ELSE -line."amountMinor" END)
        FROM "finance_journal_lines" line
        JOIN "finance_journal_entries" entry ON entry."organizationId"=line."organizationId" AND entry."id"=line."entryId"
        JOIN "pharmacy_sale_lines" sale_line ON sale_line."organizationId"=line."organizationId" AND sale_line."branchId"=line."branchId" AND sale_line."id"=entry."sourceId"
        JOIN "pharmacy_sales" sale ON sale."organizationId"=sale_line."organizationId" AND sale."branchId"=sale_line."branchId" AND sale."id"=sale_line."saleId"
        LEFT JOIN "pharmacy_inventory_lots" lot ON lot."organizationId"=line."organizationId" AND lot."id"=line."lotId"
        WHERE line."organizationId"=current_setting('app.current_organization_id',true)
          AND line."branchId" IN (${branches}) AND entry."sourceKind"='PHARMACY_SALE_LINE' AND entry."reversesEntryId" IS NULL
          AND line."accountCode" IN ('SALES_REVENUE','SALES_DISCOUNT')
          AND sale."status"='COMPLETED' AND sale."businessDate">=${parsed.from} AND sale."businessDate"<${parsed.to}
          ${marginDimensionFilter(filters)}
      ),0)::int`
    : Prisma.sql`COALESCE((SELECT SUM(l."quantity" * l."unitPriceMinor" - l."discountMinor") FROM "pharmacy_sale_lines" l JOIN "pharmacy_sales" s ON s."organizationId"=l."organizationId" AND s."branchId"=l."branchId" AND s."id"=l."saleId" WHERE l."branchId" IN (${branches}) AND s."status"='COMPLETED' AND s."businessDate">=${parsed.from} AND s."businessDate"<${parsed.to}),0)::int`;

  const [money, stock, expiry, recalls, claims, receiving, coverage, safety, fiscal] =
    await Promise.all([
      db.$queryRaw<MoneyCounts[]>(
        Prisma.sql`SELECT ${salesMinor} AS "salesMinor", (SELECT SUM("grossMarginMinor")::int FROM (${marginQuery}) journal_margin) AS "marginMinor", COALESCE((SELECT SUM(t."amountMinor") FROM "pharmacy_tenders" t WHERE t."branchId" IN (${branches}) AND t."type"='CASH' AND t."businessDate">=${parsed.from} AND t."businessDate"<${parsed.to}),0)::int AS "cashMinor", COALESCE((SELECT SUM(r."amountMinor") FROM "pharmacy_refunds" r WHERE r."branchId" IN (${branches}) AND r."businessDate">=${parsed.from} AND r."businessDate"<${parsed.to}),0)::int AS "refundsMinor", COALESCE((SELECT SUM(c."cashVarianceMinor") FROM "pharmacy_daily_closes" c WHERE c."branchId" IN (${branches}) AND c."businessDate">=${parsed.from} AND c."businessDate"<${parsed.to} AND c."isFinal"=true AND NOT EXISTS (SELECT 1 FROM "pharmacy_daily_closes" newer WHERE newer."organizationId"=c."organizationId" AND newer."branchId"=c."branchId" AND newer."businessDate"=c."businessDate" AND newer."sequence">c."sequence")),0)::int AS "cashVarianceMinor"`
      ),
      db.$queryRaw<Array<{ open: number; recommended: number }>>(
        Prisma.sql`SELECT COUNT(*)::int AS "open", COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "pharmacy_stock_signal_actions" a WHERE a."organizationId"=s."organizationId" AND a."branchId"=s."branchId" AND a."signalId"=s."id" AND a."kind"='DRAFT_REQUISITION' AND a."requisitionId" IS NOT NULL))::int AS "recommended" FROM "pharmacy_stock_signals" s WHERE s."branchId" IN (${branches}) AND s."status" IN ('OPEN','ACKNOWLEDGED','SNOOZED') ${stockDimensions}`
      ),
      db.$queryRaw<
        Array<{ d30: number; d60: number; d90: number; d180: number; quarantine: number }>
      >(
        Prisma.sql`SELECT COALESCE(SUM(CASE WHEN bal."disposition"='AVAILABLE' AND b."state"='ACTIVE' AND b."expiresAt">CURRENT_TIMESTAMP AND b."expiresAt"<CURRENT_TIMESTAMP+interval '30 days' THEN bal."onHandUnits"*lot."unitCostMinor" ELSE 0 END),0)::int AS "d30", COALESCE(SUM(CASE WHEN bal."disposition"='AVAILABLE' AND b."state"='ACTIVE' AND b."expiresAt">CURRENT_TIMESTAMP AND b."expiresAt"<CURRENT_TIMESTAMP+interval '60 days' THEN bal."onHandUnits"*lot."unitCostMinor" ELSE 0 END),0)::int AS "d60", COALESCE(SUM(CASE WHEN bal."disposition"='AVAILABLE' AND b."state"='ACTIVE' AND b."expiresAt">CURRENT_TIMESTAMP AND b."expiresAt"<CURRENT_TIMESTAMP+interval '90 days' THEN bal."onHandUnits"*lot."unitCostMinor" ELSE 0 END),0)::int AS "d90", COALESCE(SUM(CASE WHEN bal."disposition"='AVAILABLE' AND b."state"='ACTIVE' AND b."expiresAt">CURRENT_TIMESTAMP AND b."expiresAt"<CURRENT_TIMESTAMP+interval '180 days' THEN bal."onHandUnits"*lot."unitCostMinor" ELSE 0 END),0)::int AS "d180", COALESCE(SUM(CASE WHEN bal."disposition"='QUARANTINE' OR b."state"='QUARANTINED' THEN bal."onHandUnits" ELSE 0 END),0)::int AS "quarantine" FROM "pharmacy_stock_balances" bal JOIN "pharmacy_inventory_lots" lot ON lot."organizationId"=bal."organizationId" AND lot."branchId"=bal."branchId" AND lot."id"=bal."inventoryLotId" JOIN "pharmacy_manufacturing_batches" b ON b."organizationId"=lot."organizationId" AND b."id"=lot."manufacturingBatchId" WHERE bal."branchId" IN (${branches}) AND bal."onHandUnits">0 AND (bal."disposition"='AVAILABLE' OR bal."disposition"='QUARANTINE') ${lotDimensions(Prisma.sql`lot`)}`
      ),
      filters.supplierId || filters.ingredientId || filters.batchId
        ? db
            .$queryRaw<Array<{ value: number }>>(
              Prisma.sql`SELECT COUNT(*)::int AS value FROM "pharmacy_recall_notices" recall WHERE recall."status"='OPEN'
                AND ((recall."batchId" IS NULL AND ${!filters.batchId && !filters.supplierId}
                    ${ingredientForMedicine(Prisma.sql`recall."medicineId"`)})
                  OR EXISTS (
                  SELECT 1 FROM "pharmacy_manufacturing_batches" recall_batch
                  WHERE recall_batch."organizationId"=recall."organizationId"
                    AND ((recall."batchId" IS NOT NULL AND recall_batch."id"=recall."batchId")
                      OR (recall."batchId" IS NULL AND recall_batch."medicineId"=recall."medicineId"))
                    ${filters.batchId ? Prisma.sql`AND recall_batch."id"=${filters.batchId}` : Prisma.empty}
                    ${ingredientForMedicine(Prisma.sql`recall_batch."medicineId"`)}
                    ${filters.supplierId ? Prisma.sql`AND EXISTS (SELECT 1 FROM "pharmacy_inventory_lots" filter_lot WHERE filter_lot."organizationId"=recall_batch."organizationId" AND filter_lot."manufacturingBatchId"=recall_batch."id" ${lotDimensions(Prisma.sql`filter_lot`)})` : Prisma.empty}
                ))`
            )
            .then((rows) => rows[0]?.value ?? 0)
        : db.pharmacyRecallNotice.count({ where: { status: 'OPEN' } }),
      db
        .$queryRaw<Array<{ value: number }>>(
          Prisma.sql`SELECT COUNT(*)::int AS value FROM "pharmacy_supplier_claims" claim
          JOIN "pharmacy_inventory_lots" lot ON lot."organizationId"=claim."organizationId" AND lot."branchId"=claim."branchId" AND lot."id"=claim."inventoryLotId"
          WHERE claim."organizationId"=current_setting('app.current_organization_id',true)
            AND claim."branchId" IN (${branches}) AND claim."status"='RESERVED'
            ${lotDimensions(Prisma.sql`lot`)}`
        )
        .then((rows) => rows[0]?.value ?? 0),
      db.pharmacyReceivingException.count({
        where: {
          branchId: { in: filters.branchIds },
          status: 'OPEN',
          ...(filters.supplierId ? { goodsReceipt: { supplierId: filters.supplierId } } : {}),
          ...(filters.ingredientId || filters.batchId
            ? {
                goodsReceiptLine: {
                  ...(filters.ingredientId
                    ? {
                        medicine: {
                          strengths: { some: { ingredientId: filters.ingredientId } },
                        },
                      }
                    : {}),
                  ...(filters.batchId
                    ? { inventoryLot: { manufacturingBatchId: filters.batchId } }
                    : {}),
                },
              }
            : {}),
        },
      }),
      db.branchRegulatoryProfile.count({
        where: {
          branchId: { in: filters.branchIds },
          effectiveFrom: { lte: new Date() },
          OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date() } }],
        },
      }),
      db.$queryRaw<Array<{ value: number }>>(
        Prisma.sql`SELECT (SELECT COUNT(*)::int FROM "pharmacy_pharmacist_review_items" i WHERE i."organizationId"=current_setting('app.current_organization_id',true) AND NOT EXISTS (SELECT 1 FROM "pharmacy_pharmacist_review_decisions" d WHERE d."organizationId"=i."organizationId" AND d."reviewItemId"=i."id" AND d."kind"='SIGN')) + (SELECT COUNT(*)::int FROM "pharmacy_register_incidents" r WHERE r."organizationId"=current_setting('app.current_organization_id',true) AND r."status"='OPEN') AS value`
      ),
      db.$queryRaw<Array<{ aging: number; rejected: number }>>(
        Prisma.sql`SELECT COUNT(*) FILTER (WHERE "status" IN ('QUEUED','SUBMITTING') AND "createdAt"<=CURRENT_TIMESTAMP-interval '15 minutes')::int AS aging, COUNT(*) FILTER (WHERE "status" IN ('REJECTED','DEAD'))::int AS rejected FROM "pharmacy_fiscal_documents" WHERE "branchId" IN (${branches})`
      ),
    ]);
  const khataAgingMinor = await readKhataAgingMinor(db, filters.branchIds);
  const m = money[0] ?? {
    salesMinor: 0,
    marginMinor: null,
    cashMinor: 0,
    refundsMinor: 0,
    cashVarianceMinor: 0,
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
      agingFiscalDocuments: fiscal[0]?.aging ?? 0,
      rejectedFiscalDocuments: fiscal[0]?.rejected ?? 0,
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
      filters: ['branch', 'date', 'ingredient', 'batch'],
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
      filters: ['branch', 'ingredient', 'batch'],
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
      filters: ['branch', 'date', 'supplier'],
    },
  ] as const;
}
