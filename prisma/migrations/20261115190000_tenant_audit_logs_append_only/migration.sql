-- DEV-155 (#620): tenant audit_logs are append-only.
--
-- `audit_logs` carried only the all-command tenant_isolation policy
-- (20260728092000_row_level_security), so any tenant-scoped path could UPDATE
-- or DELETE its own tenant's audit evidence. Row-level security isolates
-- tenants; it does not make history tamper-resistant. The refuse-mutation
-- trigger from 20261019212000_platform_audit_append_only covered only the
-- platform tables.
--
-- Product decision (15 Nov 2026, #620): audit rows are immutable to every
-- tenant user and to ordinary application code for the whole life of the
-- tenant. The single exception is a tenant purge run by the platform control
-- plane, which must first write a permanent platform-level record of what it is
-- about to remove. That record lives in `platform_audit_logs`, which is itself
-- append-only, readable and writable only by the control plane, and excluded
-- from the purge (CONTROL_PLANE_TABLES in src/lib/platform/jobs.ts).
--
-- A DELETE is admitted only when, in the same transaction:
--   * "app.is_platform_admin" = 'true' (the control plane; `withTenantDb` sets
--     'false'),
--   * "app.purging_organization_id" names the row's own tenant, and
--   * "app.audit_purge_record_id" names a platform_audit_logs row with action
--     'organization.audit_logs.purge' for that same tenant, written by a
--     platform actor, with a reason.
-- Everything else is refused, for every role, including the table owner, and
-- TRUNCATE is refused outright.
--
-- The one UPDATE admitted is the referential action the schema already
-- declares: actorId / actorStaffProfileId ON DELETE SET NULL, when the user or
-- staff profile it named no longer exists. Every other column, including the
-- actor snapshot (actorName, actorEmail, actorRole), must stay byte-for-byte
-- identical, so the row still says who acted.
--
-- Idempotent: CREATE OR REPLACE for the function, DROP TRIGGER IF EXISTS before
-- CREATE TRIGGER. The trigger name sorts after aa_pharmacy_audit_legal_hold, so
-- a legal hold is still checked first and still refuses a purge.

BEGIN;

CREATE OR REPLACE FUNCTION audit_logs_refuse_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  purge_record text;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'audit_logs is append-only: TRUNCATE is forbidden'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    purge_record := NULLIF(current_setting('app.audit_purge_record_id', true), '');
    IF current_setting('app.is_platform_admin', true) = 'true'
       AND NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId"
       AND purge_record IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM "platform_audit_logs" p
          WHERE p."id" = purge_record
            AND p."organizationId" = OLD."organizationId"
            AND p."action" = 'organization.audit_logs.purge'
            AND p."actorPlatformUserId" IS NOT NULL
            AND NULLIF(btrim(p."reason"), '') IS NOT NULL
       ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'audit_logs is append-only: DELETE is forbidden outside a recorded platform purge of the tenant'
      USING ERRCODE = '55000';
  END IF;

  -- ON DELETE SET NULL of a vanished actor: only the actor reference changes,
  -- only to NULL, and only once its target is gone.
  IF (to_jsonb(NEW) - 'actorId' - 'actorStaffProfileId')
       = (to_jsonb(OLD) - 'actorId' - 'actorStaffProfileId')
     AND (NEW."actorId" IS DISTINCT FROM OLD."actorId"
          OR NEW."actorStaffProfileId" IS DISTINCT FROM OLD."actorStaffProfileId")
     AND (NEW."actorId" IS NOT DISTINCT FROM OLD."actorId"
          OR (NEW."actorId" IS NULL
              AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = OLD."actorId")))
     AND (NEW."actorStaffProfileId" IS NOT DISTINCT FROM OLD."actorStaffProfileId"
          OR (NEW."actorStaffProfileId" IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM "restaurant_staff_profiles" s WHERE s."id" = OLD."actorStaffProfileId"
              ))) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'audit_logs is append-only: UPDATE is forbidden'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS audit_logs_append_only ON "audit_logs";
CREATE TRIGGER audit_logs_append_only
BEFORE UPDATE OR DELETE ON "audit_logs"
FOR EACH ROW EXECUTE FUNCTION audit_logs_refuse_mutation();

-- TRUNCATE bypasses row triggers and row-level security alike.
DROP TRIGGER IF EXISTS audit_logs_no_truncate ON "audit_logs";
CREATE TRIGGER audit_logs_no_truncate
BEFORE TRUNCATE ON "audit_logs"
FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_refuse_mutation();

COMMIT;
