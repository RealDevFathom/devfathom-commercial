-- DEV-961 phase 1: approvals use an authenticator app by default.
--
-- organizations.requireApprovalAuthenticator now defaults to true, and every
-- existing organization is switched on, one organization at a time with the
-- tenant set. Demo seats are left as they are: their personas sign in without a
-- password and cannot set up an authenticator. The owner can still turn it off (audited); with it off, approvals
-- take the permanent PINs exactly as before. No PIN credential is touched, so
-- turning it off works at once.
--
-- approval_authenticator_recovery_codes holds the one-time recovery codes shown
-- once when a member sets up their approval authenticator. Only a SHA-256 hash
-- of each code is stored; a used code is stamped and never accepted again.
BEGIN;

-- The organizations policy admits the platform, so this lets a NOSUPERUSER NOBYPASSRLS
-- migration owner list every organization; each update below also sets that tenant.
SELECT set_config('app.is_platform_admin', 'true', true);

ALTER TABLE "organizations"
  ALTER COLUMN "requireApprovalAuthenticator" SET DEFAULT true;

DO $$
DECLARE
  tenant_id TEXT;
BEGIN
  FOR tenant_id IN SELECT "id" FROM "organizations" WHERE "isDemo" = false ORDER BY "id" LOOP
    PERFORM set_config('app.current_organization_id', tenant_id, true);
    UPDATE "organizations"
      SET "requireApprovalAuthenticator" = true
      WHERE "id" = tenant_id AND "requireApprovalAuthenticator" IS DISTINCT FROM true;
  END LOOP;
  PERFORM set_config('app.current_organization_id', '', true);
END $$;

SELECT set_config('app.is_platform_admin', '', true);

CREATE TABLE IF NOT EXISTS "approval_authenticator_recovery_codes" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "userId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "approval_authenticator_recovery_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "approval_authenticator_recovery_codes_hash_ck" CHECK ("codeHash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "approval_authenticator_recovery_codes_org_user_hash_key"
  ON "approval_authenticator_recovery_codes" ("organizationId", "userId", "codeHash");
CREATE INDEX IF NOT EXISTS "approval_authenticator_recovery_codes_userId_idx"
  ON "approval_authenticator_recovery_codes" ("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'approval_authenticator_recovery_codes_userId_fkey'
  ) THEN
    ALTER TABLE "approval_authenticator_recovery_codes"
      ADD CONSTRAINT "approval_authenticator_recovery_codes_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "approval_authenticator_recovery_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_authenticator_recovery_codes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "approval_authenticator_recovery_codes";
CREATE POLICY tenant_isolation ON "approval_authenticator_recovery_codes"
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

COMMIT;
