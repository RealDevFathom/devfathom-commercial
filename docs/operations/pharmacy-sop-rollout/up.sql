-- DEV-751 rollout phase 3 (up): SOP access for EXISTING pharmacy tenants' system roles.
--
-- NOT A PRISMA MIGRATION. This file lives under docs/operations on purpose:
-- `prisma migrate deploy` reads prisma/migrations only (prisma.config.ts), the
-- fresh-database tooling pins exactly the prisma/migrations directories in
-- prisma/fresh-database-manifest.json, and the runner image copies prisma/ but
-- not docs/. Nothing applies it automatically. An operator runs it by hand, per
-- environment, after approval: docs/operations/pharmacy-sop-rollout.md.
--
-- Grants (Saad, delegated on DEV-751; SOP access only):
--   owner, owner-operator, manager       -> sop:manage, sop:complete, sop:verify
--   pharmacist                           -> sop:complete, sop:verify
--   cashier, procurement, inventory      -> sop:complete
--   finance, auditor                     -> nothing
--   admin (bootstrap role)               -> nothing: its '*' ALLOW already matches
--                                           sop:* (src/lib/abac/capabilities.ts)
--
-- Scope: organization_roles with isSystem = true and exactly those keys, in
-- organizations whose vertical is PHARMACY. Tenant-authored (custom) roles,
-- other verticals, user overrides and every non-sop:* capability are untouched.
-- An existing row for the same (role, capability), ALLOW or DENY, is left as it
-- is (ON CONFLICT DO NOTHING), so an explicit DENY keeps winning.
--
-- Inserted rows carry the deterministic id
--   'dev751_sop_' || md5("organizationRoleId" || ':' || capability)
-- which is how down.sql removes exactly these rows and nothing else.
-- Idempotent: a re-run inserts 0 rows.
--
-- Run as the migration owner (MIGRATION_DATABASE_URL), never as the runtime role:
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/operations/pharmacy-sop-rollout/up.sql
--
-- Keep the explicit BEGIN/COMMIT. The platform-admin flag below is
-- transaction-local; without the transaction it does not reach the INSERT,
-- forced RLS matches no rows and the script "succeeds" having done nothing
-- (#975). The DO block refuses to run when the flag is not visible.
BEGIN;

SELECT set_config('app.is_platform_admin', 'true', true);

DO $dev751_up$
DECLARE
  grant_map CONSTANT jsonb := '{
    "owner":          ["sop:manage", "sop:complete", "sop:verify"],
    "owner-operator": ["sop:manage", "sop:complete", "sop:verify"],
    "manager":        ["sop:manage", "sop:complete", "sop:verify"],
    "pharmacist":     ["sop:complete", "sop:verify"],
    "cashier":        ["sop:complete"],
    "procurement":    ["sop:complete"],
    "inventory":      ["sop:complete"]
  }';
  sop_capabilities CONSTANT text[] := ARRAY['sop:manage', 'sop:complete', 'sop:verify'];
  never_granted CONSTANT text[] := ARRAY['admin', 'finance', 'auditor'];
  v_bad text;
  v_planned integer;
  v_existing_allow integer;
  v_existing_deny integer;
  v_inserted integer;
  v_inserted_outside_sop integer;
