-- D8: server-side state for a shared-host login between "the password is proven"
-- and "an organization has been chosen".
--
-- Control-plane, not tenant-scoped: the row deliberately spans organizations
-- before one is chosen, so there is no single organizationId for a tenant policy
-- to compare against. It holds no tenant business data — only the candidate set
-- the server itself computed — and is written and read solely by the
-- authentication path in the explicitly privileged platform scope.
--
-- Modelled on tenant_sso_tickets: the raw token never touches the database, only
-- its SHA-256 hash; consumption is a conditional update so it is single-use under
-- races; the minting host is recorded so an intent cannot be replayed elsewhere.
CREATE TABLE "pending_login_intents" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "candidates" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_login_intents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pending_login_intents_tokenHash_key"
    ON "pending_login_intents"("tokenHash");
CREATE INDEX "pending_login_intents_expiresAt_usedAt_idx"
    ON "pending_login_intents"("expiresAt", "usedAt");

ALTER TABLE "pending_login_intents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pending_login_intents" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_control_plane_only"
    ON "pending_login_intents"
    USING (current_setting('app.is_platform_admin', true) = 'true')
    WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
