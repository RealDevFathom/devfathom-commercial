CREATE TYPE "PharmacyDemandVisitType" AS ENUM ('PARTIAL', 'WALK_OUT');
CREATE TYPE "PharmacyDemandOutcome" AS ENUM ('SUBSTITUTE_TAKEN', 'WILL_RETURN', 'WENT_ELSEWHERE', 'ORDERED_FOR_CUSTOMER', 'UNKNOWN');

ALTER TABLE "pharmacy_branches"
  ADD COLUMN "lostSalesUnknownProbability" DECIMAL(5,4) NOT NULL DEFAULT 0.43,
  ADD COLUMN "lostSalesMeasuredRateMinimum" INTEGER NOT NULL DEFAULT 200,
  ADD CONSTRAINT "pharmacy_branches_lost_sales_probability_check" CHECK ("lostSalesUnknownProbability" BETWEEN 0 AND 1),
  ADD CONSTRAINT "pharmacy_branches_lost_sales_minimum_check" CHECK ("lostSalesMeasuredRateMinimum" > 0);

ALTER TABLE "pharmacy_unfulfilled_demand_events"
  ADD COLUMN "visitId" TEXT,
  ADD COLUMN "visitType" "PharmacyDemandVisitType",
  ADD COLUMN "outcome" "PharmacyDemandOutcome" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "requestedQty" INTEGER,
  ADD COLUMN "unitPricePkr" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "estLossPkr" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "lossProbability" DECIMAL(5,4) NOT NULL DEFAULT 0.43,
  ADD COLUMN "substituteProductId" TEXT,
  ADD COLUMN "notifyOptIn" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "notifyPhone" TEXT,
  ADD COLUMN "resolvedAt" TIMESTAMP(3),
  ADD COLUMN "resolvedBySaleId" TEXT,
  ADD COLUMN "freeText" TEXT,
  ADD COLUMN "matchedProductId" TEXT,
  ADD COLUMN "matchConfidence" DECIMAL(5,4),
  ADD COLUMN "terminalId" TEXT;

UPDATE "pharmacy_unfulfilled_demand_events"
SET "visitId" = id, "visitType" = 'WALK_OUT', "requestedQty" = quantity,
    "terminalId" = 'legacy:' || "capturedByUserId";

ALTER TABLE "pharmacy_unfulfilled_demand_events"
  ALTER COLUMN "visitId" SET NOT NULL,
  ALTER COLUMN "visitType" SET NOT NULL,
  ALTER COLUMN "requestedQty" SET NOT NULL,
  ALTER COLUMN "terminalId" SET NOT NULL,
  ADD CONSTRAINT "pharmacy_demand_requested_qty_check" CHECK ("requestedQty" > 0),
  ADD CONSTRAINT "pharmacy_demand_loss_probability_check" CHECK ("lossProbability" BETWEEN 0 AND 1),
  ADD CONSTRAINT "pharmacy_demand_match_confidence_check" CHECK ("matchConfidence" IS NULL OR "matchConfidence" BETWEEN 0 AND 1),
  ADD CONSTRAINT "pharmacy_demand_notify_phone_check" CHECK (NOT "notifyOptIn" OR "notifyPhone" IS NOT NULL);

CREATE INDEX "ph_demand_visit_idx"
  ON "pharmacy_unfulfilled_demand_events"("organizationId", "branchId", "visitId");
