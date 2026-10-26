-- Tenant audit evidence is immutable. RLS isolates organizations, while this
-- trigger prevents an authorized tenant path from rewriting its own history.
CREATE TRIGGER audit_logs_append_only
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION refuse_platform_history_mutation();
