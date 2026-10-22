-- Actor identifiers are durable audit snapshots, not live relationships. Drop
-- the foreign keys before installing the mutation guard: PostgreSQL implements
-- ON DELETE SET NULL as an UPDATE, which would otherwise make deletion of a
-- referenced user or staff profile fail once audit rows become immutable.
ALTER TABLE audit_logs DROP CONSTRAINT "audit_logs_actorId_fkey";
ALTER TABLE audit_logs DROP CONSTRAINT "tenant_audit_logs_actorId_users_fk";
ALTER TABLE audit_logs DROP CONSTRAINT "audit_logs_actorStaffProfileId_fkey";
ALTER TABLE audit_logs DROP CONSTRAINT "tenant_audit_actorStaffProfileId_fk";

-- Retain the former foreign keys' same-tenant validation at insertion time,
-- without coupling later actor lifecycle operations to immutable evidence.
CREATE FUNCTION validate_tenant_audit_log_actor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."actorId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM users
    WHERE id = NEW."actorId" AND "organizationId" = NEW."organizationId"
  ) THEN
    RAISE EXCEPTION 'audit_logs actorId must identify a user in the same tenant'
      USING ERRCODE = '23503';
  END IF;

  IF NEW."actorStaffProfileId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM restaurant_staff_profiles
    WHERE id = NEW."actorStaffProfileId" AND "organizationId" = NEW."organizationId"
  ) THEN
    RAISE EXCEPTION 'audit_logs actorStaffProfileId must identify staff in the same tenant'
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_audit_logs_validate_actor
BEFORE INSERT ON audit_logs
FOR EACH ROW EXECUTE FUNCTION validate_tenant_audit_log_actor();

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
