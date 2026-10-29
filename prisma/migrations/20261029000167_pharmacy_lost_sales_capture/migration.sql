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

-- Do not rewrite or exclusively lock the historical table during deploy.  The
-- application supplies these fields for every new row; NOT VALID checks enforce
-- that invariant immediately for new writes while allowing a later online,
-- resumable backfill of legacy rows.
ALTER TABLE "pharmacy_unfulfilled_demand_events"
  ADD CONSTRAINT "pharmacy_demand_capture_fields_check"
    CHECK ("visitId" IS NOT NULL AND "visitType" IS NOT NULL AND "requestedQty" IS NOT NULL AND "terminalId" IS NOT NULL) NOT VALID,
  ADD CONSTRAINT "pharmacy_demand_requested_qty_check" CHECK ("requestedQty" > 0) NOT VALID,
  ADD CONSTRAINT "pharmacy_demand_loss_probability_check" CHECK ("lossProbability" BETWEEN 0 AND 1) NOT VALID,
  ADD CONSTRAINT "pharmacy_demand_match_confidence_check" CHECK ("matchConfidence" IS NULL OR "matchConfidence" BETWEEN 0 AND 1) NOT VALID,
  ADD CONSTRAINT "pharmacy_demand_notify_phone_check" CHECK (NOT "notifyOptIn" OR "notifyPhone" IS NOT NULL) NOT VALID,
  ADD CONSTRAINT "pharmacy_demand_substitute_product_fk"
    FOREIGN KEY ("organizationId", "substituteProductId") REFERENCES medicines("organizationId", id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT "pharmacy_demand_matched_product_fk"
    FOREIGN KEY ("organizationId", "matchedProductId") REFERENCES medicines("organizationId", id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT "pharmacy_demand_resolved_sale_fk"
    FOREIGN KEY ("organizationId", "branchId", "resolvedBySaleId") REFERENCES pharmacy_sales("organizationId", "branchId", id) ON DELETE RESTRICT NOT VALID;

CREATE INDEX "ph_demand_visit_idx"
  ON "pharmacy_unfulfilled_demand_events"("organizationId", "branchId", "visitId");
