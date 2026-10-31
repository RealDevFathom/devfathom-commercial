-- Keep policy history immutable except inside the authorized organization purge.
-- Use a dedicated guard so other pharmacy ledgers keep their existing rules.
CREATE FUNCTION pharmacy_owner_policy_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId"
     AND current_setting('app.is_platform_admin', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'pharmacy_owner_policy_audit is append-only' USING ERRCODE = '55000';
END $$;

DROP TRIGGER pharmacy_owner_policy_audit_append_only ON "pharmacy_owner_policy_audit";
CREATE TRIGGER pharmacy_owner_policy_audit_append_only
  BEFORE UPDATE OR DELETE ON "pharmacy_owner_policy_audit"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_owner_policy_audit_guard();
