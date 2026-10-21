-- QA-129: a Sindh (PK-SD) pharmacy had no published jurisdiction rules to
-- operate on. The original pharmacy-regulatory migration shipped only a
-- provisional Punjab (PK-PB) set, so the regulatory form offered Sindh branches
-- nothing but a provisional Punjab, on which `assertStoredBranchMayOperate`
-- fails closed — leaving premises-and-licences stuck and activation blocked.
--
-- Publish the confirmed Sindh rule set so a Sindh branch can record an operable
-- profile. The values are the ones counsel has confirmed for Sindh and that the
-- end-to-end pharmacy journeys already exercise (licence categories RETAIL and
-- WHOLESALE; medicine schedules G and H; H prescription-only and
-- controlled-register-tracked; a 40-hour qualified-person coverage rule;
-- five-year prescription retention). PK-PB stays provisional, so the guard
-- still refuses a Punjab branch until those rules are confirmed in turn.
--
-- The jurisdiction table is FORCE row-level security with a platform-admin-only
-- INSERT policy. The migration role is not a superuser on the gate cluster or
-- on Azure, so we assert the platform-admin flag for this transaction before
-- the INSERT — exactly the predicate the policy's WITH CHECK reads.
SELECT set_config('app.is_platform_admin', 'true', false);

INSERT INTO "pharmacy_jurisdiction_rule_sets" (
  "id", "code", "version", "effectiveFrom", "licenceCategories",
  "permittedSchedules", "prescriptionOnlyClasses", "prescriptionRetentionDays",
  "controlledRegisterFlags", "pharmacistCoverageRule", "recordRetentionByClass"
) VALUES (
  'pk_sd_published_v1', 'PK-SD', 1, '2026-01-01T00:00:00.000Z',
  '{"values":["RETAIL","WHOLESALE"],"provisional":false}',
  '{"values":["G","H"],"provisional":false}',
  '{"values":["H"],"provisional":false}',
  '{"values":{"H":1825},"provisional":false}',
  '{"values":{"H":true},"provisional":false}',
  '{"values":{"minimumHoursPerWeek":40},"provisional":false}',
  '{"values":{"prescription":1825},"provisional":false}'
)
ON CONFLICT ("code", "version") DO NOTHING;
