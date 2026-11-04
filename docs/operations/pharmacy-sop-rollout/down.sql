-- DEV-751 rollout phase 5 (down): roll back docs/operations/pharmacy-sop-rollout/up.sql.
--
-- NOT A PRISMA MIGRATION; run by hand, per environment, after approval
-- (docs/operations/pharmacy-sop-rollout.md):
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/operations/pharmacy-sop-rollout/down.sql
--
-- Removes ONLY rows up.sql inserted: the id must equal
--   'dev751_sop_' || md5("organizationRoleId" || ':' || capability)
-- for that very row, the capability must be one of the three sop:* actions, the
-- effect must still be ALLOW and the role must belong to a PHARMACY
-- organization. A grant that existed before up.sql (any other id), a DENY, and
-- every non-SOP capability stay exactly as they are. Idempotent.
--
-- Rollback removes access: once it commits, holders of those system roles lose
-- the SOP screens and actions on the next request. In-flight SOP occurrences are
-- not deleted; they wait until access is restored.
--
-- Keep the explicit BEGIN/COMMIT (#975: without it forced RLS makes this a
-- silent no-op). The DO block refuses to run when the flag is not visible.
BEGIN;

SELECT set_config('app.is_platform_admin', 'true', true);

DO $dev751_down$
DECLARE
  v_removed integer;
  v_removed_outside_sop integer;
BEGIN
  IF current_setting('app.is_platform_admin', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'DEV-751: app.is_platform_admin is not set in this transaction; '
      'under forced RLS this script would change nothing (#975). Run the whole file.';
  END IF;

  WITH removed AS (
    DELETE FROM organization_role_permissions p
    USING organization_roles r, organizations o
    WHERE p."organizationRoleId" = r.id
      AND p."organizationId" = r."organizationId"
      AND o.id = r."organizationId"
      AND o.vertical = 'PHARMACY'
      AND p.id = 'dev751_sop_' || md5(p."organizationRoleId" || ':' || p.capability)
      AND p.capability IN ('sop:manage', 'sop:complete', 'sop:verify')
      AND p.effect = 'ALLOW'::"PermissionEffect"
    RETURNING p.capability
  )
  SELECT count(*), count(*) FILTER (WHERE capability NOT IN ('sop:manage', 'sop:complete', 'sop:verify'))
  INTO v_removed, v_removed_outside_sop
  FROM removed;

  IF v_removed_outside_sop <> 0 THEN
    RAISE EXCEPTION 'DEV-751: % non-SOP rows matched the rollback; rolled back',
      v_removed_outside_sop;
  END IF;

  RAISE NOTICE 'DEV-751 down: removed=%', v_removed;
END
$dev751_down$;

COMMIT;
