-- Recipe costing assumes conversion factors, yields, and BOM quantities are
-- strictly positive. Reference cost may be zero (for a free ingredient), but
-- may never be negative. Refuse to guess how financially meaningful legacy
-- values should be repaired: report a bounded set of affected tenant/record IDs
-- and let the migration be retried after an approved data repair.
DO $$
DECLARE
  affected jsonb;
BEGIN
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'unitConversions', (SELECT jsonb_agg(row_to_json(bad)) FROM (
      SELECT "organizationId", "fromUnitId", "toUnitId" FROM "restaurant_unit_conversions"
      WHERE "factor" IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) OR "factor" <= 0 LIMIT 20
    ) bad),
    'recipeVersions', (SELECT jsonb_agg(row_to_json(bad)) FROM (
      SELECT "organizationId", "id" FROM "restaurant_recipe_versions"
      WHERE "yieldQuantity" IS NOT NULL AND
        ("yieldQuantity" IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) OR "yieldQuantity" <= 0) LIMIT 20
    ) bad),
    'recipeLines', (SELECT jsonb_agg(row_to_json(bad)) FROM (
      SELECT "organizationId", "id" FROM "restaurant_recipe_lines"
      WHERE "quantity" IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) OR "quantity" <= 0 LIMIT 20
    ) bad),
    'ingredients', (SELECT jsonb_agg(row_to_json(bad)) FROM (
      SELECT "organizationId", "id" FROM "restaurant_ingredients"
      WHERE "referenceCost" IS NOT NULL AND
        ("referenceCost" IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) OR "referenceCost" < 0) LIMIT 20
    ) bad)
  )) INTO affected;

  IF affected <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Recipe measurement constraints cannot be installed: invalid legacy rows exist'
      USING DETAIL = affected::text,
            HINT = 'Repair the listed rows according to an approved business rule, then retry this migration.';
  END IF;
END $$;

ALTER TABLE "restaurant_unit_conversions"
  ADD CONSTRAINT "restaurant_unit_conversions_factor_positive_ck"
  CHECK ("factor" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND "factor" > 0);

ALTER TABLE "restaurant_recipe_versions"
  ADD CONSTRAINT "restaurant_recipe_versions_yield_quantity_positive_ck"
  CHECK ("yieldQuantity" IS NULL OR
    ("yieldQuantity" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND "yieldQuantity" > 0));

ALTER TABLE "restaurant_recipe_lines"
  ADD CONSTRAINT "restaurant_recipe_lines_quantity_positive_ck"
  CHECK ("quantity" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND "quantity" > 0);

ALTER TABLE "restaurant_ingredients"
  ADD CONSTRAINT "restaurant_ingredients_reference_cost_nonnegative_ck"
  CHECK ("referenceCost" IS NULL OR
    ("referenceCost" NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND "referenceCost" >= 0));
