-- Do not guess which date is authoritative for legacy invalid ranges. Blocking
-- the migration preserves both original values and gives operators the project
-- ids needed to remediate them through an approved, auditable process.
--
-- projects has FORCE ROW LEVEL SECURITY. The platform-admin flag is its own
-- statement so the pre-check below sees every tenant's rows and can list them.
SELECT set_config('app.is_platform_admin', 'true', true);

DO $$
DECLARE
  invalid_project_ids text;
BEGIN
  SELECT string_agg(id, ', ' ORDER BY id)
  INTO invalid_project_ids
  FROM projects
  WHERE "startDate" IS NOT NULL
    AND "endDate" IS NOT NULL
    AND "endDate" < "startDate";

  IF invalid_project_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'Cannot add projects_date_range_check: invalid date ranges exist for project ids: %',
      invalid_project_ids
      USING HINT = 'Correct these projects through an approved, audited process, then retry the migration.';
  END IF;
END
$$;

ALTER TABLE projects
ADD CONSTRAINT projects_date_range_check
CHECK ("startDate" IS NULL OR "endDate" IS NULL OR "endDate" >= "startDate");
