-- Tenant audit evidence is immutable. RLS isolates organizations, while this
-- trigger prevents an authorized tenant path from rewriting its own history.
-- Only the platform retention worker may delete the exact tenant being purged.
-- Keep this separate from the unconditional platform-history guard.
BEGIN;

-- Deleted actors may become orphaned, but new operator events must still name
-- their staff profile. Enforce that requirement on INSERT below; the CHECK
-- continues to forbid mixing user and staff attribution on every write.
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_operator_actor_ck;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_operator_actor_ck CHECK (
  CASE WHEN "actorType" = 'RESTAURANT_OPERATOR'
    THEN "actorId" IS NULL
    ELSE "actorStaffProfileId" IS NULL
  END
);

CREATE FUNCTION refuse_tenant_audit_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."actorType" = 'RESTAURANT_OPERATOR' AND NEW."actorStaffProfileId" IS NULL THEN
      RAISE EXCEPTION 'operator audit rows require a staff profile'
        USING ERRCODE = '23514', CONSTRAINT = 'audit_logs_operator_actor_ck';
    END IF;
    RETURN NEW;
  END IF;

  -- ON DELETE SET NULL runs inside the parent's FK trigger. Permit only that
  -- loss of a reference to a now-deleted actor, preserving every other field
  -- (including actor snapshots and JSON payloads). Direct UPDATEs stay blocked.
  IF TG_OP = 'UPDATE' THEN
    IF pg_trigger_depth() > 1
       AND to_jsonb(NEW) - 'actorId' - 'actorStaffProfileId'
           = to_jsonb(OLD) - 'actorId' - 'actorStaffProfileId'
       AND (NEW."actorId" IS DISTINCT FROM OLD."actorId"
            OR NEW."actorStaffProfileId" IS DISTINCT FROM OLD."actorStaffProfileId")
       AND (NEW."actorId" IS NOT DISTINCT FROM OLD."actorId"
            OR (OLD."actorId" IS NOT NULL AND NEW."actorId" IS NULL
                AND NOT EXISTS (SELECT 1 FROM users WHERE id = OLD."actorId")))
       AND (NEW."actorStaffProfileId" IS NOT DISTINCT FROM OLD."actorStaffProfileId"
            OR (OLD."actorStaffProfileId" IS NOT NULL AND NEW."actorStaffProfileId" IS NULL
                AND NOT EXISTS (SELECT 1 FROM restaurant_staff_profiles
                                WHERE id = OLD."actorStaffProfileId"))) THEN
      RETURN NEW;
    END IF;
  END IF;

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

CREATE TRIGGER audit_logs_actor_on_insert
BEFORE INSERT ON audit_logs
FOR EACH ROW EXECUTE FUNCTION refuse_tenant_audit_mutation();

-- TRUNCATE bypasses row triggers and RLS, so guard it unconditionally, including
-- on platform ledgers. Retention purges must continue to use scoped DELETEs.
CREATE TRIGGER audit_logs_no_truncate
BEFORE TRUNCATE ON audit_logs
FOR EACH STATEMENT EXECUTE FUNCTION refuse_platform_history_mutation();

CREATE TRIGGER platform_audit_logs_no_truncate
BEFORE TRUNCATE ON platform_audit_logs
FOR EACH STATEMENT EXECUTE FUNCTION refuse_platform_history_mutation();

CREATE TRIGGER organization_lifecycle_events_no_truncate
BEFORE TRUNCATE ON organization_lifecycle_events
FOR EACH STATEMENT EXECUTE FUNCTION refuse_platform_history_mutation();

COMMIT;
