-- Tenant audit evidence is append-only (DEV-155, GitHub #620).
--
-- "audit_logs" carries one all-command tenant_isolation policy (20260728092000).
-- Row-level security isolates tenants from each other but gives no tamper
-- resistance: any tenant-scoped path could UPDATE or DELETE its own audit rows,
-- which undermines the Pharmacy, Restaurant and Agency audit evidence. The
-- platform ledger has been immutable since 20261019212000; this applies the same
-- rule to the tenant ledger, with only the exceptions the schema itself needs.
--
-- UPDATE is refused unless the only change is the declared ON DELETE SET NULL of
-- an actor reference ("actorId" -> users, "actorStaffProfileId" ->
-- restaurant_staff_profiles) whose referenced row no longer exists. That keeps
-- user deletion working while a direct "SET actorId = NULL" against a live actor
-- is still refused. An actor id rename (the FKs' ON UPDATE CASCADE) is refused
-- too; user and staff-profile ids are never renamed.
--
-- The "actorStaffProfileId" branch mirrors the declared FK action, but it does
-- NOT make staff-profile deletion work today. audit_logs_operator_actor_ck
-- requires a non-NULL "actorStaffProfileId" on every RESTAURANT_OPERATOR row and
-- a NULL one on every other row, so deleting a staff profile that an operator
-- audit row references still fails on that CHECK after this trigger allows the
-- SET NULL. That failure predates this migration (it happens with the trigger
-- disabled too) and is a known follow-up: either the CHECK accepts a NULL once
-- the profile is gone, or the deletion paths (e.g. the demo reset) keep any
-- profile an operator audit row references.
--
-- DELETE is refused unless either
--   * it is the sanctioned retention purge of this row's own tenant: the purge
--     worker names the tenant in "app.purging_organization_id" inside the
--     platform transaction, which also sets "app.is_platform_admin" (the same
--     clause 20261021104500 requires of every other append-only purge guard); or
--   * the organization row is already gone, so the row is orphaned history of a
--     deleted tenant.
-- Both rules also admit UPDATE in the sanctioned purge context, so the purge's
-- detach pass can clear nullable references on rows it is about to delete.
--
-- The pharmacy legal-hold trigger (aa_pharmacy_audit_legal_hold) still fires
-- first on DELETE, so a held row is refused even inside a purge.
-- SQLSTATE 55000 (object_not_in_prerequisite_state) matches the platform ledger.
--
-- Idempotent: the function is replaced and the trigger re-created, in one
-- transaction so the table is never left without the trigger.

BEGIN;

CREATE OR REPLACE FUNCTION tenant_audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
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

DROP TRIGGER IF EXISTS audit_logs_append_only ON "audit_logs";

CREATE TRIGGER audit_logs_append_only
BEFORE UPDATE OR DELETE ON "audit_logs"
FOR EACH ROW EXECUTE FUNCTION tenant_audit_log_append_only();

COMMIT;
