\set ON_ERROR_STOP on

-- Material regression proof for the forward migration. Run only in a fresh,
-- disposable database as a role allowed to create extensions and roles. Set
-- preinstall_vulnerable=false to prove migration from an extension-absent state.
\if :{?preinstall_vulnerable}
\else
  \set preinstall_vulnerable true
\endif

-- Trusted extension scripts run as the cluster's privileged bootstrap role.
-- Capture that fixture role instead of assuming the conventional postgres name.
SELECT current_user AS extension_function_owner \gset

-- Preparation records skips it cannot perform in this table. A real deployment
-- always runs preparation as one database-owning role; this proof drives it as
-- several fixture roles in turn, so create the table up front under the fixture
-- owner and grant each role the access that deploy role would already have.
CREATE SCHEMA IF NOT EXISTS platform_ops;
CREATE TABLE IF NOT EXISTS platform_ops.platform_db_hardening (
  extension_name text NOT NULL,
  owner_role name NOT NULL,
  reason text NOT NULL,
  function_count integer NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_db_hardening_pkey PRIMARY KEY (extension_name, owner_role)
);

\if :preinstall_vulnerable
  CREATE EXTENSION IF NOT EXISTS btree_gist;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;

  SELECT count(*) = 2 AS preinstalled_required_extensions
    FROM pg_catalog.pg_extension
   WHERE extname IN ('btree_gist', 'pg_trgm')
  \gset
  \if :preinstalled_required_extensions
  \else
    \echo 'preinstalled scenario lacks a required extension'
    \quit 1
  \endif
\endif

CREATE FUNCTION public.wha766_unrelated_fixture(integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS 'SELECT $1';
GRANT EXECUTE ON FUNCTION public.wha766_unrelated_fixture(integer) TO PUBLIC;

\if :preinstall_vulnerable
  -- Recreate the already-installed vulnerable ACL before applying the correction.
  GRANT EXECUTE ON FUNCTION public.int4_dist(integer, integer) TO PUBLIC;
\endif

CREATE ROLE wha911_nonowner LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA platform_ops TO wha911_nonowner;
GRANT SELECT, INSERT, UPDATE ON platform_ops.platform_db_hardening TO wha911_nonowner;

DO $proof$
DECLARE
  role_row pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO STRICT role_row
    FROM pg_catalog.pg_roles
   WHERE rolname = 'wha911_nonowner';

  IF role_row.rolsuper OR role_row.rolbypassrls THEN
    RAISE EXCEPTION 'negative preparation role can bypass authorization';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = role_row.oid
  ) THEN
    RAISE EXCEPTION 'negative preparation role unexpectedly has memberships';
  END IF;
END
$proof$;

SELECT count(*) AS public_execute_before_failed_preparation
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_depend AS dependency
    ON dependency.classid = 'pg_catalog.pg_proc'::regclass
   AND dependency.objid = procedure.oid
   AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
   AND dependency.deptype = 'e'
  JOIN pg_catalog.pg_extension AS extension
    ON extension.oid = dependency.refobjid
   AND extension.extname = 'btree_gist'
 WHERE EXISTS (
   SELECT 1
     FROM pg_catalog.aclexplode(
       coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
     ) AS acl
    WHERE acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'
 )
\gset

\if :preinstall_vulnerable
  -- Managed PostgreSQL owns extension functions with an internal superuser no
  -- customer role may assume.
  -- Preparation must skip the revoke it cannot perform, record that skip, and
  -- leave the ACLs exactly as it found them.
  SET SESSION AUTHORIZATION wha911_nonowner;
  \ir ../../prisma/prepare-extensions.sql
  RESET SESSION AUTHORIZATION;

  SELECT EXISTS (
    SELECT 1
      FROM platform_ops.platform_db_hardening
     WHERE extension_name = 'btree_gist'
       AND owner_role = :'extension_function_owner'
       AND reason = 'managed-owner'
       AND function_count > 0
  ) AS non_owner_recorded_skip \gset
  \if :non_owner_recorded_skip
  \else
    \echo 'managed-owner preparation did not record a skip for' :extension_function_owner
    \quit 1
  \endif

  -- The guard migration must tolerate exactly what preparation could not correct.
  SET SESSION AUTHORIZATION wha911_nonowner;
  \ir ../../prisma/migrations/20260830120000_btree_gist_public_execute_acl/migration.sql
  RESET SESSION AUTHORIZATION;

  DELETE FROM platform_ops.platform_db_hardening;
