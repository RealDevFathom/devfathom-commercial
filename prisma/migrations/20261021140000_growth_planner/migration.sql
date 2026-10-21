-- Existing growth_settings tenant RLS and FORCE RLS remain in place.
ALTER TABLE "growth_settings"
  ADD COLUMN "lastPlanRunAt" TIMESTAMP(3),
  ADD COLUMN "customDates" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "maxDiscountPct" INTEGER;
ALTER TABLE "growth_settings" ADD CONSTRAINT "growth_settings_discount_limit"
  CHECK ("maxDiscountPct" IS NULL OR "maxDiscountPct" BETWEEN 0 AND 100);
