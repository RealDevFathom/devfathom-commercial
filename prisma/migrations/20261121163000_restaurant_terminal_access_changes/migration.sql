-- Synchronous revocation under the writer's tenant scope. A policy edit can retire a
-- binding, but never grants access, changes the operator, or extends the idle clock.
BEGIN;
SET LOCAL lock_timeout = '10s';

-- Compare effective terminal operations, including wildcard grants and deny precedence.
-- The optional replacement models the before-images of all rows changed by a statement. This lets the
-- trigger distinguish genuine losses from additions, equivalent roles or redundant grants
-- without storing a second authorization policy on the session. Reads use existing keys.
CREATE OR REPLACE FUNCTION restaurant_terminal_effective_actions(
  tenant text, staff text, branch text, linked_user text,
  changed_table text DEFAULT '', replaced_ids text[] DEFAULT '{}', replacement jsonb DEFAULT '[]'
) RETURNS text[]
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
WITH
linked_role AS (
  SELECT t."organizationRoleId" FROM public.users t
   WHERE t."organizationId" = tenant AND t.id = linked_user
     AND (changed_table <> 'users' OR t.id <> ALL(replaced_ids))
  UNION ALL
  SELECT r."organizationRoleId" FROM jsonb_populate_recordset(NULL::public.users, replacement) r
   WHERE changed_table = 'users' AND r."organizationId" = tenant AND r.id = linked_user
),
holdings AS (
  SELECT t."jobRoleId" FROM public.restaurant_staff_job_roles t
   WHERE t."organizationId" = tenant AND (t."staffProfileId", t."branchId") = (staff, branch)
     AND (changed_table <> 'restaurant_staff_job_roles' OR t.id <> ALL(replaced_ids))
  UNION ALL
  SELECT r."jobRoleId" FROM jsonb_populate_recordset(NULL::public.restaurant_staff_job_roles, replacement) r
   WHERE changed_table = 'restaurant_staff_job_roles' AND r."organizationId" = tenant AND (r."staffProfileId", r."branchId") = (staff, branch)
),
active_roles AS (
  SELECT t."id" FROM public.restaurant_job_roles t
   WHERE t."organizationId" = tenant AND t.active AND t.id IN (SELECT "jobRoleId" FROM holdings)
     AND (changed_table <> 'restaurant_job_roles' OR t.id <> ALL(replaced_ids))
  UNION ALL
  SELECT r."id" FROM jsonb_populate_recordset(NULL::public.restaurant_job_roles, replacement) r
   WHERE changed_table = 'restaurant_job_roles' AND r."organizationId" = tenant AND r.active AND r.id IN (SELECT "jobRoleId" FROM holdings)
),
inherited AS (
  SELECT t."capability" FROM public.restaurant_job_role_capabilities t
   WHERE t."organizationId" = tenant AND t."jobRoleId" IN (SELECT id FROM active_roles)
     AND (changed_table <> 'restaurant_job_role_capabilities' OR t.id <> ALL(replaced_ids))
  UNION ALL
  SELECT r."capability" FROM jsonb_populate_recordset(NULL::public.restaurant_job_role_capabilities, replacement) r
   WHERE changed_table = 'restaurant_job_role_capabilities' AND r."organizationId" = tenant AND r."jobRoleId" IN (SELECT id FROM active_roles)
),
direct AS (
  SELECT t."capability", t."effect" FROM public.restaurant_staff_capability_grants t
   WHERE t."organizationId" = tenant AND (t."staffProfileId", t."branchId") = (staff, branch)
     AND (changed_table <> 'restaurant_staff_capability_grants' OR t.id <> ALL(replaced_ids))
  UNION ALL
  SELECT r."capability", r."effect" FROM jsonb_populate_recordset(NULL::public.restaurant_staff_capability_grants, replacement) r
   WHERE changed_table = 'restaurant_staff_capability_grants' AND r."organizationId" = tenant AND (r."staffProfileId", r."branchId") = (staff, branch)
),
user_rules AS (
  SELECT t."capability", t."effect" FROM public.user_permission_overrides t
   WHERE t."organizationId" = tenant AND t."userId" = linked_user AND (t."expiresAt" IS NULL OR t."expiresAt" > statement_timestamp())
     AND (changed_table <> 'user_permission_overrides' OR t.id <> ALL(replaced_ids))
  UNION ALL
  SELECT r."capability", r."effect" FROM jsonb_populate_recordset(NULL::public.user_permission_overrides, replacement) r
   WHERE changed_table = 'user_permission_overrides' AND r."organizationId" = tenant AND r."userId" = linked_user AND (r."expiresAt" IS NULL OR r."expiresAt" > statement_timestamp())
),
role_rules AS (
  SELECT t."capability", t."effect" FROM public.organization_role_permissions t
   WHERE t."organizationId" = tenant AND t."organizationRoleId" IN (SELECT "organizationRoleId" FROM linked_role)
     AND (changed_table <> 'organization_role_permissions' OR t.id <> ALL(replaced_ids))
  UNION ALL
  SELECT r."capability", r."effect" FROM jsonb_populate_recordset(NULL::public.organization_role_permissions, replacement) r
   WHERE changed_table = 'organization_role_permissions' AND r."organizationId" = tenant AND r."organizationRoleId" IN (SELECT "organizationRoleId" FROM linked_role)
),
rules AS (
  SELECT capability, 'ALLOW' AS effect FROM inherited
  UNION ALL SELECT capability, effect::text FROM direct
  UNION ALL SELECT capability, effect::text FROM user_rules
  UNION ALL SELECT capability, effect::text FROM role_rules
),
-- These are operations of the terminal, its connected workflows and approvals.
-- This list is used only for revocation comparisons, never as a grant.
actions(action) AS (VALUES
  ('pos:operate'), ('kitchen:operate'), ('terminal:operate'), ('orders:take'), ('orders:read'), ('orders:void'),
  ('orders:discount'), ('orders:complimentary'), ('payments:collect'), ('payments:refund'),
  ('cash:open'), ('cash:adjust'), ('cash:close'), ('customers:read'), ('customers:manage'),
  ('loyalty:redeem'), ('catering:read'), ('catering:manage'), ('coauth:approve')
)
SELECT ARRAY(
  SELECT action FROM actions JOIN rules
    ON capability IN (action, '*', split_part(action, ':', 1) || ':*')
   GROUP BY action HAVING bool_or(effect = 'ALLOW') AND NOT bool_or(effect = 'DENY')
   ORDER BY action
)
$$;

