-- DEV-833 (F11): mailbox OAuth connect state. A provider callback is accepted
-- only for the user, tenant, session and provider that started the connect,
-- and only once. Only a SHA-256 hash of the OAuth state is stored.
BEGIN;

CREATE TABLE IF NOT EXISTS "mailbox_oauth_states" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "userId" TEXT NOT NULL,
    "provider" "MailboxType" NOT NULL,
    "stateHash" TEXT NOT NULL,
    "sessionBinding" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "mailbox_oauth_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "mailbox_oauth_states_stateHash_key"
  ON "mailbox_oauth_states"("stateHash");
CREATE INDEX IF NOT EXISTS "mailbox_oauth_states_userId_expiresAt_idx"
  ON "mailbox_oauth_states"("userId", "expiresAt");
CREATE INDEX IF NOT EXISTS "mailbox_oauth_states_organizationId_expiresAt_idx"
  ON "mailbox_oauth_states"("organizationId", "expiresAt");

ALTER TABLE "mailbox_oauth_states" DROP CONSTRAINT IF EXISTS "mailbox_oauth_states_organizationId_fkey";
ALTER TABLE "mailbox_oauth_states"
  ADD CONSTRAINT "mailbox_oauth_states_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "mailbox_oauth_states" DROP CONSTRAINT IF EXISTS "mailbox_oauth_states_userId_fkey";
ALTER TABLE "mailbox_oauth_states"
  ADD CONSTRAINT "mailbox_oauth_states_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Defense in depth: a state row can never pair a user with another tenant.
ALTER TABLE "mailbox_oauth_states" DROP CONSTRAINT IF EXISTS "tenant_mailbox_oauth_states_user_fk";
ALTER TABLE "mailbox_oauth_states"
  ADD CONSTRAINT "tenant_mailbox_oauth_states_user_fk"
  FOREIGN KEY ("organizationId", "userId")
  REFERENCES "users" ("organizationId", "id")
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "mailbox_oauth_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mailbox_oauth_states" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "mailbox_oauth_states";
CREATE POLICY "tenant_isolation" ON "mailbox_oauth_states"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

COMMIT;
