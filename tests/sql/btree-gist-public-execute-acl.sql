\set ON_ERROR_STOP on

-- Material regression proof for the forward migration. Run only in a fresh,
-- disposable database as a role allowed to create extensions and roles.
CREATE EXTENSION btree_gist;

CREATE FUNCTION public.wha766_unrelated_fixture(integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS 'SELECT $1';
GRANT EXECUTE ON FUNCTION public.wha766_unrelated_fixture(integer) TO PUBLIC;

-- Recreate the already-installed vulnerable ACL before applying the correction.
GRANT EXECUTE ON FUNCTION public.int4_dist(integer, integer) TO PUBLIC;

\ir ../../prisma/migrations/20260830120000_btree_gist_public_execute_acl/migration.sql

DO $proof$
DECLARE
  attributed_count integer;
  public_execute_count integer;
BEGIN
  SELECT count(*),
         count(*) FILTER (
           WHERE EXISTS (
             SELECT 1
               FROM aclexplode(
                 coalesce(procedure.proacl, acldefault('f', procedure.proowner))
               ) AS acl
              WHERE acl.grantee = 0
                AND acl.privilege_type = 'EXECUTE'
           )
         )
    INTO attributed_count, public_execute_count
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_depend AS dependency
      ON dependency.classid = 'pg_catalog.pg_proc'::regclass
     AND dependency.objid = procedure.oid
     AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
     AND dependency.deptype = 'e'
    JOIN pg_catalog.pg_extension AS extension
      ON extension.oid = dependency.refobjid
     AND extension.extname = 'btree_gist';

  IF attributed_count = 0 THEN
    RAISE EXCEPTION 'proof found no btree_gist pg_proc members';
  END IF;
  IF public_execute_count <> 0 THEN
    RAISE EXCEPTION '% attributed btree_gist functions retain PUBLIC EXECUTE', public_execute_count;
  END IF;
  IF NOT has_function_privilege(
    'public.wha766_unrelated_fixture(integer)'::regprocedure,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'migration changed an unrelated function ACL';
  END IF;
END
$proof$;

CREATE ROLE wha766_restricted NOLOGIN NOSUPERUSER NOBYPASSRLS;

DO $proof$
DECLARE
  role_row pg_catalog.pg_roles%ROWTYPE;
  executable_count integer;
  membership_count integer;
BEGIN
  SELECT * INTO STRICT role_row
    FROM pg_catalog.pg_roles
   WHERE rolname = 'wha766_restricted';

  IF role_row.rolsuper OR role_row.rolbypassrls THEN
    RAISE EXCEPTION 'restricted proof role can bypass authorization';
  END IF;

  SELECT count(*) INTO membership_count
    FROM pg_catalog.pg_auth_members
   WHERE member = role_row.oid;
  IF membership_count <> 0 THEN
    RAISE EXCEPTION 'restricted proof role unexpectedly has memberships';
  END IF;

  SELECT count(*) INTO executable_count
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_depend AS dependency
      ON dependency.classid = 'pg_catalog.pg_proc'::regclass
     AND dependency.objid = procedure.oid
     AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
     AND dependency.deptype = 'e'
    JOIN pg_catalog.pg_extension AS extension
      ON extension.oid = dependency.refobjid
     AND extension.extname = 'btree_gist'
   WHERE has_function_privilege(
     'wha766_restricted', procedure.oid, 'EXECUTE'
   );
  IF executable_count <> 0 THEN
    RAISE EXCEPTION 'restricted role can execute % btree_gist functions', executable_count;
  END IF;
END
$proof$;

SET ROLE wha766_restricted;
\set ON_ERROR_STOP off
SELECT public.int4_dist(1, 2);
\set direct_call_sqlstate :SQLSTATE
\set ON_ERROR_STOP on
RESET ROLE;

SELECT :'direct_call_sqlstate' = '42501' AS direct_call_denied \gset
\if :direct_call_denied
\else
  \echo 'expected direct btree_gist call to fail with SQLSTATE 42501, got' :direct_call_sqlstate
  \quit 1
\endif

CREATE TEMPORARY TABLE wha766_gist_behavior (
  subject integer NOT NULL,
  active int4range NOT NULL,
  EXCLUDE USING gist (subject WITH =, active WITH &&)
);
INSERT INTO wha766_gist_behavior VALUES
  (1, '[1,3)'),
  (1, '[3,5)');

\set ON_ERROR_STOP off
INSERT INTO wha766_gist_behavior VALUES (1, '[2,4)');
\set overlap_sqlstate :SQLSTATE
\set ON_ERROR_STOP on

SELECT :'overlap_sqlstate' = '23P01' AS overlap_rejected \gset
\if :overlap_rejected
\else
  \echo 'expected overlapping GiST insert to fail with SQLSTATE 23P01, got' :overlap_sqlstate
  \quit 1
\endif

SELECT count(*) = 2 AS non_overlapping_rows_retained
  FROM wha766_gist_behavior
\gset
\if :non_overlapping_rows_retained
\else
  \echo 'expected exactly two retained non-overlapping rows'
  \quit 1
\endif

\echo 'WHA-766 btree_gist ACL regression proof passed'
