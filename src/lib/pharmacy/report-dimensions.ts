import { Prisma } from '@/generated/prisma/client';

/**
 * Supplier, ingredient and batch report dimensions (DEV-256). Shared by the owner command
 * centre and the report panels beside it so every reader narrows stock the same way.
 */
export type PharmacyReportDimensions = {
  supplierId?: string;
  ingredientId?: string;
  batchId?: string;
};

/** True when a supplier, ingredient or batch filter narrows the report. */
export function hasPharmacyReportDimension(filters: PharmacyReportDimensions) {
  return Boolean(filters.supplierId || filters.ingredientId || filters.batchId);
}

/** The medicine at `medicineId` contains the ingredient (catalogue strength components). */
export function medicineHasIngredient(
  organizationId: Prisma.Sql,
  medicineId: Prisma.Sql,
  ingredientId: string
) {
  return Prisma.sql`EXISTS (SELECT 1 FROM "pharmacy_medicine_strength_components" dim_ingredient WHERE dim_ingredient."organizationId"=${organizationId} AND dim_ingredient."medicineId"=${medicineId} AND dim_ingredient."ingredientId"=${ingredientId})`;
}

/**
 * `AND ...` predicates narrowing an inventory-lot alias to the selected batch (manufacturing
 * batch), supplier and, when asked, ingredient. A lot belongs to a supplier through the goods
 * receipt that created it; lots without a receipt (inter-branch transfers, opening stock) carry
 * the supplier's name snapshot instead, which is unique per organization.
 */
export function lotDimension(
  lot: Prisma.Sql,
  filters: PharmacyReportDimensions,
  withIngredient: boolean
) {
  const clauses: Prisma.Sql[] = [];
  if (filters.batchId) clauses.push(Prisma.sql`${lot}."manufacturingBatchId"=${filters.batchId}`);
  if (withIngredient && filters.ingredientId)
    clauses.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "pharmacy_manufacturing_batches" dim_batch WHERE dim_batch."organizationId"=${lot}."organizationId" AND dim_batch."id"=${lot}."manufacturingBatchId" AND ${medicineHasIngredient(Prisma.sql`dim_batch."organizationId"`, Prisma.sql`dim_batch."medicineId"`, filters.ingredientId)})`
    );
  if (filters.supplierId) {
    const receiptLine = Prisma.sql`SELECT 1 FROM "pharmacy_goods_receipt_lines" dim_line JOIN "pharmacy_goods_receipts" dim_receipt ON dim_receipt."organizationId"=dim_line."organizationId" AND dim_receipt."branchId"=dim_line."branchId" AND dim_receipt."id"=dim_line."goodsReceiptId" WHERE dim_line."organizationId"=${lot}."organizationId" AND dim_line."branchId"=${lot}."branchId" AND dim_line."inventoryLotId"=${lot}."id"`;
    clauses.push(
      Prisma.sql`(EXISTS (${receiptLine} AND dim_receipt."supplierId"=${filters.supplierId}) OR (NOT EXISTS (${receiptLine}) AND EXISTS (SELECT 1 FROM "pharmacy_suppliers" dim_supplier WHERE dim_supplier."organizationId"=${lot}."organizationId" AND dim_supplier."id"=${filters.supplierId} AND dim_supplier."name"=${lot}."supplierName")))`
    );
  }
  return clauses.length ? Prisma.sql`AND ${Prisma.join(clauses, ' AND ')}` : Prisma.empty;
}
