BEGIN;
SET LOCAL lock_timeout = '10s';

ALTER TYPE "PlatformJobType" ADD VALUE IF NOT EXISTS 'password.reset.request.v1';

-- Every credential writer already holds the updated member's row lock. The
-- trigger also covers platform resets, invitation acceptance and future writers.
CREATE OR REPLACE FUNCTION public.retire_password_reset_links() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE public.password_reset_tokens
     SET "usedAt" = clock_timestamp()
   WHERE "organizationId" = NEW."organizationId" AND "userId" = NEW.id AND "usedAt" IS NULL;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER retire_password_reset_links
AFTER UPDATE OF password, email, status, "twoFactorSecret", "twoFactorEnabledAt" ON public.users
FOR EACH ROW WHEN (
  OLD.password IS DISTINCT FROM NEW.password
  OR OLD.email IS DISTINCT FROM NEW.email
  OR (OLD.status IS DISTINCT FROM NEW.status AND NEW.status NOT IN ('ACTIVE', 'ON_LEAVE'))
  OR OLD."twoFactorSecret" IS DISTINCT FROM NEW."twoFactorSecret"
  OR OLD."twoFactorEnabledAt" IS DISTINCT FROM NEW."twoFactorEnabledAt"
)
EXECUTE FUNCTION public.retire_password_reset_links();

REVOKE ALL ON FUNCTION public.retire_password_reset_links() FROM PUBLIC;

COMMIT;
