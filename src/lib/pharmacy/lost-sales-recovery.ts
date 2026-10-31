import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';

/** Call in the owning completion transaction, after receipt and payment checks. */
export async function recoverCompletedDemand(db: ScopedDb, scope: LedgerScope, saleId: string) {
  // A completed basket is a partial visit; its purchased lines are not losses.
  await db.$executeRaw(Prisma.sql`
    UPDATE pharmacy_unfulfilled_demand_events AS demand
    SET "visitType" = 'PARTIAL'::"PharmacyDemandVisitType",
        "estLossPkr" = "estLossPkr" - "abandonedBasketPkr", "abandonedBasketPkr" = 0
    WHERE demand."organizationId" = ${scope.organizationId}
      AND demand."branchId" = ${scope.branchId} AND demand."saleId" = ${saleId}
      AND EXISTS (SELECT 1 FROM pharmacy_sales AS sale
        WHERE sale.id = ${saleId} AND sale."organizationId" = demand."organizationId"
          AND sale."branchId" = demand."branchId" AND sale.status = 'COMPLETED')
  `);
  // A shared terminal identifies a workstation, never a returning customer.
  // Customer identity comes from the originating sale's PharmacyCustomer link;
  // demand.customerId retains its existing PharmacyPatient meaning.
  await db.$executeRaw(Prisma.sql`
    UPDATE pharmacy_unfulfilled_demand_events AS demand
    SET "resolvedBySaleId" = sale.id, "resolvedAt" = sale."completedAt",
        "lossProbability" = 0, "estLossPkr" = demand."abandonedBasketPkr"
    FROM pharmacy_sales AS sale
    WHERE sale.id = ${saleId} AND sale."organizationId" = ${scope.organizationId}
      AND sale."branchId" = ${scope.branchId} AND sale.status = 'COMPLETED'
      AND demand."organizationId" = sale."organizationId" AND demand."branchId" = sale."branchId"
      AND demand.outcome = 'WILL_RETURN'::"PharmacyDemandOutcome"
      AND demand."resolvedBySaleId" IS NULL
      AND sale."completedAt" >= demand."createdAt"
      AND sale."completedAt" < demand."createdAt" + interval '7 days'
      AND (demand."saleId" = sale.id OR EXISTS (
        SELECT 1 FROM pharmacy_sales AS origin
        WHERE origin.id = demand."saleId" AND origin."organizationId" = sale."organizationId"
          AND origin."branchId" = sale."branchId" AND origin."customerId" = sale."customerId"))
      AND EXISTS (SELECT 1 FROM pharmacy_sale_lines AS line
        WHERE line."saleId" = sale.id AND line."organizationId" = sale."organizationId"
          AND line."branchId" = sale."branchId" AND line."medicineId" = demand."requestedMedicineId")
  `);
}