CREATE OR REPLACE FUNCTION restaurant_terminal_staff_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  staff text;
BEGIN
  IF TG_TABLE_NAME = 'restaurant_operator_credentials' THEN
    staff := OLD."staffProfileId";
  ELSE
    staff := OLD.id;
  END IF;
  UPDATE public.restaurant_terminal_sessions
     SET "endedAt" = statement_timestamp(), "activeStaffProfileId" = NULL
   WHERE "organizationId" = OLD."organizationId" AND "activeStaffProfileId" = staff AND "endedAt" IS NULL;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER end_affected_terminal_sessions
BEFORE UPDATE OF status, "primaryBranchId" ON public.restaurant_staff_profiles
FOR EACH ROW WHEN ((OLD.status = 'ACTIVE' AND NEW.status <> 'ACTIVE') OR
                   (OLD."primaryBranchId" IS NOT NULL AND OLD."primaryBranchId" IS DISTINCT FROM NEW."primaryBranchId"))
EXECUTE FUNCTION restaurant_terminal_staff_changed();

CREATE OR REPLACE TRIGGER end_affected_terminal_sessions
BEFORE UPDATE OF "credentialHash", "revokedAt" ON public.restaurant_operator_credentials
FOR EACH ROW WHEN (OLD.type = 'PIN' AND OLD."revokedAt" IS NULL AND
                   (OLD."credentialHash" IS DISTINCT FROM NEW."credentialHash" OR NEW."revokedAt" IS NOT NULL))
EXECUTE FUNCTION restaurant_terminal_staff_changed();

CREATE OR REPLACE FUNCTION restaurant_terminal_access_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  prior jsonb := '[]';
  proposed jsonb := '[]';
  replaced_ids text[];
  binding record;
  before_actions text[];
  after_actions text[];
