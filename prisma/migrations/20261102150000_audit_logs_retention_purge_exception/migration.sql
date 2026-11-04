-- Tenant audit_logs: let the pharmacy retention purge delete expired rows
-- (DEV-155 / GitHub #620, with DEV-96 / #1165).
--
-- 20261102090000 made "audit_logs" append-only. The DEV-96 pharmacy retention
-- job deletes AUDIT rows once their confirmed legal retention period has
-- ended, and it runs inside the tenant's own transaction (withTenantDb), not
-- the platform purge, so that guard refuses every one of its deletes. This adds
-- one narrow exception, for DELETE only. A row may be deleted when all four
-- hold:
--   1. the retention purge names this row's tenant in
--      "app.retention_purge_organization_id" (set with set_config(..., true),
--      so it ends with the purge's own transaction);
--   2. the tenant context "app.current_organization_id" is that same tenant;
--   3. that tenant's vertical is PHARMACY;
--   4. public.pharmacy_record_retention_deadline(text, text, text, text)
--      exists and returns a deadline for this AUDIT row that has passed.
--
-- Rule 4's function ships with DEV-96 (20261102010000 on #1165). Until it is
-- deployed the exception never applies. That function also refuses a row under
-- legal hold, a tenant with no confirmed branch profile or jurisdiction policy,
-- and a row outside the tenant; its refusals propagate unchanged.
--
-- The flag is a marker, not a credential: any code running in that tenant's
-- transaction could set it. It unlocks only what rules 2 to 4 admit, which is a
-- row the confirmed retention policy already allows to be destroyed.
--
-- UPDATE stays refused in this context, and every rule of 20261102090000 is
-- unchanged: the actor ON DELETE SET NULL, the platform purge of exactly the
-- named tenant, and the orphaned rows of a deleted organization. The pharmacy
-- legal-hold trigger (aa_pharmacy_audit_legal_hold) still fires first on DELETE.
--
-- Idempotent: CREATE OR REPLACE of the trigger function in one transaction. The
-- trigger itself is unchanged and keeps pointing at this function.

BEGIN;

CREATE OR REPLACE FUNCTION tenant_audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  retention_deadline timestamp;
BEGIN
  IF NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId"
     AND current_setting('app.is_platform_admin', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM "organizations" WHERE "id" = OLD."organizationId") THEN
      RETURN OLD;
    END IF;

    IF NULLIF(current_setting('app.retention_purge_organization_id', true), '') = OLD."organizationId"
       AND NULLIF(current_setting('app.current_organization_id', true), '') = OLD."organizationId"
       AND EXISTS (
         SELECT 1 FROM "organizations"
          WHERE "id" = OLD."organizationId" AND "vertical"::text = 'PHARMACY'
       )
       AND to_regprocedure('public.pharmacy_record_retention_deadline(text,text,text,text)') IS NOT NULL THEN
      retention_deadline := public.pharmacy_record_retention_deadline(
        OLD."organizationId", 'AUDIT', OLD."id", NULL::text
      );
      IF retention_deadline IS NOT NULL
         AND isfinite(retention_deadline)
         AND (clock_timestamp() AT TIME ZONE 'UTC') >= retention_deadline THEN
        RETURN OLD;
      END IF;
    END IF;
  ELSIF (to_jsonb(NEW) - 'actorId' - 'actorStaffProfileId')
          = (to_jsonb(OLD) - 'actorId' - 'actorStaffProfileId')
        AND (NEW."actorId" IS NOT DISTINCT FROM OLD."actorId"
             OR (NEW."actorId" IS NULL
                 AND NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = OLD."actorId")))
        AND (NEW."actorStaffProfileId" IS NOT DISTINCT FROM OLD."actorStaffProfileId"
             OR (NEW."actorStaffProfileId" IS NULL
                 AND NOT EXISTS (
                   SELECT 1 FROM "restaurant_staff_profiles" WHERE "id" = OLD."actorStaffProfileId"
                 ))) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'audit_logs is append-only: % is forbidden', TG_OP
    USING ERRCODE = '55000';
END;
$$;

COMMIT;
