-- Records hardening steps that could not be applied on this cluster. A managed
-- PostgreSQL service can install trusted extensions under an internal superuser
-- that no customer role may assume, so the PUBLIC EXECUTE revoke below is impossible there. Skipping it
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
  target_extension name;
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

  FOREACH target_extension IN ARRAY ARRAY['btree_gist', 'pg_trgm']::name[]
  LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_extension
       WHERE extname = target_extension
    ) THEN
      IF NOT configured_role_is_superuser
         AND NOT pg_catalog.has_database_privilege(
           configured_role,
           current_database(),
           'CREATE'
         ) THEN
        RAISE EXCEPTION
          'extension preparation role % cannot bootstrap % in database % (CREATE privilege required)',
          configured_role, target_extension, current_database();
      END IF;

      EXECUTE format('CREATE EXTENSION %I', target_extension);
    END IF;

    SELECT oid
      INTO extension_oid
      FROM pg_catalog.pg_extension
     WHERE extname = target_extension;

    IF extension_oid IS NULL THEN
      RAISE EXCEPTION '% extension attribution is unavailable', target_extension;
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
      RAISE EXCEPTION '% has no attributed pg_proc members; refusing incomplete ACL preparation',
        target_extension;
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
        VALUES (target_extension, owner.owner_name, 'managed-owner', owner.function_count)
        ON CONFLICT ON CONSTRAINT platform_db_hardening_pkey DO UPDATE
          SET reason = excluded.reason,
              function_count = excluded.function_count,
              recorded_at = now();

        RAISE NOTICE
          'skipping % PUBLIC EXECUTE revoke for % functions owned by %: preparation role % cannot SET ROLE to it (managed-owner)',
          target_extension, owner.function_count, owner.owner_name, configured_role;
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

      -- Medicine search runs pg_trgm's % operator as devfathom_app, which calls
      -- similarity_op. The revoke above removed its PUBLIC route, and only this owner
      -- (not a plain migration role) may grant it back, so grant it here whenever the
      -- runtime role already exists. prepare-runtime-role.ts covers a brand-new role.
      IF target_extension = 'pg_trgm'
         AND EXISTS (
           SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'devfathom_app'
         )
         AND EXISTS (
           SELECT 1
             FROM pg_catalog.pg_proc AS procedure
            WHERE procedure.oid = pg_catalog.to_regprocedure('public.similarity_op(text,text)')
              AND procedure.proowner = owner.owner_oid
         ) THEN
        GRANT EXECUTE ON FUNCTION public.similarity_op(text,text) TO devfathom_app;
      END IF;

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
      RAISE EXCEPTION '% % functions retain PUBLIC EXECUTE after ACL preparation',
        public_execute_count, target_extension;
    END IF;
  END LOOP;
END
$preflight$;
