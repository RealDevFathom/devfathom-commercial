-- Platform history survives the retention worker: both tables are excluded by
-- CONTROL_PLANE_TABLES in jobs.ts. No runtime purge bypass is needed or allowed.
CREATE FUNCTION refuse_platform_history_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER platform_audit_logs_append_only
BEFORE UPDATE OR DELETE ON platform_audit_logs
FOR EACH ROW EXECUTE FUNCTION refuse_platform_history_mutation();

CREATE TRIGGER organization_lifecycle_events_append_only
BEFORE UPDATE OR DELETE ON organization_lifecycle_events
FOR EACH ROW EXECUTE FUNCTION refuse_platform_history_mutation();
