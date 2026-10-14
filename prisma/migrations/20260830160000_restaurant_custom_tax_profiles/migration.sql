ALTER TABLE "restaurant_tax_profile_versions"
  ADD COLUMN "profileName" TEXT,
  ADD COLUMN "jurisdictionCode" TEXT,
  ADD COLUMN "priceMode" "RestaurantTaxPriceMode",
  ADD COLUMN "evidenceKind" TEXT;

ALTER TABLE "restaurant_tax_profile_versions"
  ADD CONSTRAINT "tax_profile_custom_metadata" CHECK (
    "evidenceKind" IS NULL OR (
      "evidenceKind" = 'CUSTOMER_SUPPLIED' AND
      "profileName" IS NOT NULL AND length(btrim("profileName")) > 0 AND
      "jurisdictionCode" IN ('PK-PB', 'PK-SD', 'PK-KP', 'PK-ICT', 'PK-BA') AND
      "priceMode" IS NOT NULL
    )
  );

CREATE OR REPLACE FUNCTION guard_tax_profile_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'DRAFT' THEN RETURN NEW; END IF;
  IF OLD."status" = 'PUBLISHED'
     AND OLD."effectiveTo" IS NULL AND NEW."effectiveTo" IS NOT NULL
     AND NEW."effectiveTo" > OLD."effectiveFrom"
     AND (to_jsonb(NEW) - 'effectiveTo' - 'updatedAt') = (to_jsonb(OLD) - 'effectiveTo' - 'updatedAt')
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'published tax version is immutable' USING ERRCODE = '55000';
END; $$;

CREATE OR REPLACE FUNCTION guard_tax_rule_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'DRAFT' THEN RETURN NEW; END IF;
  IF OLD."status" = 'PUBLISHED'
     AND OLD."effectiveTo" IS NULL AND NEW."effectiveTo" IS NOT NULL
     AND NEW."effectiveTo" > OLD."effectiveFrom"
     AND (to_jsonb(NEW) - 'effectiveTo' - 'updatedAt') = (to_jsonb(OLD) - 'effectiveTo' - 'updatedAt')
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'published tax version is immutable' USING ERRCODE = '55000';
END; $$;

DROP TRIGGER tax_profile_immutable ON "restaurant_tax_profile_versions";
CREATE TRIGGER tax_profile_immutable BEFORE UPDATE OR DELETE ON "restaurant_tax_profile_versions"
FOR EACH ROW EXECUTE FUNCTION guard_tax_profile_mutation();

DROP TRIGGER tax_rule_immutable ON "restaurant_tax_rule_versions";
CREATE TRIGGER tax_rule_immutable BEFORE UPDATE OR DELETE ON "restaurant_tax_rule_versions"
FOR EACH ROW EXECUTE FUNCTION guard_tax_rule_mutation();
