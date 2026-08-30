-- btree_gist objects are owned by PostgreSQL's extension bootstrap role when a
-- non-superuser installs this trusted extension. The executable deployment path
-- must therefore run prisma/prepare-extensions.ts with the privileged extension
-- administrator before Prisma migrations. This migration verifies that required
-- postcondition and fails closed instead of accepting ineffective REVOKE warnings.

DO $migration$
DECLARE
  extension_oid oid;
  member_count integer := 0;
  public_execute_count integer;
BEGIN
  SELECT oid
    INTO extension_oid
    FROM pg_catalog.pg_extension
   WHERE extname = 'btree_gist';

  IF extension_oid IS NULL THEN
    RAISE EXCEPTION 'btree_gist extension attribution is unavailable';
  END IF;

  SELECT count(*),
         count(*) FILTER (
           WHERE EXISTS (
             SELECT 1
               FROM pg_catalog.aclexplode(
                 coalesce(
                   procedure.proacl,
                   pg_catalog.acldefault('f', procedure.proowner)
                 )
               ) AS acl
              WHERE acl.grantee = 0
                AND acl.privilege_type = 'EXECUTE'
           )
         )
    INTO member_count, public_execute_count
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_depend AS dependency
      ON dependency.classid = 'pg_catalog.pg_proc'::regclass
     AND dependency.objid = procedure.oid
     AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
     AND dependency.refobjid = extension_oid
     AND dependency.deptype = 'e';

  IF member_count = 0 THEN
    RAISE EXCEPTION 'btree_gist has no attributed pg_proc members; refusing incomplete ACL correction';
  END IF;
  IF public_execute_count <> 0 THEN
    RAISE EXCEPTION USING
      MESSAGE = format('%s btree_gist functions retain PUBLIC EXECUTE', public_execute_count),
      HINT = 'Run prisma/prepare-extensions.ts with EXTENSION_ADMIN_DATABASE_URL before prisma migrate deploy.';
  END IF;
END
$migration$;
