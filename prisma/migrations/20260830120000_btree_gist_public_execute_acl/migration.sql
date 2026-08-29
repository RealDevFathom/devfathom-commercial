-- btree_gist installs functions with PostgreSQL's default PUBLIC EXECUTE grant.
-- Restrict only functions attributed to this extension; unrelated functions and
-- extension ownership remain unchanged.
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $migration$
DECLARE
  extension_oid oid;
  member_count integer := 0;
  member record;
BEGIN
  SELECT oid
    INTO extension_oid
    FROM pg_catalog.pg_extension
   WHERE extname = 'btree_gist';

  IF extension_oid IS NULL THEN
    RAISE EXCEPTION 'btree_gist extension attribution is unavailable';
  END IF;

  FOR member IN
    SELECT procedure.oid::regprocedure AS identity
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_depend AS dependency
        ON dependency.classid = 'pg_catalog.pg_proc'::regclass
       AND dependency.objid = procedure.oid
       AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
       AND dependency.refobjid = extension_oid
       AND dependency.deptype = 'e'
     ORDER BY procedure.oid
  LOOP
    member_count := member_count + 1;
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC',
      member.identity
    );
  END LOOP;

  IF member_count = 0 THEN
    RAISE EXCEPTION 'btree_gist has no attributed pg_proc members; refusing incomplete ACL correction';
  END IF;
END
$migration$;