\else
  -- With the extension absent this role cannot bootstrap it at all, which is a
  -- different failure from an unassumable owner and must still fail closed.
  SET SESSION AUTHORIZATION wha911_nonowner;
  \set ON_ERROR_STOP off
  \ir ../../prisma/prepare-extensions.sql
  \set failed_preparation_sqlstate :SQLSTATE
  \set ON_ERROR_STOP on
  RESET SESSION AUTHORIZATION;

  SELECT :'failed_preparation_sqlstate' = 'P0001' AS failed_closed \gset
  \if :failed_closed
  \else
    \echo 'expected extension-absent preparation to fail with SQLSTATE P0001, got' :failed_preparation_sqlstate
    \quit 1
  \endif
\endif

SELECT count(*) = :public_execute_before_failed_preparation AS skipped_preparation_left_acl_unchanged
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_depend AS dependency
    ON dependency.classid = 'pg_catalog.pg_proc'::regclass
   AND dependency.objid = procedure.oid
   AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
   AND dependency.deptype = 'e'
  JOIN pg_catalog.pg_extension AS extension
    ON extension.oid = dependency.refobjid
   AND extension.extname = 'btree_gist'
 WHERE EXISTS (
   SELECT 1
     FROM pg_catalog.aclexplode(
       coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
     ) AS acl
    WHERE acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'
 )
\gset
\if :skipped_preparation_left_acl_unchanged
\else
  \echo 'skipped preparation changed btree_gist ACLs'
  \quit 1
\endif

REVOKE ALL ON platform_ops.platform_db_hardening FROM wha911_nonowner;
REVOKE USAGE ON SCHEMA platform_ops FROM wha911_nonowner;
DROP ROLE wha911_nonowner;

\if :preinstall_vulnerable
\else
  CREATE ROLE wha911_creator_only LOGIN NOSUPERUSER NOBYPASSRLS;
  GRANT USAGE ON SCHEMA platform_ops TO wha911_creator_only;
  GRANT SELECT, INSERT, UPDATE ON platform_ops.platform_db_hardening TO wha911_creator_only;
  SELECT format(
    'GRANT CREATE ON DATABASE %I TO wha911_creator_only',
    current_database()
  ) \gexec

  DO $proof$
  DECLARE
    role_row pg_catalog.pg_roles%ROWTYPE;
  BEGIN
    SELECT * INTO STRICT role_row
      FROM pg_catalog.pg_roles
     WHERE rolname = 'wha911_creator_only';

    IF role_row.rolsuper OR role_row.rolbypassrls THEN
      RAISE EXCEPTION 'CREATE-only preparation role can bypass authorization';
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members WHERE member = role_row.oid
    ) THEN
      RAISE EXCEPTION 'CREATE-only preparation role unexpectedly has memberships';
    END IF;
    IF NOT pg_catalog.has_database_privilege(
      'wha911_creator_only', current_database(), 'CREATE'
    ) THEN
      RAISE EXCEPTION 'CREATE-only preparation role lacks database CREATE privilege';
    END IF;
  END
  $proof$;

  SELECT NOT pg_catalog.pg_has_role(
    'wha911_creator_only', :'extension_function_owner', 'SET'
  ) AS creator_only_lacks_owner_set
  \gset
  \if :creator_only_lacks_owner_set
  \else
    \echo 'CREATE-only preparation role can unexpectedly SET extension function owner' :extension_function_owner
    \quit 1
  \endif

  -- This role can install the extension but cannot assume the bootstrap role that
  -- ends up owning its functions: the managed-service shape, reached from an
  -- extension-absent start. Installation must succeed and the skip be recorded.
  SET SESSION AUTHORIZATION wha911_creator_only;
  \ir ../../prisma/prepare-extensions.sql
  RESET SESSION AUTHORIZATION;

  SELECT (
           SELECT count(*) = 2
             FROM pg_catalog.pg_extension
            WHERE extname IN ('btree_gist', 'pg_trgm')
         ) AS creator_only_installed_extensions,
         EXISTS (
           SELECT 1
             FROM platform_ops.platform_db_hardening
            WHERE extension_name = 'btree_gist'
              AND owner_role = :'extension_function_owner'
              AND reason = 'managed-owner'
              AND function_count > 0
         ) AS creator_only_recorded_skip,
         EXISTS (
           SELECT 1
             FROM pg_catalog.pg_proc AS procedure
             CROSS JOIN LATERAL pg_catalog.aclexplode(
               coalesce(
                 procedure.proacl,
                 pg_catalog.acldefault('f', procedure.proowner)
               )
             ) AS acl
            WHERE procedure.oid = 'public.wha766_unrelated_fixture(integer)'::regprocedure
              AND acl.grantee = 0
              AND acl.privilege_type = 'EXECUTE'
         ) AS creator_only_preserved_unrelated_acl
  \gset
  \if :creator_only_installed_extensions
  \else
    \echo 'CREATE-only preparation did not install all required extensions'
    \quit 1
  \endif
  \if :creator_only_recorded_skip
  \else
    \echo 'CREATE-only preparation did not record a managed-owner skip for' :extension_function_owner
    \quit 1
  \endif
  \if :creator_only_preserved_unrelated_acl
  \else
    \echo 'CREATE-only preparation changed unrelated PUBLIC EXECUTE ACL'
    \quit 1
  \endif

  -- The guard migration must tolerate this state too.
  SET SESSION AUTHORIZATION wha911_creator_only;
  \ir ../../prisma/migrations/20260830120000_btree_gist_public_execute_acl/migration.sql
  RESET SESSION AUTHORIZATION;

  DELETE FROM platform_ops.platform_db_hardening;

  SELECT format(
    'REVOKE CREATE ON DATABASE %I FROM wha911_creator_only',
    current_database()
  ) \gexec
  REVOKE ALL ON platform_ops.platform_db_hardening FROM wha911_creator_only;
  REVOKE USAGE ON SCHEMA platform_ops FROM wha911_creator_only;
  -- Preparation no longer rolls the installation back, so this role now owns the
  -- extension it created and cannot be dropped until that is reassigned.
  SELECT format(
    'REASSIGN OWNED BY wha911_creator_only TO %I',
    :'extension_function_owner'
  ) \gexec
  DROP ROLE wha911_creator_only;
