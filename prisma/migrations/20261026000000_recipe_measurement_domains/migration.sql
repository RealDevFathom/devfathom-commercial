-- Recipe costing assumes conversion factors, yields, and BOM quantities are
-- strictly positive. Reference cost may be zero (for a free ingredient), but
-- may never be negative. Keep these invariants below the application boundary
-- so direct SQL and future write paths cannot persist unusable values.
ALTER TABLE "restaurant_unit_conversions"
  ADD CONSTRAINT "restaurant_unit_conversions_factor_positive_ck"
  CHECK ("factor" > 0);

ALTER TABLE "restaurant_recipe_versions"
  ADD CONSTRAINT "restaurant_recipe_versions_yield_quantity_positive_ck"
  CHECK ("yieldQuantity" IS NULL OR "yieldQuantity" > 0);

ALTER TABLE "restaurant_recipe_lines"
  ADD CONSTRAINT "restaurant_recipe_lines_quantity_positive_ck"
  CHECK ("quantity" > 0);

ALTER TABLE "restaurant_ingredients"
  ADD CONSTRAINT "restaurant_ingredients_reference_cost_nonnegative_ck"
  CHECK ("referenceCost" IS NULL OR "referenceCost" >= 0);
