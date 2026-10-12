-- Preserve delivery fee sales/refunds as separate immutable close facts and
-- carry them through the rebuildable financial insight projection.
ALTER TABLE "restaurant_daily_closes"
  ADD COLUMN "deliveryFeeSales" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "deliveryFeeRefunds" DECIMAL(12,2) NOT NULL DEFAULT 0;

ALTER TABLE "restaurant_insight_daily_rollups"
  ADD COLUMN "deliveryFeeSales" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "deliveryFeeRefunds" DECIMAL(12,2) NOT NULL DEFAULT 0;

ALTER TABLE "restaurant_daily_closes"
  ADD CONSTRAINT "restaurant_daily_closes_delivery_fees_nonneg_ck"
  CHECK ("deliveryFeeSales" >= 0 AND "deliveryFeeRefunds" >= 0);

ALTER TABLE "restaurant_insight_daily_rollups"
  ADD CONSTRAINT "restaurant_insight_daily_rollups_delivery_fees_nonneg_ck"
  CHECK ("deliveryFeeSales" >= 0 AND "deliveryFeeRefunds" >= 0);
