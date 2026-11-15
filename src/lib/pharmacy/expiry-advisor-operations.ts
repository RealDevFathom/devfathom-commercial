import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { adviseExpiryLots, type ExpiryLotFact } from './expiry-advisor';
import { lotDimension, type PharmacyReportDimensions } from './report-dimensions';
import { createPurchaseReturn } from './supplier-returns-operations';

type AdvisorRow = Omit<ExpiryLotFact, 'onHandUnits' | 'soldUnits' | 'historyDays'> & {
  onHandUnits: number;
  soldUnits: number;
  historyDays: number;
};

/**
 * Server-resolved tenant and report branches; never accept these from a client. The optional
 * report dimensions (DEV-256) narrow the advice to the selected supplier, ingredient and batch.
 */
export type ExpiryAdvisorScope = PharmacyReportDimensions & {
  organizationId: string;
  branchIds: readonly string[];
};

/**
 * AI-02 facts for every AVAILABLE, not-yet-expired lot in scope.
 *
 * Every CTE and the outer query bind the tenant and the branches explicitly
 * (#1042 / DEV-581). Row level security still applies, but as the second line
 * rather than the only one: a platform or owner connection, or a branch id that
 * belongs to another tenant, must not widen what this returns.
 */
export async function readExpiryAdvice(db: ScopedDb, scope: ExpiryAdvisorScope, at = new Date()) {
  const { organizationId, branchIds } = scope;
  if (!organizationId) throw new Error('EXPIRY_ADVISOR_SCOPE_REQUIRED');
  if (!branchIds.length) return [];
  const branches = Prisma.join(branchIds);
  const historyFrom = new Date(at.getTime() - 30 * 86_400_000);
  const rows = await db.$queryRaw<AdvisorRow[]>(Prisma.sql`
    WITH branch_history AS (
      SELECT s."branchId", LEAST(30, GREATEST(1, (${at}::date-min(s."businessDate")::date)+1))::int AS "historyDays"
      FROM "pharmacy_sales" s
      WHERE s."organizationId"=${organizationId} AND s."branchId" IN (${branches})
        AND s."status"='COMPLETED' AND s."businessDate">=${historyFrom} AND s."businessDate"<${at}
      GROUP BY s."branchId"
    ), sold AS (
      SELECT a."inventoryLotId", COALESCE(sum(a."canonicalUnits"),0)::int AS "soldUnits"
      FROM "pharmacy_sale_line_allocations" a
      JOIN "pharmacy_sale_lines" line ON line."organizationId"=a."organizationId" AND line."branchId"=a."branchId" AND line."id"=a."saleLineId"
      JOIN "pharmacy_sales" s ON s."organizationId"=line."organizationId" AND s."branchId"=line."branchId" AND s."id"=line."saleId"
      WHERE a."organizationId"=${organizationId} AND a."branchId" IN (${branches})
        AND s."status"='COMPLETED' AND s."businessDate">=${historyFrom} AND s."businessDate"<${at}
      GROUP BY a."inventoryLotId"
    ), available AS (
      SELECT balance."organizationId", balance."branchId", balance."inventoryLotId",
        sum(balance."onHandUnits")::int AS "onHandUnits",
        (array_agg(balance."stockLocationId" ORDER BY balance."onHandUnits" DESC, balance."stockLocationId"))[1] AS "stockLocationId"
      FROM "pharmacy_stock_balances" balance
      WHERE balance."organizationId"=${organizationId} AND balance."branchId" IN (${branches})
        AND balance."disposition"='AVAILABLE' AND balance."onHandUnits">0
      GROUP BY balance."organizationId", balance."branchId", balance."inventoryLotId"
    ), source AS (
      SELECT DISTINCT ON (line."inventoryLotId") line."inventoryLotId", gr."supplierId"
      FROM "pharmacy_goods_receipt_lines" line
      JOIN "pharmacy_goods_receipts" gr ON gr."organizationId"=line."organizationId" AND gr."branchId"=line."branchId" AND gr."id"=line."goodsReceiptId"
      WHERE line."organizationId"=${organizationId} AND line."branchId" IN (${branches})
        AND line."inventoryLotId" IS NOT NULL AND gr."status"='POSTED'
      ORDER BY line."inventoryLotId", gr."postedAt" DESC
    )
    SELECT lot."id" AS "lotId", lot."branchId", medicine."productName" AS "medicineName",
      batch."batchNumber", source."supplierId", lot."supplierName", available."stockLocationId",
      available."onHandUnits", lot."unitCostMinor", batch."expiresAt",
      COALESCE(sold."soldUnits",0)::int AS "soldUnits", COALESCE(branch_history."historyDays",0)::int AS "historyDays",
      relationship."expiryReturnWindowDays" AS "returnWindowDays", medicine."coldChain"
    FROM available
    JOIN "pharmacy_inventory_lots" lot ON lot."organizationId"=available."organizationId" AND lot."branchId"=available."branchId" AND lot."id"=available."inventoryLotId"
    JOIN "pharmacy_manufacturing_batches" batch ON batch."organizationId"=lot."organizationId" AND batch."id"=lot."manufacturingBatchId"
    JOIN "pharmacy_medicines" medicine ON medicine."organizationId"=batch."organizationId" AND medicine."id"=batch."medicineId"
    LEFT JOIN sold ON sold."inventoryLotId"=lot."id"
    LEFT JOIN branch_history ON branch_history."branchId"=lot."branchId"
    LEFT JOIN source ON source."inventoryLotId"=lot."id"
    LEFT JOIN "pharmacy_supplier_relationships" relationship ON relationship."organizationId"=lot."organizationId"
      AND relationship."branchId"=lot."branchId" AND relationship."supplierId"=source."supplierId" AND relationship."active"=true
    WHERE lot."organizationId"=${organizationId} AND lot."branchId" IN (${branches})
      AND batch."expiresAt">${at} ${lotDimension(Prisma.raw('lot'), scope, true)}
  `);
  return adviseExpiryLots(rows, at);
}

