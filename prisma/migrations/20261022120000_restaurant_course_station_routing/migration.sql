ALTER TABLE "restaurant_station_routing_rules"
  ADD COLUMN "course" INTEGER;

ALTER TABLE "restaurant_station_routing_rules"
  DROP CONSTRAINT "restaurant_station_routing_rules_product_xor_category_ck";

ALTER TABLE "restaurant_station_routing_rules"
  ADD CONSTRAINT "restaurant_station_routing_rules_target_xor_ck"
  CHECK (
    num_nonnulls("productId", "categoryId", "course") = 1
    AND ("course" IS NULL OR "course" > 0)
  );

CREATE INDEX "restaurant_station_routing_rules_course_idx"
  ON "restaurant_station_routing_rules"("course");
