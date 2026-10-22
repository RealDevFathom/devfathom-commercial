-- Issue #129: make the Karachi/Sindh regulatory profile operable. Sindh is the
-- only newly confirmed rule set in this migration. The other unseeded Pakistan
-- jurisdictions are visible but remain fail-closed until counsel confirms them.
-- Punjab's original provisional record is intentionally left immutable.
-- The table is FORCE RLS; scope the existing platform-admin insert policy to
-- this migration transaction rather than weakening or bypassing that policy.
SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO "pharmacy_jurisdiction_rule_sets" (
  "id", "code", "version", "effectiveFrom", "licenceCategories",
  "permittedSchedules", "prescriptionOnlyClasses", "prescriptionRetentionDays",
  "controlledRegisterFlags", "pharmacistCoverageRule", "recordRetentionByClass"
) VALUES (
  'pk_sd_confirmed_v1', 'PK-SD', 1, '2026-01-01T00:00:00.000Z',
  '{"values":["RETAIL","WHOLESALE"],"provisional":false}',
  '{"values":["G","H"],"provisional":false}',
  '{"values":["H"],"provisional":false}',
  '{"values":{"H":1825},"provisional":false}',
  '{"values":{"H":true},"provisional":false}',
  '{"values":{"minimumHoursPerWeek":40},"provisional":false}',
  '{"values":{"prescription":1825},"provisional":false}'
);

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
FROM unnest(ARRAY['PK-KP', 'PK-BA', 'PK-ICT', 'PK-GB', 'PK-AJK']) AS code;
