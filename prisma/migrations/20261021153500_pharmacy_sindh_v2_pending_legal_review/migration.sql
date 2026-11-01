-- Append-only correction: v1 is already deployed without legal-review flags.
-- Never update v1 or alter its migration checksum.
BEGIN;
-- Different append-only versions may supersede the same effective window.
-- Retain overlap protection within each version; consumers choose the latest.
ALTER TABLE "pharmacy_jurisdiction_rule_sets"
  DROP CONSTRAINT "pharmacy_jurisdiction_rule_sets_no_overlap";
ALTER TABLE "pharmacy_jurisdiction_rule_sets"
  ADD CONSTRAINT "pharmacy_jurisdiction_rule_sets_no_overlap"
  EXCLUDE USING gist ("code" WITH =, "version" WITH =,
    tsrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamp), '[)') WITH &&);

SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO "pharmacy_jurisdiction_rule_sets" (
  "id", "code", "version", "effectiveFrom", "licenceCategories",
  "permittedSchedules", "prescriptionOnlyClasses", "prescriptionRetentionDays",
  "controlledRegisterFlags", "pharmacistCoverageRule", "recordRetentionByClass"
) VALUES (
  'pk_sd_pending_review_v2', 'PK-SD', 2, '2026-01-01T00:00:00.000Z',
  '{"values":["RETAIL","WHOLESALE"],"provisional":false,"pendingLegalReview":true}',
  '{"values":["G","H"],"provisional":false,"pendingLegalReview":true}',
  '{"values":["H"],"provisional":false,"pendingLegalReview":true}',
  '{"values":{"H":1825},"provisional":false,"pendingLegalReview":true}',
  '{"values":{"H":true},"provisional":false,"pendingLegalReview":true}',
  '{"values":{"minimumHoursPerWeek":40},"provisional":false,"pendingLegalReview":true}',
  '{"values":{"prescription":1825},"provisional":false,"pendingLegalReview":true}'
)
ON CONFLICT ("code", "version") DO NOTHING;

COMMIT;

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
