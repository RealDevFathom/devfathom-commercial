-- DEV-81 (#735): lost-sales capture. Extends the existing POS-10 demand events
-- with visit grouping, the counter outcome chip, server-side PKR price and the
-- estimated loss. Adds two per-branch tunables for the UNKNOWN-outcome loss
-- probability; 0.43 is a grocery-study estimate and stays configurable.
-- No new table, so the existing tenant RLS policies keep covering every row.
-- Idempotent: IF NOT EXISTS everywhere, enum creation guarded.
BEGIN;

DO $$ BEGIN
  CREATE TYPE "PharmacyLostSaleOutcome" AS ENUM (
    'SUBSTITUTE_TAKEN', 'WILL_RETURN', 'WENT_ELSEWHERE', 'ORDERED_FOR_CUSTOMER', 'UNKNOWN'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "PharmacyLostSaleVisitType" AS ENUM ('PARTIAL', 'WALK_OUT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "pharmacy_unfulfilled_demand_events"
  ADD COLUMN IF NOT EXISTS "terminalId" TEXT,
  ADD COLUMN IF NOT EXISTS "visitId" TEXT,
  ADD COLUMN IF NOT EXISTS "visitType" "PharmacyLostSaleVisitType",
  ADD COLUMN IF NOT EXISTS "outcome" "PharmacyLostSaleOutcome" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS "requestedQty" INTEGER,
  ADD COLUMN IF NOT EXISTS "unitPricePkrMinor" INTEGER,
  ADD COLUMN IF NOT EXISTS "estLossPkrMinor" INTEGER,
  ADD COLUMN IF NOT EXISTS "lossProbability" DECIMAL(5,4),
  ADD COLUMN IF NOT EXISTS "substituteProductId" TEXT,
  ADD COLUMN IF NOT EXISTS "notifyOptIn" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "notifyPhone" TEXT,
  ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "resolvedBySaleId" TEXT,
  ADD COLUMN IF NOT EXISTS "freeText" TEXT,
  ADD COLUMN IF NOT EXISTS "matchedProductId" TEXT,
  ADD COLUMN IF NOT EXISTS "matchConfidence" DECIMAL(5,4);

-- A phone number is kept only with an explicit notify-when-back opt-in.
ALTER TABLE "pharmacy_unfulfilled_demand_events"
  DROP CONSTRAINT IF EXISTS "pharmacy_demand_notify_phone_check";
ALTER TABLE "pharmacy_unfulfilled_demand_events"
  ADD CONSTRAINT "pharmacy_demand_notify_phone_check"
  CHECK ("notifyPhone" IS NULL OR "notifyOptIn");

ALTER TABLE "pharmacy_unfulfilled_demand_events"
  DROP CONSTRAINT IF EXISTS "pharmacy_demand_loss_probability_check";
ALTER TABLE "pharmacy_unfulfilled_demand_events"
  ADD CONSTRAINT "pharmacy_demand_loss_probability_check"
  CHECK ("lossProbability" IS NULL OR ("lossProbability" >= 0 AND "lossProbability" <= 1));

CREATE INDEX IF NOT EXISTS "pharmacy_demand_events_visit_idx"
  ON "pharmacy_unfulfilled_demand_events" ("organizationId", "branchId", "visitId");
CREATE INDEX IF NOT EXISTS "pharmacy_demand_events_outcome_idx"
  ON "pharmacy_unfulfilled_demand_events" ("organizationId", "branchId", "outcome", "createdAt");

ALTER TABLE "pharmacy_branches"
  ADD COLUMN IF NOT EXISTS "lostSalesUnknownLossProbability" DECIMAL(5,4) NOT NULL DEFAULT 0.43,
  ADD COLUMN IF NOT EXISTS "lostSalesMeasuredRateMinEvents" INTEGER NOT NULL DEFAULT 200;

ALTER TABLE "pharmacy_branches"
  DROP CONSTRAINT IF EXISTS "pharmacy_branches_lost_sales_settings_check";
ALTER TABLE "pharmacy_branches"
  ADD CONSTRAINT "pharmacy_branches_lost_sales_settings_check"
  CHECK ("lostSalesUnknownLossProbability" >= 0 AND "lostSalesUnknownLossProbability" <= 1
         AND "lostSalesMeasuredRateMinEvents" >= 1);

COMMIT;
