CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $preflight$
DECLARE
  extension_oid oid;
  configured_role name := current_user;
  configured_role_oid oid;
  configured_role_is_superuser boolean;
  member_count integer;
  public_execute_count integer;
  owner record;
  member record;
BEGIN
  SELECT oid
    INTO extension_oid
    FROM pg_catalog.pg_extension
   WHERE extname = 'btree_gist';

  IF extension_oid IS NULL THEN
    RAISE EXCEPTION 'btree_gist extension attribution is unavailable';
  END IF;

  SELECT role.oid, role.rolsuper
    INTO STRICT configured_role_oid, configured_role_is_superuser
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = configured_role;

  SELECT count(*)
    INTO member_count
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_depend AS dependency
      ON dependency.classid = 'pg_catalog.pg_proc'::regclass
     AND dependency.objid = procedure.oid
     AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
     AND dependency.refobjid = extension_oid
     AND dependency.deptype = 'e';

  IF member_count = 0 THEN
    RAISE EXCEPTION 'btree_gist has no attributed pg_proc members; refusing incomplete ACL preparation';
  END IF;

  -- Prove every role transition before changing any ACL. PostgreSQL reports an
  -- ineffective non-owner REVOKE as a warning, so attempting first is unsafe.
  FOR owner IN
    SELECT procedure.proowner AS owner_oid,
           pg_catalog.pg_get_userbyid(procedure.proowner) AS owner_name,
           count(*) AS function_count
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_depend AS dependency
        ON dependency.classid = 'pg_catalog.pg_proc'::regclass
       AND dependency.objid = procedure.oid
       AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
       AND dependency.refobjid = extension_oid
       AND dependency.deptype = 'e'
     GROUP BY procedure.proowner
     ORDER BY procedure.proowner
  LOOP
    IF NOT configured_role_is_superuser
       AND configured_role_oid <> owner.owner_oid
       AND NOT pg_catalog.pg_has_role(configured_role_oid, owner.owner_oid, 'SET') THEN
      RAISE EXCEPTION
        'extension preparation role % cannot SET ROLE to btree_gist function owner % (% functions)',
        configured_role, owner.owner_name, owner.function_count;
    END IF;
  END LOOP;

  FOR owner IN
    SELECT procedure.proowner AS owner_oid,
           pg_catalog.pg_get_userbyid(procedure.proowner) AS owner_name
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_depend AS dependency
        ON dependency.classid = 'pg_catalog.pg_proc'::regclass
       AND dependency.objid = procedure.oid
       AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
       AND dependency.refobjid = extension_oid
       AND dependency.deptype = 'e'
     GROUP BY procedure.proowner
     ORDER BY procedure.proowner
  LOOP
    EXECUTE format('SET LOCAL ROLE %I', owner.owner_name);

    FOR member IN
      SELECT procedure.oid::regprocedure AS identity
        FROM pg_catalog.pg_proc AS procedure
        JOIN pg_catalog.pg_depend AS dependency
          ON dependency.classid = 'pg_catalog.pg_proc'::regclass
         AND dependency.objid = procedure.oid
         AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
         AND dependency.refobjid = extension_oid
         AND dependency.deptype = 'e'
       WHERE procedure.proowner = owner.owner_oid
       ORDER BY procedure.oid
    LOOP
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', member.identity);
    END LOOP;

    EXECUTE format('SET LOCAL ROLE %I', configured_role);
  END LOOP;

  SELECT count(*) FILTER (
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
    INTO public_execute_count
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_depend AS dependency
      ON dependency.classid = 'pg_catalog.pg_proc'::regclass
     AND dependency.objid = procedure.oid
     AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
     AND dependency.refobjid = extension_oid
     AND dependency.deptype = 'e';

  IF public_execute_count <> 0 THEN
    RAISE EXCEPTION '% btree_gist functions retain PUBLIC EXECUTE after ACL preparation',
      public_execute_count;
  END IF;
END
$preflight$;
