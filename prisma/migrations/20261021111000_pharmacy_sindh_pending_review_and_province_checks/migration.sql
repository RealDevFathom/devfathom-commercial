-- #162 follow-up. Kept separate from 20261021110500 so environments that applied the
-- old-named Sindh migration only need their _prisma_migrations row renamed; this file
-- then applies normally everywhere. Idempotent.
SELECT set_config('app.is_platform_admin', 'true', true);
-- Databases that already applied this rule set under the old migration name
-- (20261021110000_pharmacy_sindh_published_rules) have the row without the flag.
-- Set it idempotently on every relevant field.
UPDATE "pharmacy_jurisdiction_rule_sets"
SET "licenceCategories" = ("licenceCategories"::jsonb || '{"pendingLegalReview":true}'),
    "permittedSchedules" = ("permittedSchedules"::jsonb || '{"pendingLegalReview":true}'),
    "prescriptionOnlyClasses" = ("prescriptionOnlyClasses"::jsonb || '{"pendingLegalReview":true}'),
    "prescriptionRetentionDays" = ("prescriptionRetentionDays"::jsonb || '{"pendingLegalReview":true}'),
    "controlledRegisterFlags" = ("controlledRegisterFlags"::jsonb || '{"pendingLegalReview":true}'),
    "pharmacistCoverageRule" = ("pharmacistCoverageRule"::jsonb || '{"pendingLegalReview":true}'),
    "recordRetentionByClass" = ("recordRetentionByClass"::jsonb || '{"pendingLegalReview":true}')
WHERE "id" = 'pk_sd_published_v1';

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
