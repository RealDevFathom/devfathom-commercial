-- WHA-763: btree_gist is required for GiST exclusion constraints, but its
-- extension-owned functions are not an application runtime API.
--
-- PostgreSQL grants PUBLIC EXECUTE to newly created functions by default. Run
-- this normalization after CREATE/UPDATE EXTENSION btree_gist. A future
-- btree_gist upgrade must be followed by a new migration containing this same
-- normalization so any newly added extension members are also covered.
DO $revoke_btree_gist_public_execute$
DECLARE
  member regprocedure;
  member_count integer := 0;
BEGIN
  FOR member IN
    SELECT procedure.oid::regprocedure
    FROM pg_catalog.pg_extension AS extension
    JOIN pg_catalog.pg_depend AS dependency
      ON dependency.refclassid = 'pg_catalog.pg_extension'::regclass
     AND dependency.refobjid = extension.oid
     AND dependency.classid = 'pg_catalog.pg_proc'::regclass
     AND dependency.deptype = 'e'
    JOIN pg_catalog.pg_proc AS procedure
      ON procedure.oid = dependency.objid
     AND dependency.objsubid = 0
    WHERE extension.extname = 'btree_gist'
    ORDER BY procedure.oid
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', member);
    member_count := member_count + 1;
  END LOOP;

  IF member_count = 0 THEN
    RAISE EXCEPTION
      'Cannot revoke btree_gist PUBLIC EXECUTE: no pg_proc extension members were attributed through pg_depend';
  END IF;
END
$revoke_btree_gist_public_execute$;
