import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-678 (#1301) — draft reorder → distributor purchase order.
 *
 * Every number comes from recorded facts read by SQL (completed sales, available
 * stock, open orders, the distributor's last approved order and its observed
 * delivery time) and deterministic integer arithmetic below. Nothing here
 * writes: the result is an inert proposal. A person edits the packs and confirms
 * each distributor's draft, which then goes through the ordinary purchase-order
 * path (draft → submit → approve → send) with every server check intact.
 *
 * Prices are purchase terms copied from the distributor's last order; nothing
 * here reads or changes a medicine's selling price.
 */

export const REORDER_DEFAULT_WINDOW_DAYS = 28;
export const REORDER_DEFAULT_COVER_DAYS = 14;
/** Used only when neither the last order line nor a past delivery records a lead time. */
export const REORDER_DEFAULT_LEAD_TIME_DAYS = 7;
export const REORDER_MAX_PACKS = 100_000;
/** Most medicines one reorder plan (and so one supplier draft) can hold. */
export const REORDER_MAX_DRAFT_LINES = 5_000;
const MAX_FACT_ROWS = REORDER_MAX_DRAFT_LINES;

export type ReorderPolicy = {
  /** Sales history the daily rate is measured over. */
  windowDays: number;
  /** Days of sales to hold once the order arrives, on top of the lead time. */
  coverDays: number;
};

/** One medicine sold at the branch, with its supply facts. Read by SQL. */
export type ReorderFact = {
  medicineId: string;
  medicineName: string;
  soldUnits: number;
  onHandUnits: number;
  inboundUnits: number;
  supplierId: string | null;
  supplierName: string | null;
  supplierActive: boolean;
  packLevelId: string | null;
  canonicalUnitsPerPack: number | null;
  listPricePerPackMinor: number | null;
  discountBps: number;
  taxBps: number;
  taxCreditable: boolean;
  lineLeadTimeDays: number | null;
  observedLeadTimeDays: number | null;
};

export type LeadTimeSource = 'LAST_ORDER_TERMS' | 'OBSERVED_DELIVERIES' | 'DEFAULT';

export type ReorderLine = {
  medicineId: string;
  medicineName: string;
  packLevelId: string;
  canonicalUnitsPerPack: number;
  suggestedPacks: number;
  listPricePerPackMinor: number;
  discountBps: number;
  taxBps: number;
  taxCreditable: boolean;
  soldUnits: number;
  onHandUnits: number;
  inboundUnits: number;
  leadTimeDays: number;
  leadTimeSource: LeadTimeSource;
  targetUnits: number;
  shortfallUnits: number;
  /** Plain-language working, built from the numbers above. Never names a customer. */
  explanation: string;
};

export type ReorderDraft = {
  supplierId: string;
  supplierName: string;
  lines: ReorderLine[];
  /** Sum of list price × suggested packs, before discount and tax. */
  listValueMinor: number;
};

export type UnassignedReorder = {
  medicineId: string;
  medicineName: string;
  shortfallUnits: number;
  reason: 'NO_DISTRIBUTOR' | 'SUPPLIER_INACTIVE';
};

export type ReorderPlan = {
  policy: ReorderPolicy;
  drafts: ReorderDraft[];
  unassigned: UnassignedReorder[];
};

function ceilDiv(numerator: number, denominator: number): number {
  return Math.floor((numerator + denominator - 1) / denominator);
}

function assertPolicy(policy: ReorderPolicy) {
  if (
    !Number.isInteger(policy.windowDays) ||
    policy.windowDays < 1 ||
    policy.windowDays > 90 ||
    !Number.isInteger(policy.coverDays) ||
    policy.coverDays < 0 ||
    policy.coverDays > 90
  )
    throw new RangeError('Use 1..90 history days and 0..90 cover days.');
}

function leadTimeFor(fact: ReorderFact): { days: number; source: LeadTimeSource } {
  if (fact.lineLeadTimeDays !== null && fact.lineLeadTimeDays >= 0)
    return { days: fact.lineLeadTimeDays, source: 'LAST_ORDER_TERMS' };
  if (fact.observedLeadTimeDays !== null && fact.observedLeadTimeDays >= 0)
    return { days: fact.observedLeadTimeDays, source: 'OBSERVED_DELIVERIES' };
  return { days: REORDER_DEFAULT_LEAD_TIME_DAYS, source: 'DEFAULT' };
}

const LEAD_TIME_WORDING: Record<LeadTimeSource, string> = {
  LAST_ORDER_TERMS: 'from the last order’s terms',
  OBSERVED_DELIVERIES: 'from past deliveries',
  DEFAULT: 'default; no lead time on record',
};

/**
 * Deterministic: target = ⌈sold × (lead time + cover) ÷ history days⌉, the
 * shortfall is the target less available stock and units still on order, and
 * the suggestion is that shortfall rounded up to whole packs. Medicines with no
 * shortfall are left out; one with a shortfall but no orderable distributor is
 * listed separately so it is never silently dropped.
 */
export function planReorderDrafts(
  facts: readonly ReorderFact[],
  policy: ReorderPolicy
): ReorderPlan {
  assertPolicy(policy);
  const drafts = new Map<string, ReorderDraft>();
  const unassigned: UnassignedReorder[] = [];
  for (const fact of facts) {
    for (const value of [fact.soldUnits, fact.onHandUnits, fact.inboundUnits])
      if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError('Reorder facts must be whole, non-negative units.');
    if (fact.soldUnits === 0) continue;
    const lead = leadTimeFor(fact);
    const horizonDays = lead.days + policy.coverDays;
    const demand = fact.soldUnits * horizonDays;
    if (!Number.isSafeInteger(demand)) throw new RangeError('Reorder demand is out of range.');
    const targetUnits = ceilDiv(demand, policy.windowDays);
    const shortfallUnits = targetUnits - fact.onHandUnits - fact.inboundUnits;
    if (shortfallUnits <= 0) continue;
    if (
      !fact.supplierId ||
      !fact.supplierName ||
      !fact.packLevelId ||
      !fact.canonicalUnitsPerPack ||
      fact.canonicalUnitsPerPack < 1 ||
      fact.listPricePerPackMinor === null
    ) {
      unassigned.push({
        medicineId: fact.medicineId,
        medicineName: fact.medicineName,
        shortfallUnits,
        reason: 'NO_DISTRIBUTOR',
      });
      continue;
    }
    if (!fact.supplierActive) {
      unassigned.push({
        medicineId: fact.medicineId,
        medicineName: fact.medicineName,
        shortfallUnits,
        reason: 'SUPPLIER_INACTIVE',
      });
      continue;
    }
    const suggestedPacks = Math.min(
      ceilDiv(shortfallUnits, fact.canonicalUnitsPerPack),
      REORDER_MAX_PACKS
    );
    const line: ReorderLine = {
      medicineId: fact.medicineId,
      medicineName: fact.medicineName,
      packLevelId: fact.packLevelId,
      canonicalUnitsPerPack: fact.canonicalUnitsPerPack,
      suggestedPacks,
      listPricePerPackMinor: fact.listPricePerPackMinor,
      discountBps: fact.discountBps,
      taxBps: fact.taxBps,
      taxCreditable: fact.taxCreditable,
      soldUnits: fact.soldUnits,
      onHandUnits: fact.onHandUnits,
      inboundUnits: fact.inboundUnits,
      leadTimeDays: lead.days,
      leadTimeSource: lead.source,
      targetUnits,
      shortfallUnits,
      explanation:
        `Sold ${fact.soldUnits} units in ${policy.windowDays} days. ` +
        `Lead time ${lead.days} days (${LEAD_TIME_WORDING[lead.source]}) plus ${policy.coverDays} days of cover needs ${targetUnits} units. ` +
        `Available ${fact.onHandUnits}, on order ${fact.inboundUnits}: short ${shortfallUnits} units, ` +
        `${suggestedPacks} pack${suggestedPacks === 1 ? '' : 's'} of ${fact.canonicalUnitsPerPack}.`,
    };
    const draft = drafts.get(fact.supplierId) ?? {
      supplierId: fact.supplierId,
      supplierName: fact.supplierName,
      lines: [],
      listValueMinor: 0,
    };
    draft.lines.push(line);
    draft.listValueMinor += suggestedPacks * fact.listPricePerPackMinor;
    drafts.set(fact.supplierId, draft);
  }
  const ordered = [...drafts.values()]
    .map((draft) => ({
      ...draft,
      lines: draft.lines.sort((a, b) => a.medicineName.localeCompare(b.medicineName)),
    }))
    .sort((a, b) => a.supplierName.localeCompare(b.supplierName));
  return {
    policy,
    drafts: ordered,
    unassigned: unassigned.sort((a, b) => a.medicineName.localeCompare(b.medicineName)),
  };
}

export type ConfirmedReorderLine = {
  medicineId: string;
  packLevelId: string;
  orderedPacks: number;
  canonicalUnitsPerPack: number;
  listPricePerPackMinor: number;
  discountBps: number;
  taxBps: number;
  taxCreditable: boolean;
};

export class ReorderConfirmationError extends Error {
  constructor(
    message: string,
    readonly field?: string
  ) {
    super(message);
    this.name = 'ReorderConfirmationError';
  }
}

/**
 * The lines a person confirmed. Terms come from the server-computed draft, never
 * from the form; the person decides only how many packs of each line to order
 * (zero drops the line). Every draft line needs an explicit count, and a medicine
 * outside this distributor's draft is refused, so a stale form never orders a
 * line nobody saw.
 */
export function confirmedReorderLines(
  draft: ReorderDraft,
  packsByMedicine: ReadonlyMap<string, number>
): ConfirmedReorderLine[] {
  const known = new Set(draft.lines.map((line) => line.medicineId));
  for (const medicineId of packsByMedicine.keys())
    if (!known.has(medicineId))
      throw new ReorderConfirmationError('A line is not part of this distributor’s draft.');
  const lines: ConfirmedReorderLine[] = [];
  for (const line of draft.lines) {
    const packs = packsByMedicine.get(line.medicineId);
    // A line the person was never shown (the plan changed since the page loaded)
    // is never ordered on their behalf.
    if (packs === undefined)
      throw new ReorderConfirmationError(
        'The suggestions for this distributor changed since the page loaded. Review the refreshed draft and confirm again.'
      );
    if (!Number.isInteger(packs) || packs < 0 || packs > REORDER_MAX_PACKS)
      throw new ReorderConfirmationError(
        `Packs: enter a whole number from 0 to ${REORDER_MAX_PACKS}.`,
        `packs-${line.medicineId}`
      );
    if (packs === 0) continue;
    lines.push({
      medicineId: line.medicineId,
      packLevelId: line.packLevelId,
      orderedPacks: packs,
      canonicalUnitsPerPack: line.canonicalUnitsPerPack,
      listPricePerPackMinor: line.listPricePerPackMinor,
      discountBps: line.discountBps,
      taxBps: line.taxBps,
      taxCreditable: line.taxCreditable,
    });
  }
  if (lines.length === 0)
    throw new ReorderConfirmationError('Keep at least one line with one or more packs.');
  return lines;
}

type FactRow = {
  medicineId: string;
  medicineName: string;
  soldUnits: bigint | number;
  onHandUnits: bigint | number | null;
  inboundUnits: bigint | number | null;
  supplierId: string | null;
  supplierName: string | null;
  supplierActive: boolean | null;
  packLevelId: string | null;
  canonicalUnitsPerPack: number | null;
  listPricePerPackMinor: number | null;
  discountBps: number | null;
  taxBps: number | null;
  taxCreditable: boolean | null;
  lineLeadTimeDays: number | null;
  observedLeadTimeDays: number | null;
};

const count = (value: bigint | number | null) => Number(value ?? 0);

/**
 * One read of the branch's recorded facts for every medicine with completed
 * sales in the window. Caller must enforce procurement access and branch scope.
 */
export async function readReorderFacts(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  policy: ReorderPolicy,
  readAt: Date = new Date()
): Promise<ReorderFact[]> {
  assertPolicy(policy);
  const { organizationId, branchId } = scope;
  const since = new Date(readAt.getTime() - policy.windowDays * 86_400_000);
  const rows = await db.$queryRaw<FactRow[]>(Prisma.sql`
    WITH sold AS (
      SELECT l."medicineId", SUM(l."canonicalUnits")::bigint AS "soldUnits"
      FROM pharmacy_sale_lines l
      JOIN pharmacy_sales s ON s."organizationId"=l."organizationId" AND s."branchId"=l."branchId" AND s.id=l."saleId"
      WHERE l."organizationId"=${organizationId} AND l."branchId"=${branchId}
        AND s.status='COMPLETED' AND s."completedAt">=${since} AND s."completedAt"<${readAt}
      GROUP BY l."medicineId"
      HAVING SUM(l."canonicalUnits")>0
    ), on_hand AS (
      -- Sellable cover only, by the same rules the counter allocates with
      -- (stock-ledger + inventory.blockReasonFor): AVAILABLE bucket of an ACTIVE,
      -- unexpired batch on a received lot, net of supplier-claim and restock
      -- reservations, never below zero per bucket.
      SELECT b."medicineId", SUM(GREATEST(sb."onHandUnits" - COALESCE((
        SELECT SUM(claim."reservedUnits") FROM pharmacy_supplier_claims claim
        WHERE claim."organizationId"=sb."organizationId" AND claim."branchId"=sb."branchId"
          AND claim."inventoryLotId"=sb."inventoryLotId" AND claim.status='RESERVED'
      ),0) - COALESCE((
        SELECT SUM(reservation."reservedUnits") FROM pharmacy_restock_reservations reservation
        WHERE reservation."organizationId"=sb."organizationId" AND reservation."branchId"=sb."branchId"
          AND reservation."inventoryLotId"=sb."inventoryLotId" AND reservation."stockLocationId"=sb."stockLocationId"
          AND reservation.status='RESERVED'
      ),0),0))::bigint AS "onHandUnits"
      FROM pharmacy_stock_balances sb
      JOIN pharmacy_inventory_lots lot ON lot."organizationId"=sb."organizationId" AND lot."branchId"=sb."branchId" AND lot.id=sb."inventoryLotId"
      JOIN pharmacy_manufacturing_batches b ON b."organizationId"=lot."organizationId" AND b.id=lot."manufacturingBatchId"
      WHERE sb."organizationId"=${organizationId} AND sb."branchId"=${branchId}
        AND sb.disposition='AVAILABLE' AND sb."onHandUnits">0
        AND b.state='ACTIVE' AND (b."expiresAt" IS NULL OR b."expiresAt">${readAt})
        AND lot."receivedAt" IS NOT NULL AND lot."receivedAt"<=${readAt}
        AND b."medicineId" IN (SELECT "medicineId" FROM sold)
      GROUP BY b."medicineId"
    ), inbound AS (
      SELECT ol."medicineId", SUM(GREATEST(
        ol."orderedCanonicalUnits"+ol."bonusCanonicalUnits"-COALESCE((
          SELECT SUM(grl."acceptedCanonicalUnits")
          FROM pharmacy_goods_receipt_lines grl
          JOIN pharmacy_goods_receipts gr ON gr."organizationId"=grl."organizationId" AND gr."branchId"=grl."branchId" AND gr.id=grl."goodsReceiptId"
          WHERE grl."organizationId"=ol."organizationId" AND grl."purchaseOrderLineId"=ol.id AND gr.status='POSTED'
        ),0),0))::bigint AS "inboundUnits"
      FROM pharmacy_purchase_order_lines ol
      JOIN pharmacy_purchase_orders po ON po."organizationId"=ol."organizationId" AND po.id=ol."purchaseOrderId"
      WHERE ol."organizationId"=${organizationId} AND po."branchId"=${branchId}
        AND po.status IN ('DRAFT','SUBMITTED','APPROVED','SENT','RECEIVING')
        AND ol."medicineId" IN (SELECT "medicineId" FROM sold)
      GROUP BY ol."medicineId"
    ), last_line AS (
      SELECT DISTINCT ON (ol."medicineId") ol."medicineId", po."supplierId", ol."packLevelId",
        ol."canonicalUnitsPerPack", ol."listPricePerPackMinor", ol."discountBps", ol."taxBps",
        ol."taxCreditable", ol."leadTimeDays" AS "lineLeadTimeDays"
      FROM pharmacy_purchase_order_lines ol
      JOIN pharmacy_purchase_orders po ON po."organizationId"=ol."organizationId" AND po.id=ol."purchaseOrderId"
      WHERE ol."organizationId"=${organizationId} AND (po."branchId"=${branchId} OR po."branchId" IS NULL)
        AND po.status IN ('APPROVED','SENT','RECEIVING')
        AND ol."medicineId" IN (SELECT "medicineId" FROM sold)
      ORDER BY ol."medicineId", COALESCE(po."approvedAt", po."createdAt") DESC, po.id DESC, ol."lineNumber"
    ), deliveries AS (
      SELECT po."supplierId", po."sentAt", (
        SELECT MIN(gr."receivedAt") FROM pharmacy_goods_receipts gr
        WHERE gr."organizationId"=po."organizationId" AND gr."purchaseOrderId"=po.id AND gr.status='POSTED'
      ) AS "firstReceivedAt"
      FROM pharmacy_purchase_orders po
      WHERE po."organizationId"=${organizationId} AND (po."branchId"=${branchId} OR po."branchId" IS NULL)
        AND po."sentAt" IS NOT NULL AND po."supplierId" IN (SELECT "supplierId" FROM last_line)
    ), supplier_lead AS (
      SELECT "supplierId", CEIL(AVG(EXTRACT(EPOCH FROM ("firstReceivedAt"-"sentAt"))/86400))::int AS "observedLeadTimeDays"
      FROM deliveries WHERE "firstReceivedAt" IS NOT NULL AND "firstReceivedAt">="sentAt"
      GROUP BY "supplierId"
    )
    SELECT s."medicineId", m."productName" AS "medicineName", s."soldUnits",
      oh."onHandUnits", ib."inboundUnits", ll."supplierId", sup.name AS "supplierName",
      sup.active AS "supplierActive", ll."packLevelId", ll."canonicalUnitsPerPack",
      ll."listPricePerPackMinor", ll."discountBps", ll."taxBps", ll."taxCreditable",
      ll."lineLeadTimeDays", sl."observedLeadTimeDays"
    FROM sold s
    JOIN pharmacy_medicines m ON m."organizationId"=${organizationId} AND m.id=s."medicineId"
    LEFT JOIN on_hand oh ON oh."medicineId"=s."medicineId"
    LEFT JOIN inbound ib ON ib."medicineId"=s."medicineId"
    LEFT JOIN last_line ll ON ll."medicineId"=s."medicineId"
    LEFT JOIN pharmacy_suppliers sup ON sup."organizationId"=${organizationId} AND sup.id=ll."supplierId"
    LEFT JOIN supplier_lead sl ON sl."supplierId"=ll."supplierId"
    ORDER BY m."productName", s."medicineId"
    LIMIT ${MAX_FACT_ROWS + 1}
  `);
  if (rows.length > MAX_FACT_ROWS)
    throw new RangeError('Too many medicines to plan at once; shorten the history.');
  return rows.map((row) => ({
    medicineId: row.medicineId,
    medicineName: row.medicineName,
    soldUnits: count(row.soldUnits),
    // A negative recorded balance cannot cover demand; treat it as nothing available.
    onHandUnits: Math.max(0, count(row.onHandUnits)),
    inboundUnits: count(row.inboundUnits),
    supplierId: row.supplierId,
    supplierName: row.supplierName,
    supplierActive: row.supplierActive === true,
    packLevelId: row.packLevelId,
    canonicalUnitsPerPack: row.canonicalUnitsPerPack,
    listPricePerPackMinor: row.listPricePerPackMinor,
    discountBps: row.discountBps ?? 0,
    taxBps: row.taxBps ?? 0,
    taxCreditable: row.taxCreditable === true,
    lineLeadTimeDays: row.lineLeadTimeDays,
    observedLeadTimeDays: row.observedLeadTimeDays,
  }));
}
