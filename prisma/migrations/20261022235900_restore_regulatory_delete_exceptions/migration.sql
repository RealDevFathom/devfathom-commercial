-- Restore every narrowly-scoped exception on the shared regulatory append-only
-- trigger. The placeholder migration replaced this function and accidentally
-- removed the existing tenant-purge and orphan-cleanup paths.
CREATE OR REPLACE FUNCTION pharmacy_reject_regulatory_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."effectiveTo" IS NULL
     AND NEW."effectiveTo" IS NOT NULL
     AND NEW."effectiveTo" > OLD."effectiveFrom"
     AND (to_jsonb(NEW) - 'effectiveTo') = (to_jsonb(OLD) - 'effectiveTo') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'pharmacy_branch_regulatory_profiles' THEN
    -- Regulatory evidence is never removed by the placeholder lock. Deletes
    -- remain available only to the two existing teardown paths below.
    IF NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId"
       AND current_setting('app.is_platform_admin', true) = 'true' THEN
      RETURN OLD;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "organizations" WHERE "id" = OLD."organizationId") THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION '% is append-only; create a new effective-dated version', TG_TABLE_NAME
    USING ERRCODE = '23514';
END $$;
