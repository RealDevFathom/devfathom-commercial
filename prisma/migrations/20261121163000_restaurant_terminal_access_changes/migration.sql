-- End the affected live bindings in the same transaction as the access edit.
-- All functions run with the caller's privileges and existing tenant RLS.
-- Keep the previous activity timestamp: a revocation is not operator activity.

BEGIN;

CREATE OR REPLACE FUNCTION restaurant_terminal_staff_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.restaurant_terminal_sessions s
     SET "endedAt" = statement_timestamp(), "activeStaffProfileId" = NULL
   WHERE s."endedAt" IS NULL
     AND (s."organizationId", s."activeStaffProfileId") = (NEW."organizationId", NEW.id);
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER end_affected_terminal_sessions
AFTER UPDATE OF status, "primaryBranchId", "userId" ON public.restaurant_staff_profiles
FOR EACH ROW WHEN ((OLD.status, OLD."primaryBranchId", OLD."userId") IS DISTINCT FROM
                   (NEW.status, NEW."primaryBranchId", NEW."userId"))
EXECUTE FUNCTION restaurant_terminal_staff_changed();

CREATE OR REPLACE FUNCTION restaurant_terminal_branch_grant_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.restaurant_terminal_sessions s
     SET "endedAt" = statement_timestamp(), "activeStaffProfileId" = NULL
   WHERE s."endedAt" IS NULL
     AND EXISTS (
       SELECT 1 FROM public.restaurant_registered_devices d
        WHERE d.id = s."deviceId" AND d."organizationId" = s."organizationId"
          AND (s."organizationId", s."activeStaffProfileId", d."branchId") IN
              ((OLD."organizationId", OLD."staffProfileId", OLD."branchId"),
               (NEW."organizationId", NEW."staffProfileId", NEW."branchId"))
     );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER end_affected_terminal_sessions
AFTER INSERT OR UPDATE OR DELETE ON public.restaurant_staff_job_roles
FOR EACH ROW EXECUTE FUNCTION restaurant_terminal_branch_grant_changed();

CREATE OR REPLACE TRIGGER end_affected_terminal_sessions
AFTER INSERT OR UPDATE OR DELETE ON public.restaurant_staff_capability_grants
FOR EACH ROW EXECUTE FUNCTION restaurant_terminal_branch_grant_changed();

CREATE OR REPLACE FUNCTION restaurant_terminal_role_activation_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.restaurant_terminal_sessions s
     SET "endedAt" = statement_timestamp(), "activeStaffProfileId" = NULL
   WHERE s."endedAt" IS NULL
     AND EXISTS (
       SELECT 1 FROM public.restaurant_staff_job_roles h
       JOIN public.restaurant_registered_devices d
         ON d."organizationId" = h."organizationId" AND d."branchId" = h."branchId"
        WHERE d.id = s."deviceId" AND h."organizationId" = s."organizationId"
          AND h."staffProfileId" = s."activeStaffProfileId"
          AND h."jobRoleId" = NEW.id
     );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER end_affected_terminal_sessions
AFTER UPDATE OF active ON public.restaurant_job_roles
FOR EACH ROW WHEN (OLD.active IS DISTINCT FROM NEW.active)
EXECUTE FUNCTION restaurant_terminal_role_activation_changed();

CREATE OR REPLACE FUNCTION restaurant_terminal_role_grant_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.restaurant_terminal_sessions s
     SET "endedAt" = statement_timestamp(), "activeStaffProfileId" = NULL
   WHERE s."endedAt" IS NULL
     AND EXISTS (
       SELECT 1 FROM public.restaurant_staff_job_roles h
       JOIN public.restaurant_registered_devices d
         ON d."organizationId" = h."organizationId" AND d."branchId" = h."branchId"
        WHERE d.id = s."deviceId" AND h."organizationId" = s."organizationId"
          AND h."staffProfileId" = s."activeStaffProfileId"
          AND (h."organizationId", h."jobRoleId") IN
              ((OLD."organizationId", OLD."jobRoleId"), (NEW."organizationId", NEW."jobRoleId"))
     );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER end_affected_terminal_sessions
AFTER INSERT OR UPDATE OR DELETE ON public.restaurant_job_role_capabilities
FOR EACH ROW EXECUTE FUNCTION restaurant_terminal_role_grant_changed();

CREATE OR REPLACE FUNCTION restaurant_terminal_user_role_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.restaurant_terminal_sessions s
     SET "endedAt" = statement_timestamp(), "activeStaffProfileId" = NULL
   WHERE s."endedAt" IS NULL
     AND EXISTS (
       SELECT 1 FROM public.restaurant_staff_profiles p
        WHERE p.id = s."activeStaffProfileId" AND p."organizationId" = s."organizationId"
          AND p."userId" = NEW.id
     );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER end_affected_terminal_sessions
AFTER UPDATE OF "organizationRoleId" ON public.users
FOR EACH ROW WHEN (OLD."organizationRoleId" IS DISTINCT FROM NEW."organizationRoleId")
EXECUTE FUNCTION restaurant_terminal_user_role_changed();

CREATE OR REPLACE FUNCTION restaurant_terminal_user_grant_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.restaurant_terminal_sessions s
     SET "endedAt" = statement_timestamp(), "activeStaffProfileId" = NULL
   WHERE s."endedAt" IS NULL
     AND EXISTS (
       SELECT 1 FROM public.restaurant_staff_profiles p
        WHERE p.id = s."activeStaffProfileId" AND p."organizationId" = s."organizationId"
          AND (p."organizationId", p."userId") IN
              ((OLD."organizationId", OLD."userId"), (NEW."organizationId", NEW."userId"))
     );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER end_affected_terminal_sessions
AFTER INSERT OR UPDATE OR DELETE ON public.user_permission_overrides
FOR EACH ROW EXECUTE FUNCTION restaurant_terminal_user_grant_changed();

CREATE OR REPLACE FUNCTION restaurant_terminal_org_role_grant_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.restaurant_terminal_sessions s
     SET "endedAt" = statement_timestamp(), "activeStaffProfileId" = NULL
   WHERE s."endedAt" IS NULL
     AND EXISTS (
       SELECT 1 FROM public.restaurant_staff_profiles p
       JOIN public.users u ON u.id = p."userId" AND u."organizationId" = p."organizationId"
        WHERE p.id = s."activeStaffProfileId" AND p."organizationId" = s."organizationId"
          AND (u."organizationId", u."organizationRoleId") IN
              ((OLD."organizationId", OLD."organizationRoleId"), (NEW."organizationId", NEW."organizationRoleId"))
     );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER end_affected_terminal_sessions
AFTER INSERT OR UPDATE OR DELETE ON public.organization_role_permissions
FOR EACH ROW EXECUTE FUNCTION restaurant_terminal_org_role_grant_changed();

COMMIT;
