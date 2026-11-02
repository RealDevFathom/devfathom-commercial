-- btree_gist objects are owned by PostgreSQL's extension bootstrap role when a
-- non-superuser installs this trusted extension. The executable deployment path
-- must therefore run prisma/prepare-extensions.ts with the privileged extension
-- administrator before Prisma migrations. This migration also corrects functions
-- owned by its own role in shadow databases, then verifies that postcondition and
-- fails closed instead of accepting ineffective REVOKE warnings.
--
-- A managed PostgreSQL service installs trusted extensions under an internal
-- superuser (Azure Database for PostgreSQL uses "azuresu") that no customer role
-- may assume, so the revoke is impossible there and prepare-extensions.ts records
-- the skip in platform_ops.platform_db_hardening. Failing closed on functions this role
-- could never have corrected would make the schema undeployable on managed
-- PostgreSQL, so the assertion is scoped to the owners this role can assume.

DO $migration$
DECLARE
  extension_oid oid;
  configured_role name := current_user;
  configured_role_oid oid;
  configured_role_is_superuser boolean;
  member record;
  member_count integer := 0;
  remediable_public_execute_count integer;
  managed_public_execute_count integer;
BEGIN
  SELECT role.oid, role.rolsuper
    INTO STRICT configured_role_oid, configured_role_is_superuser
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = configured_role;

  SELECT oid
    INTO extension_oid
    FROM pg_catalog.pg_extension
   WHERE extname = 'btree_gist';

  IF extension_oid IS NULL THEN
    RAISE EXCEPTION 'btree_gist extension attribution is unavailable';
  END IF;

  -- Shadow databases can create extension functions owned by the migration role.
  FOR member IN
    SELECT procedure.oid::regprocedure AS identity
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_depend AS dependency
        ON dependency.classid = 'pg_catalog.pg_proc'::regclass
       AND dependency.objid = procedure.oid
       AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
       AND dependency.refobjid = extension_oid
       AND dependency.deptype = 'e'
     WHERE procedure.proowner = configured_role_oid
     ORDER BY procedure.oid
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', member.identity);
  END LOOP;

  SELECT count(*),
         count(*) FILTER (
           WHERE retains_public_execute AND owner_is_assumable
         ),
         count(*) FILTER (
           WHERE retains_public_execute AND NOT owner_is_assumable
         )
    INTO member_count, remediable_public_execute_count, managed_public_execute_count
    FROM (
      SELECT EXISTS (
               SELECT 1
                 FROM pg_catalog.aclexplode(
                   coalesce(
                     procedure.proacl,
                     pg_catalog.acldefault('f', procedure.proowner)
                   )
                 ) AS acl
                WHERE acl.grantee = 0
                  AND acl.privilege_type = 'EXECUTE'
             ) AS retains_public_execute,
             (
               configured_role_is_superuser
               OR procedure.proowner = configured_role_oid
               OR pg_catalog.pg_has_role(configured_role_oid, procedure.proowner, 'SET')
             ) AS owner_is_assumable
        FROM pg_catalog.pg_proc AS procedure
        JOIN pg_catalog.pg_depend AS dependency
          ON dependency.classid = 'pg_catalog.pg_proc'::regclass
         AND dependency.objid = procedure.oid
         AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
         AND dependency.refobjid = extension_oid
         AND dependency.deptype = 'e'
    ) AS attributed_member;

  IF member_count = 0 THEN
    RAISE EXCEPTION 'btree_gist has no attributed pg_proc members; refusing incomplete ACL correction';
  END IF;
  IF remediable_public_execute_count <> 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        '%s btree_gist functions retain PUBLIC EXECUTE',
        remediable_public_execute_count
      ),
      HINT = 'Run prisma/prepare-extensions.ts with EXTENSION_ADMIN_DATABASE_URL before prisma migrate deploy.';
  END IF;
  IF managed_public_execute_count <> 0 THEN
    RAISE NOTICE
      '% btree_gist functions retain PUBLIC EXECUTE under owners this role cannot assume; see platform_ops.platform_db_hardening',
      managed_public_execute_count;
  END IF;
END
$migration$;
