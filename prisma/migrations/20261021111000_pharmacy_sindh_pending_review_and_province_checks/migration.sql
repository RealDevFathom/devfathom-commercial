-- The unreleased Sindh insert already includes pendingLegalReview on every field.
-- Jurisdiction rules are append-only; do not rewrite the published row.

-- Security (#162): a regulatory profile must name a province. NOT VALID keeps any
-- legacy row from blocking the deploy while enforcing every new/updated row.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pharmacy_branch_regulatory_profiles_province_nonempty'
      AND conrelid = '"pharmacy_branch_regulatory_profiles"'::regclass
  ) THEN
    ALTER TABLE "pharmacy_branch_regulatory_profiles"
      ADD CONSTRAINT "pharmacy_branch_regulatory_profiles_province_nonempty"
      CHECK (btrim("provinceCode") <> '') NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pharmacy_branches_province_nonempty'
      AND conrelid = '"pharmacy_branches"'::regclass
  ) THEN
    ALTER TABLE "pharmacy_branches"
      ADD CONSTRAINT "pharmacy_branches_province_nonempty"
      CHECK (btrim("provinceCode") <> '') NOT VALID;
  END IF;
END $$;
