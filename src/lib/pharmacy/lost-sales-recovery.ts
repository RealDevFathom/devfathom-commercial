import 'server-only';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';

/** Call in the owning completion transaction, after receipt and payment checks. */
export async function recoverCompletedDemand(db: ScopedDb, scope: LedgerScope, saleId: string) {
  // Checkout already owns the sale row. Serialize the customer's returning
  // purchases as well, so two receipts cannot spend the same missing units.
  await db.$executeRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(hashtextextended(
      json_build_array(sale."organizationId", sale."branchId", 'demand-recovery', sale."customerId")::text, 0))
    FROM pharmacy_sales AS sale
    WHERE sale.id = ${saleId} AND sale."organizationId" = ${scope.organizationId}
      AND sale."branchId" = ${scope.branchId} AND sale.status = 'COMPLETED'
      AND sale."customerId" IS NOT NULL
  `);
  // A shared terminal never identifies a customer. In particular, the
  // originating basket's purchased units cannot fulfill its own shortfall.
  // Lock candidates before reading allocations in a fresh statement snapshot.
  const candidates = Prisma.sql`
    FROM pharmacy_unfulfilled_demand_events AS demand
    JOIN pharmacy_sales AS origin ON origin.id = demand."saleId"
      AND origin."organizationId" = demand."organizationId" AND origin."branchId" = demand."branchId"
    JOIN pharmacy_sales AS sale ON sale.id = ${saleId}
      AND sale."organizationId" = demand."organizationId" AND sale."branchId" = demand."branchId"
      AND sale."customerId" = origin."customerId"
    WHERE demand."organizationId" = ${scope.organizationId} AND demand."branchId" = ${scope.branchId}
      AND sale.status = 'COMPLETED' AND demand."saleId" <> sale.id
      AND demand.outcome = 'WILL_RETURN'::"PharmacyDemandOutcome"
      AND demand."resolvedBySaleId" IS NULL
      AND sale."completedAt" >= demand."createdAt"
      AND sale."completedAt" < demand."createdAt" + interval '7 days'
      AND EXISTS (SELECT 1 FROM pharmacy_sale_lines AS line
        WHERE line."saleId" = sale.id AND line."organizationId" = sale."organizationId"
          AND line."branchId" = sale."branchId" AND line."medicineId" = demand."requestedMedicineId")
  `;
  // Lock all affected events in the same order as expiry, including this
  // receipt's own basket events, before updating any of them.
  await db.$executeRaw(Prisma.sql`
    SELECT demand.id FROM pharmacy_unfulfilled_demand_events AS demand
    WHERE demand."organizationId" = ${scope.organizationId} AND demand."branchId" = ${scope.branchId}
      AND (demand."saleId" = ${saleId} OR demand.id IN (SELECT demand.id ${candidates}))
    ORDER BY demand.id FOR UPDATE OF demand
  `);
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
  // Allocate each receipt's canonical units oldest demand first, subtracting
  // earlier allocations from both supply and demand. The ledger also makes
  // completion retries harmless and supports several partial return purchases.
  await db.$executeRaw(Prisma.sql`
    WITH remaining AS (
      SELECT demand.id, demand."requestedMedicineId", demand."createdAt",
        demand."requestedQty" - COALESCE((
          SELECT SUM(recovery."canonicalUnits") FROM pharmacy_demand_recoveries AS recovery
          WHERE recovery."organizationId" = demand."organizationId" AND recovery."branchId" = demand."branchId"
            AND recovery."demandId" = demand.id), 0) AS needed
      ${candidates}
      AND NOT EXISTS (SELECT 1 FROM pharmacy_demand_recoveries AS recovery
        WHERE recovery."organizationId" = demand."organizationId" AND recovery."branchId" = demand."branchId"
          AND recovery."demandId" = demand.id AND recovery."saleId" = sale.id)
    ), supply AS (
      SELECT line."medicineId", SUM(line."canonicalUnits") - COALESCE((
        SELECT SUM(recovery."canonicalUnits") FROM pharmacy_demand_recoveries AS recovery
        JOIN pharmacy_unfulfilled_demand_events AS demand ON demand.id = recovery."demandId"
          AND demand."organizationId" = recovery."organizationId" AND demand."branchId" = recovery."branchId"
        WHERE recovery."organizationId" = ${scope.organizationId} AND recovery."branchId" = ${scope.branchId}
          AND recovery."saleId" = ${saleId} AND demand."requestedMedicineId" = line."medicineId"
      ), 0) AS available
      FROM pharmacy_sale_lines AS line
      WHERE line."organizationId" = ${scope.organizationId} AND line."branchId" = ${scope.branchId}
        AND line."saleId" = ${saleId}
      GROUP BY line."medicineId"
    ), allocation AS (
      SELECT remaining.id, LEAST(needed, GREATEST(0, supply.available - COALESCE(
        SUM(needed) OVER (PARTITION BY "requestedMedicineId" ORDER BY "createdAt", id
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)))::integer AS units
      FROM remaining JOIN supply ON supply."medicineId" = remaining."requestedMedicineId"
    )
    INSERT INTO pharmacy_demand_recoveries ("organizationId", "branchId", "demandId", "saleId", "canonicalUnits")
    SELECT ${scope.organizationId}, ${scope.branchId}, id, ${saleId}, units FROM allocation WHERE units > 0
    ON CONFLICT ("organizationId", "branchId", "demandId", "saleId") DO NOTHING
  `);
  await db.$executeRaw(Prisma.sql`
    WITH recovered AS (
      SELECT recovery."demandId", SUM(recovery."canonicalUnits") AS units
      FROM pharmacy_demand_recoveries AS recovery
      WHERE recovery."organizationId" = ${scope.organizationId} AND recovery."branchId" = ${scope.branchId}
      GROUP BY recovery."demandId"
    )
    UPDATE pharmacy_unfulfilled_demand_events AS demand
    SET "resolvedBySaleId" = CASE WHEN recovered.units >= demand."requestedQty" THEN sale.id ELSE NULL END,
        "resolvedAt" = CASE WHEN recovered.units >= demand."requestedQty" THEN sale."completedAt" ELSE NULL END,
        "lossProbability" = CASE WHEN recovered.units >= demand."requestedQty" THEN 0 ELSE demand."lossProbability" END,
        "estLossPkr" = ROUND(GREATEST(0, demand."requestedQty" - recovered.units) * demand."unitPricePkr"
          * demand."lossProbability", 2) + demand."abandonedBasketPkr"
    FROM recovered, pharmacy_sales AS sale
    WHERE demand.id = recovered."demandId" AND demand."organizationId" = ${scope.organizationId}
      AND demand."branchId" = ${scope.branchId} AND sale.id = ${saleId}
      AND sale."organizationId" = demand."organizationId" AND sale."branchId" = demand."branchId"
      AND EXISTS (SELECT 1 FROM pharmacy_demand_recoveries AS recovery
        WHERE recovery."organizationId" = demand."organizationId" AND recovery."branchId" = demand."branchId"
          AND recovery."demandId" = demand.id AND recovery."saleId" = sale.id)
      AND demand."resolvedBySaleId" IS NULL
  `);
}
