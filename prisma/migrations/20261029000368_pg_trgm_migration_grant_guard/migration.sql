-- prepare-extensions.sql delegates this narrowly required pg_trgm function to
-- the configured migration role while executing as its real owner. Do not issue
-- a best-effort GRANT here: PostgreSQL only warns when a non-owner grants nothing.
DO $migration$
BEGIN
  IF to_regprocedure('public.similarity_op(text,text)') IS NULL THEN
    RAISE EXCEPTION 'pg_trgm similarity_op(text,text) is unavailable';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_roles AS role
     WHERE role.rolname = current_user
       AND (
         role.rolsuper
         OR EXISTS (
           SELECT 1
             FROM pg_catalog.pg_proc AS procedure
             CROSS JOIN LATERAL pg_catalog.aclexplode(procedure.proacl) AS acl
            WHERE procedure.oid = 'public.similarity_op(text,text)'::regprocedure
              AND acl.grantee = role.oid
              AND acl.privilege_type = 'EXECUTE'
              AND acl.is_grantable
         )
         -- Managed services may own extension functions under a role the
         -- customer cannot assume. Preparation records that skip instead of
         -- revoking PUBLIC EXECUTE. Accept it only while PUBLIC still provides
         -- execution to the runtime role, including one created after deploy.
         OR EXISTS (
           SELECT 1
             FROM pg_catalog.pg_proc AS procedure
             CROSS JOIN LATERAL pg_catalog.aclexplode(
               coalesce(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
             ) AS acl
            WHERE procedure.oid = 'public.similarity_op(text,text)'::regprocedure
              AND procedure.proowner <> role.oid
              AND NOT pg_catalog.pg_has_role(role.oid, procedure.proowner, 'SET')
              AND acl.grantee = 0
              AND acl.privilege_type = 'EXECUTE'
         )
       )
  ) THEN
    RAISE EXCEPTION USING
      MESSAGE = format(
        'migration role %s cannot grant EXECUTE on pg_trgm similarity_op(text,text)',
        current_user
      ),
      HINT = 'Run prisma/prepare-extensions.ts with EXTENSION_ADMIN_DATABASE_URL and MIGRATION_DATABASE_URL before prisma migrate deploy.';
  END IF;
END
$migration$;
