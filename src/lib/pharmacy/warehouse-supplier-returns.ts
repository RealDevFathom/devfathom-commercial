import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export type HeldReturnAuthorization = {
  id: string;
  inventoryLotId: string;
  stockLocationId: string;
  supplierId: string;
  quantityUnits: number;
  disposition: 'DAMAGED' | 'QUARANTINE';
};

/** Each reviewed decision authorizes one whole line against its original vendor
 * and held balance. Submitted lines still own their units until dispatch. */
export function eligibleHeldSupplierReturns(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  lotIds?: string[]
) {
  if (lotIds?.length === 0) return Promise.resolve<HeldReturnAuthorization[]>([]);
  return db.$queryRaw<HeldReturnAuthorization[]>(Prisma.sql`
    WITH decisions AS (
      SELECT q.id, q."inventoryLotId", q."stockLocationId", q."createdAt", q."supplierReturnLineId",
        CASE WHEN q."sourceKey" LIKE 'damage:%' THEN 'DAMAGED' ELSE 'QUARANTINE' END AS disposition,
        CASE WHEN q."sourceKey" LIKE 'damage:%' THEN q."quantityUnits" ELSE q."quarantineUnits" END AS "quantityUnits"
      FROM pharmacy_warehouse_quality_incidents q
      WHERE q."organizationId" = ${scope.organizationId} AND q."branchId" = ${scope.branchId}
        AND q.status = 'RETURN'
        ${lotIds ? Prisma.sql`AND q."inventoryLotId" IN (${Prisma.join(lotIds)})` : Prisma.empty}
    ), outstanding AS (
      SELECT d.*, b."onHandUnits",
        SUM(d."quantityUnits") OVER (
          PARTITION BY d."inventoryLotId", d."stockLocationId", d.disposition
          ORDER BY (d."supplierReturnLineId" IS NULL), d."quantityUnits", d."createdAt", d.id
          ROWS UNBOUNDED PRECEDING
        ) AS allocated
      FROM decisions d
      JOIN pharmacy_stock_balances b ON b."organizationId" = ${scope.organizationId}
        AND b."branchId" = ${scope.branchId} AND b."inventoryLotId" = d."inventoryLotId"
        AND b."stockLocationId" = d."stockLocationId" AND b.disposition::text = d.disposition
      LEFT JOIN pharmacy_purchase_return_lines line ON line."organizationId" = b."organizationId"
        AND line."branchId" = b."branchId" AND line.id = d."supplierReturnLineId"
      LEFT JOIN pharmacy_purchase_returns doc ON doc."organizationId" = line."organizationId"
        AND doc."branchId" = line."branchId" AND doc.id = line."purchaseReturnId"
      WHERE d."quantityUnits" > 0 AND (d."supplierReturnLineId" IS NULL OR doc.status = 'SUBMITTED')
    ), origin_receipts AS (
      SELECT gl."inventoryLotId", MIN(gr."supplierId") AS "supplierId", COUNT(DISTINCT gr."supplierId") AS vendors
      FROM pharmacy_goods_receipt_lines gl
      JOIN pharmacy_goods_receipts gr ON gr."organizationId" = gl."organizationId"
        AND gr."branchId" = gl."branchId" AND gr.id = gl."goodsReceiptId"
      WHERE gl."organizationId" = ${scope.organizationId} AND gl."branchId" = ${scope.branchId}
        AND gl."inventoryLotId" IN (SELECT "inventoryLotId" FROM outstanding WHERE "supplierReturnLineId" IS NULL)
      GROUP BY gl."inventoryLotId"
    )
    SELECT o.id, o."inventoryLotId", o."stockLocationId", vendor.id AS "supplierId", o."quantityUnits", o.disposition
    FROM outstanding o
    JOIN pharmacy_inventory_lots lot ON lot."organizationId" = ${scope.organizationId}
      AND lot."branchId" = ${scope.branchId} AND lot.id = o."inventoryLotId"
    LEFT JOIN origin_receipts receipt ON receipt."inventoryLotId" = lot.id
    JOIN pharmacy_suppliers vendor ON vendor."organizationId" = lot."organizationId"
      AND ((receipt.vendors = 1 AND vendor.id = receipt."supplierId")
        OR (receipt."inventoryLotId" IS NULL AND vendor.name = lot."supplierName"))
    WHERE o."supplierReturnLineId" IS NULL AND o.allocated <= o."onHandUnits"
    ORDER BY o."createdAt", o.id
  `);
}
