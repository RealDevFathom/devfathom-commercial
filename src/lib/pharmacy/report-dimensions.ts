/**
 * #402: one definition of how a pharmacy report narrows to a supplier, an active
 * ingredient or a manufacturing batch, shared by the command-centre KPIs, the journal
 * margin and the report lists so a filter cannot mean different things on one page.
 *
 * - A lot's supplier is the supplier on its latest POSTED goods receipt (the expiry
 *   advisor's rule). A lot received outside purchasing has no receipt and no supplier.
 * - A medicine matches an ingredient through its strength components.
 * - A batch is the manufacturing batch a lot belongs to.
 *
 * Every fragment binds the caller's values as parameters; only fixed column
 * expressions written in this codebase are spliced in as SQL.
 */
import { Prisma } from '@/generated/prisma/client';

export type PharmacyReportDimensions = {
  supplierId?: string;
  ingredientId?: string;
  batchId?: string;
};

export type PharmacyReportDimension = 'supplier' | 'ingredient' | 'batch';

export function activeReportDimensions(
  filters: PharmacyReportDimensions
): PharmacyReportDimension[] {
  const active: PharmacyReportDimension[] = [];
  if (filters.supplierId) active.push('supplier');
  if (filters.ingredientId) active.push('ingredient');
  if (filters.batchId) active.push('batch');
  return active;
}

/** True when the lot aliased `lot` came from the supplier (see the module rule). */
export function lotFromSupplier(supplierId: string): Prisma.Sql {
  return Prisma.sql`(SELECT gr."supplierId" FROM "pharmacy_goods_receipt_lines" grl JOIN "pharmacy_goods_receipts" gr ON gr."organizationId"=grl."organizationId" AND gr."branchId"=grl."branchId" AND gr."id"=grl."goodsReceiptId" WHERE grl."organizationId"=lot."organizationId" AND grl."branchId"=lot."branchId" AND grl."inventoryLotId"=lot."id" AND gr."status"='POSTED' ORDER BY gr."postedAt" DESC, gr."id" DESC LIMIT 1)=${supplierId}`;
}

/** True when the medicine (a fixed column expression) contains the ingredient. */
export function medicineHasIngredient(
  medicine: { id: Prisma.Sql; organizationId: Prisma.Sql },
  ingredientId: string
): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM "pharmacy_medicine_strength_components" strength WHERE strength."organizationId"=${medicine.organizationId} AND strength."medicineId"=${medicine.id} AND strength."ingredientId"=${ingredientId})`;
}

/** ` AND …` for the ingredient on a medicine column, or nothing without that filter. */
export function andMedicineHasIngredient(
  filters: PharmacyReportDimensions,
  medicine: { id: Prisma.Sql; organizationId: Prisma.Sql }
): Prisma.Sql {
  return filters.ingredientId
    ? Prisma.sql` AND ${medicineHasIngredient(medicine, filters.ingredientId)}`
    : Prisma.empty;
}

/** ` AND …` batch and supplier predicates on the lot aliased `lot`, or nothing. */
export function andLotMatches(filters: PharmacyReportDimensions): Prisma.Sql {
  return Prisma.sql`${
    filters.batchId ? Prisma.sql` AND lot."manufacturingBatchId"=${filters.batchId}` : Prisma.empty
  }${filters.supplierId ? Prisma.sql` AND ${lotFromSupplier(filters.supplierId)}` : Prisma.empty}`;
}
