-- DEV-879: manager and owner approvals accept a rotating authenticator code.
--
-- approval_authenticators holds one enrolment per member: the AES-256-GCM
-- encrypted TOTP secret (never plaintext), when it was confirmed, and the last
-- accepted 30-second time step so each code approves at most one action.
-- organizations.requireApprovalAuthenticator lets the owner turn fixed approval
-- PINs off for the whole organization.
BEGIN;

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "requireApprovalAuthenticator" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "approval_authenticators" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "userId" TEXT NOT NULL,
  "encryptedSecret" TEXT NOT NULL,
  "enabledAt" TIMESTAMP(3),
  "lastUsedStep" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "approval_authenticators_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "approval_authenticators_secret_ck" CHECK ("encryptedSecret" LIKE 'v1.%')
);

CREATE UNIQUE INDEX IF NOT EXISTS "approval_authenticators_organizationId_userId_key"
  ON "approval_authenticators" ("organizationId", "userId");
CREATE INDEX IF NOT EXISTS "approval_authenticators_userId_idx"
  ON "approval_authenticators" ("userId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'approval_authenticators_userId_fkey'
  ) THEN
    ALTER TABLE "approval_authenticators"
      ADD CONSTRAINT "approval_authenticators_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "approval_authenticators" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "approval_authenticators" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "approval_authenticators";
CREATE POLICY tenant_isolation ON "approval_authenticators"
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

COMMIT;
