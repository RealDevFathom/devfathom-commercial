-- The ledger outlives tenant users. A tenant actor is an immutable historical
-- identifier, so deleting its user must neither block retention nor rewrite the
-- audit row. Validate attribution when it is recorded instead of retaining a FK.
ALTER TABLE "platform_audit_logs"
DROP CONSTRAINT "platform_audit_logs_actorTenantUserId_fkey";

CREATE FUNCTION check_platform_audit_tenant_actor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."actorTenantUserId" IS NOT NULL THEN
    -- Serialize with a concurrent user deletion until this insert commits.
    PERFORM 1 FROM public.users
    WHERE "organizationId" = NEW."organizationId"
      AND id = NEW."actorTenantUserId"
    FOR KEY SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Foreign key constraint violated: tenant audit actor must belong to the organization'
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER platform_audit_logs_check_tenant_actor
BEFORE INSERT ON "platform_audit_logs"
FOR EACH ROW EXECUTE FUNCTION check_platform_audit_tenant_actor();

-- UPDATE and DELETE remain unconditionally forbidden by the existing
-- platform_audit_logs_append_only trigger, including during tenant purging.
