-- Records hardening steps that could not be applied on this cluster. A managed
-- PostgreSQL service installs trusted extensions under an internal superuser
-- (Azure Database for PostgreSQL uses "azuresu") that no customer role may
-- assume, so the PUBLIC EXECUTE revoke below is impossible there. Skipping it
-- silently would hide a real gap, so every skip is recorded instead.
-- Kept out of "public" on purpose: preparation runs before prisma migrate deploy,
-- and a table in the migrated schema would make a brand-new database look
-- non-empty, which fails deploy with P3005.
-- CREATE TABLE IF NOT EXISTS still demands CREATE on the schema, so guard the
-- bootstrap: once the table exists, recording needs only INSERT and UPDATE.
DO $hardening_table$
BEGIN
  -- to_regclass resolves names through schema access, so it reports NULL for a
  -- role without USAGE on platform_ops. Read the catalog directly instead.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'platform_ops'
       AND relation.relname = 'platform_db_hardening'
  ) THEN
    CREATE SCHEMA IF NOT EXISTS platform_ops;
    CREATE TABLE platform_ops.platform_db_hardening (
      extension_name text NOT NULL,
      owner_role name NOT NULL,
      reason text NOT NULL,
      function_count integer NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT platform_db_hardening_pkey PRIMARY KEY (extension_name, owner_role)
    );
  END IF;
END
$hardening_table$;

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
  SELECT role.oid, role.rolsuper
    INTO STRICT configured_role_oid, configured_role_is_superuser
    FROM pg_catalog.pg_roles AS role
   WHERE role.rolname = configured_role;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_extension
     WHERE extname = 'btree_gist'
  ) THEN
    IF NOT configured_role_is_superuser
       AND NOT pg_catalog.has_database_privilege(
         configured_role,
         current_database(),
         'CREATE'
       ) THEN
      RAISE EXCEPTION
        'extension preparation role % cannot bootstrap btree_gist in database % (CREATE privilege required)',
        configured_role, current_database();
    END IF;

    EXECUTE 'CREATE EXTENSION btree_gist';
  END IF;

  SELECT oid
    INTO extension_oid
    FROM pg_catalog.pg_extension
   WHERE extname = 'btree_gist';

  IF extension_oid IS NULL THEN
    RAISE EXCEPTION 'btree_gist extension attribution is unavailable';
  END IF;

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

  -- Classify every function owner before changing any ACL. PostgreSQL reports an
  -- ineffective non-owner REVOKE as a warning, so attempting first is unsafe.
  -- An owner this role cannot assume is a managed-service owner: record the skip
  -- rather than failing the deployment, and leave its ACLs untouched.
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
      INSERT INTO platform_ops.platform_db_hardening (
        extension_name, owner_role, reason, function_count
      )
      VALUES ('btree_gist', owner.owner_name, 'managed-owner', owner.function_count)
      ON CONFLICT ON CONSTRAINT platform_db_hardening_pkey DO UPDATE
        SET reason = excluded.reason,
            function_count = excluded.function_count,
            recorded_at = now();

      RAISE NOTICE
        'skipping btree_gist PUBLIC EXECUTE revoke for % functions owned by %: preparation role % cannot SET ROLE to it (managed-owner)',
        owner.function_count, owner.owner_name, configured_role;
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
     WHERE configured_role_is_superuser
        OR procedure.proowner = configured_role_oid
        OR pg_catalog.pg_has_role(configured_role_oid, procedure.proowner, 'SET')
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

  -- Only functions this role could have corrected are allowed to fail the check.
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
     AND dependency.deptype = 'e'
   WHERE configured_role_is_superuser
      OR procedure.proowner = configured_role_oid
      OR pg_catalog.pg_has_role(configured_role_oid, procedure.proowner, 'SET');

  IF public_execute_count <> 0 THEN
    RAISE EXCEPTION '% btree_gist functions retain PUBLIC EXECUTE after ACL preparation',
      public_execute_count;
  END IF;
END
$preflight$;
