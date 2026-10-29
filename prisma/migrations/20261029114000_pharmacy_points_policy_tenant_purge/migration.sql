-- Keep policy history append-only while admitting the retention worker's
-- transaction-local, exact-tenant platform purge, like onboarding history.
CREATE OR REPLACE FUNCTION pharmacy_loyalty_policy_audit_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId"
     AND current_setting('app.is_platform_admin', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Loyalty settings audit is append only';
END $$;