\endif

CREATE ROLE wha911_preparer LOGIN NOSUPERUSER NOBYPASSRLS;
SELECT format(
  'GRANT %I TO wha911_preparer WITH INHERIT FALSE, SET TRUE',
  :'extension_function_owner'
) \gexec

\if :preinstall_vulnerable
\else
  SELECT format(
    'GRANT CREATE ON DATABASE %I TO wha911_preparer',
    current_database()
  ) \gexec
\endif

DO $proof$
DECLARE
  role_row pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO STRICT role_row
    FROM pg_catalog.pg_roles
   WHERE rolname = 'wha911_preparer';

  IF role_row.rolsuper OR role_row.rolbypassrls THEN
    RAISE EXCEPTION 'SET-capable preparation role can bypass authorization';
  END IF;
END
$proof$;

SELECT pg_catalog.pg_has_role(
  'wha911_preparer', :'extension_function_owner', 'SET'
) AS preparer_can_set_function_owner
\gset
\if :preparer_can_set_function_owner
\else
  \echo 'positive preparation role lacks SET privilege for extension function owner' :extension_function_owner
  \quit 1
\endif

\if :preinstall_vulnerable
\else
  SELECT pg_catalog.has_database_privilege(
    'wha911_preparer', current_database(), 'CREATE'
  ) AS preparer_can_bootstrap_extension
  \gset
  \if :preparer_can_bootstrap_extension
  \else
    \echo 'positive absent-state preparation role lacks database CREATE privilege'
    \quit 1
  \endif
\endif

SET SESSION AUTHORIZATION wha911_preparer;
\ir ../../prisma/prepare-extensions.sql
RESET SESSION AUTHORIZATION;

\if :preinstall_vulnerable
\else
  SELECT format(
    'REVOKE CREATE ON DATABASE %I FROM wha911_preparer',
    current_database()
  ) \gexec
\endif

SELECT format(
  'REVOKE %I FROM wha911_preparer',
  :'extension_function_owner'
) \gexec
\if :preinstall_vulnerable
  DROP ROLE wha911_preparer;
\endif

-- The SET-capable run above performs the correction. This second run proves
-- that preparation remains idempotent, and that it bootstraps its own record
-- table when absent.
DROP TABLE platform_ops.platform_db_hardening;
\ir ../../prisma/prepare-extensions.sql
\ir ../../prisma/migrations/20260830120000_btree_gist_public_execute_acl/migration.sql