export async function proposeExpiryReturn(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string; actorId: string },
  lotId: string,
  at = new Date()
) {
  const existing = await db.pharmacyPurchaseReturn.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      status: 'DRAFT',
      lines: { some: { inventoryLotId: lotId } },
    },
    include: { lines: true },
  });
  if (existing) return existing;
  const advice = (
    await readExpiryAdvice(
      db,
      { organizationId: scope.organizationId, branchIds: [scope.branchId] },
      at
    )
  ).find((item) => item.lotId === lotId);
  if (!advice || !advice.proposalAllowed || !advice.supplierId || !advice.returnWindowDays)
    throw new Error('EXPIRY_RETURN_NOT_ELIGIBLE');
  const balances = await db.pharmacyStockBalance.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      inventoryLotId: lotId,
      disposition: 'AVAILABLE',
      onHandUnits: { gt: 0 },
    },
    orderBy: [{ onHandUnits: 'desc' }, { stockLocationId: 'asc' }],
  });
  let remaining = advice.projectedUnsoldUnits;
  const lines = balances.flatMap((balance) => {
    const quantityUnits = Math.min(remaining, balance.onHandUnits);
    remaining -= quantityUnits;
    return quantityUnits > 0
      ? [
          {
            inventoryLotId: advice.lotId,
            stockLocationId: balance.stockLocationId,
            quantityUnits,
            reason: 'Projected unsold stock inside recorded supplier expiry-return window',
            returnWindowEndsAt: advice.expiresAt,
            expectedCreditMinor: quantityUnits * advice.unitCostMinor,
          },
        ]
      : [];
  });
  if (remaining > 0 || !lines.length) throw new Error('EXPIRY_RETURN_STOCK_CHANGED');
  return createPurchaseReturn(db, scope, {
    supplierId: advice.supplierId,
    kind: 'EXPIRY_CLAIM',
    reference: `AI02-${advice.lotId}-${at.toISOString().slice(0, 10)}`,
    note: `Advisor draft only. Human confirmation required. ${advice.explanation}`,
    lines,
  });
}