BEGIN
  IF TG_LEVEL = 'STATEMENT' THEN
    -- Transition relations contain only rows actually written (including ON
    -- CONFLICT), and preserve simultaneous overlapping grants and denials.
    IF TG_OP <> 'INSERT' THEN
      SELECT coalesce(jsonb_agg(to_jsonb(r) - ARRAY['updatedAt','createdAt','reason','grantedAt','grantedByStaffId','createdById'] ORDER BY r.id), '[]')
        INTO prior FROM changed_old r;
    END IF;
    IF TG_OP <> 'DELETE' THEN
      SELECT coalesce(jsonb_agg(to_jsonb(r) - ARRAY['updatedAt','createdAt','reason','grantedAt','grantedByStaffId','createdById'] ORDER BY r.id), '[]')
        INTO proposed FROM changed_new r;
    END IF;
  ELSIF TG_TABLE_NAME = 'users' THEN
    prior := jsonb_build_array(jsonb_build_object('id', OLD.id, 'organizationId', OLD."organizationId", 'organizationRoleId', OLD."organizationRoleId"));
    proposed := jsonb_build_array(jsonb_build_object('id', NEW.id, 'organizationId', NEW."organizationId", 'organizationRoleId', NEW."organizationRoleId"));
  ELSIF TG_TABLE_NAME = 'restaurant_staff_profiles' THEN
    prior := jsonb_build_array(jsonb_build_object('id', OLD.id, 'organizationId', OLD."organizationId", 'userId', OLD."userId"));
    proposed := jsonb_build_array(jsonb_build_object('id', NEW.id, 'organizationId', NEW."organizationId", 'userId', NEW."userId"));
  ELSE
    -- Role deletion must compare before cascading away its grants and holders.
    prior := jsonb_build_array(to_jsonb(OLD));
  END IF;
  IF prior = proposed OR
     (TG_OP = 'INSERT' AND NOT EXISTS (SELECT FROM jsonb_array_elements(proposed) r WHERE r->>'effect' = 'DENY')) OR
     (TG_OP = 'DELETE' AND NOT EXISTS (SELECT FROM jsonb_array_elements(prior) r WHERE r->>'effect' IS DISTINCT FROM 'DENY')) THEN
    RETURN NULL;
  END IF;
  SELECT ARRAY(SELECT r->>'id' FROM jsonb_array_elements(
    CASE WHEN TG_WHEN = 'BEFORE' THEN prior ELSE proposed END) r) INTO replaced_ids;

  FOR binding IN
    WITH affected AS MATERIALIZED (SELECT r FROM jsonb_array_elements(prior || proposed) r)
    SELECT s.id, s."organizationId" AS tenant, p.id AS staff, p."userId" AS linked_user, d."branchId" AS branch
      FROM public.restaurant_terminal_sessions s
      JOIN public.restaurant_staff_profiles p ON (p."organizationId", p.id) = (s."organizationId", s."activeStaffProfileId")
      JOIN public.restaurant_registered_devices d ON (d."organizationId", d.id) = (s."organizationId", s."deviceId")
     WHERE s."endedAt" IS NULL AND s."organizationId" IN (SELECT r->>'organizationId' FROM affected)
       AND EXISTS (
         SELECT FROM affected WHERE r->>'organizationId' = s."organizationId" AND
           CASE
             WHEN TG_TABLE_NAME = 'restaurant_staff_profiles' THEN p.id = r->>'id'
             WHEN TG_TABLE_NAME = 'users' THEN p."userId" = r->>'id'
             WHEN TG_TABLE_NAME = 'user_permission_overrides' THEN p."userId" = r->>'userId'
             WHEN TG_TABLE_NAME = 'organization_role_permissions' THEN EXISTS (
               SELECT FROM public.users u WHERE (u.id, u."organizationId", u."organizationRoleId")
                 = (p."userId", s."organizationId", r->>'organizationRoleId'))
             WHEN TG_TABLE_NAME IN ('restaurant_staff_job_roles','restaurant_staff_capability_grants') THEN
               (p.id, d."branchId") = (r->>'staffProfileId', r->>'branchId')
             ELSE EXISTS (
               SELECT FROM public.restaurant_staff_job_roles h
                WHERE (h."organizationId", h."staffProfileId", h."branchId") = (s."organizationId", p.id, d."branchId")
                  AND h."jobRoleId" = CASE WHEN TG_TABLE_NAME = 'restaurant_job_roles' THEN r->>'id' ELSE r->>'jobRoleId' END)
           END)
     ORDER BY s.id FOR UPDATE OF s
  LOOP
    after_actions := public.restaurant_terminal_effective_actions(binding.tenant, binding.staff, binding.branch, binding.linked_user);
    IF TG_WHEN = 'AFTER' THEN
      before_actions := public.restaurant_terminal_effective_actions(
        binding.tenant, binding.staff, binding.branch,
        CASE WHEN TG_TABLE_NAME = 'restaurant_staff_profiles' THEN prior->0->>'userId' ELSE binding.linked_user END,
        TG_TABLE_NAME, replaced_ids, prior);
    ELSE
      before_actions := after_actions;
      after_actions := public.restaurant_terminal_effective_actions(binding.tenant, binding.staff, binding.branch,
        binding.linked_user, TG_TABLE_NAME, replaced_ids, '[]');
    END IF;
    IF NOT before_actions <@ after_actions THEN
      UPDATE public.restaurant_terminal_sessions SET "endedAt" = statement_timestamp(), "activeStaffProfileId" = NULL
       WHERE id = binding.id AND "organizationId" = binding.tenant AND "activeStaffProfileId" = binding.staff AND "endedAt" IS NULL;
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER end_reduced_linked_access
AFTER UPDATE OF "userId" ON public.restaurant_staff_profiles
FOR EACH ROW WHEN (OLD."userId" IS DISTINCT FROM NEW."userId") EXECUTE FUNCTION restaurant_terminal_access_changed();

