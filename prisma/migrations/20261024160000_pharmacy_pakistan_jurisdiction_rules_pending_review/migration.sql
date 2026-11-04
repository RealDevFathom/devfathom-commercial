-- #129: carry the Pakistan jurisdiction choices forward without rewriting any
-- deployed migration or rule payload. Sindh's values remain pending legal review;
-- they are not a production legal confirmation. Other new provinces fail closed.
BEGIN;

-- The historical Sindh correction allows immutable versions to supersede the
-- same window. Keep overlap protection within each version and choose the latest
-- effective version in consumers; never update or delete an earlier rule set.
LOCK TABLE "pharmacy_jurisdiction_rule_sets" IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE "pharmacy_jurisdiction_rule_sets"
  DROP CONSTRAINT "pharmacy_jurisdiction_rule_sets_no_overlap";
ALTER TABLE "pharmacy_jurisdiction_rule_sets"
  ADD CONSTRAINT "pharmacy_jurisdiction_rule_sets_no_overlap"
  EXCLUDE USING gist ("code" WITH =, "version" WITH =,
    tsrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamp), '[)') WITH &&);

-- FORCE RLS remains enabled. This flag must not outlive the migration transaction.
SELECT set_config('app.is_platform_admin', 'true', true);

-- v1/v2 occur in the historical #129 branches. Reserve those versions and append
-- above any existing Sindh version, rather than ignoring a conflicting payload.
WITH next_sindh_version AS (
  SELECT GREATEST(COALESCE(MAX("version"), 0) + 1, 3) AS version
  FROM "pharmacy_jurisdiction_rule_sets" WHERE "code" = 'PK-SD'
)
INSERT INTO "pharmacy_jurisdiction_rule_sets" (
  "id", "code", "version", "effectiveFrom", "licenceCategories",
  "permittedSchedules", "prescriptionOnlyClasses", "prescriptionRetentionDays",
  "controlledRegisterFlags", "pharmacistCoverageRule", "recordRetentionByClass"
)
SELECT
  'pk_sd_pending_review_v' || version, 'PK-SD', version, '2026-01-01T00:00:00.000Z'::timestamp,
  '{"values":["RETAIL","WHOLESALE"],"provisional":false,"pendingLegalReview":true}'::jsonb,
  '{"values":["G","H"],"provisional":false,"pendingLegalReview":true}'::jsonb,
  '{"values":["H"],"provisional":false,"pendingLegalReview":true}'::jsonb,
  '{"values":{"H":1825},"provisional":false,"pendingLegalReview":true}'::jsonb,
  '{"values":{"H":true},"provisional":false,"pendingLegalReview":true}'::jsonb,
  '{"values":{"minimumHoursPerWeek":40},"provisional":false,"pendingLegalReview":true}'::jsonb,
  '{"values":{"prescription":1825},"provisional":false,"pendingLegalReview":true}'::jsonb
FROM next_sindh_version;

INSERT INTO "pharmacy_jurisdiction_rule_sets" (
  "id", "code", "version", "effectiveFrom", "licenceCategories",
  "permittedSchedules", "prescriptionOnlyClasses", "prescriptionRetentionDays",
  "controlledRegisterFlags", "pharmacistCoverageRule", "recordRetentionByClass"
)
SELECT
  lower(replace(code, '-', '_')) || '_provisional_v1', code, 1,
  '2026-10-22T00:00:00.000Z'::timestamp,
  '{"values":[],"provisional":true,"toConfirm":"Issue #129 jurisdiction counsel review"}'::jsonb,
  '{"values":[],"provisional":true,"toConfirm":"Issue #129 jurisdiction counsel review"}'::jsonb,
  '{"values":[],"provisional":true,"toConfirm":"Issue #129 jurisdiction counsel review"}'::jsonb,
  '{"values":{},"provisional":true,"toConfirm":"Issue #129 jurisdiction counsel review"}'::jsonb,
  '{"values":{},"provisional":true,"toConfirm":"Issue #129 jurisdiction counsel review"}'::jsonb,
  '{"values":{},"provisional":true,"toConfirm":"Issue #129 jurisdiction counsel review"}'::jsonb,
  '{"values":{},"provisional":true,"toConfirm":"Issue #129 jurisdiction counsel review"}'::jsonb
FROM unnest(ARRAY['PK-KP', 'PK-BA', 'PK-ICT', 'PK-GB', 'PK-AJK']) AS jurisdictions(code)
WHERE NOT EXISTS (
  SELECT 1 FROM "pharmacy_jurisdiction_rule_sets" existing
  WHERE existing."code" = jurisdictions.code
);

COMMIT;