SELECT count(*) = 0 AS assumable_owner_recorded_no_skip
  FROM platform_ops.platform_db_hardening
\gset
\if :assumable_owner_recorded_no_skip
\else
  \echo 'preparation recorded a skip despite being able to assume the function owner'
  \quit 1
\endif

DO $proof$
DECLARE
  attributed_count integer;
  public_execute_count integer;
BEGIN
  IF current_setting('server_version_num')::integer <> 160015 THEN
    RAISE EXCEPTION 'proof requires PostgreSQL 16.15, found %', version();
  END IF;

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

  IF attributed_count <> 188 THEN
    RAISE EXCEPTION 'expected 188 btree_gist pg_proc members on PostgreSQL 16.15, found %',
      attributed_count;
  END IF;
  IF public_execute_count <> 0 THEN
    RAISE EXCEPTION '% attributed btree_gist functions retain PUBLIC EXECUTE', public_execute_count;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
      ) AS acl
     WHERE procedure.oid = 'public.wha766_unrelated_fixture(integer)'::regprocedure
       AND acl.grantee = 0
       AND acl.privilege_type = 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'migration removed unrelated PUBLIC EXECUTE ACL';
  END IF;
END
$proof$;

CREATE ROLE wha766_restricted LOGIN NOSUPERUSER NOBYPASSRLS;

CREATE SCHEMA wha766_proof;
CREATE TABLE wha766_proof.gist_behavior (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  subject integer NOT NULL,
  active int4range NOT NULL,
  EXCLUDE USING gist (subject WITH =, active WITH &&)
);
GRANT USAGE ON SCHEMA wha766_proof TO wha766_restricted;
GRANT SELECT, INSERT ON TABLE wha766_proof.gist_behavior TO wha766_restricted;
GRANT USAGE ON SEQUENCE wha766_proof.gist_behavior_id_seq TO wha766_restricted;

DO $proof$
DECLARE
  role_row pg_catalog.pg_roles%ROWTYPE;
  executable_count integer;
  membership_count integer;
BEGIN
  SELECT * INTO STRICT role_row
    FROM pg_catalog.pg_roles
   WHERE rolname = 'wha766_restricted';

  IF NOT role_row.rolcanlogin OR role_row.rolsuper OR role_row.rolbypassrls THEN
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

SELECT current_user = 'wha766_restricted' AS restricted_identity_active \gset
\if :restricted_identity_active
\else
  \echo 'expected current_user to be wha766_restricted, got' :USER
  \quit 1
\endif

\set ON_ERROR_STOP off
SELECT public.int4_dist(1, 2);
\set direct_call_sqlstate :SQLSTATE
\set ON_ERROR_STOP on

SELECT :'direct_call_sqlstate' = '42501' AS direct_call_denied \gset
\if :direct_call_denied
\else
  \echo 'expected direct btree_gist call to fail with SQLSTATE 42501, got' :direct_call_sqlstate
  \quit 1
\endif

INSERT INTO wha766_proof.gist_behavior (subject, active) VALUES
  (1, '[1,3)'),
  (1, '[3,5)');

\set ON_ERROR_STOP off
INSERT INTO wha766_proof.gist_behavior (subject, active) VALUES (1, '[2,4)');
\set overlap_sqlstate :SQLSTATE
\set ON_ERROR_STOP on

SELECT :'overlap_sqlstate' = '23P01' AS overlap_rejected \gset
\if :overlap_rejected
\else
  \echo 'expected overlapping GiST insert to fail with SQLSTATE 23P01, got' :overlap_sqlstate
  \quit 1
\endif

SELECT count(*) = 2 AS non_overlapping_rows_retained
  FROM wha766_proof.gist_behavior
\gset
\if :non_overlapping_rows_retained
\else
  \echo 'expected exactly two retained non-overlapping rows'
  \quit 1
\endif

RESET ROLE;

DROP OWNED BY wha766_restricted;
DROP ROLE wha766_restricted;
DROP SCHEMA wha766_proof CASCADE;

\if :preinstall_vulnerable
\else
  DROP EXTENSION btree_gist;
  DROP ROLE wha911_preparer;
\endif

DROP SCHEMA platform_ops CASCADE;

\echo 'WHA-911 owner-aware btree_gist ACL regression proof passed'