BEGIN
  IF current_setting('app.is_platform_admin', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'DEV-751: app.is_platform_admin is not set in this transaction; '
      'under forced RLS this script would change nothing (#975). Run the whole file.';
  END IF;

  IF to_regclass('public.pharmacy_sop_sites') IS NULL THEN
    RAISE EXCEPTION 'DEV-751: pharmacy_sop_sites is missing; deploy the DEV-751 code and '
      'migrations (rollout phases 0 and 1) before granting SOP access.';
  END IF;

  SELECT string_agg(DISTINCT c.capability, ', ') INTO v_bad
  FROM jsonb_each(grant_map) AS e(role_key, capabilities)
  CROSS JOIN LATERAL jsonb_array_elements_text(e.capabilities) AS c(capability)
  WHERE c.capability <> ALL (sop_capabilities);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'DEV-751: refusing to write capabilities outside sop:*: %', v_bad;
  END IF;

  SELECT string_agg(k, ', ') INTO v_bad
  FROM jsonb_object_keys(grant_map) AS k
  WHERE k = ANY (never_granted);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'DEV-751: refusing to grant SOP access to role keys: %', v_bad;
  END IF;

  WITH planned AS (
    SELECT r.id AS role_id, r."organizationId" AS organization_id, c.capability
    FROM organization_roles r
    JOIN organizations o ON o.id = r."organizationId"
    CROSS JOIN LATERAL jsonb_array_elements_text(grant_map -> r.key) AS c(capability)
    WHERE o.vertical = 'PHARMACY'
      AND r."isSystem" = true
      AND grant_map ? r.key
  )
  SELECT
    count(*),
    count(p.id) FILTER (WHERE p.effect = 'ALLOW'),
    count(p.id) FILTER (WHERE p.effect = 'DENY')
  INTO v_planned, v_existing_allow, v_existing_deny
  FROM planned
  LEFT JOIN organization_role_permissions p
    ON p."organizationRoleId" = planned.role_id AND p.capability = planned.capability;

  WITH planned AS (
    SELECT r.id AS role_id, r."organizationId" AS organization_id, c.capability
    FROM organization_roles r
    JOIN organizations o ON o.id = r."organizationId"
    CROSS JOIN LATERAL jsonb_array_elements_text(grant_map -> r.key) AS c(capability)
    WHERE o.vertical = 'PHARMACY'
      AND r."isSystem" = true
      AND grant_map ? r.key
  ),
  inserted AS (
    INSERT INTO organization_role_permissions
      (id, "organizationId", "organizationRoleId", capability, effect, "createdAt")
    SELECT
      'dev751_sop_' || md5(planned.role_id || ':' || planned.capability),
      planned.organization_id,
      planned.role_id,
      planned.capability,
      'ALLOW'::"PermissionEffect",
      now()
    FROM planned
    ON CONFLICT ("organizationRoleId", capability) DO NOTHING
    RETURNING capability
  )
  SELECT count(*), count(*) FILTER (WHERE capability <> ALL (sop_capabilities))
  INTO v_inserted, v_inserted_outside_sop
  FROM inserted;

  IF v_inserted_outside_sop <> 0 THEN
    RAISE EXCEPTION 'DEV-751: % non-SOP rows would have been written; rolled back',
      v_inserted_outside_sop;
  END IF;

  RAISE NOTICE 'DEV-751 up: planned=% inserted=% kept_existing_allow=% kept_existing_deny=%',
    v_planned, v_inserted, v_existing_allow, v_existing_deny;
END
$dev751_up$;

-- Per role key: how many system roles there are, how many SOP rows this script
-- owns, and how many explicit SOP DENY rows remain in force.
SELECT
  r.key AS role_key,
  count(DISTINCT r.id) AS system_roles,
  count(p.id) FILTER (
    WHERE p.id = 'dev751_sop_' || md5(p."organizationRoleId" || ':' || p.capability)
  ) AS dev751_rows,
  count(p.id) FILTER (WHERE p.effect = 'DENY') AS sop_deny_rows
FROM organization_roles r
JOIN organizations o ON o.id = r."organizationId"
LEFT JOIN organization_role_permissions p
  ON p."organizationRoleId" = r.id
 AND p.capability IN ('sop:manage', 'sop:complete', 'sop:verify')
WHERE o.vertical = 'PHARMACY'
  AND r."isSystem" = true
  AND r.key IN ('owner', 'owner-operator', 'manager', 'pharmacist', 'cashier', 'procurement',
                'inventory')
GROUP BY r.key
ORDER BY r.key;

COMMIT;