CREATE OR REPLACE TRIGGER end_affected_terminal_sessions
AFTER UPDATE OF "organizationRoleId" ON public.users
FOR EACH ROW WHEN (OLD."organizationRoleId" IS DISTINCT FROM NEW."organizationRoleId") EXECUTE FUNCTION restaurant_terminal_access_changed();

-- PostgreSQL requires a separate trigger per event when using transition
-- tables. Each event compares the complete statement, once per affected binding.
DO $$
DECLARE policy_table text;
BEGIN
  FOREACH policy_table IN ARRAY ARRAY[
    'restaurant_job_roles', 'restaurant_staff_job_roles', 'restaurant_job_role_capabilities',
    'restaurant_staff_capability_grants', 'user_permission_overrides', 'organization_role_permissions'
  ] LOOP
    EXECUTE format('CREATE OR REPLACE TRIGGER end_access_after_update AFTER UPDATE ON public.%I
      REFERENCING OLD TABLE AS changed_old NEW TABLE AS changed_new
      FOR EACH STATEMENT EXECUTE FUNCTION public.restaurant_terminal_access_changed()', policy_table);
    IF policy_table <> 'restaurant_job_roles' THEN
      EXECUTE format('CREATE OR REPLACE TRIGGER end_access_after_delete AFTER DELETE ON public.%I
        REFERENCING OLD TABLE AS changed_old
        FOR EACH STATEMENT EXECUTE FUNCTION public.restaurant_terminal_access_changed()', policy_table);
    END IF;
    IF policy_table IN ('restaurant_staff_capability_grants', 'user_permission_overrides', 'organization_role_permissions') THEN
      EXECUTE format('CREATE OR REPLACE TRIGGER end_access_after_insert AFTER INSERT ON public.%I
        REFERENCING NEW TABLE AS changed_new
        FOR EACH STATEMENT EXECUTE FUNCTION public.restaurant_terminal_access_changed()', policy_table);
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE TRIGGER end_access_before_role_delete
BEFORE DELETE ON public.restaurant_job_roles
FOR EACH ROW EXECUTE FUNCTION restaurant_terminal_access_changed();

COMMIT;
