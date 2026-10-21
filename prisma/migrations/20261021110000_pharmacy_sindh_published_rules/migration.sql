-- Published Sindh pharmacy rules. This migration has already been deployed;
-- do not amend it (the session-scoped platform flag is tracked by #245).
SELECT set_config('app.is_platform_admin', 'true', false);

INSERT INTO "pharmacy_jurisdiction_rule_sets" (
  "id", "code", "version", "effectiveFrom", "licenceCategories",
  "permittedSchedules", "prescriptionOnlyClasses", "prescriptionRetentionDays",
  "controlledRegisterFlags", "pharmacistCoverageRule", "recordRetentionByClass"
) VALUES (
  'pk_sd_published_v1', 'PK-SD', 1, '2026-10-21T00:00:00.000Z',
  '{"values":["RETAIL","WHOLESALE"],"provisional":false}',
  '{"values":["G","H"],"provisional":false}',
  '{"values":["H"],"provisional":false}',
  '{"values":{"H":1825},"provisional":false}',
  '{"values":{"H":true},"provisional":false}',
  '{"values":{"minimumHoursPerWeek":40},"provisional":false}',
  '{"values":{"prescriptions":1825,"invoices":1825,"controlledRegister":1825},"provisional":false}'
);

SELECT set_config('app.is_platform_admin', 'false', false);
