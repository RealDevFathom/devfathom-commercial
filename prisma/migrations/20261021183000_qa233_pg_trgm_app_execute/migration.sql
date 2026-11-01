BEGIN;

-- Extension preparation intentionally revokes PUBLIC EXECUTE. Restore only the
-- text search entry points needed by the application. PostgreSQL checks EXECUTE
-- on the backing functions when %, <%, %>, <<%, and %>> operators are used.
-- A plain GRANT only warns (and changes nothing) when the migration role does
-- not own these extension objects. Verify the result so that deployment either
-- has the required privileges or stops with an actionable error.
--
-- The runtime role is created by prisma/prepare-runtime-role.ts, which runs
-- after `prisma migrate deploy` on a fresh database and in QA lanes that use a
-- differently named runtime role. When devfathom_app does not exist yet there
-- is nothing to grant here: skip, and let prepare-runtime-role.ts grant these
-- functions when it creates the role.
DO $grant_pg_trgm$
DECLARE
  target regprocedure;
  targets constant regprocedure[] := ARRAY[
    'public.similarity(text,text)'::regprocedure,
    'public.similarity_op(text,text)'::regprocedure,
    'public.word_similarity(text,text)'::regprocedure,
    'public.word_similarity_op(text,text)'::regprocedure,
    'public.word_similarity_commutator_op(text,text)'::regprocedure,
    'public.strict_word_similarity(text,text)'::regprocedure,
    'public.strict_word_similarity_op(text,text)'::regprocedure,
    'public.strict_word_similarity_commutator_op(text,text)'::regprocedure
  ];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'devfathom_app') THEN
    RAISE NOTICE
      'devfathom_app does not exist yet; pg_trgm EXECUTE grants are left to prisma/prepare-runtime-role.ts';
    RETURN;
  END IF;

  FOREACH target IN ARRAY targets
  LOOP
    IF NOT pg_catalog.has_function_privilege('devfathom_app', target, 'EXECUTE') THEN
      IF NOT pg_catalog.has_function_privilege(current_user, target, 'EXECUTE WITH GRANT OPTION') THEN
        RAISE EXCEPTION
          'devfathom_app lacks EXECUTE on pg_trgm function %, and migration role % cannot grant it',
          target, current_user
          USING HINT = 'Run prisma/prepare-extensions.ts with EXTENSION_ADMIN_DATABASE_URL before prisma migrate deploy.';
      END IF;

      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO devfathom_app', target);
    END IF;

    IF NOT pg_catalog.has_function_privilege('devfathom_app', target, 'EXECUTE') THEN
      RAISE EXCEPTION
        'pg_trgm EXECUTE grant for devfathom_app did not take effect on %', target
        USING HINT = 'Run prisma/prepare-extensions.ts with EXTENSION_ADMIN_DATABASE_URL before prisma migrate deploy.';
    END IF;
  END LOOP;
END
$grant_pg_trgm$;

COMMIT;
