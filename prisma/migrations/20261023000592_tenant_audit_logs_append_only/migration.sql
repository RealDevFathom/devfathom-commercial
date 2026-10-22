-- Audit evidence is immutable even for sessions that satisfy the tenant RLS
-- policy. RLS continues to control visibility and insertion; this trigger
-- independently rejects every attempt to rewrite or remove existing evidence.
CREATE FUNCTION refuse_tenant_audit_log_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER tenant_audit_logs_append_only
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION refuse_tenant_audit_log_mutation();
