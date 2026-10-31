-- #718: non-drug retail items with promo eligibility.
--
-- The commercial class is derived from the existing "productFamily" ('FRONT_SHOP' =
-- NON_DRUG_RETAIL, everything else = MEDICINE); no parallel enum is introduced.
-- Additive and backward compatible: every new column is nullable or defaulted, and no
-- existing row, constraint, policy or trigger is changed.

-- Shop-set retail price and retail category for non-drug items. A medicine keeps its DRAP
-- printed MRP on the received lot and may never carry either field.
ALTER TABLE "pharmacy_medicines"
  ADD COLUMN "retailPriceMinor" INTEGER,
  ADD COLUMN "retailCategory" TEXT;

ALTER TABLE "pharmacy_medicines"
  ADD CONSTRAINT "pharmacy_medicines_retail_price_positive"
    CHECK ("retailPriceMinor" IS NULL OR "retailPriceMinor" > 0),
  ADD CONSTRAINT "pharmacy_medicines_retail_category_shape"
    CHECK ("retailCategory" IS NULL OR (btrim("retailCategory") <> '' AND char_length("retailCategory") <= 80)),
  ADD CONSTRAINT "pharmacy_medicines_retail_fields_non_drug_only"
    CHECK (("retailPriceMinor" IS NULL AND "retailCategory" IS NULL) OR "productFamily" = 'FRONT_SHOP');

-- The catalogue items a marketing template promotes. Empty for every existing template.
ALTER TABLE "pharmacy_marketing_templates"
  ADD COLUMN "featuredMedicineIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "pharmacy_marketing_templates"
  ADD CONSTRAINT "pharmacy_marketing_templates_featured_limit"
    CHECK (cardinality("featuredMedicineIds") <= 20);

-- Database backstop for the server-side guard: a template may feature only visible,
-- same-tenant NON_DRUG_RETAIL items without Rx, restricted or controlled flags. The lookup
-- runs as the invoker, so FORCE RLS on pharmacy_medicines hides other tenants' rows and a
-- foreign id is refused as missing.
CREATE OR REPLACE FUNCTION pharmacy_marketing_template_featured_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  eligible integer;
  requested integer;
BEGIN
  requested := (SELECT count(DISTINCT id) FROM unnest(NEW."featuredMedicineIds") AS id);
  IF requested = 0 THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO eligible
  FROM "pharmacy_medicines" m
  WHERE m."organizationId" = NEW."organizationId"
    AND m."id" = ANY (NEW."featuredMedicineIds")
    AND m."productFamily" = 'FRONT_SHOP'
    AND m."rx" = false
    AND m."restricted" = false
    AND m."controlled" = false;
  IF eligible <> requested THEN
    RAISE EXCEPTION 'pharmacy marketing templates may feature only non-drug retail items'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "pharmacy_marketing_templates_featured_guard"
  BEFORE INSERT OR UPDATE OF "featuredMedicineIds" ON "pharmacy_marketing_templates"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_marketing_template_featured_guard();
