-- DEV-63: a delivery order records the route distance the runner was sent on,
-- so delivery profitability can be reported by radius band. Nullable: orders
-- dispatched before this column, and collections, have no recorded distance and
-- are reported as such rather than guessed. The table keeps its existing RLS.
BEGIN;

ALTER TABLE "pharmacy_customer_orders"
  ADD COLUMN IF NOT EXISTS "deliveryDistanceMeters" INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pharmacy_customer_orders_delivery_distance_range'
  ) THEN
    ALTER TABLE "pharmacy_customer_orders"
      ADD CONSTRAINT "pharmacy_customer_orders_delivery_distance_range"
      CHECK ("deliveryDistanceMeters" IS NULL OR "deliveryDistanceMeters" BETWEEN 0 AND 200000);
  END IF;
END $$;

COMMIT;
