-- A jurisdiction may retain separately effective versions while legal review is
-- pending. Overlap remains prohibited within each individual version.
SELECT set_config('app.is_platform_admin', 'true', true);

ALTER TABLE "pharmacy_jurisdiction_rule_sets"
  DROP CONSTRAINT "pharmacy_jurisdiction_rule_sets_no_overlap";
ALTER TABLE "pharmacy_jurisdiction_rule_sets"
  ADD CONSTRAINT "pharmacy_jurisdiction_rule_sets_no_overlap"
  EXCLUDE USING gist (
    "code" WITH =,
    "version" WITH =,
    tsrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamp), '[)') WITH &&
  );

INSERT INTO "pharmacy_jurisdiction_rule_sets" (
  "id", "code", "version", "effectiveFrom", "licenceCategories",
  "permittedSchedules", "prescriptionOnlyClasses", "prescriptionRetentionDays",
  "controlledRegisterFlags", "pharmacistCoverageRule", "recordRetentionByClass"
) VALUES (
  'pk_sd_pending_review_v2', 'PK-SD', 2, '2026-10-21T00:00:00.000Z',
  '{"values":["RETAIL","WHOLESALE"],"provisional":false,"pendingLegalReview":true}',
  '{"values":["G","H"],"provisional":false,"pendingLegalReview":true}',
  '{"values":["H"],"provisional":false,"pendingLegalReview":true}',
  '{"values":{"H":1825},"provisional":false,"pendingLegalReview":true}',
  '{"values":{"H":true},"provisional":false,"pendingLegalReview":true}',
  '{"values":{"minimumHoursPerWeek":40},"provisional":false,"pendingLegalReview":true}',
  '{"values":{"prescriptions":1825,"invoices":1825,"controlledRegister":1825},"provisional":false,"pendingLegalReview":true}'
);
