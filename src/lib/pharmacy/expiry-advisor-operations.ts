import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { adviseExpiryLots, type ExpiryLotFact } from './expiry-advisor';
import { createPurchaseReturn } from './supplier-returns-operations';

type AdvisorRow = Omit<ExpiryLotFact, 'onHandUnits' | 'soldUnits' | 'historyDays'> & {
  onHandUnits: number;
  soldUnits: number;
  historyDays: number;
};

export async function readExpiryAdvice(
  db: ScopedDb,
  branchIds: readonly string[],
  at = new Date(),
  expiryRange?: { from: Date; to: Date }
) {
  if (!branchIds.length) return [];
  const rows = await db.$queryRaw<AdvisorRow[]>(Prisma.sql`
    WITH branch_history AS (
      SELECT s."branchId", LEAST(30, GREATEST(1, (${at}::date-min(s."businessDate")::date)+1))::int AS "historyDays"
      FROM "pharmacy_sales" s
      WHERE s."branchId" IN (${Prisma.join(branchIds)}) AND s."status"='COMPLETED'
        AND s."businessDate">=${new Date(at.getTime() - 30 * 86_400_000)}
        AND s."businessDate"<${at}
      GROUP BY s."branchId"
    ), sold AS (
      SELECT a."inventoryLotId", COALESCE(sum(a."canonicalUnits"),0)::int AS "soldUnits"
      FROM "pharmacy_sale_line_allocations" a
      JOIN "pharmacy_sale_lines" line ON line."organizationId"=a."organizationId" AND line."branchId"=a."branchId" AND line."id"=a."saleLineId"
      JOIN "pharmacy_sales" s ON s."organizationId"=line."organizationId" AND s."branchId"=line."branchId" AND s."id"=line."saleId"
      WHERE a."branchId" IN (${Prisma.join(branchIds)}) AND s."status"='COMPLETED'
        AND s."businessDate">=${new Date(at.getTime() - 30 * 86_400_000)} AND s."businessDate"<${at}
      GROUP BY a."inventoryLotId"
    ), available AS (
      SELECT balance."organizationId", balance."branchId", balance."inventoryLotId",
        sum(balance."onHandUnits")::int AS "onHandUnits",
        (array_agg(balance."stockLocationId" ORDER BY balance."onHandUnits" DESC, balance."stockLocationId"))[1] AS "stockLocationId"
      FROM "pharmacy_stock_balances" balance
      WHERE balance."branchId" IN (${Prisma.join(branchIds)}) AND balance."disposition"='AVAILABLE'
        AND balance."onHandUnits">0
      GROUP BY balance."organizationId", balance."branchId", balance."inventoryLotId"
    ), source AS (
      SELECT DISTINCT ON (line."organizationId", line."inventoryLotId")
        line."organizationId", line."inventoryLotId", gr."supplierId", supplier."name" AS "supplierName"
      FROM "pharmacy_goods_receipt_lines" line
      JOIN "pharmacy_goods_receipts" gr ON gr."organizationId"=line."organizationId" AND gr."branchId"=line."branchId" AND gr."id"=line."goodsReceiptId"
      JOIN "pharmacy_suppliers" supplier ON supplier."organizationId"=gr."organizationId" AND supplier."id"=gr."supplierId"
      WHERE line."inventoryLotId" IS NOT NULL AND gr."status"='POSTED'
      ORDER BY line."organizationId", line."inventoryLotId", gr."postedAt" DESC, gr."id" DESC, line."id" DESC
    )
    SELECT lot."id" AS "lotId", lot."branchId", medicine."name" AS "medicineName",
      batch."batchNumber", source."supplierId", COALESCE(source."supplierName", lot."supplierName") AS "supplierName", available."stockLocationId",
      available."onHandUnits", lot."unitCostMinor", batch."expiresAt",
      COALESCE(sold."soldUnits",0)::int AS "soldUnits", COALESCE(branch_history."historyDays",0)::int AS "historyDays",
      relationship."expiryReturnWindowDays" AS "returnWindowDays", medicine."coldChain"
    FROM available
    JOIN "pharmacy_inventory_lots" lot ON lot."organizationId"=available."organizationId" AND lot."branchId"=available."branchId" AND lot."id"=available."inventoryLotId"
    JOIN "pharmacy_manufacturing_batches" batch ON batch."organizationId"=lot."organizationId" AND batch."id"=lot."manufacturingBatchId"
    JOIN "medicines" medicine ON medicine."organizationId"=batch."organizationId" AND medicine."id"=batch."medicineId"
    LEFT JOIN sold ON sold."inventoryLotId"=lot."id"
    LEFT JOIN branch_history ON branch_history."branchId"=lot."branchId"
    LEFT JOIN source ON source."organizationId"=lot."organizationId" AND source."inventoryLotId"=lot."id"
    LEFT JOIN "pharmacy_supplier_relationships" relationship ON relationship."organizationId"=lot."organizationId"
      AND relationship."branchId"=lot."branchId" AND relationship."supplierId"=source."supplierId" AND relationship."active"=true
    WHERE lot."branchId" IN (${Prisma.join(branchIds)}) AND batch."expiresAt">${at}
      ${
        expiryRange
          ? Prisma.sql`AND batch."expiresAt">=${expiryRange.from} AND batch."expiresAt"<${expiryRange.to}`
          : Prisma.empty
      }
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
      branchId: scope.branchId,
      status: 'DRAFT',
      lines: { some: { inventoryLotId: lotId } },
    },
    include: { lines: true },
  });
  if (existing) return existing;
  const advice = (await readExpiryAdvice(db, [scope.branchId], at)).find(
    (item) => item.lotId === lotId
  );
  if (!advice || !advice.proposalAllowed || !advice.supplierId || !advice.returnWindowDays)
    throw new Error('EXPIRY_RETURN_NOT_ELIGIBLE');
  const balances = await db.pharmacyStockBalance.findMany({
    where: {
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
