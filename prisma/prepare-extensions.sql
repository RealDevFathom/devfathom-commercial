CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $preflight$
DECLARE
  extension_oid oid;
  member record;
BEGIN
  SELECT oid
    INTO STRICT extension_oid
    FROM pg_catalog.pg_extension
   WHERE extname = 'btree_gist';

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
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', member.identity);
  END LOOP;
END
$preflight$;
