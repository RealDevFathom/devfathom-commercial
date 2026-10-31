-- Tenant audit evidence is immutable. RLS isolates organizations, while this
-- trigger prevents an authorized tenant path from rewriting its own history.
-- Only the platform retention worker may delete the exact tenant being purged.
-- Keep this separate from the unconditional platform-history guard.
CREATE FUNCTION refuse_tenant_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('app.is_platform_admin', true) = 'true'
     AND NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId" THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER audit_logs_append_only
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION refuse_tenant_audit_mutation();
