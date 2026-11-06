BEGIN;

-- FORCE RLS applies even to the table owner. Inspect every tenant, using the
-- same transaction-local platform scope as MEET-01, and never run blind.
SELECT set_config('app.is_platform_admin', 'true', true);

DO $$
BEGIN
  IF row_security_active('meetings')
     AND current_setting('app.is_platform_admin', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'Meeting time constraint: row level security is active for role % without platform scope; aborting.',
      current_user;
  END IF;
END $$;

-- Hold the DDL lock through preflight and validation so another writer cannot
-- introduce an invalid range between the two. Roll back everything on failure.
ALTER TABLE "meetings"
ADD CONSTRAINT "meetings_endTime_after_startTime_check"
CHECK ("endTime" > "startTime") NOT VALID;

-- Follow MEET-01: surface invalid data rather than inventing meeting times.
-- Clamping only a series would leave its occurrences and history inconsistent.
-- Report the count and a bounded ID sample so an operator can correct BOTH
-- through an audited data correction before retrying deployment.
DO $$
DECLARE
  invalid_count bigint;
  invalid_ids text;
BEGIN
  SELECT count(*) INTO invalid_count
  FROM "meetings" WHERE "endTime" <= "startTime";

  IF invalid_count > 0 THEN
    SELECT string_agg("id", ', ' ORDER BY "id") INTO invalid_ids
    FROM (
      SELECT "id" FROM "meetings"
      WHERE "endTime" <= "startTime" ORDER BY "id" LIMIT 20
    ) AS invalid;
    RAISE EXCEPTION
      'Meeting time constraint: % meetings end at or before they start. Meeting IDs (first 20): %',
      invalid_count, invalid_ids
      USING HINT = 'A human must correct the meetings and their occurrences through an audited data correction before retrying this migration. No times have been changed.';
  END IF;
END $$;

ALTER TABLE "meetings"
VALIDATE CONSTRAINT "meetings_endTime_after_startTime_check";

COMMIT;
